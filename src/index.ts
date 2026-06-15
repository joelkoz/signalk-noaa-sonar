import path from 'path'
import fs from 'fs'
import { Request, Response, Application } from 'express'
import {
  Plugin,
  ServerAPI,
  ResourceProviderRegistry
} from '@signalk/server-api'
import { CHARTS, ChartDef, cacheBaseName } from './charts'
import { TileCache } from './cache'
import { LandMask } from './landmask'
import { buildLandDb } from './landbuild'
import { validateTileCoords } from './validate'

const TILE_BASE = '/signalk/noaa-sonar/chart-tiles'
// A single on-demand tile fetch may not hold the request longer than this; on
// expiry we answer as "tile absent" so one bad upstream can never stall a chart.
const REQUEST_BUDGET_MS = 4000
// After an upstream timeout/error we drop into cache-only ("offline") mode for
// this long, so a struggling provider isn't hammered tile-after-tile.
const OFFLINE_COOLDOWN_MS = 30000
const V1 = '/signalk/v1/api/resources'
const V2 = '/signalk/v2/api/resources'
const WORLD_BOUNDS: [number, number, number, number] = [
  -180, -85.05112878, 180, 85.05112878
]

interface Config {
  fetchOnMiss: boolean
  // Per-chart baked opacity, keyed by cache base name (e.g. 'noaa-sonar').
  opacity?: Record<string, number>
}

interface ChartProviderApp
  extends ServerAPI,
    ResourceProviderRegistry,
    Application {
  // Plugin data directory: <configPath>/plugin-config-data/<pluginId>
  getDataDirPath: () => string
  config: {
    ssl: boolean
    configPath: string
    version: string
    getExternalPort: () => number
  }
}

module.exports = (app: ChartProviderApp): Plugin => {
  let props: Config = { fetchOnMiss: true }
  let caches: Map<string, TileCache> = new Map()
  let landMask: LandMask | null = null
  let routesRegistered = false
  let providerRegistered = false
  // Epoch ms until which on-demand fetching is suspended (cache-only mode)
  // after an upstream timeout/error. 0 = online.
  let offlineUntil = 0
  const isOffline = () => Date.now() < offlineUntil

  // Plugin-owned data dir (<configPath>/plugin-config-data/<pluginId>).
  const getDataDirPath = (app as unknown as { getDataDirPath?: () => string }).getDataDirPath
  const dataDir =
    typeof getDataDirPath === 'function'
      ? getDataDirPath.call(app)
      : path.join(app.config.configPath, 'plugin-config-data', 'noaa-sonar-chart-provider')
  const chartsDir = path.join(dataDir, 'charts')
  const landDbPath = path.join(dataDir, 'land.sqlite')

  const byId = (id: string): ChartDef | undefined => CHARTS.find((c) => c.id === id)

  const buildSchema = () => ({
    title: 'NOAA Sonar Charts',
    description:
      'Adds NOAA sonar and BlueTopo underwater-relief charts. Tiles are cached under ' +
      `"${chartsDir}". Land masking for the BlueTopo charts needs a one-time land-data download.`,
    type: 'object',
    properties: {
      fetchOnMiss: {
        type: 'boolean',
        title: 'Download missing tiles dynamically',
        description: '(disable for offline viewing)',
        default: true
      },
      opacity: {
        type: 'object',
        title: 'Baked layer opacity (advanced)',
        description:
          'Opacity (0–1) baked into each layer as its tiles are cached, so the ' +
          'three layers stack sensibly without per-layer tuning in Freeboard ' +
          '(leave Freeboard layer opacity at 100%). Most users will not change ' +
          "these. A change only affects tiles fetched afterward — clear that " +
          "chart's cache to re-bake existing tiles.",
        properties: Object.fromEntries(
          CHARTS.map((c) => [
            cacheBaseName(c.id),
            {
              type: 'number',
              title: c.name,
              default: c.opacity,
              minimum: 0,
              maximum: 1
            }
          ])
        )
      }
    }
  })

  const chartMeta = (chart: ChartDef, version: 1 | 2) => {
    const url = `${TILE_BASE}/${chart.id}/{z}/{x}/{y}`
    const base = {
      identifier: chart.id,
      name: chart.name,
      description: chart.description,
      type: 'tilelayer',
      scale: 250000,
      format: 'png',
      bounds: WORLD_BOUNDS,
      minzoom: chart.minzoom,
      maxzoom: chart.maxzoom
    }
    return version === 1
      ? { ...base, tilemapUrl: url, chartLayers: [] }
      : { ...base, url, layers: [] }
  }

  // Effective baked opacity for a chart: config override (by cache base name)
  // falls back to the chart's default, clamped to 0..1.
  const opacityFor = (chart: ChartDef): number => {
    const v = props.opacity?.[cacheBaseName(chart.id)]
    const o = typeof v === 'number' ? v : chart.opacity
    return Math.max(0, Math.min(1, o))
  }

  const handleTile = async (req: Request, res: Response): Promise<void> => {
    const { identifier, z, x, y } = req.params as Record<string, string>
    const chart = byId(identifier)
    const cache = caches.get(identifier)
    if (!chart || !cache) {
      res.sendStatus(404)
      return
    }
    const iz = parseInt(z)
    const ix = parseInt(x)
    const iy = parseInt(y)
    const coordErr = validateTileCoords(iz, ix, iy)
    if (coordErr) {
      res.status(400).send(coordErr)
      return
    }

    // Below the chart's floor the upstreams add no usable detail and misbehave
    // (slow world renders, out-of-range gridset tiles). Answer "absent" without
    // touching the upstream or the cache. Clients honour the advertised minzoom;
    // this guards against any that don't.
    if (iz < chart.minzoom) {
      res.sendStatus(404)
      return
    }

    const cached = cache.getTile(iz, ix, iy)
    if (cached) return sendPng(res, cached)
    if (cache.isVisited(iz, ix, iy)) {
      res.sendStatus(404) // known empty
      return
    }
    // Cache-only when the user disabled fetch-on-miss, or while we are riding
    // out an upstream outage (offline cooldown). Either way: behave as absent.
    if (!props.fetchOnMiss || isOffline()) {
      res.sendStatus(404)
      return
    }

    // Bound the on-demand fetch: if it can't deliver within the budget, abort
    // the upstream request and answer "absent" so the chart keeps moving.
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), REQUEST_BUDGET_MS)
    try {
      // Lazy-load the tile producer (and its native `sharp` dependency) only
      // on a cache miss. Keeping it out of the module's static import graph
      // means the plugin loads, exposes its schema, and starts even on hosts
      // where sharp's native binary cannot be mapped (e.g. the sandboxed
      // signalk-plugin-registry CI). Rendering still needs sharp; serving
      // already-cached tiles does not.
      const { produceTile } = await import('./produce')
      const png = await produceTile(
        chart,
        cache,
        landMask,
        iz,
        ix,
        iy,
        opacityFor(chart),
        deadline.signal
      )
      if (png) sendPng(res, png)
      else res.sendStatus(404)
    } catch (e) {
      // Timeout or upstream error: trip cache-only mode for the cooldown so we
      // stop hammering a struggling provider, and answer "absent" WITHOUT
      // negative-caching — a transient failure must not permanently hide a tile
      // (genuine no-coverage tiles are negative-cached inside produceTile).
      offlineUntil = Date.now() + OFFLINE_COOLDOWN_MS
      const why = deadline.signal.aborted
        ? `timed out after ${REQUEST_BUDGET_MS}ms`
        : (e as Error).message
      app.error(
        `noaa-sonar ${identifier} ${iz}/${ix}/${iy}: ${why} — ` +
          `cache-only for ${OFFLINE_COOLDOWN_MS / 1000}s`
      )
      res.sendStatus(404)
    } finally {
      clearTimeout(timer)
    }
  }

  const registerRoutes = () => {
    app.get(`${TILE_BASE}/:identifier/:z/:x/:y`, handleTile)
    app.get(`${V1}/charts/:identifier`, (req: Request, res: Response) => {
      const c = byId(req.params.identifier)
      if (c) res.json(chartMeta(c, 1))
      else res.status(404).send('Not found')
    })
    app.get(`${V1}/charts`, (_req: Request, res: Response) => {
      const out: Record<string, unknown> = {}
      for (const c of CHARTS) out[c.id] = chartMeta(c, 1)
      res.json(out)
    })
  }

  const registerAsProvider = () => {
    if (providerRegistered || typeof app.registerResourceProvider !== 'function') return
    try {
      app.registerResourceProvider({
        type: 'charts',
        methods: {
          listResources: () => {
            const out: Record<string, unknown> = {}
            for (const c of CHARTS) out[c.id] = chartMeta(c, 2)
            return Promise.resolve(out)
          },
          getResource: (id: string) => {
            const c = byId(id)
            return c
              ? Promise.resolve(chartMeta(c, 2))
              : Promise.reject(new Error('Chart not found!'))
          },
          setResource: (id: string) =>
            Promise.reject(new Error(`Not implemented: cannot set ${id}`)),
          deleteResource: (id: string) =>
            Promise.reject(new Error(`Not implemented: cannot delete ${id}`))
        }
      })
      providerRegistered = true
    } catch (e) {
      app.error(`noaa-sonar: provider registration failed: ${e}`)
    }
  }

  // Land DB: build it (download) in the background if missing, then open it.
  const initLandMask = async () => {
    landMask = new LandMask(landDbPath)
    if (!landMask.exists()) {
      app.setPluginStatus('Downloading land data (one-time) for masking...')
      try {
        await buildLandDb(landDbPath, (m) => app.debug(m))
      } catch (e) {
        app.error(`noaa-sonar: land data build failed: ${(e as Error).message}`)
        return
      }
    }
    try {
      landMask.open()
      app.debug('noaa-sonar: land mask ready')
      app.setPluginStatus(statusLine())
    } catch (e) {
      app.error(`noaa-sonar: opening land db failed: ${(e as Error).message}`)
    }
  }

  const statusLine = () =>
    `Serving ${CHARTS.length} charts` +
    (props.fetchOnMiss ? ', fetch-on-miss ON' : ', cache-only') +
    (landMask?.ready ? ', land mask ready' : ', land mask loading…')

  const plugin: Plugin = {
    id: 'noaa-sonar-chart-provider',
    name: 'NOAA Sonar Chart Provider',
    schema: () => buildSchema(),
    start: (settings: Partial<Config>) => {
      props = { fetchOnMiss: true, ...settings }
      const nextCaches = new Map<string, TileCache>()
      try {
        fs.mkdirSync(chartsDir, { recursive: true })
        for (const c of CHARTS) {
          nextCaches.set(
            c.id,
            new TileCache(path.join(chartsDir, `${cacheBaseName(c.id)}.mbtiles`))
          )
        }
      } catch (e) {
        for (const c of nextCaches.values()) c.close()
        app.setPluginError(
          `NOAA Sonar Charts disabled: opening SQLite caches failed: ${(e as Error).message}`
        )
        return
      }
      caches = nextCaches
      if (!routesRegistered) {
        registerRoutes()
        routesRegistered = true
      }
      registerAsProvider()
      app.setPluginStatus(statusLine())
      // Kick off land-data init without blocking startup.
      void initLandMask()
    },
    stop: () => {
      for (const c of caches.values()) c.close()
      caches = new Map()
      landMask?.close()
      landMask = null
      app.setPluginStatus('Stopped')
    }
  }

  return plugin
}

function sendPng(res: Response, body: Buffer): void {
  res.set('Content-Type', 'image/png')
  res.set('Cache-Control', 'public, max-age=7776000')
  res.send(body)
}
