# AGENTS.md

Guidance for AI agents (and humans) working on **signalk-noaa-sonar**. Read this
before changing code. For install/config/usage see [README.md](README.md); this
covers *how it works* and the invariants not to break.

## What this app is

A Signal K chart-provider plugin that serves three NOAA underwater-relief charts
to Freeboard-SK as a **caching proxy**: serve from an MBTiles cache; on a miss,
fetch the tile from NOAA, (optionally) mask out land, cache it, serve it.

It is intentionally **purpose-built, not generic**: the three sources are
hard-coded and there is essentially one user setting (`fetchOnMiss`).

## The three charts (src/charts.ts)

| id | source kind | mask | tiles |
|---|---|---|---|
| `noaa-sonar` | `exportimage` (ArcGIS ImageServer) | no | 256px direct |
| `bluetopo-relief` | `wmts` (GeoServer GWC) | yes | 512px native → 4×256 |
| `bluetopo-bathymetry` | `wmts` (GeoServer GWC) | yes | 512px native → 4×256 |

## Layout

| Path | Role |
|---|---|
| `src/index.ts` | Plugin entry: chart/route/provider registration, per-miss producers, dispatch. |
| `src/charts.ts` | Hard-coded `ChartDef[]` (URLs, layers, mask flag, zoom ranges). |
| `src/source.ts` | Upstream fetch: `fetchExportImage`, `fetchWmts`, `isFullyTransparent` (all via `sharp`). |
| `src/cache.ts` | `TileCache`: better-sqlite3 read/write of one chart's `.mbtiles` + `.progress`. |
| `src/landmask.ts` | `LandMask`: query land R*Tree, emit an SVG of land in pixel space. |
| `src/landbuild.ts` | One-time builder: download OSM land polygons → `land.sqlite` R*Tree. |
| `src/tiles.ts` | XYZ↔EPSG:3857 math, XYZ↔TMS row flip. |
| `src/validate.ts` | Tile-coordinate validation. |
| `tools/noaa-sonar-to-mbtiles.js` | Bulk pre-fill for the sonar chart (quadtree, resumable). |
| `tools/build-land-db.js` | Standalone land.sqlite builder. |
| `plugin/` | TS build output (gitignored). |

## Chart-provider contract (Signal K / Freeboard)

- v2: `app.registerResourceProvider({ type:'charts', methods })` — `listResources`
  returns all three; `getResource(id)` one; set/delete reject.
- v1: routes `GET /signalk/v1/api/resources/charts[/:id]`.
- Each chart is `type:'tilelayer'`, `format:'png'`, with a `{z}/{x}/{y}` URL
  template (`url` for v2 / `tilemapUrl` for v1) →
  `GET /signalk/noaa-sonar/chart-tiles/:identifier/:z/:x/:y`.
- Advertised `bounds` are worldwide (the cache may grow anywhere); per-tile 404s
  mark the gaps.
- Keep this plugin's live MBTiles caches outside `<config>/charts`. The generic
  `@signalk/charts-plugin` scans that directory and can publish the same chart
  identifiers with `/signalk/chart-tiles/...`, causing Freeboard to request the
  wrong endpoint.

## Tile request flow (per chart)

1. Validate `z/x/y`. Cache **hit** (in `tiles`) → serve.
2. **Known-empty** (in `.progress` `visited`, not in `tiles`) → 404, no refetch.
3. `fetchOnMiss` off → 404.
4. Miss → producer:
   - **exportImage**: fetch one 256px tile; empty → `markEmpty`; else store+serve.
   - **wmts**: fetch the **parent 512px** tile `(z-1, x>>1, y>>1)`; mask land
     (if ready); split into the **four 256px children** at `z`; store/`markEmpty`
     each; serve the requested one. One upstream fetch fills all four siblings.

## Invariants — DO NOT BREAK

1. **`tiles` = data only; `.progress` `visited` = every resolved tile** (data or
   empty), keyed XYZ. This is shared with `tools/noaa-sonar-to-mbtiles.js`, whose
   quadtree treats "present in `tiles`" as "has data, descend." Never store a
   fully-transparent tile in `tiles` (that includes land-masked-to-empty tiles —
   they are `markEmpty` only).
2. **Row convention**: `tiles` stores TMS rows (`flipRow = 2^z-1-y`); `visited`
   uses XYZ `y`. Keep both tools consistent.
3. **Tile geometry must match** between `src/tiles.ts` and
   `tools/noaa-sonar-to-mbtiles.js` (verified by exact bbox comparison).
4. **All output tiles are 256px.** BlueTopo's native gridset is 512px with the
   *same* tile indexing as XYZ (2^z tiles/side), so its level `z` 512px tile is
   split into the four XYZ-256 children at `z+1` — preserving native detail under
   the standard 256 assumption. Don't emit mixed tile sizes.

## Land masking

- **Data**: OSM "land polygons", **split** (small pieces, so per-tile we touch
  few/short polygons) and in **EPSG:3857** (our tile CRS — no reprojection).
  `landbuild.ts` downloads + stores each exterior ring as a packed Float64 blob
  in `land(id, coords)`, indexed by `land_rtree(id, minx,maxx,miny,maxy)`.
- **Apply**: `LandMask.maskSvg(tileBBox3857, sizePx)` bbox-queries the R*Tree,
  projects ring coords to pixels, returns an SVG (land filled white) or `null`
  (no land). `index.ts` composites it with `sharp` blend **`dest-out`** → land
  becomes transparent. Masking is done at 512 **before** the 4-way split.
- **Async/ready**: the land DB builds in the background on first run; until
  `landMask.ready`, BlueTopo tiles are served **unmasked** (acceptable; they get
  re-masked once tiles are re-requested after a cache miss — note already-cached
  unmasked tiles won't be re-masked, so ideally let the DB finish before heavy
  browsing, or pre-build with `tools/build-land-db.js`).

## Performance (measured on a Pi 5, per 512px tile)

decode+encode ≈ 12 ms · +mask ≈ 23–34 ms · +retile to 4×256 ≈ 42 ms. Paid once
per tile, then it's a pure cache hit. Network fetch dominates first-view latency.

## Build & test

- Build: `npm run build` (or `npm install` → `prepare` runs `tsc`).
- No bundled runner; behavior was validated with fake-`app` harnesses covering:
  mask alignment (synthetic land polygon erases exactly the right pixels), 3-chart
  metadata, sonar fetch (256, unmasked), BlueTopo retile+mask+sibling-caching,
  negative caching, and cache-only mode. Recreate that style of check after
  changes to request handling or tile math.

## Native dependencies & the App Store

- The Signal K AppStore installs plugins with `npm install --ignore-scripts`
  (signalk-server `src/modules.ts`). That skips dependency build/postinstall
  scripts. Consequences:
  - **`sharp`** is fine: it ships prebuilt binaries as optional dependencies
    (`@img/sharp-*`), which need no install script.
  - **`better-sqlite3`** is NOT fine: its native `.node` binary is fetched by an
    `install` script, which `--ignore-scripts` skips → the module is present but
    fails to `require`.
- `src/db.ts` loads better-sqlite3 **lazily** and catches that failure. When it's
  unavailable the plugin does not crash: `start()` calls `setPluginError(...)`,
  the config schema's top line shows `❌ better-sqlite3 is NOT installed …` with
  the fix (`npm install better-sqlite3` in the package dir), and no charts are
  registered. When available, the line shows `✅`. All SQLite access goes through
  `openDatabase()` so this is the single choke point.
- This keeps broad Node support (no `node:sqlite` requirement). If you ever want
  zero-native-deps + AppStore-clean out of the box, `node:sqlite` (Node ≥ 23.4,
  R*Tree verified) is the migration path — but it raises the minimum Node.

## Extending / caution

- New WMTS-style chart: add a `ChartDef` with a `wmts` source. ImageServer with a
  real tile cache → prefer that over `exportImage`.
- Don't add a PMTiles **write** path — PMTiles is write-once; keep MBTiles as the
  live cache and convert offline if needed.
- Keep it purpose-built; resist turning it into a configurable generic proxy
  (cache files get large, and config is what we deliberately removed).

## Safety

Not for navigation. Tile coords are integer-validated and used only as SQLite
bind params and numeric bbox math — no path/string injection. All upstream URLs
are hard-coded.
