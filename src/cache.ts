/**
 * MBTiles read/write cache backed by better-sqlite3, sharing one file (and one
 * `.progress` sidecar) with the Python bulk tool. The two agree on conventions:
 *
 *   - `tiles(zoom_level, tile_column, tile_row, tile_data)` holds DATA tiles
 *     only; `tile_row` is a TMS row (origin bottom-left) per the MBTiles spec.
 *   - `<file>.progress` `visited(z, x, y)` records every tile that has been
 *     resolved -- whether it had data or was empty -- keyed by XYZ coordinates.
 *
 * So a tile is: served if in `tiles`; known-empty if in `visited` but not in
 * `tiles`; otherwise unknown (fetch it).
 */

import type Database from 'better-sqlite3'
import { openDatabase } from './db'
import { flipRow } from './tiles'

export class TileCache {
  private db: Database.Database
  private progress: Database.Database

  private selTile: Database.Statement
  private selVisited: Database.Statement
  private insTile: Database.Statement
  private insVisited: Database.Statement

  constructor(mbtilesPath: string) {
    this.db = openDatabase(mbtilesPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS metadata (name text, value text);
       CREATE UNIQUE INDEX IF NOT EXISTS name ON metadata (name);
       CREATE TABLE IF NOT EXISTS tiles (zoom_level integer, tile_column integer,
         tile_row integer, tile_data blob);
       CREATE UNIQUE INDEX IF NOT EXISTS tile_index
         ON tiles (zoom_level, tile_column, tile_row);`
    )

    this.progress = openDatabase(mbtilesPath + '.progress')
    this.progress.pragma('journal_mode = WAL')
    this.progress.pragma('synchronous = NORMAL')
    this.progress.exec(
      `CREATE TABLE IF NOT EXISTS visited
         (z int, x int, y int, PRIMARY KEY (z, x, y));`
    )

    this.selTile = this.db.prepare(
      'SELECT tile_data AS d FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?'
    )
    this.insTile = this.db.prepare(
      'INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)'
    )
    this.selVisited = this.progress.prepare(
      'SELECT 1 AS hit FROM visited WHERE z=? AND x=? AND y=?'
    )
    this.insVisited = this.progress.prepare(
      'INSERT OR IGNORE INTO visited (z, x, y) VALUES (?, ?, ?)'
    )
  }

  /** Cached DATA tile for XYZ (z, x, y), or null. */
  getTile(z: number, x: number, y: number): Buffer | null {
    const row = this.selTile.get(z, x, flipRow(y, z)) as { d: Buffer } | undefined
    return row ? row.d : null
  }

  /** True if this tile was already resolved (data or empty). */
  isVisited(z: number, x: number, y: number): boolean {
    return this.selVisited.get(z, x, y) !== undefined
  }

  /** Store a DATA tile and mark it resolved. */
  putData(z: number, x: number, y: number, body: Buffer): void {
    this.insTile.run(z, x, flipRow(y, z), body)
    this.insVisited.run(z, x, y)
  }

  /** Record that this tile is empty (no survey data) without storing a blob. */
  markEmpty(z: number, x: number, y: number): void {
    this.insVisited.run(z, x, y)
  }

  close(): void {
    this.db.close()
    this.progress.close()
  }
}
