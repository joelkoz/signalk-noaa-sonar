# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Stop the charts (and the Signal K server) from locking up when BlueTopo or the
  NOAA hi-res relief layer is viewed zoomed out. Three low-zoom failure modes
  were compounding: BlueTopo's WMTS gridset only covers US waters, so world
  tiles returned `HTTP 400 TileOutOfRange` that were retried as transient errors
  (~18s per tile before a 502); the land-mask SVG grew past libvips' XML parse
  limit (`XML_PARSE_HUGE`); and the NOAA BAG ImageServer takes 8–13s to render a
  low-zoom world bbox. `TileOutOfRange` is now treated as "no coverage" (cached,
  not retried), and the layers are no longer requested at zooms where they add no
  usable detail (see below).

### Added
- On-demand tile fetches now have a 4-second time budget. If a tile can't be
  produced in time (slow or failing upstream), the request returns as if the
  tile is simply absent — without permanently marking it missing — and the
  plugin drops into cache-only ("offline") mode for 30 seconds before trying the
  upstream again, so a struggling provider can't stall the chart. Offline mode
  is also entered on any upstream error, not just timeouts.

### Changed
- Hard-code a minimum serve zoom of **8** for all charts (advertised in the
  chart metadata, so clients stop requesting lower zooms, and enforced
  server-side as a guard). Below z8 the upstreams add no usable detail and
  misbehave.
- Skip land masking below zoom **12**. The mask only matters once coastline
  detail is visible, and at low zoom its coastline SVG overran libvips' parser.
  BlueTopo over land is nodata/transparent, so the unmasked low-zoom view is
  unaffected visually. The bulk pre-fill tool shares this logic and so behaves
  consistently.

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
