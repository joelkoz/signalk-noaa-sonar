# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.2] - 2026-06-09

### Fixed
- Lazy-load the `sharp`-based tile renderer so the plugin loads, exposes its
  configuration schema, and starts even on hosts where `sharp`'s native binary
  cannot be loaded (for example the sandboxed
  [signalk-plugin-registry](https://github.com/dirkwa/signalk-plugin-registry)
  CI, which runs plugin code under `firejail --net=none`). `sharp` is now
  required only when a tile actually has to be rendered on a cache miss; serving
  already-cached tiles and starting the plugin no longer touch the native
  binary. Rendering behaviour is unchanged.

### Added
- Declare `signalk.screenshots` so the Signal K app store can display a plugin
  screenshot (shipped under `docs/screenshots/`). README images now load from
  absolute GitHub URLs, so the README renders on npm and GitHub without the
  images bloating the published package.
- This changelog.

## [1.1.1]

### Added
- README: document the geographic coverage area of the BlueTopo charts and add a
  screenshot.

## [1.1.0]

### Changed
- Use the built-in `node:sqlite` module for the MBTiles cache instead of
  `better-sqlite3`, removing the native-module install/build dependency.
  Requires Node.js >= 22.5.0.

### Fixed
- Handle Signal K server versions that do not expose the plugin data-directory
  API by falling back to `<configPath>/plugin-config-data/<pluginId>`.

## [1.0.0]

### Added
- Initial public release: on-demand NOAA high-resolution sonar chart provider
  for Signal K / Freeboard, serving XYZ tiles backed by an MBTiles cache.
- BlueTopo relief/bathymetry charts with land masking (three hard-coded charts).
- Bulk MBTiles pre-fill tool (`noaa-sonar-charts`), implemented in pure Node.
- Per-chart cache files to avoid collisions with the charts plugin cache.
