# signalk-noaa-sonar

On-demand **NOAA bathymetric sonar (hillshade) chart provider** for
[Signal K](https://signalk.org/) and Freeboard-SK.

It serves raster chart tiles to Freeboard from a local **MBTiles cache**. On a
cache miss — when online — it renders the missing tile on the fly from NOAA's
ArcGIS ImageServer (`bag_hillshades_subsets`) using the `exportImage` endpoint,
stores it in the cache, and serves it. The result:

- **Works offline** from whatever is already cached.
- **The cache grows as you use it** — pan/zoom over an area and those tiles are
  fetched once and kept.
- A companion **bulk tool** can pre-render a whole region in advance (e.g. while
  on a fast connection).

### Why this exists

NOAA's original `bag_hillshades` *tiled* service (a simple `/tile/{z}/{y}/{x}`
cache) was retired. The same bathymetry now lives in an **ImageServer with no
tile cache** — only the dynamic `exportImage` operation. This plugin bridges
that gap by rendering standard web-mercator XYZ tiles from `exportImage` and
caching them in the familiar MBTiles format.

## Features

- Registers as a Signal K `charts` resource provider (both v1 and v2 APIs).
- Tile endpoint: `GET /signalk/noaa-sonar/chart-tiles/noaa-sonar/{z}/{x}/{y}`.
- MBTiles (SQLite) cache, shared with the bulk builder.
- **Fetch-on-miss** toggle — turn it off for cellular / fully-offline use.
- **Negative caching** of empty (no-survey-data) tiles so they aren't re-fetched.
- Transparent PNGs (`png32`), so the bathymetry overlays cleanly on a base map.

## Requirements

- Node.js >= 18 (uses global `fetch`).
- A C toolchain for `better-sqlite3`'s native build (prebuilt binaries cover most
  platforms).
- Signal K server with Freeboard-SK v2+.

## Install

From source (development):

```bash
cd signalk-noaa-sonar
npm install        # builds via the `prepare` hook (tsc -> plugin/)
npm link

cd ~/.signalk      # your Signal K configuration directory
npm link signalk-noaa-sonar
```

Restart Signal K, then open **Server → Plugin Config → "NOAA Sonar Chart
Provider"** and enable it. The **NOAA Sonar** chart then appears in Freeboard's
chart list.

## Configuration

| Setting | Default | Notes |
|---|---|---|
| MBTiles cache file | `<config>/charts/noaa-sonar.mbtiles` | Absolute, or relative to the SK config dir. Created if missing. |
| Render missing tiles (fetch-on-miss) | `true` | Turn **off** for cellular/offline (serve cached only). |
| NOAA ImageServer URL | `bag_hillshades_subsets` ImageServer | Change only if NOAA moves the service again. |
| Min / Max zoom | `1` / `18` | Native survey resolution is ~0.5 m, ≈ zoom 18. |
| Bounds (W/S/E/N) | *(blank = worldwide)* | Set to constrain the chart to your cruising area and avoid empty open-ocean fetches. |

## Bulk pre-rendering (optional)

`tools/noaa-sonar-to-mbtiles.js` fills the same MBTiles cache for a chosen
bounding box, using a quadtree walk that skips empty ocean. It is **resumable**
and **additive** — run it repeatedly (wider area, deeper zoom) into the same
file.

```bash
node tools/noaa-sonar-to-mbtiles.js \
  --out noaa-sonar.mbtiles \
  --bbox -82.0 24.4 -80.05 25.6 \
  --min-zoom 10 --max-zoom 18
```

Run it from the package root so it can use the bundled `better-sqlite3` and
`pngjs` (no extra dependencies). Point the plugin's "MBTiles cache file" at the
resulting file. `--help` lists all options.

## Offline distribution (optional)

The cache is plain MBTiles, so you can convert a finished file to
[PMTiles](https://github.com/protomaps/go-pmtiles) and serve it read-only with
[signalk-pmtiles-plugin](https://github.com/panaaj/signalk-pmtiles-plugin) if you
prefer a single portable archive.

## Data source & attribution

Bathymetry imagery is served by NOAA NCEI:
`https://gis.ngdc.noaa.gov/arcgis/rest/services/bag_hillshades_subsets/ImageServer`.
NOAA data is in the public domain. **This is not for navigation.**

## License

Apache-2.0

See [AGENTS.md](AGENTS.md) for architecture and implementation details.
