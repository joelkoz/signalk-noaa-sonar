import path from 'path'
import fs from 'fs'
import sharp from 'sharp'
import { Request, Response, Application } from 'express'
import {
  Plugin,
  ServerAPI,
  ResourceProviderRegistry
} from '@signalk/server-api'
import { CHARTS, ChartDef } from './charts'
import { sqliteAvailable, sqliteLoadError, packageRoot } from './db'
import { TileCache } from './cache'
import { LandMask } from './landmask'
import { buildLandDb } from './landbuild'
import { fetchExportImage, fetchWmts, isFullyTransparent } from './source'
import { tileBBox3857 } from './tiles'
import { validateTileCoords } from './validate'

const TILE_BASE = '/signalk/noaa-sonar/chart-tiles'
const V1 = '/signalk/v1/api/resources'
const V2 = '/signalk/v2/api/resources'
const WORLD_BOUNDS: [number, number, number, number] = [
  -180, -85.05112878, 180, 85.05112878
]
const WMTS_NATIVE_PX = 512 // BlueTopo gridset tile size
const OUT_PX = 256 // we always emit 256px XYZ tiles

interface Config {
  fetchOnMiss: boolean
}

interface ChartProviderApp
  extends ServerAPI,
    ResourceProviderRegistry,
    Application {
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

  const dataDir = path.join(app.config.configPath, 'noaa-sonar-data')
  const chartsDir = path.join(dataDir, 'charts')
  const landDbPath = path.join(dataDir, 'land.sqlite')

  const byId = (id: string): ChartDef | undefined => CHARTS.find((c) => c.id === id)

  // Dependency status shown at the top of the plugin config screen.
  const dependencyStatus = () =>
    sqliteAvailable()
      ? '✅ better-sqlite3 is installed.'
      : '❌ better-sqlite3 is NOT installed — charts are disabled. ' +
        `From a terminal run:  cd ${packageRoot()} && npm install better-sqlite3  ` +
        'then restart Signal K. (The Signal K App Store installs plugins with ' +
        "--ignore-scripts, which skips better-sqlite3's native build.)"

  const buildSchema = () => ({
    title: 'NOAA Sonar Charts',
    description:
      dependencyStatus() +
      '\n\nAdds NOAA sonar and BlueTopo underwater-relief charts. Tiles are cached under ' +
      `"${chartsDir}". Land masking for the BlueTopo charts needs a one-time land-data download.`,
    type: 'object',
    properties: {
      fetchOnMiss: {
        type: 'boolean',
        title: 'Download missing tiles when online',
        description:
          'When ON, tiles not yet cached are fetched from NOAA and saved. Turn OFF for cellular/offline (serve only what is cached).',
        default: true
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

  // --- per-miss producers --------------------------------------------------

  // exportImage chart (sonar): one 256px tile, optional mask (off for sonar).
  const produceExport = async (
    chart: ChartDef,
    cache: TileCache,
    z: number,
    x: number,
    y: number
  ): Promise<Buffer | null> => {
    if (chart.source.kind !== 'exportimage') return null
    const res = await fetchExportImage(chart.source.serviceUrl, z, x, y, OUT_PX)
    if (res.status === 'error') throw new Error('upstream error')
    if (res.status === 'empty' || !res.body) {
      cache.markEmpty(z, x, y)
      return null
    }
    cache.putData(z, x, y, res.body)
    return res.body
  }

  // wmts chart (BlueTopo): fetch the parent 512px tile, mask land, split into
  // four native-resolution 256px children (z-1 -> z), cache all four.
  const produceWmts = async (
    chart: ChartDef,
    cache: TileCache,
    z: number,
    x: number,
    y: number
  ): Promise<Buffer | null> => {
    if (chart.source.kind !== 'wmts') return null
    const pz = z - 1
    const pcol = x >> 1
    const prow = y >> 1
    const res = await fetchWmts(
      chart.source.base,
      chart.source.layer,
      chart.source.style,
      chart.source.format,
      pz,
      pcol,
      prow
    )
    if (res.status === 'error') throw new Error('upstream error')
    if (res.status === 'empty' || !res.body) {
      // whole 512 is empty -> all four children are empty
      for (const [cx, cy] of childrenOf(pcol, prow)) cache.markEmpty(z, cx, cy)
      return null
    }

    // Mask land out of the 512 before splitting.
    let img = res.body
    if (chart.mask && landMask?.ready) {
      const svg = landMask.maskSvg(tileBBox3857(pcol, prow, pz), WMTS_NATIVE_PX)
      if (svg) {
        img = await sharp(img)
          .ensureAlpha()
          .composite([{ input: svg, blend: 'dest-out' }])
          .png()
          .toBuffer()
      }
    }

    // Split into four 256px quadrants = the four XYZ children at zoom z.
    for (const [cx, cy] of childrenOf(pcol, prow)) {
      const quad = await sharp(img)
        .extract({
          left: (cx - pcol * 2) * OUT_PX,
          top: (cy - prow * 2) * OUT_PX,
          width: OUT_PX,
          height: OUT_PX
        })
        .png()
        .toBuffer()
      if (await isFullyTransparent(quad)) cache.markEmpty(z, cx, cy)
      else cache.putData(z, cx, cy, quad)
    }
    return cache.getTile(z, x, y)
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

    const cached = cache.getTile(iz, ix, iy)
    if (cached) return sendPng(res, cached)
    if (cache.isVisited(iz, ix, iy)) {
      res.sendStatus(404) // known empty
      return
    }
    if (!props.fetchOnMiss) {
      res.sendStatus(404)
      return
    }

    try {
      const png =
        chart.source.kind === 'wmts'
          ? await produceWmts(chart, cache, iz, ix, iy)
          : await produceExport(chart, cache, iz, ix, iy)
      if (png) sendPng(res, png)
      else res.sendStatus(404)
    } catch (e) {
      app.error(`noaa-sonar ${identifier} ${iz}/${ix}/${iy}: ${(e as Error).message}`)
      res.sendStatus(502)
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
      if (!sqliteAvailable()) {
        app.setPluginError(
          'better-sqlite3 is not installed, so charts are disabled. Install it: ' +
            `cd ${packageRoot()} && npm install better-sqlite3, then restart Signal K. ` +
            `(load error: ${sqliteLoadError()})`
        )
        return
      }
      fs.mkdirSync(chartsDir, { recursive: true })
      caches = new Map()
      for (const c of CHARTS) {
        caches.set(c.id, new TileCache(path.join(chartsDir, `${c.id}.mbtiles`)))
      }
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

function childrenOf(pcol: number, prow: number): Array<[number, number]> {
  return [
    [pcol * 2, prow * 2],
    [pcol * 2 + 1, prow * 2],
    [pcol * 2, prow * 2 + 1],
    [pcol * 2 + 1, prow * 2 + 1]
  ]
}

function sendPng(res: Response, body: Buffer): void {
  res.set('Content-Type', 'image/png')
  res.set('Cache-Control', 'public, max-age=7776000')
  res.send(body)
}
