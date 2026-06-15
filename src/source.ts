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
  'signalk-noaa-sonar-charts/1.0 (https://github.com/joelkoz/signalk-noaa-sonar-charts)'
const HTTP_TIMEOUT = 60000
const HTTP_RETRIES = 4

/** True if every alpha sample is 0 (no data covers this tile). */
export async function isFullyTransparent(buf: Buffer): Promise<boolean> {
  const stats = await sharp(buf).ensureAlpha().stats()
  const alpha = stats.channels[stats.channels.length - 1]
  return alpha.max === 0
}

/** A 4xx whose body says the tile lies outside the gridset's defined extent. */
class TileOutOfRangeError extends Error {}

async function getImage(url: string, signal?: AbortSignal): Promise<Buffer> {
  // Cap each attempt at HTTP_TIMEOUT, but also honour an outer deadline/abort
  // (the per-request budget from the live plugin path) so a slow upstream can
  // never hold a request longer than the caller allows.
  const perAttempt = AbortSignal.timeout(HTTP_TIMEOUT)
  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: signal ? AbortSignal.any([signal, perAttempt]) : perAttempt
  })
  const ctype = resp.headers.get('content-type') || ''
  const buf = Buffer.from(await resp.arrayBuffer())
  if (!resp.ok || !ctype.includes('image')) {
    // ArcGIS / GeoServer return a non-image (JSON/XML) error body on failure.
    const body = buf.toString('utf8')
    // GeoWebCache answers tiles outside a layer's TileMatrixSetLimits (e.g. the
    // world tiles a zoomed-out chart requests over BlueTopo's US-waters extent)
    // with HTTP 400 TileOutOfRange. That is a permanent "no coverage here", not
    // a transient failure — surface it distinctly so the caller negative-caches
    // it instead of retrying.
    if (resp.status === 400 && /TileOutOfRange/.test(body)) {
      throw new TileOutOfRangeError('tile outside gridset extent')
    }
    throw new Error(`HTTP ${resp.status} ${ctype}: ${body.slice(0, 160)}`)
  }
  return buf
}

async function tryFetch(
  url: string,
  label: string,
  signal?: AbortSignal
): Promise<FetchResult> {
  let lastErr: unknown
  for (let attempt = 0; attempt < HTTP_RETRIES; attempt++) {
    if (signal?.aborted) break
    try {
      const buf = await getImage(url, signal)
      return (await isFullyTransparent(buf))
        ? { status: 'empty' }
        : { status: 'data', body: buf }
    } catch (e) {
      // Out-of-range is a definitive answer: no coverage, no point retrying.
      if (e instanceof TileOutOfRangeError) return { status: 'empty' }
      lastErr = e
      if (signal?.aborted) break
      await delay(1000 + attempt * 1500, signal)
    }
  }
  if (!signal?.aborted) {
    // eslint-disable-next-line no-console
    console.error(`noaa-sonar: fetch ${label} failed: ${String(lastErr)}`)
  }
  return { status: 'error' }
}

/** ArcGIS ImageServer exportImage: render a single web-mercator tile (sizePx). */
export function fetchExportImage(
  serviceUrl: string,
  z: number,
  x: number,
  y: number,
  sizePx = 256,
  signal?: AbortSignal
): Promise<FetchResult> {
  const b = tileBBox3857(x, y, z)
  const url =
    `${serviceUrl.replace(/\/+$/, '')}/exportImage` +
    `?bbox=${b.minX},${b.minY},${b.maxX},${b.maxY}` +
    `&bboxSR=3857&imageSR=3857&size=${sizePx},${sizePx}` +
    `&format=png32&transparent=true&f=image`
  return tryFetch(url, `exportImage ${z}/${x}/${y}`, signal)
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
  row: number,
  signal?: AbortSignal
): Promise<FetchResult> {
  return tryFetch(
    wmtsTileUrl(base, layer, style, format, z, col, row),
    `wmts ${layer} ${z}/${col}/${row}`,
    signal
  )
}

/** Sleep `ms`, resolving early (not rejecting) if `signal` aborts first. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
