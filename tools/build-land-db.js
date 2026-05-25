#!/usr/bin/env node
/*
 * Standalone builder for the land-mask database (land.sqlite).
 *
 * The plugin builds this automatically on first run, but you can pre-build it
 * here (e.g. on a fast machine, then copy land.sqlite to the Pi at
 * <signalk-config>/noaa-sonar-data/land.sqlite).
 *
 * Usage:
 *   npm run build            # compile TS -> plugin/
 *   node tools/build-land-db.js [outPath]
 *
 * Default outPath: ./land.sqlite
 */
const path = require('path')
const { buildLandDb } = require('../plugin/landbuild.js')

const out = path.resolve(process.argv[2] || 'land.sqlite')
buildLandDb(out, (m) => console.log(m))
  .then(() => console.log(`Done -> ${out}`))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
