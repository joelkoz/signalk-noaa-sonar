import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'

export type DatabaseHandle = DatabaseSync
export type StatementHandle = StatementSync

export interface OpenDatabaseOptions {
  readonly?: boolean
}

export function openDatabase(
  file: string,
  opts: OpenDatabaseOptions = {}
): DatabaseHandle {
  return new DatabaseSync(file, { readOnly: opts.readonly })
}
