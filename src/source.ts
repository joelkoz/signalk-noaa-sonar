/**
 * Renders individual web-mercator tiles from a NOAA ArcGIS ImageServer using
 * the dynamic `exportImage` endpoint (the service exposes no tile cache).
 *
 * A tile that falls entirely outside any survey swath comes back as a fully
 * transparent PNG. We detect that and report it as EMPTY so the caller can
 * record a negative-cache entry instead of storing a useless transparent tile
 * -- keeping the MBTiles `tiles` table "data only", which is what the Python
 * quadtree tool relies on.
 */

import { PNG } from 'pngjs'
import { tileBBox3857, TILE_SIZE } from './tiles'

export type TileStatus = 'data' | 'empty' | 'error'

export interface FetchResult {
  status: TileStatus
  body?: Buffer
}

export class NoaaSource {
  constructor(
    private serviceUrl: string,
    private tileSize: number = TILE_SIZE,
    private timeoutMs: number = 60000,
    private retries: number = 4
  ) {
    this.serviceUrl = serviceUrl.replace(/\/+$/, '')
  }

  tileUrl(x: number, y: number, z: number): string {
    const b = tileBBox3857(x, y, z)
    const size = `${this.tileSize},${this.tileSize}`
    return (
      `${this.serviceUrl}/exportImage` +
      `?bbox=${b.minX},${b.minY},${b.maxX},${b.maxY}` +
      `&bboxSR=3857&imageSR=3857&size=${size}` +
      `&format=png32&transparent=true&f=image`
    )
  }

  async fetchTile(x: number, y: number, z: number): Promise<FetchResult> {
    const url = this.tileUrl(x, y, z)
    let lastErr: unknown
    for (let attempt = 0; attempt < this.retries; attempt++) {
      try {
        const resp = await fetch(url, {
          signal: AbortSignal.timeout(this.timeoutMs)
        })
        const ctype = resp.headers.get('content-type') || ''
        const buf = Buffer.from(await resp.arrayBuffer())
        if (!resp.ok || !ctype.includes('image')) {
          // ArcGIS returns a JSON error body even with f=image on failure.
          throw new Error(
            `HTTP ${resp.status} ${ctype}: ${buf.toString('utf8').slice(0, 160)}`
          )
        }
        return isFullyTransparent(buf)
          ? { status: 'empty' }
          : { status: 'data', body: buf }
      } catch (e) {
        lastErr = e
        await delay(1000 + attempt * 1500)
      }
    }
    // eslint-disable-next-line no-console
    console.error(`noaa-sonar: tile ${z}/${x}/${y} failed: ${String(lastErr)}`)
    return { status: 'error' }
  }
}

/** True if every pixel's alpha is 0 (no survey data covers this tile). */
function isFullyTransparent(buf: Buffer): boolean {
  const png = PNG.sync.read(buf) // normalizes to 8-bit RGBA
  const data = png.data
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0) return false
  }
  return true
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
