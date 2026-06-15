/**
 * Tile producers — the fetch + (mask) + (opacity) + cache logic shared by the
 * plugin (per request, in index.ts) and the bulk pre-fill tool
 * (tools/noaa-sonar-to-mbtiles.js). Keeping this in one place guarantees the two
 * agree on tile geometry, the data-only cache invariant, and the masked/opacity
 * output.
 *
 *  - exportImage charts: one 256px tile per (z,x,y).
 *  - wmts charts: fetch the parent 512px tile (z-1, x>>1, y>>1), mask + bake
 *    opacity, split into the four native-resolution 256px children at z, and
 *    cache all four (one upstream fetch fills a quadrant).
 *
 * `produceTile` returns the requested tile's PNG, or null if it is empty (no
 * data). It throws on an upstream error so the caller can decide (retry / 502).
 */

import sharp from 'sharp'
import { ChartDef, MASK_MIN_ZOOM } from './charts'
import { TileCache } from './cache'
import { LandMask } from './landmask'
import { fetchExportImage, fetchWmts, isFullyTransparent } from './source'
import { tileBBox3857 } from './tiles'

const WMTS_NATIVE_PX = 512 // BlueTopo gridset tile size
const OUT_PX = 256 // we always emit 256px XYZ tiles

/** sharp op that multiplies alpha by `factor` (0..1), leaving RGB untouched. */
export function alphaBakeOp(factor: number, size: number): sharp.OverlayOptions {
  return {
    input: {
      create: {
        width: size,
        height: size,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: factor }
      }
    },
    blend: 'dest-in'
  }
}

/** The four XYZ children (at z+1) of a tile, given the parent's col/row. */
export function childrenOf(pcol: number, prow: number): Array<[number, number]> {
  return [
    [pcol * 2, prow * 2],
    [pcol * 2 + 1, prow * 2],
    [pcol * 2, prow * 2 + 1],
    [pcol * 2 + 1, prow * 2 + 1]
  ]
}

async function produceExport(
  chart: ChartDef,
  cache: TileCache,
  z: number,
  x: number,
  y: number,
  opacity: number,
  signal?: AbortSignal
): Promise<Buffer | null> {
  if (chart.source.kind !== 'exportimage') return null
  const res = await fetchExportImage(chart.source.serviceUrl, z, x, y, OUT_PX, signal)
  if (res.status === 'error') throw new Error('upstream error')
  if (res.status === 'empty' || !res.body) {
    cache.markEmpty(z, x, y)
    return null
  }
  let body = res.body
  if (opacity < 1) {
    body = await sharp(res.body)
      .ensureAlpha()
      .composite([alphaBakeOp(opacity, OUT_PX)])
      .png()
      .toBuffer()
  }
  cache.putData(z, x, y, body)
  return body
}

async function produceWmts(
  chart: ChartDef,
  cache: TileCache,
  landMask: LandMask | null,
  z: number,
  x: number,
  y: number,
  opacity: number,
  signal?: AbortSignal
): Promise<Buffer | null> {
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
    prow,
    signal
  )
  if (res.status === 'error') throw new Error('upstream error')
  if (res.status === 'empty' || !res.body) {
    for (const [cx, cy] of childrenOf(pcol, prow)) cache.markEmpty(z, cx, cy)
    return null
  }

  // Mask land out of the 512 and bake in the layer opacity before splitting.
  // Skip masking below MASK_MIN_ZOOM: the parent-tile bbox is large enough there
  // that the coastline SVG overruns libvips' XML limit, and the detail isn't
  // visible at that scale anyway.
  const composites: sharp.OverlayOptions[] = []
  if (chart.mask && landMask?.ready && z >= MASK_MIN_ZOOM) {
    const svg = landMask.maskSvg(tileBBox3857(pcol, prow, pz), WMTS_NATIVE_PX)
    if (svg) composites.push({ input: svg, blend: 'dest-out' })
  }
  if (opacity < 1) composites.push(alphaBakeOp(opacity, WMTS_NATIVE_PX))
  let img = res.body
  if (composites.length) {
    img = await sharp(res.body).ensureAlpha().composite(composites).png().toBuffer()
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

/**
 * Fetch + process + cache the tile (z,x,y) for a chart, baking in `opacity`.
 * For wmts charts this also caches the requested tile's three siblings.
 */
export function produceTile(
  chart: ChartDef,
  cache: TileCache,
  landMask: LandMask | null,
  z: number,
  x: number,
  y: number,
  opacity: number,
  signal?: AbortSignal
): Promise<Buffer | null> {
  return chart.source.kind === 'wmts'
    ? produceWmts(chart, cache, landMask, z, x, y, opacity, signal)
    : produceExport(chart, cache, z, x, y, opacity, signal)
}
