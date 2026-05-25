#!/usr/bin/env node
/*
 * noaa-sonar-charts — pre-fill the NOAA Sonar Charts tile caches for an area.
 *
 * Walks a quadtree over the requested bounding box (skipping empty ocean) and
 * produces tiles for the selected chart layers into their MBTiles caches, using
 * the SAME producer the plugin uses on demand (mask + baked opacity + retile),
 * so pre-rendered tiles are identical to on-demand ones. Resumable and additive.
 *
 * Requires the plugin to be built (the `plugin/` output must exist) — it does
 * when installed from npm.
 */

'use strict'

const path = require('path')
const os = require('os')
const fs = require('fs')

const { CHARTS, cacheBaseName } = require('../plugin/charts.js')
const { TileCache } = require('../plugin/cache.js')
const { LandMask } = require('../plugin/landmask.js')
const { buildLandDb } = require('../plugin/landbuild.js')
const { produceTile } = require('../plugin/produce.js')
const { lonLatToTile } = require('../plugin/tiles.js')

// Match the plugin's data dir: <config>/plugin-config-data/<pluginId>. The
// plugin gets this from app.getDataDirPath(); that API isn't available to this
// standalone CLI, so we reconstruct the same path (override with --dir).
const SK_CONFIG =
  process.env.SIGNALK_NODE_CONFIG_DIR || path.join(os.homedir(), '.signalk')
const PLUGIN_ID = 'noaa-sonar-chart-provider'
const DEFAULT_DIR = path.join(SK_CONFIG, 'plugin-config-data', PLUGIN_ID)
const DEFAULT_MIN_ZOOM = 10
const DEFAULT_MAX_ZOOM = 18
const DEFAULT_WORKERS = 8

// selector keyword -> chart cache base name
const SELECTORS = {
  hi: 'noaa-sonar',
  relief: 'bluetopo-relief',
  color: 'bluetopo-bathymetry'
}

// --- helpers ---------------------------------------------------------------
/** Inclusive XYZ tile range covering a WGS84 bbox [W,S,E,N] at zoom z. */
function bboxTileRange(bbox, z) {
  const [w, s, e, n] = bbox
  const a = lonLatToTile(w, n, z) // NW -> min x, min y
  const b = lonLatToTile(e, s, z) // SE -> max x, max y
  return {
    x0: Math.min(a.x, b.x),
    y0: Math.min(a.y, b.y),
    x1: Math.max(a.x, b.x),
    y1: Math.max(a.y, b.y)
  }
}

async function runPool(items, workers, fn) {
  let i = 0
  const worker = async () => {
    while (i < items.length) await fn(items[i++])
  }
  await Promise.all(Array.from({ length: Math.max(1, workers) }, worker))
}

// --- per-chart build -------------------------------------------------------
async function buildChart(chart, args, landMask) {
  const base = cacheBaseName(chart.id)
  const cache = new TileCache(path.join(args.dir, 'charts', `${base}.mbtiles`))
  const minZ = Math.max(args.minZoom, chart.minzoom)
  const maxZ = Math.min(args.maxZoom, chart.maxzoom)
  const isWmts = chart.source.kind === 'wmts'
  const totals = { data: 0, empty: 0, error: 0 }

  for (let z = minZ; z <= maxZ; z++) {
    const r = bboxTileRange(args.bbox, z)
    let candidates = []
    if (z === minZ) {
      for (let x = r.x0; x <= r.x1; x++)
        for (let y = r.y0; y <= r.y1; y++) candidates.push([x, y])
    } else {
      const seen = new Set()
      for (const p of cache.dataTilesAt(z - 1)) {
        for (const x of [p.x * 2, p.x * 2 + 1]) {
          for (const y of [p.y * 2, p.y * 2 + 1]) {
            const k = x + ',' + y
            if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1 && !seen.has(k)) {
              seen.add(k)
              candidates.push([x, y])
            }
          }
        }
      }
    }
    // For wmts, one parent 512 fetch fills a quadrant of four 256 children, so
    // collapse candidates to one representative per parent to avoid refetching.
    if (isWmts) {
      const seen = new Set()
      candidates = candidates.filter(([x, y]) => {
        const k = (x >> 1) + ',' + (y >> 1)
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
    }

    const todo = candidates.filter(([x, y]) => !cache.isVisited(z, x, y))
    const counts = { data: 0, empty: 0, error: 0 }
    const start = Date.now()
    let done = 0
    console.log(
      `[${base} z${z}] ${todo.length} to fetch (${candidates.length - todo.length} already done)`
    )
    await runPool(todo, args.workers, async ([x, y]) => {
      try {
        const buf = await produceTile(chart, cache, landMask, z, x, y, chart.opacity)
        if (buf) counts.data++
        else counts.empty++
      } catch (e) {
        counts.error++
        process.stderr.write(`  ! ${base} ${z}/${x}/${y}: ${String(e.message || e)}\n`)
      }
      if (++done % 200 === 0) {
        const rate = done / Math.max((Date.now() - start) / 1000, 1e-6)
        console.log(`  ${base} z${z}: ${done}/${todo.length} (${rate.toFixed(1)}/s)`)
      }
    })
    totals.data += counts.data
    totals.empty += counts.empty
    totals.error += counts.error
    console.log(
      `[${base} z${z}] done: data=${counts.data} empty=${counts.empty} err=${counts.error} ` +
        `in ${Math.round((Date.now() - start) / 1000)}s`
    )
    if (counts.error) console.log(`[${base} z${z}] WARNING: ${counts.error} errored; re-run to retry.`)
  }

  cache.close()
  console.log(`[${base}] total: data=${totals.data} empty=${totals.empty} err=${totals.error}\n`)
}

// --- CLI -------------------------------------------------------------------
function parseArgs(argv) {
  const a = {
    dir: DEFAULT_DIR,
    bbox: null,
    minZoom: DEFAULT_MIN_ZOOM,
    maxZoom: DEFAULT_MAX_ZOOM,
    workers: DEFAULT_WORKERS,
    selOps: []
  }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const sel = /^([+-])(all|hi|relief|color)$/.exec(k)
    if (sel) {
      a.selOps.push({ op: sel[1], key: sel[2] })
      continue
    }
    switch (k) {
      case '--dir': a.dir = argv[++i]; break
      case '--bbox':
        a.bbox = [Number(argv[++i]), Number(argv[++i]), Number(argv[++i]), Number(argv[++i])]
        break
      case '--min-zoom': a.minZoom = Number(argv[++i]); break
      case '--max-zoom': a.maxZoom = Number(argv[++i]); break
      case '--workers': a.workers = Number(argv[++i]); break
      case '-h':
      case '--help': printHelp(); process.exit(0); break
      default:
        console.error(`Unknown argument: ${k}\n`)
        printHelp()
        process.exit(2)
    }
  }
  return a
}

/** Resolve +/- selector ops (default +all) to a list of ChartDefs. */
function resolveSelection(selOps) {
  const ops = selOps.length ? selOps : [{ op: '+', key: 'all' }]
  const keys = new Set()
  for (const { op, key } of ops) {
    const targets = key === 'all' ? ['hi', 'relief', 'color'] : [key]
    for (const t of targets) (op === '+' ? keys.add(t) : keys.delete(t))
  }
  return [...keys]
    .map((k) => CHARTS.find((c) => cacheBaseName(c.id) === SELECTORS[k]))
    .filter(Boolean)
}

function printHelp() {
  console.log(
    `noaa-sonar-charts — pre-fill the NOAA Sonar Charts tile caches for an area.\n` +
      `\n` +
      `Usage:\n` +
      `  npx noaa-sonar-charts --bbox W S E N [layers] [options]\n` +
      `  node tools/noaa-sonar-to-mbtiles.js --bbox W S E N [layers] [options]\n` +
      `\n` +
      `Layers (default: +all) — combine + / - left to right:\n` +
      `  +all / -all        all three layers\n` +
      `  +hi / -hi          NOAA Hi-Res Relief\n` +
      `  +relief / -relief  BlueTopo Relief\n` +
      `  +color / -color    BlueTopo Depth Color\n` +
      `  examples:  -all +color     only Depth Color\n` +
      `             +all -hi        relief + color (not hi-res)\n` +
      `\n` +
      `Options:\n` +
      `  --bbox W S E N   REQUIRED. Bounding box in decimal degrees (WGS84):\n` +
      `                     W = west longitude   S = south latitude\n` +
      `                     E = east longitude   N = north latitude\n` +
      `                   (western longitudes and southern latitudes are negative)\n` +
      `                   Example (Florida Keys): --bbox -82.0 24.4 -80.05 25.6\n` +
      `  --dir <path>     Data directory (default: ${DEFAULT_DIR}).\n` +
      `                   Caches -> <dir>/charts/ , land data -> <dir>/land.sqlite\n` +
      `  --min-zoom <n>   Minimum zoom (default ${DEFAULT_MIN_ZOOM}).\n` +
      `  --max-zoom <n>   Maximum zoom (default ${DEFAULT_MAX_ZOOM}). Caps: Hi-Res 18, BlueTopo 21.\n` +
      `  --workers <n>    Concurrent downloads (default ${DEFAULT_WORKERS}).\n` +
      `  -h, --help       Show this help.\n` +
      `\n` +
      `Resumable & additive: re-run to extend the area or add zoom levels.`
  )
}

async function main() {
  if (process.argv.length <= 2) {
    printHelp()
    process.exit(0)
  }
  const args = parseArgs(process.argv.slice(2))
  if (!args.bbox || args.bbox.length !== 4 || !args.bbox.every(Number.isFinite)) {
    console.error('Error: --bbox W S E N is required.\n')
    printHelp()
    process.exit(2)
  }
  const charts = resolveSelection(args.selOps)
  if (!charts.length) {
    console.error('Error: no layers selected.\n')
    printHelp()
    process.exit(2)
  }

  fs.mkdirSync(path.join(args.dir, 'charts'), { recursive: true })

  let landMask = null
  if (charts.some((c) => c.mask)) {
    const landDb = path.join(args.dir, 'land.sqlite')
    landMask = new LandMask(landDb)
    if (!landMask.exists()) {
      console.log('Land data not found — building (one-time, large download)...')
      await buildLandDb(landDb, (m) => console.log('  ' + m))
    }
    landMask.open()
    console.log('Land mask ready.')
  }

  console.log(`Layers: ${charts.map((c) => cacheBaseName(c.id)).join(', ')}`)
  console.log(
    `Area: [${args.bbox.join(', ')}]  zoom ${args.minZoom}-${args.maxZoom}  workers ${args.workers}`
  )
  console.log(`Data dir: ${args.dir}\n`)

  for (const chart of charts) await buildChart(chart, args, landMask)

  landMask?.close()
  console.log('Done.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
