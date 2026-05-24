/**
 * Validates XYZ tile coordinates supplied on the HTTP tile route. Zoom may
 * legitimately be 0 (clients ask for the world tile when framing the initial
 * view); x/y must fit the 2^z grid for that zoom.
 */

const MIN_Z = 0
const MAX_Z = 24

export function validateTileCoords(
  z: number,
  x: number,
  y: number
): string | undefined {
  if (!Number.isInteger(z) || z < MIN_Z || z > MAX_Z) {
    return `Invalid zoom ${z} (must be an integer in [${MIN_Z}, ${MAX_Z}])`
  }
  const n = 2 ** z
  if (!Number.isInteger(x) || x < 0 || x >= n) {
    return `Invalid x ${x} at zoom ${z} (must be an integer in [0, ${n}))`
  }
  if (!Number.isInteger(y) || y < 0 || y >= n) {
    return `Invalid y ${y} at zoom ${z} (must be an integer in [0, ${n}))`
  }
  return undefined
}
