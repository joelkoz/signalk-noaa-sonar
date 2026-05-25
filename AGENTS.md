# AGENTS.md

Guidance for AI agents (and humans) working on **signalk-noaa-sonar**. Read this
before changing code. For install/config/usage see [README.md](README.md); this
covers *how it works* and the invariants not to break. Note that the README.md is end user facing, so keep only usage instructions there. Development notes should be added to this AGENTS.md

## What this app is

A Signal K chart-provider plugin that serves three NOAA underwater-relief charts
to Freeboard-SK as a **caching proxy**: serve from an MBTiles cache; on a miss,
fetch the tile from NOAA, (optionally) mask out land, cache it, serve it.

It is intentionally **purpose-built, not generic**: the three sources are
hard-coded and there is essentially one user setting (`fetchOnMiss`).

## The three charts (src/charts.ts)

| id | name | source kind | mask | opacity | tiles |
|---|---|---|---|---|---|
| `_ns01-noaa-sonar` | NOAA Hi-Res Relief | `exportimage` (ArcGIS ImageServer) | no | 0.75 | 256px direct |
| `_ns02-bluetopo-relief` | BlueTopo Relief | `wmts` (GeoServer GWC) | yes | 0.50 | 512px native → 4×256 |
| `_ns03-bluetopo-bathymetry` | BlueTopo Depth Color | `wmts` (GeoServer GWC) | yes | 0.30 | 512px native → 4×256 |

**Ids & cache names:** ids carry an `_nsNN-` prefix purely to set Freeboard's
default stacking order (users never see ids; the prefix drives the tile URL and
resource-map key). `cacheBaseName(id)` strips the prefix for the `.mbtiles`
filename, so caches are `noaa-sonar.mbtiles`, `bluetopo-relief.mbtiles`,
`bluetopo-bathymetry.mbtiles` (stable across id renames). Renaming an id is safe
for caches but changes the Freeboard chart identity.

**Baked opacity:** each chart's `opacity` (0..1) is multiplied into the tile's
alpha before caching (`alphaBakeOp` — a sharp `dest-in` composite against a
uniform alpha=factor source; RGB untouched). Equivalent to setting that layer's
opacity in Freeboard, so users leave Freeboard layer opacity at 100% and the
three layers stack sensibly. Defaults live in `charts.ts` and are also exposed in
the plugin config (`opacity.<baseName>`, resolved by `opacityFor()`); config
overrides the default. It's baked into the cache, so a change only affects
tiles fetched afterward — clear that chart's cache to re-bake. The bulk tool
applies the same factor (`--opacity`, default 0.75).

## Layout

| Path | Role |
|---|---|
| `src/index.ts` | Plugin entry: chart/route/provider registration, request dispatch, opacity resolution. |
| `src/produce.ts` | **Shared producers** (`produceTile`): fetch + mask + opacity + retile + cache. Used by the plugin (per request) **and** the bulk tool. |
| `src/charts.ts` | Hard-coded `ChartDef[]` + `cacheBaseName()`. |
| `src/source.ts` | Upstream fetch: `fetchExportImage`, `fetchWmts`, `isFullyTransparent` (all via `sharp`). |
| `src/cache.ts` | `TileCache`: native `node:sqlite` read/write of one chart's `.mbtiles` + `.progress` (incl. `dataTilesAt` for the bulk walk). |
| `src/landmask.ts` | `LandMask`: query land R*Tree, emit an SVG of land in pixel space. |
| `src/landbuild.ts` | One-time builder: download OSM land polygons → `land.sqlite` R*Tree. |
| `src/tiles.ts` | XYZ↔EPSG:3857 math, XYZ↔TMS row flip. |
| `src/validate.ts` | Tile-coordinate validation. |
| `tools/noaa-sonar-to-mbtiles.js` | Bulk pre-fill for any/all charts via the shared producer (quadtree, resumable). Exposed as the **`noaa-sonar-charts`** bin. |
| `tools/build-land-db.js` | Standalone land.sqlite builder. |
| `plugin/` | TS build output (gitignored; shipped in the npm tarball via `files`). |

## Chart-provider contract (Signal K / Freeboard)

- v2: `app.registerResourceProvider({ type:'charts', methods })` — `listResources`
  returns all three; `getResource(id)` one; set/delete reject.
- v1: routes `GET /signalk/v1/api/resources/charts[/:id]`.
- Each chart is `type:'tilelayer'`, `format:'png'`, with a `{z}/{x}/{y}` URL
  template (`url` for v2 / `tilemapUrl` for v1) →
  `GET /signalk/noaa-sonar/chart-tiles/:identifier/:z/:x/:y`.
- Advertised `bounds` are worldwide (the cache may grow anywhere); per-tile 404s
  mark the gaps.
- Data dir = `app.getDataDirPath()` when available, otherwise fallback to
  `<config>/plugin-config-data/<pluginId>` (pluginId
  `noaa-sonar-chart-provider`); caches go in `<dataDir>/charts/`, land data in
  `<dataDir>/land.sqlite`. This is outside `<config>/charts` on purpose: the
  generic `@signalk/charts-plugin` scans `<config>/charts` and would publish the
  same chart ids with `/signalk/chart-tiles/...`, making Freeboard hit the wrong
  endpoint. The bulk tool can't call `getDataDirPath()` (no `app`), so it
  reconstructs the same path for its `--dir` default (override with `--dir`).

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

## Development & build

From source (for development):

```bash
git clone https://github.com/joelkoz/signalk-noaa-sonar-charts
cd signalk-noaa-sonar-charts
npm install        # builds via the `prepare` hook (tsc -> plugin/)
npm link
cd ~/.signalk && npm link signalk-noaa-sonar-charts
```

- Build: `npm run build` (or `npm install` → `prepare` runs `tsc`).
- Pre-build the land DB (so an end user on a slow link can skip the large
  first-run download), then copy it across:
  ```bash
  npm run build
  node tools/build-land-db.js land.sqlite
  # copy land.sqlite to <signalk-config>/noaa-sonar-data/
  ```
- **Bulk tool walk** (`tools/noaa-sonar-to-mbtiles.js`): BFS by served zoom over
  the bbox, calling the shared `produceTile`. Base level = bbox tile range; deeper
  levels = children (in cache) of the previous level's `dataTilesAt`, so empty
  ocean is pruned. For wmts charts it collapses each level's candidates to one
  representative per parent 512 (`x>>1,y>>1`) — since one parent fetch caches all
  four children — avoiding redundant fetches. `cache.isVisited` makes it
  resumable. Uses `chart.opacity` (the plugin's config override doesn't apply
  here). Selectors resolve `+/-{all,hi,relief,color}` left-to-right (default
  `+all`).
- No bundled runner; behavior was validated with fake-`app` harnesses covering:
  mask alignment (synthetic land polygon erases exactly the right pixels), 3-chart
  metadata, sonar fetch (256, unmasked), BlueTopo retile+mask+sibling-caching,
  negative caching, cache-only mode, and the bulk tool filling all three caches.
  Recreate that style of check after changes to request handling or tile math.

## Native dependencies & the App Store

- Minimum runtime is **Node >= 22.5.0** because SQLite access uses Node's native
  synchronous `node:sqlite` API. All SQLite access goes through `src/db.ts` /
  `openDatabase()` so this remains the single choke point.
- The Signal K AppStore installs plugins with `npm install --ignore-scripts`
  (signalk-server `src/modules.ts`). Avoid dependencies that need install or
  postinstall scripts for runtime correctness.
- `sharp` is fine: it ships prebuilt binaries as optional dependencies
  (`@img/sharp-*`), which need no install script.

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
