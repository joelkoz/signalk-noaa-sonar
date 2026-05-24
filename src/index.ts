import path from 'path'
import { Request, Response, Application } from 'express'
import {
  Plugin,
  ServerAPI,
  ResourceProviderRegistry
} from '@signalk/server-api'
import { TileCache } from './cache'
import { NoaaSource } from './source'
import { validateTileCoords } from './validate'

const NOAA_BAG_SUBSETS =
  'https://gis.ngdc.noaa.gov/arcgis/rest/services/bag_hillshades_subsets/ImageServer'

const CHART_ID = 'noaa-sonar'
const TILE_BASE = '/signalk/noaa-sonar/chart-tiles'
const V1 = '/signalk/v1/api/resources'
const V2 = '/signalk/v2/api/resources'

// A chart whose tiles cover only sparse survey swaths: advertise the whole
// world so Freeboard never pre-clips a request, and let per-tile 404s mark the
// gaps. Latitude is bounded by the web-mercator limit.
const WORLD_BOUNDS: [number, number, number, number] = [
  -180, -85.05112878, 180, 85.05112878
]

interface Config {
  mbtilesPath: string
  serviceUrl: string
  fetchOnMiss: boolean
  minzoom: number
  maxzoom: number
  name: string
  description: string
  minLon?: number
  minLat?: number
  maxLon?: number
  maxLat?: number
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
  let cache: TileCache | null = null
  let source: NoaaSource | null = null
  let props: Config
  let routesRegistered = false
  let providerRegistered = false

  const defaultMbtiles = path.join(
    app.config.configPath,
    'charts',
    'noaa-sonar.mbtiles'
  )

  const CONFIG_SCHEMA = {
    title: 'NOAA Sonar Chart Provider',
    type: 'object',
    properties: {
      mbtilesPath: {
        type: 'string',
        title: 'MBTiles cache file',
        description: `Absolute path, or relative to "${app.config.configPath}". Defaults to "${defaultMbtiles}". Created if missing.`,
        default: ''
      },
      fetchOnMiss: {
        type: 'boolean',
        title: 'Render missing tiles from NOAA (fetch-on-miss)',
        description:
          'When ON, tiles not in the cache are rendered from the NOAA ImageServer and saved. Turn OFF to serve only cached tiles (e.g. on cellular / offline).',
        default: true
      },
      serviceUrl: {
        type: 'string',
        title: 'NOAA ImageServer URL',
        default: NOAA_BAG_SUBSETS
      },
      minzoom: { type: 'number', title: 'Min zoom', default: 1 },
      maxzoom: {
        type: 'number',
        title: 'Max zoom',
        description: 'Native survey resolution is ~0.5 m, around zoom 18.',
        default: 18
      },
      name: { type: 'string', title: 'Chart name', default: 'NOAA Sonar' },
      description: {
        type: 'string',
        title: 'Chart description',
        default: 'NOAA bathymetric sonar (hillshade)'
      },
      minLon: {
        type: 'number',
        title: 'Bounds: west longitude (optional)',
        description:
          'Leave all four bounds blank for worldwide. Set them to constrain the chart to your cruising area and avoid fetching empty open-ocean tiles.'
      },
      minLat: { type: 'number', title: 'Bounds: south latitude (optional)' },
      maxLon: { type: 'number', title: 'Bounds: east longitude (optional)' },
      maxLat: { type: 'number', title: 'Bounds: north latitude (optional)' }
    }
  }

  const resolveMbtilesPath = (p: string): string =>
    !p
      ? defaultMbtiles
      : path.isAbsolute(p)
        ? p
        : path.resolve(app.config.configPath, p)

  // The provider advertises the area over which it is willing to serve/fetch
  // tiles -- NOT the area currently cached. Default is the whole world so the
  // cache can grow anywhere NOAA has data; set explicit bounds in config to
  // constrain it to a cruising area (and avoid empty fetches over open ocean).
  const resolveBounds = (): [number, number, number, number] => {
    const { minLon, minLat, maxLon, maxLat } = props
    if ([minLon, minLat, maxLon, maxLat].every((v) => Number.isFinite(v))) {
      return [minLon!, minLat!, maxLon!, maxLat!]
    }
    return WORLD_BOUNDS
  }

  // Chart resource as Freeboard expects it. `version` selects the v1
  // (tilemapUrl/chartLayers) vs v2 (url/layers) field shape.
  const chartMeta = (version: 1 | 2) => {
    const urlTemplate = `${TILE_BASE}/${CHART_ID}/{z}/{x}/{y}`
    const base = {
      identifier: CHART_ID,
      name: props.name,
      description: props.description,
      type: 'tilelayer',
      scale: 250000,
      format: 'png',
      bounds: resolveBounds(),
      minzoom: props.minzoom,
      maxzoom: props.maxzoom
    }
    return version === 1
      ? { ...base, tilemapUrl: urlTemplate, chartLayers: [] }
      : { ...base, url: urlTemplate, layers: [] }
  }

  const handleTile = async (req: Request, res: Response): Promise<void> => {
    const { identifier, z, x, y } = req.params as Record<string, string>
    if (identifier !== CHART_ID) {
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
    if (!cache) {
      res.sendStatus(503)
      return
    }

    const cached = cache.getTile(iz, ix, iy)
    if (cached) {
      sendPng(res, cached)
      return
    }
    // Known-empty (resolved before, no data): don't re-fetch.
    if (cache.isVisited(iz, ix, iy)) {
      res.sendStatus(404)
      return
    }
    if (!props.fetchOnMiss || !source) {
      res.sendStatus(404)
      return
    }

    try {
      const result = await source.fetchTile(ix, iy, iz)
      if (result.status === 'data' && result.body) {
        cache.putData(iz, ix, iy, result.body)
        sendPng(res, result.body)
      } else if (result.status === 'empty') {
        cache.markEmpty(iz, ix, iy)
        res.sendStatus(404)
      } else {
        res.sendStatus(502) // upstream error; leave unresolved so it retries
      }
    } catch (e) {
      app.error(`noaa-sonar tile ${iz}/${ix}/${iy}: ${(e as Error).message}`)
      res.sendStatus(500)
    }
  }

  const registerRoutes = () => {
    app.get(`${TILE_BASE}/:identifier/:z/:x/:y`, handleTile)

    // v1 Resources API (always available)
    app.get(`${V1}/charts/:identifier`, (req: Request, res: Response) => {
      if (req.params.identifier === CHART_ID) res.json(chartMeta(1))
      else res.status(404).send('Not found')
    })
    app.get(`${V1}/charts`, (_req: Request, res: Response) => {
      res.json({ [CHART_ID]: chartMeta(1) })
    })
  }

  const registerAsProvider = () => {
    if (providerRegistered || typeof app.registerResourceProvider !== 'function') {
      return
    }
    try {
      app.registerResourceProvider({
        type: 'charts',
        methods: {
          listResources: () =>
            Promise.resolve({ [CHART_ID]: chartMeta(2) }),
          getResource: (id: string) =>
            id === CHART_ID
              ? Promise.resolve(chartMeta(2))
              : Promise.reject(new Error('Chart not found!')),
          setResource: (id: string) =>
            Promise.reject(new Error(`Not implemented: cannot set ${id}`)),
          deleteResource: (id: string) =>
            Promise.reject(new Error(`Not implemented: cannot delete ${id}`))
        }
      })
      providerRegistered = true
    } catch (e) {
      app.error(`noaa-sonar: resource provider registration failed: ${e}`)
    }
  }

  const plugin: Plugin = {
    id: 'noaa-sonar-chart-provider',
    name: 'NOAA Sonar Chart Provider',
    schema: () => CONFIG_SCHEMA,
    start: (settings: Partial<Config>) => {
      props = {
        mbtilesPath: '',
        serviceUrl: NOAA_BAG_SUBSETS,
        fetchOnMiss: true,
        minzoom: 1,
        maxzoom: 18,
        name: 'NOAA Sonar',
        description: 'NOAA bathymetric sonar (hillshade)',
        ...settings
      }
      const mbtilesPath = resolveMbtilesPath(props.mbtilesPath)
      ensureDir(path.dirname(mbtilesPath))
      cache = new TileCache(mbtilesPath)
      source = new NoaaSource(props.serviceUrl)

      if (!routesRegistered) {
        registerRoutes()
        routesRegistered = true
      }
      registerAsProvider()

      app.setPluginStatus(
        `Serving ${CHART_ID} from ${mbtilesPath}` +
          (props.fetchOnMiss ? ' (fetch-on-miss ON)' : ' (cache-only)')
      )
    },
    stop: () => {
      cache?.close()
      cache = null
      source = null
      app.setPluginStatus('Stopped')
    }
  }

  return plugin
}

function sendPng(res: Response, body: Buffer): void {
  res.set('Content-Type', 'image/png')
  res.set('Cache-Control', 'public, max-age=7776000') // 90 days
  res.send(body)
}

function ensureDir(dir: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs')
  fs.mkdirSync(dir, { recursive: true })
}
