/**
 * Fault-tolerant loader for better-sqlite3.
 *
 * The Signal K AppStore installs plugins with `npm install --ignore-scripts`
 * (see signalk-server src/modules.ts), which skips better-sqlite3's native build
 * step. The JS package is then present but its `.node` binary is missing, so
 * `require('better-sqlite3')` throws. We load it lazily and catch that, so the
 * plugin can report a friendly "not installed" status instead of crashing —
 * the user just runs `npm install better-sqlite3` in the package dir and
 * restarts. (sharp is unaffected: it ships prebuilt binaries as optional deps.)
 */

import path from 'path'
import type Database from 'better-sqlite3'

type DatabaseCtor = typeof Database

let ctor: DatabaseCtor | null = null
let loadError: string | null = null
let attempted = false

function tryLoad(): void {
  if (attempted) return
  attempted = true
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ctor = require('better-sqlite3') as DatabaseCtor
  } catch (e) {
    loadError = (e as Error).message
  }
}

export function sqliteAvailable(): boolean {
  tryLoad()
  return ctor !== null
}

export function sqliteLoadError(): string | null {
  tryLoad()
  return loadError
}

/** Absolute path to this package's root (used in install instructions). */
export function packageRoot(): string {
  return path.resolve(__dirname, '..')
}

export function openDatabase(
  file: string,
  opts?: Database.Options
): Database.Database {
  tryLoad()
  if (!ctor) {
    throw new Error(`better-sqlite3 is not available: ${loadError}`)
  }
  return new ctor(file, opts)
}
