# signalk-noaa-sonar

A Signal K chart provider for high resolution underwater relief charts around the
United States. It registers three chart layers and serves their tiles from local
MBTiles caches, rendering any missing tile on demand from NOAA and saving it. So
the charts **work offline** from whatever's cached, and the cache **grows as you
use it**.

| Chart | Source | Land masked? |
|---|---|---|
| **NOAA Sonar** | NOAA NCEI BAG hillshade (ArcGIS ImageServer `exportImage`) | no |
| **BlueTopo Relief** | NOAA BlueTopo hillshade (GeoServer WMTS) | **yes** |
| **BlueTopo Bathymetry** | NOAA BlueTopo colorized depth (GeoServer WMTS) | **yes** |

The two BlueTopo layers are **land-masked**: land is made transparent so it
doesn't cover the land features of your base chart. Stack them in Freeboard at
whatever opacities you like (e.g. relief under bathymetry) — over water you see
the seafloor; over land your base chart shows through.

### Why this exists

NOAA's original `bag_hillshades` tile cache was retired; that data now comes from
an ImageServer with no tile cache (rendered per tile via `exportImage`). BlueTopo
is a WMTS tile cache but covers land, which obscures other charts. This plugin
bridges both and adds the land mask.

## Design goals

Purpose-built, **not** a generic chart-cache server. The three sources are
hard-coded — there's essentially **one setting** (online fetch on/off). Less to
configure, easier for a non-technical user.

## Requirements

- Node.js ≥ 18 (uses global `fetch`).
- Native modules `better-sqlite3` and `sharp` (prebuilt binaries cover Pi/arm64,
  Linux, macOS).
- Signal K server with Freeboard-SK v2+.

## Install

```bash
cd signalk-noaa-sonar
npm install        # builds via the `prepare` hook (tsc -> plugin/)
npm link
cd ~/.signalk
npm link signalk-noaa-sonar
```

Restart Signal K → **Server → Plugin Config → "NOAA Sonar Chart Provider"** →
enable. The three charts then appear in Freeboard's chart list.

## Configuration

| Setting | Default | Notes |
|---|---|---|
| Download missing tiles when online | `true` | Turn **off** for cellular/offline (serve only cached tiles). |

Caches live in `<signalk-config>/noaa-sonar-data/charts/<chart-id>.mbtiles`.
Keeping them outside `<signalk-config>/charts` avoids having the generic Signal K
charts plugin publish the same chart identifiers with its static tile route.

## Land data (one-time)

Masking needs a coastline dataset. On first run the plugin **auto-downloads** OSM
land polygons and builds `<signalk-config>/noaa-sonar-data/land.sqlite` (a large
one-time download). Until it's ready, BlueTopo tiles are served unmasked. To
pre-build it on a faster machine and copy it over:

```bash
npm run build
node tools/build-land-db.js land.sqlite
# copy land.sqlite to <signalk-config>/noaa-sonar-data/ on the Pi
```

## Bulk pre-rendering (optional, NOAA Sonar)

`tools/noaa-sonar-to-mbtiles.js` fills the **NOAA Sonar** cache for a bounding
box, using a quadtree that skips empty ocean. Resumable and additive.

```bash
node tools/noaa-sonar-to-mbtiles.js \
  --out ~/.signalk/noaa-sonar-data/charts/noaa-sonar.mbtiles \
  --bbox -82.0 24.4 -80.05 25.6 --min-zoom 10 --max-zoom 18
```

## Offline distribution (optional)

The caches are plain MBTiles, so you can convert one to
[PMTiles](https://github.com/protomaps/go-pmtiles) for a portable read-only
archive if you wish.

## Data sources & attribution

- NOAA NCEI bathymetric sonar (BAG hillshade subsets).
- NOAA Office of Coast Survey **BlueTopo** via nowCOAST WMTS.
- Coastline: OpenStreetMap land polygons (© OpenStreetMap contributors, ODbL).

NOAA data is public domain. **Not for navigation.**

## License

Apache-2.0 — see [AGENTS.md](AGENTS.md) for architecture and implementation
details.
