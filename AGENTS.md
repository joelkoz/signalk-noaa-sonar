# AGENTS.md

Guidance for AI agents (and humans) working on **signalk-noaa-sonar**. Read this
before making changes. For install/config/usage, see [README.md](README.md);
this file covers *how it works* and *why*, plus the invariants you must not break.

## What this app is

A Signal K server plugin that acts as a **chart provider** for Freeboard-SK,
serving NOAA bathymetric "hillshade" raster tiles. It is a **caching proxy**:

```
Freeboard ──GET {z}/{x}/{y}──▶ plugin tile route
                                  │ hit  → serve PNG from MBTiles
                                  │ empty→ 404 (negative-cached)
                                  │ miss → NOAA exportImage → store → serve
                                  ▼
                         noaa-sonar.mbtiles  (SQLite)  +  .progress (sidecar)
                                  ▲
                         tools/noaa_sonar_to_mbtiles.py  (optional bulk pre-fill)
```

The NOAA source is an **ArcGIS ImageServer with no tile cache**. We synthesize
XYZ tiles by calling `exportImage` with the tile's web-mercator bounding box.

## Layout

| Path | Role |
|---|---|
| `src/index.ts` | Plugin entry: config schema, route + resource-provider registration, tile request handler. |
| `src/cache.ts` | `TileCache` — better-sqlite3 read/write of the MBTiles file and the `.progress` sidecar. |
| `src/source.ts` | `NoaaSource` — builds the `exportImage` URL, fetches, classifies data/empty/error. |
| `src/tiles.ts` | XYZ ⇄ EPSG:3857 math and the XYZ ⇄ TMS row flip. |
| `src/validate.ts` | Tile-coordinate validation for the HTTP route. |
| `tools/noaa-sonar-to-mbtiles.js` | Standalone Node bulk builder (quadtree, resumable). |
| `plugin/` | TypeScript build output (gitignored; produced by `tsc` / `npm run build`). |

## The chart-provider contract (Signal K / Freeboard)

- **v2**: `app.registerResourceProvider({ type: 'charts', methods: {...} })`.
  `listResources()` returns `{ [id]: chart }`; `getResource(id)` returns one;
  `setResource`/`deleteResource` reject (read-only provider).
- **v1**: plain routes `GET /signalk/v1/api/resources/charts[/:id]`.
- A chart object is `type: 'tilelayer'` with `format: 'png'`, `bounds`,
  `minzoom`, `maxzoom`, and a **tile URL template**:
  - v2 field `url`, v1 field `tilemapUrl`, both = `…/chart-tiles/<id>/{z}/{x}/{y}`.
- Freeboard expands `{z}/{x}/{y}` (XYZ, y from the top) and hits our route.

This mirrors `@signalk/charts-plugin` (which serves MBTiles over a `{z}/{x}/{y}`
route) more than `signalk-pmtiles-plugin` (which serves the whole `.pmtiles` file
for client-side range reads). The latter was the original reference but does not
fit on-demand fetching.

## Core invariants — DO NOT BREAK

1. **Two files, two meanings, shared with the bulk tool.**
   - `noaa-sonar.mbtiles` table `tiles(zoom_level, tile_column, tile_row,
     tile_data)` holds **DATA tiles only** (never a fully-transparent tile).
   - `noaa-sonar.mbtiles.progress` table `visited(z, x, y)` records **every tile
     that has been resolved**, data *or* empty.
   - Therefore a tile is: **served** if in `tiles`; **known-empty → 404** if in
     `visited` but not `tiles`; **unknown → fetch** otherwise.
   - *Why it matters:* the bulk tool walks a quadtree and treats "present
     in `tiles`" as "has data, descend into children." If the plugin ever stored
     a transparent tile in `tiles`, a later bulk run would recurse into empty
     ocean and explode the tile count. Hence `source.ts` checks the alpha channel
     and the plugin calls `markEmpty()` (visited-only) for transparent results.

2. **Row convention.** MBTiles stores **TMS** rows (origin bottom-left); XYZ/
   Freeboard use top-left. `tiles.ts#flipRow` converts (`2^z - 1 - y`). `tiles`
   is keyed by TMS row; `visited` is keyed by **XYZ** `y` (matching the bulk
   tool). Keep these consistent across both tools.

3. **Tile geometry must match the bulk tool exactly.** Both writers must agree
   on each tile's bbox or they'd cache misaligned imagery. `src/tiles.ts` and
   `tools/noaa-sonar-to-mbtiles.js` use identical math; verified by an exact
   bbox comparison. If you change one, change both and re-verify.

## Implementation notes / gotchas

- **exportImage params:** `bbox=<3857>&bboxSR=3857&imageSR=3857&size=256,256&`
  `format=png32&transparent=true&f=image`. `png32` (not `png`) is required to get
  an **RGBA** image so no-data areas are truly transparent.
- **ArcGIS error responses:** even with `f=image`, failures return a JSON body.
  `source.ts` checks `content-type` includes `image` and HTTP ok; otherwise it
  treats the response as an error and retries. An `error` result is **not**
  marked visited, so it will be retried on a later request.
- **Empty detection:** decode with `pngjs` and scan the alpha bytes; all-zero ⇒
  empty. 256×256 is cheap.
- **Route registration once:** routes are registered with `app.get(...)` a single
  time per process (guarded), since SK calls `stop()`/`start()` on config change
  without re-creating the plugin. Handlers read the latest `cache`/`props` via
  closure.
- **better-sqlite3 is synchronous** — fine on the request path (lookups are
  microseconds) and simpler than async SQLite. WAL mode is enabled.
- **Bounds default = worldwide.** The provider advertises where it is *willing to
  fetch*, not what is cached, so the cache can grow anywhere. Constrain via config
  to limit empty open-ocean fetches.

## Build, test, verify

- Build: `npm run build` (or `npm install`, which runs `tsc` via `prepare`).
- There is no bundled test runner. The behavior was verified with a fake-`app`
  harness that drives the compiled plugin through: chart metadata, cache-hit,
  fetch-on-miss (data + empty + negative cache), and cache-only mode. If you
  change request handling, re-create that style of check (construct a fake
  `app` with `get`/`registerResourceProvider`/`config`, call `plugin.start`,
  invoke the route handler with mock `req`/`res`).
- After any change to tile math, re-verify parity with `tools/`:
  identical `(x, y)` and bbox for the same lon/lat/zoom.

## Extending

- **Different NOAA layer / another ImageServer:** change `serviceUrl` (config) —
  any ArcGIS ImageServer supporting `exportImage` works. If it has a real tile
  cache, prefer that endpoint instead of `exportImage`.
- **Multiple charts:** today there is one chart id (`noaa-sonar`). To support
  several, key providers/caches by id and generalize the route's `:identifier`
  handling (it currently must equal the single id).
- **Don't add a PMTiles write path.** PMTiles is write-once/read-optimized; it is
  unsuitable as a live, incrementally-written cache. Keep MBTiles as the cache
  and convert to PMTiles offline if a portable archive is wanted.

## Safety

Not for navigation. Tile coordinates are integer-validated and used only as
SQLite bind parameters and numeric bbox math (no path building, no string
interpolation into queries or URLs beyond numbers), so the route is not a path-
traversal or injection vector. `serviceUrl` is admin-configured (trusted).
