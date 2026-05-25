/**
 * One-time builder for the land database used to mask land out of BlueTopo
 * tiles. Downloads OSM "land polygons" (already in EPSG:3857, and pre-split into
 * small pieces so per-tile rasterization stays fast), then stores each polygon's
 * exterior ring as a packed Float64 blob in SQLite, indexed by an R*Tree on its
 * bounding box.
 *
 * Runs from the plugin on first use (if land.sqlite is missing) or standalone
 * via tools/build-land-db.js. It is the heaviest one-time step; afterwards the
 * mask is just fast bbox lookups.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { Readable } from 'stream'
import { finished } from 'stream/promises'
import Database from 'better-sqlite3'
import AdmZip from 'adm-zip'
import { openShp } from 'shapefile'

export const OSM_LAND_URL =
  'https://osmdata.openstreetmap.de/download/land-polygons-split-3857.zip'

type Log = (msg: string) => void

async function download(url: string, dest: string, log: Log): Promise<void> {
  const resp = await fetch(url)
  if (!resp.ok || !resp.body) {
    throw new Error(`download failed: HTTP ${resp.status} for ${url}`)
  }
  const total = Number(resp.headers.get('content-length')) || 0
  let got = 0
  let lastPct = -1
  const reader = Readable.fromWeb(resp.body as never)
  reader.on('data', (chunk: Buffer) => {
    got += chunk.length
    if (total) {
      const pct = Math.floor((got / total) * 100)
      if (pct >= lastPct + 5) {
        lastPct = pct
        log(`  download ${pct}% (${(got / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} MB)`)
      }
    }
  })
  const out = fs.createWriteStream(dest)
  reader.pipe(out)
  await finished(out)
}

/** Pack a GeoJSON ring ([[x,y],...], EPSG:3857) into a Float64 buffer + bbox. */
function packRing(ring: number[][]) {
  const f = new Float64Array(ring.length * 2)
  let minx = Infinity,
    miny = Infinity,
    maxx = -Infinity,
    maxy = -Infinity
  for (let i = 0; i < ring.length; i++) {
    const x = ring[i][0]
    const y = ring[i][1]
    f[i * 2] = x
    f[i * 2 + 1] = y
    if (x < minx) minx = x
    if (x > maxx) maxx = x
    if (y < miny) miny = y
    if (y > maxy) maxy = y
  }
  return { buf: Buffer.from(f.buffer), minx, miny, maxx, maxy }
}

export async function buildLandDb(dbPath: string, log: Log): Promise<void> {
  const dir = path.dirname(dbPath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noaa-land-'))
  const zipPath = path.join(tmp, 'land.zip')
  try {
    log('Downloading OSM land polygons (one-time; this is a large file)...')
    await download(OSM_LAND_URL, zipPath, log)

    log('Extracting shapefile...')
    const zip = new AdmZip(zipPath)
    const entries = zip.getEntries()
    const base = entries
      .find((e) => e.entryName.toLowerCase().endsWith('.shp'))
      ?.entryName.replace(/\.shp$/i, '')
    if (!base) throw new Error('no .shp found in land polygons archive')
    for (const ext of ['shp', 'dbf', 'shx']) {
      const entry = entries.find(
        (e) => e.entryName.toLowerCase() === `${base}.${ext}`.toLowerCase()
      )
      if (entry) zip.extractEntryTo(entry, tmp, false, true)
    }
    const shpPath = path.join(tmp, path.basename(base) + '.shp')

    log('Building land index (this can take a few minutes)...')
    const tmpDb = dbPath + '.building'
    if (fs.existsSync(tmpDb)) fs.rmSync(tmpDb)
    const db = new Database(tmpDb)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = OFF')
    db.exec(
      `CREATE TABLE land (id INTEGER PRIMARY KEY, coords BLOB);
       CREATE VIRTUAL TABLE land_rtree USING rtree(id, minx, maxx, miny, maxy);`
    )
    const insLand = db.prepare('INSERT INTO land (id, coords) VALUES (?, ?)')
    const insRtree = db.prepare(
      'INSERT INTO land_rtree (id, minx, maxx, miny, maxy) VALUES (?, ?, ?, ?, ?)'
    )

    let id = 0
    let pending = 0
    db.exec('BEGIN')
    const addRing = (ring: number[][]) => {
      if (!ring || ring.length < 4) return
      const p = packRing(ring)
      id++
      insLand.run(id, p.buf)
      insRtree.run(id, p.minx, p.maxx, p.miny, p.maxy)
      if (++pending >= 5000) {
        db.exec('COMMIT')
        db.exec('BEGIN')
        pending = 0
      }
    }

    const src = await openShp(shpPath)
    for (;;) {
      const r = await src.read()
      if (r.done) break
      const g = r.value as { type: string; coordinates: unknown }
      if (!g) continue
      if (g.type === 'Polygon') {
        addRing((g.coordinates as number[][][])[0]) // exterior ring only
      } else if (g.type === 'MultiPolygon') {
        for (const poly of g.coordinates as number[][][][]) addRing(poly[0])
      }
    }
    db.exec('COMMIT')
    log(`Indexed ${id} land polygons.`)
    db.close()

    fs.renameSync(tmpDb, dbPath)
    for (const f of [dbPath + '.building-wal', dbPath + '.building-shm']) {
      if (fs.existsSync(f)) fs.rmSync(f)
    }
    log('Land database ready.')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
