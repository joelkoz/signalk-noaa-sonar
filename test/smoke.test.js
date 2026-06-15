/**
 * Smoke tests — no network, no native rendering. They exercise the registry's
 * "plugin loads / activates / exposes a schema" path and lock in the
 * minimum-serve-zoom behaviour, all offline:
 *
 *   - require() the built plugin (load check)
 *   - schema() returns an object with the documented properties (schema check)
 *   - start()/stop() run without throwing against a mock app (activate check)
 *   - the chart metadata advertises the zoom floor, and tile requests below it
 *     are answered 404 without ever touching the upstream or the cache.
 *
 * Run after a build (`pretest` runs tsc). Tiles at/above the floor are NOT
 * fetched here — that would require the network — so every assertion is
 * deterministic and offline.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const createPlugin = require('../plugin/index.js')
const { MIN_SERVE_ZOOM } = require('../plugin/charts.js')

function mockApp(dataDir) {
  const routes = new Map()
  let provider = null
  return {
    routes,
    getProvider: () => provider,
    // Plugin uses this to locate its data dir; pointing it at a temp dir keeps
    // the test self-contained.
    getDataDirPath: () => dataDir,
    config: { ssl: false, configPath: dataDir, version: 'test', getExternalPort: () => 3000 },
    get: (route, handler) => routes.set(route, handler),
    registerResourceProvider: (p) => {
      provider = p
    },
    setPluginStatus: () => {},
    setPluginError: () => {},
    debug: () => {},
    error: () => {}
  }
}

function mockRes() {
  const res = { statusCode: null, body: undefined, headers: {} }
  res.sendStatus = (c) => ((res.statusCode = c), res)
  res.status = (c) => ((res.statusCode = c), res)
  res.send = (b) => ((res.body = b), res)
  res.json = (o) => ((res.body = o), res)
  res.set = (k, v) => ((res.headers[k] = v), res)
  return res
}

// Create a valid (empty) land DB at <dataDir>/land.sqlite so start()'s
// background land-mask init finds it and skips the one-time coastline download
// — keeping the test offline. The schema only needs to satisfy the mask query's
// compilation; no rows are required.
function seedLandDb(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'land.sqlite'))
  db.exec(
    'CREATE TABLE land (id INTEGER PRIMARY KEY, coords BLOB);' +
      'CREATE TABLE land_rtree (id, minx, maxx, miny, maxy);'
  )
  db.close()
}

function withStartedPlugin(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noaa-sonar-test-'))
  seedLandDb(dataDir)
  const app = mockApp(dataDir)
  const plugin = createPlugin(app)
  plugin.start({})
  try {
    return fn(plugin, app)
  } finally {
    plugin.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

test('plugin loads and exposes the expected shape', () => {
  assert.equal(typeof createPlugin, 'function')
  const app = mockApp(fs.mkdtempSync(path.join(os.tmpdir(), 'noaa-sonar-load-')))
  const plugin = createPlugin(app)
  assert.equal(typeof plugin.id, 'string')
  assert.equal(typeof plugin.start, 'function')
  assert.equal(typeof plugin.stop, 'function')
})

test('schema() returns an object with the fetchOnMiss toggle', () => {
  const app = mockApp(fs.mkdtempSync(path.join(os.tmpdir(), 'noaa-sonar-schema-')))
  const plugin = createPlugin(app)
  const schema = plugin.schema()
  assert.equal(schema.type, 'object')
  assert.equal(schema.properties.fetchOnMiss.type, 'boolean')
})

test('start()/stop() run without throwing and register routes + provider', () => {
  withStartedPlugin((plugin, app) => {
    assert.ok(app.routes.size > 0, 'expected HTTP routes to be registered')
    assert.ok(app.getProvider(), 'expected a charts resource provider')
  })
})

test('chart metadata advertises the zoom floor', async () => {
  await withStartedPlugin(async (plugin, app) => {
    const charts = await app.getProvider().methods.listResources()
    const ids = Object.keys(charts)
    assert.ok(ids.length >= 1)
    for (const id of ids) {
      assert.equal(charts[id].minzoom, MIN_SERVE_ZOOM, `${id} should advertise the floor`)
    }
  })
})

test('tile requests below the zoom floor are 404 (no upstream, no cache)', async () => {
  await withStartedPlugin(async (plugin, app) => {
    const tileRoute = [...app.routes.keys()].find((r) => r.includes('chart-tiles'))
    assert.ok(tileRoute, 'tile route should be registered')
    const handler = app.routes.get(tileRoute)
    const res = mockRes()
    await handler(
      { params: { identifier: '_ns01-noaa-sonar', z: '3', x: '1', y: '1' } },
      res
    )
    assert.equal(res.statusCode, 404)
  })
})

test('unknown chart id is 404', async () => {
  await withStartedPlugin(async (plugin, app) => {
    const tileRoute = [...app.routes.keys()].find((r) => r.includes('chart-tiles'))
    const handler = app.routes.get(tileRoute)
    const res = mockRes()
    await handler({ params: { identifier: 'does-not-exist', z: '10', x: '1', y: '1' } }, res)
    assert.equal(res.statusCode, 404)
  })
})
