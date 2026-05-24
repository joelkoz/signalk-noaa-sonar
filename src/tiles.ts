/**
 * Web-mercator (EPSG:3857) XYZ tile math. Mirrors the Python bulk tool
 * (tools/noaa_sonar_to_mbtiles.py) exactly so both writers agree on tile
 * geometry and on the XYZ<->TMS row convention used by the MBTiles cache.
 */

export const TILE_SIZE = 256

// Half the circumference of the earth at the equator, in EPSG:3857 meters.
const WEBMERC_ORIGIN = Math.PI * 6378137.0
const MAX_LAT = 85.05112878

export interface BBox3857 {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** WGS84 lon/lat -> XYZ tile (x, y) at the given zoom. */
export function lonLatToTile(
  lon: number,
  lat: number,
  z: number
): { x: number; y: number } {
  const n = 1 << z
  const clampedLat = Math.max(Math.min(lat, MAX_LAT), -MAX_LAT)
  let x = Math.floor(((lon + 180) / 360) * n)
  let y = Math.floor(
    ((1 - Math.asinh(Math.tan((clampedLat * Math.PI) / 180)) / Math.PI) / 2) * n
  )
  x = Math.min(Math.max(x, 0), n - 1)
  y = Math.min(Math.max(y, 0), n - 1)
  return { x, y }
}

/** EPSG:3857 bounding box (meters) of an XYZ tile. */
export function tileBBox3857(x: number, y: number, z: number): BBox3857 {
  const n = 1 << z
  const span = (2 * WEBMERC_ORIGIN) / n
  const minX = -WEBMERC_ORIGIN + x * span
  const maxY = WEBMERC_ORIGIN - y * span
  return { minX, minY: maxY - span, maxX: minX + span, maxY }
}

/**
 * Convert between the XYZ row (y, origin top-left) that Freeboard/Leaflet use
 * and the TMS row (origin bottom-left) that the MBTiles spec stores. The
 * transform is its own inverse.
 */
export function flipRow(y: number, z: number): number {
  return (1 << z) - 1 - y
}
