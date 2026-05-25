/**
 * Land masking. Reads the land.sqlite R*Tree built by landbuild.ts, and for a
 * given tile produces an SVG of the land polygons in pixel space. The caller
 * composites that over the tile with blend 'dest-out', erasing land to
 * transparent so the underlying chart shows through.
 *
 * Querying is a fast bbox lookup that touches only the few small polygons near
 * the tile, so masking stays cheap on a Pi.
 */

import fs from 'fs'
import { DatabaseHandle, StatementHandle, openDatabase } from './db'
import { BBox3857 } from './tiles'

export class LandMask {
  private db: DatabaseHandle | null = null
  private q: StatementHandle | null = null
  ready = false

  constructor(private dbPath: string) {}

  exists(): boolean {
    return fs.existsSync(this.dbPath)
  }

  open(): void {
    this.db = openDatabase(this.dbPath, { readonly: true })
    this.db.exec('PRAGMA query_only = true')
    // polygon bbox intersects tile bbox
    this.q = this.db.prepare(
      'SELECT l.coords AS c FROM land_rtree r JOIN land l ON l.id = r.id ' +
        'WHERE r.minx <= ? AND r.maxx >= ? AND r.miny <= ? AND r.maxy >= ?'
    )
    this.ready = true
  }

  /**
   * SVG (sizePx square) with land filled white, for use as a dest-out mask.
   * Returns null when no land touches the tile (nothing to erase).
   */
  maskSvg(bbox: BBox3857, sizePx: number): Buffer | null {
    if (!this.q) return null
    const rows = this.q.all(
      bbox.maxX,
      bbox.minX,
      bbox.maxY,
      bbox.minY
    ) as Array<{ c: Uint8Array }>
    if (rows.length === 0) return null

    const sx = sizePx / (bbox.maxX - bbox.minX)
    const sy = sizePx / (bbox.maxY - bbox.minY)
    let d = ''
    for (const row of rows) {
      const b = row.c
      const f = new Float64Array(
        b.buffer,
        b.byteOffset,
        b.byteLength / 8
      )
      for (let i = 0; i < f.length; i += 2) {
        const px = (f[i] - bbox.minX) * sx
        const py = (bbox.maxY - f[i + 1]) * sy // 3857 y is up; pixel y is down
        d += (i === 0 ? 'M' : 'L') + px.toFixed(1) + ' ' + py.toFixed(1) + ' '
      }
      d += 'Z '
    }
    return Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}">` +
        `<path d="${d}" fill="#ffffff" fill-rule="nonzero"/></svg>`
    )
  }

  close(): void {
    this.db?.close()
    this.db = null
    this.ready = false
  }
}
