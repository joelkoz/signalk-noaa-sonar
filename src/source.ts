/**
 * Upstream tile fetching for the two source kinds, plus the empty-tile check.
 *
 *  - exportImage: ArcGIS ImageServer rendered per tile by 3857 bbox (256px).
 *  - wmts: GeoServer GeoWebCache KVP GetTile (BlueTopo, native 512px).
 *
 * A tile that lands entirely outside survey coverage comes back fully
 * transparent; we report that as 'empty' so the caller negative-caches it
 * instead of storing a useless blob.
 */

import sharp from 'sharp'
import { tileBBox3857 } from './tiles'

export type TileStatus = 'data' | 'empty' | 'error'
export interface FetchResult {
  status: TileStatus
  body?: Buffer
}

const USER_AGENT =
  'signalk-noaa-sonar/0.2 (https://github.com/joelkoz/signalk-noaa-sonar)'
const HTTP_TIMEOUT = 60000
const HTTP_RETRIES = 4

/** True if every alpha sample is 0 (no data covers this tile). */
export async function isFullyTransparent(buf: Buffer): Promise<boolean> {
  const stats = await sharp(buf).ensureAlpha().stats()
  const alpha = stats.channels[stats.channels.length - 1]
  return alpha.max === 0
}

async function getImage(url: string): Promise<Buffer> {
  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(HTTP_TIMEOUT)
  })
  const ctype = resp.headers.get('content-type') || ''
  const buf = Buffer.from(await resp.arrayBuffer())
  if (!resp.ok || !ctype.includes('image')) {
    // ArcGIS / GeoServer return a non-image (JSON/XML) error body on failure.
    throw new Error(
      `HTTP ${resp.status} ${ctype}: ${buf.toString('utf8').slice(0, 160)}`
    )
  }
  return buf
}

async function tryFetch(url: string, label: string): Promise<FetchResult> {
  let lastErr: unknown
  for (let attempt = 0; attempt < HTTP_RETRIES; attempt++) {
    try {
      const buf = await getImage(url)
      return (await isFullyTransparent(buf))
        ? { status: 'empty' }
        : { status: 'data', body: buf }
    } catch (e) {
      lastErr = e
      await delay(1000 + attempt * 1500)
    }
  }
  // eslint-disable-next-line no-console
  console.error(`noaa-sonar: fetch ${label} failed: ${String(lastErr)}`)
  return { status: 'error' }
}

/** ArcGIS ImageServer exportImage: render a single web-mercator tile (sizePx). */
export function fetchExportImage(
  serviceUrl: string,
  z: number,
  x: number,
  y: number,
  sizePx = 256
): Promise<FetchResult> {
  const b = tileBBox3857(x, y, z)
  const url =
    `${serviceUrl.replace(/\/+$/, '')}/exportImage` +
    `?bbox=${b.minX},${b.minY},${b.maxX},${b.maxY}` +
    `&bboxSR=3857&imageSR=3857&size=${sizePx},${sizePx}` +
    `&format=png32&transparent=true&f=image`
  return tryFetch(url, `exportImage ${z}/${x}/${y}`)
}

export function wmtsTileUrl(
  base: string,
  layer: string,
  style: string,
  format: string,
  z: number,
  col: number,
  row: number
): string {
  return (
    `${base}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
    `&LAYER=${encodeURIComponent(layer)}&STYLE=${encodeURIComponent(style)}` +
    `&FORMAT=${encodeURIComponent(format)}&TILEMATRIXSET=EPSG:3857` +
    `&TILEMATRIX=EPSG:3857:${z}&TILEROW=${row}&TILECOL=${col}`
  )
}

/** GeoServer WMTS GetTile (native 512px for BlueTopo). */
export function fetchWmts(
  base: string,
  layer: string,
  style: string,
  format: string,
  z: number,
  col: number,
  row: number
): Promise<FetchResult> {
  return tryFetch(
    wmtsTileUrl(base, layer, style, format, z, col, row),
    `wmts ${layer} ${z}/${col}/${row}`
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
