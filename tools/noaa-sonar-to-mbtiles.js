#!/usr/bin/env node
/*
 * noaa-sonar-to-mbtiles.js
 *
 * Bulk-build / pre-fill the MBTiles cache used by the signalk-noaa-sonar plugin,
 * for a chosen bounding box, from NOAA's ArcGIS ImageServer.
 *
 * The original NOAA `bag_hillshades` *tile cache* was retired; the data now
 * lives in `bag_hillshades_subsets`, an ImageServer with NO tile cache -- only
 * the dynamic `exportImage` operation. So instead of fetching cached tiles we
 * render each web-mercator (XYZ) tile on demand:
 *
 *   exportImage?bbox=<tile bbox in EPSG:3857>&bboxSR=3857&imageSR=3857
 *              &size=256,256&format=png32&transparent=true&f=image
 *
 * Survey coverage is sparse (narrow multibeam swaths with large nodata gaps), so
 * we walk a QUADTREE: fetch a tile, and only descend into its four children if
 * it contained any data (any non-transparent pixel). A fully transparent tile
 * prunes its whole subtree. Because a child's extent is contained in its
 * parent's, this is lossless.
 *
 * Progress is tracked in a sidecar (<out>.progress) so the job is fully
 * resumable and ADDITIVE: re-run with a wider --bbox or deeper --max-zoom into
 * the same file and it continues where it left off, never re-downloading a tile.
 *
 * This shares one cache file (and one set of conventions) with the plugin --
 * see AGENTS.md. In particular the `tiles` table holds DATA tiles only, and the
 * tile math here MUST match src/tiles.ts exactly.
 *
 * Run from the package root (uses its better-sqlite3 + pngjs):
 *   node tools/noaa-sonar-to-mbtiles.js --bbox -82.0 24.4 -80.05 25.6 \
 *        --min-zoom 10 --max-zoom 18
 */

'use strict'

const Database = require('better-sqlite3')
const sharp = require('sharp')

// --- Defaults --------------------------------------------------------------
const DEFAULT_SERVICE =
  'https://gis.ngdc.noaa.gov/arcgis/rest/services/bag_hillshades_subsets/ImageServer'
const DEFAULT_OUT = 'noaa-sonar.mbtiles'
const DEFAULT_NAME = 'noaa-sonar'
const DEFAULT_DESCRIPTION = 'NOAA bathymetric sonar (hillshade)'
// west, south, east, north (WGS84): Florida Keys reef tract by default.
const DEFAULT_BBOX = [-82.0, 24.4, -80.05, 25.6]
const DEFAULT_MIN_ZOOM = 10
const DEFAULT_MAX_ZOOM = 18 // ~0.5 m/px at this latitude == native survey res
const TILE_SIZE = 256

const HTTP_TIMEOUT = 60000
const HTTP_RETRIES = 4
const USER_AGENT = 'signalk-noaa-sonar/bulk (mbtiles builder)'

// --- Web-mercator XYZ tile math (must match src/tiles.ts) ------------------
const WEBMERC_ORIGIN = Math.PI * 6378137.0
const MAX_LAT = 85.05112878

function lonLatToTile(lon, lat, z) {
  const n = 1 << z
  const clamped = Math.max(Math.min(lat, MAX_LAT), -MAX_LAT)
  let x = Math.floor(((lon + 180) / 360) * n)
  let y = Math.floor(
    ((1 - Math.asinh(Math.tan((clamped * Math.PI) / 180)) / Math.PI) / 2) * n
  )
  x = Math.min(Math.max(x, 0), n - 1)
  y = Math.min(Math.max(y, 0), n - 1)
  return { x, y }
}

function tileBBox3857(x, y, z) {
  const n = 1 << z
  const span = (2 * WEBMERC_ORIGIN) / n
  const minX = -WEBMERC_ORIGIN + x * span
  const maxY = WEBMERC_ORIGIN - y * span
  return { minX, minY: maxY - span, maxX: minX + span, maxY }
}

function flipRow(y, z) {
  return (1 << z) - 1 - y
}

/** Inclusive XYZ tile range {x0,y0,x1,y1} covering a WGS84 bbox at zoom z. */
function bboxTileRange(bbox, z) {
  const [west, south, east, north] = bbox
  const a = lonLatToTile(west, north, z) // NW -> min x, min y
  const b = lonLatToTile(east, south, z) // SE -> max x, max y
  return {
    x0: Math.min(a.x, b.x),
    y0: Math.min(a.y, b.y),
    x1: Math.max(a.x, b.x),
    y1: Math.max(a.y, b.y)
  }
}

// --- MBTiles output --------------------------------------------------------
class MBTiles {
  constructor(path) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS metadata (name text, value text);
       CREATE UNIQUE INDEX IF NOT EXISTS name ON metadata (name);
       CREATE TABLE IF NOT EXISTS tiles (zoom_level integer, tile_column integer,
         tile_row integer, tile_data blob);
       CREATE UNIQUE INDEX IF NOT EXISTS tile_index
         ON tiles (zoom_level, tile_column, tile_row);`
    )
    this._insTile = this.db.prepare(
      'INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)'
    )
    this._selMeta = this.db.prepare('SELECT value AS v FROM metadata WHERE name=?')
    this._insMeta = this.db.prepare(
      'INSERT OR REPLACE INTO metadata (name, value) VALUES (?, ?)'
    )
  }

  setMetadata(name, value) {
    this._insMeta.run(name, String(value))
  }

  getMetadata(name) {
    const row = this._selMeta.get(name)
    return row ? row.v : null
  }

  addTile(z, x, y, data) {
    this._insTile.run(z, x, flipRow(y, z), data)
  }

  /** XYZ {x, y} of every tile already stored at zoom z. */
  dataTilesAt(z) {
    const rows = this.db
      .prepare('SELECT tile_column AS c, tile_row AS r FROM tiles WHERE zoom_level=?')
      .all(z)
    return rows.map((row) => ({ x: row.c, y: flipRow(row.r, z) }))
  }

  zoomLevels() {
    return this.db
      .prepare('SELECT DISTINCT zoom_level AS z FROM tiles ORDER BY zoom_level')
      .all()
      .map((r) => r.z)
  }

  close() {
    this.db.close()
  }
}

// --- Resumable progress sidecar --------------------------------------------
class Progress {
  constructor(path) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS visited (z int, x int, y int, PRIMARY KEY (z, x, y))'
    )
    this._sel = this.db.prepare('SELECT x, y FROM visited WHERE z=?')
    this._ins = this.db.prepare('INSERT OR IGNORE INTO visited (z, x, y) VALUES (?, ?, ?)')
  }

  /** Set of "x,y" strings already resolved at zoom z. */
  visitedAt(z) {
    const set = new Set()
    for (const r of this._sel.all(z)) set.add(r.x + ',' + r.y)
    return set
  }

  mark(z, x, y) {
    this._ins.run(z, x, y)
  }

  close() {
    this.db.close()
  }
}

// --- Tile fetching ---------------------------------------------------------
async function fetchTile(service, z, x, y) {
  const b = tileBBox3857(x, y, z)
  const url =
    `${service}/exportImage?bbox=${b.minX},${b.minY},${b.maxX},${b.maxY}` +
    `&bboxSR=3857&imageSR=3857&size=${TILE_SIZE},${TILE_SIZE}` +
    `&format=png32&transparent=true&f=image`
  let lastErr
  for (let attempt = 0; attempt < HTTP_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(HTTP_TIMEOUT)
      })
      const ctype = resp.headers.get('content-type') || ''
      const buf = Buffer.from(await resp.arrayBuffer())
      if (!resp.ok || !ctype.includes('image')) {
        // ArcGIS returns a JSON error body even with f=image.
        throw new Error(`HTTP ${resp.status} ${ctype}: ${buf.toString('utf8').slice(0, 160)}`)
      }
      return (await isFullyTransparent(buf)) ? { status: 'empty' } : { status: 'data', body: buf }
    } catch (e) {
      lastErr = e
      await delay(1000 + attempt * 1500)
    }
  }
  process.stderr.write(`  ! tile ${z}/${x}/${y} failed: ${String(lastErr)}\n`)
  return { status: 'error' }
}

/** True if every alpha sample is 0 (no survey data covers this tile). */
async function isFullyTransparent(buf) {
  const stats = await sharp(buf).ensureAlpha().stats()
  const alpha = stats.channels[stats.channels.length - 1]
  return alpha.max === 0
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// --- Driver ----------------------------------------------------------------
async function build(args) {
  const mbt = new MBTiles(args.out)
  const prog = new Progress(args.out + '.progress')

  mbt.setMetadata('name', args.name)
  mbt.setMetadata('description', args.description)
  mbt.setMetadata('type', 'overlay')
  mbt.setMetadata('version', '1')
  mbt.setMetadata('format', 'png')
  // Accumulate bounds: this is a shared, growing cache, so union the new bbox
  // with whatever the file already covered rather than clobbering it.
  let [w, s, e, n] = args.bbox
  const prev = mbt.getMetadata('bounds')
  if (prev) {
    const p = prev.split(',').map(Number)
    if (p.length === 4 && p.every(Number.isFinite)) {
      w = Math.min(w, p[0]); s = Math.min(s, p[1]); e = Math.max(e, p[2]); n = Math.max(n, p[3])
    }
  }
  mbt.setMetadata('bounds', `${w},${s},${e},${n}`)
  mbt.setMetadata('center', `${(w + e) / 2},${(s + n) / 2},${args.minZoom}`)

  const totals = { data: 0, empty: 0, error: 0 }

  for (let z = args.minZoom; z <= args.maxZoom; z++) {
    // Candidate tiles at this zoom.
    let candidates
    if (z === args.minZoom) {
      const r = bboxTileRange(args.bbox, z)
      candidates = []
      for (let x = r.x0; x <= r.x1; x++)
        for (let y = r.y0; y <= r.y1; y++) candidates.push([x, y])
    } else {
      // children of every tile that had data one level up, clipped to bbox
      const r = bboxTileRange(args.bbox, z)
      const seen = new Set()
      candidates = []
      for (const p of mbt.dataTilesAt(z - 1)) {
        for (const x of [p.x * 2, p.x * 2 + 1]) {
          for (const y of [p.y * 2, p.y * 2 + 1]) {
            const key = x + ',' + y
            if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1 && !seen.has(key)) {
              seen.add(key)
              candidates.push([x, y])
            }
          }
        }
      }
    }

    const visited = prog.visitedAt(z)
    const todo = candidates.filter(([x, y]) => !visited.has(x + ',' + y))
    const counts = { data: 0, empty: 0, error: 0 }
    const start = Date.now()
    console.log(
      `[z${z}] ${todo.length} tiles to fetch (${candidates.length - todo.length} already done)`
    )

    let done = 0
    let cursor = 0
    const worker = async () => {
      while (cursor < todo.length) {
        const [x, y] = todo[cursor++]
        const result = await fetchTile(args.service, z, x, y)
        if (result.status === 'data') {
          mbt.addTile(z, x, y, result.body)
          prog.mark(z, x, y)
          counts.data++
        } else if (result.status === 'empty') {
          prog.mark(z, x, y)
          counts.empty++
        } else {
          counts.error++ // leave unmarked -> retried on a later run
        }
        if (++done % 200 === 0) {
          const rate = done / Math.max((Date.now() - start) / 1000, 1e-6)
          console.log(
            `  z${z}: ${done}/${todo.length} ` +
              `(data=${counts.data} empty=${counts.empty} err=${counts.error}) ${rate.toFixed(1)}/s`
          )
        }
      }
    }
    await Promise.all(Array.from({ length: args.workers }, worker))

    totals.data += counts.data
    totals.empty += counts.empty
    totals.error += counts.error
    console.log(
      `[z${z}] done: data=${counts.data} empty=${counts.empty} err=${counts.error} ` +
        `in ${Math.round((Date.now() - start) / 1000)}s`
    )
    if (counts.error) console.log(`[z${z}] WARNING: ${counts.error} tiles errored; re-run to retry.`)
  }

  const levels = mbt.zoomLevels()
  if (levels.length) {
    mbt.setMetadata('minzoom', Math.min(...levels))
    mbt.setMetadata('maxzoom', Math.max(...levels))
  }
  mbt.close()
  prog.close()
  console.log(
    `\nTotal: data=${totals.data} empty=${totals.empty} err=${totals.error}. ` +
      `Zoom levels present: ${JSON.stringify(levels)}`
  )
}

// --- CLI -------------------------------------------------------------------
function parseArgs(argv) {
  const a = {
    service: DEFAULT_SERVICE,
    out: DEFAULT_OUT,
    name: DEFAULT_NAME,
    description: DEFAULT_DESCRIPTION,
    bbox: DEFAULT_BBOX.slice(),
    minZoom: DEFAULT_MIN_ZOOM,
    maxZoom: DEFAULT_MAX_ZOOM,
    workers: 8
  }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    switch (k) {
      case '--service': a.service = argv[++i]; break
      case '--out': a.out = argv[++i]; break
      case '--name': a.name = argv[++i]; break
      case '--description': a.description = argv[++i]; break
      case '--bbox':
        a.bbox = [Number(argv[++i]), Number(argv[++i]), Number(argv[++i]), Number(argv[++i])]
        break
      case '--min-zoom': a.minZoom = Number(argv[++i]); break
      case '--max-zoom': a.maxZoom = Number(argv[++i]); break
      case '--workers': a.workers = Number(argv[++i]); break
      case '-h':
      case '--help':
        printHelp(); process.exit(0)
        break
      default:
        console.error(`Unknown argument: ${k}`)
        printHelp(); process.exit(2)
    }
  }
  if (a.bbox.length !== 4 || !a.bbox.every(Number.isFinite)) {
    console.error('--bbox requires four numbers: W S E N')
    process.exit(2)
  }
  return a
}

function printHelp() {
  console.log(
    `Usage: node tools/noaa-sonar-to-mbtiles.js [options]\n\n` +
      `  --out <file>          MBTiles cache to build (default ${DEFAULT_OUT})\n` +
      `  --bbox W S E N        WGS84 bounding box (default Florida Keys)\n` +
      `  --min-zoom <n>        Base zoom (default ${DEFAULT_MIN_ZOOM})\n` +
      `  --max-zoom <n>        Max zoom; ~0.5 m native is ~18 (default ${DEFAULT_MAX_ZOOM})\n` +
      `  --workers <n>         Concurrent fetches (default 8)\n` +
      `  --service <url>       NOAA ImageServer URL\n` +
      `  --name <s>            Tileset name metadata (default ${DEFAULT_NAME})\n` +
      `  --description <s>     Tileset description metadata\n` +
      `  -h, --help            Show this help\n\n` +
      `Resumable and additive: re-run into the same --out to extend it.`
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  console.log(
    `Building ${args.out}  bbox=[${args.bbox.join(', ')}]  ` +
      `zoom ${args.minZoom}-${args.maxZoom}  workers=${args.workers}`
  )
  await build(args)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
