#!/usr/bin/env python3
"""
noaa_sonar_to_mbtiles.py

Build an MBTiles overlay of NOAA bathymetric "hillshade" sonar imagery for a
geographic area, sourced from the NOAA NGDC ArcGIS ImageServer.

This is the spiritual successor to org.map4j.utils.NOAASonarToMBTiles (Java).
The original pulled pre-rendered tiles from the NOAA `bag_hillshades` ArcGIS
*tile cache* at /tile/{z}/{row}/{col}. That service has been retired. The data
now lives in `bag_hillshades_subsets`, an ImageServer that exposes NO tile cache
-- only the dynamic `exportImage` endpoint. So instead of fetching cached tiles,
we render each web-mercator (XYZ) tile on demand:

    exportImage?bbox=<tile bbox in EPSG:3857>&bboxSR=3857&imageSR=3857
               &size=256,256&format=png32&transparent=true&f=image

Survey coverage is sparse -- narrow multibeam swaths separated by large nodata
gaps. Naively fetching every tile in the bounding box at zoom 18 would mean
hundreds of thousands of requests for empty ocean. Instead we walk a QUADTREE:
fetch a tile, and only descend into its four children if the tile contained any
data (any non-transparent pixel). A fully transparent tile prunes its entire
subtree. Because a child's geographic extent is wholly contained in its parent's,
this is lossless: no data tile can hide under an empty parent.

Progress is recorded in a sidecar SQLite file (<out>.progress) so the job is
fully resumable -- re-running picks up where it left off and never re-downloads a
tile it already resolved.

Default configuration targets the Florida Keys reef tract, from the southern edge
of the existing "South Florida" file down to Satan Shoal (west of Key West).
"""

import argparse
import io
import math
import sqlite3
import sys
import threading
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

from PIL import Image

# --- Defaults --------------------------------------------------------------
# The cache file is generic (a single growing NOAA-sonar cache shared with the
# Signal K proxy plugin); the default *bbox* is the Florida Keys reef tract,
# but any --bbox can be appended into the same file over time.
DEFAULT_SERVICE = ("https://gis.ngdc.noaa.gov/arcgis/rest/services/"
                   "bag_hillshades_subsets/ImageServer")
DEFAULT_OUT = "noaa-sonar.mbtiles"
DEFAULT_NAME = "noaa-sonar"
DEFAULT_DESCRIPTION = "NOAA bathymetric sonar (hillshade)"
# west, south, east, north  (WGS84). South/east edge of the original South
# Florida file (~25.6N, -80.05W) down to Satan Shoal (~24.41N, -81.97W).
DEFAULT_BBOX = (-82.00, 24.40, -80.05, 25.60)
DEFAULT_MIN_ZOOM = 10
DEFAULT_MAX_ZOOM = 18           # ~0.5 m/px at this latitude == native survey res
TILE_SIZE = 256                 # matches map4j MapProjections.Merc256

WEBMERC_ORIGIN = math.pi * 6378137.0   # half-circumference, EPSG:3857 (meters)

USER_AGENT = "map4j-noaa-sonar/1.0 (mbtiles builder)"
HTTP_TIMEOUT = 60
HTTP_RETRIES = 4


# --- Web-mercator XYZ tile math --------------------------------------------
def lonlat_to_tile(lon, lat, z):
    n = 1 << z
    x = int((lon + 180.0) / 360.0 * n)
    lat = max(min(lat, 85.05112878), -85.05112878)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    x = min(max(x, 0), n - 1)
    y = min(max(y, 0), n - 1)
    return x, y


def tile_bbox_3857(x, y, z):
    n = 1 << z
    span = 2.0 * WEBMERC_ORIGIN / n
    minx = -WEBMERC_ORIGIN + x * span
    maxy = WEBMERC_ORIGIN - y * span
    return minx, maxy - span, minx + span, maxy


def bbox_tile_range(bbox, z):
    """Inclusive XYZ tile range (x0,y0,x1,y1) covering a WGS84 bbox at zoom z."""
    west, south, east, north = bbox
    x0, y0 = lonlat_to_tile(west, north, z)   # NW corner -> min x, min y
    x1, y1 = lonlat_to_tile(east, south, z)   # SE corner -> max x, max y
    return min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)


# --- MBTiles output ---------------------------------------------------------
class MBTiles:
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS metadata "
                        "(name text, value text)")
        self.db.execute("CREATE UNIQUE INDEX IF NOT EXISTS name "
                        "ON metadata (name)")
        self.db.execute("CREATE TABLE IF NOT EXISTS tiles "
                        "(zoom_level integer, tile_column integer, "
                        " tile_row integer, tile_data blob)")
        self.db.execute("CREATE UNIQUE INDEX IF NOT EXISTS tile_index "
                        "ON tiles (zoom_level, tile_column, tile_row)")
        self.db.commit()

    def set_metadata(self, name, value):
        self.db.execute("INSERT OR REPLACE INTO metadata (name, value) "
                        "VALUES (?, ?)", (name, str(value)))

    def get_metadata(self, name):
        row = self.db.execute("SELECT value FROM metadata WHERE name=?",
                              (name,)).fetchone()
        return row[0] if row else None

    def add_tile(self, z, x, y, data):
        tms_row = (1 << z) - 1 - y          # XYZ -> TMS row, as map4j stores
        self.db.execute("INSERT OR REPLACE INTO tiles "
                        "(zoom_level, tile_column, tile_row, tile_data) "
                        "VALUES (?, ?, ?, ?)", (z, x, tms_row, data))

    def data_tiles_at(self, z):
        """XYZ (x, y) of every tile already stored at zoom z."""
        out = []
        for col, tms in self.db.execute(
                "SELECT tile_column, tile_row FROM tiles WHERE zoom_level=?",
                (z,)):
            out.append((col, (1 << z) - 1 - tms))
        return out

    def zoom_levels(self):
        return [r[0] for r in self.db.execute(
            "SELECT DISTINCT zoom_level FROM tiles ORDER BY zoom_level")]

    def commit(self):
        self.db.commit()

    def close(self):
        self.db.commit()
        self.db.close()


# --- Resumable progress (sidecar) ------------------------------------------
class Progress:
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS visited "
                        "(z int, x int, y int, PRIMARY KEY (z, x, y))")
        self.db.commit()

    def visited_at(self, z):
        return {(x, y) for x, y in
                self.db.execute("SELECT x, y FROM visited WHERE z=?", (z,))}

    def mark(self, z, x, y):
        self.db.execute("INSERT OR IGNORE INTO visited (z, x, y) "
                        "VALUES (?, ?, ?)", (z, x, y))

    def commit(self):
        self.db.commit()

    def close(self):
        self.db.commit()
        self.db.close()


# --- Tile fetching ----------------------------------------------------------
DATA, EMPTY, ERROR = "data", "empty", "error"


def fetch_tile(service, z, x, y):
    """Return (status, png_bytes_or_None). status in {DATA, EMPTY, ERROR}."""
    minx, miny, maxx, maxy = tile_bbox_3857(x, y, z)
    url = (f"{service}/exportImage?bbox={minx},{miny},{maxx},{maxy}"
           f"&bboxSR=3857&imageSR=3857&size={TILE_SIZE},{TILE_SIZE}"
           f"&format=png32&transparent=true&f=image")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    last_err = None
    for attempt in range(HTTP_RETRIES):
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                ctype = resp.headers.get("Content-Type", "")
                body = resp.read()
            if "image" not in ctype:
                # ArcGIS returns JSON on error even with f=image
                last_err = f"non-image response ({ctype}): {body[:160]!r}"
                raise ValueError(last_err)
            img = Image.open(io.BytesIO(body)).convert("RGBA")
            if img.getchannel("A").getextrema()[1] == 0:
                return EMPTY, None          # fully transparent -> no survey data
            return DATA, body
        except Exception as e:                # noqa: BLE001  (retry anything)
            last_err = e
            time.sleep(1.0 + attempt * 1.5)
    sys.stderr.write(f"  ! tile {z}/{x}/{y} failed: {last_err}\n")
    return ERROR, None


# --- Driver -----------------------------------------------------------------
def build(args):
    mbt = MBTiles(args.out)
    prog = Progress(args.out + ".progress")

    mbt.set_metadata("name", args.name)
    mbt.set_metadata("description", args.description)
    mbt.set_metadata("type", "overlay")
    mbt.set_metadata("version", "1")
    mbt.set_metadata("format", "png")
    # Accumulate bounds: this file is a shared, growing cache, so union the new
    # bbox with whatever the file already covered rather than clobbering it.
    w, s, e, n = args.bbox
    prev = mbt.get_metadata("bounds")
    if prev:
        try:
            pw, ps, pe, pn = (float(v) for v in prev.split(","))
            w, s, e, n = min(w, pw), min(s, ps), max(e, pe), max(n, pn)
        except ValueError:
            pass
    mbt.set_metadata("bounds", f"{w},{s},{e},{n}")
    mbt.set_metadata("center", f"{(w + e) / 2},{(s + n) / 2},{args.min_zoom}")
    mbt.commit()

    write_lock = threading.Lock()
    totals = {DATA: 0, EMPTY: 0, ERROR: 0}

    for z in range(args.min_zoom, args.max_zoom + 1):
        # Candidate tiles at this zoom.
        if z == args.min_zoom:
            x0, y0, x1, y1 = bbox_tile_range(args.bbox, z)
            candidates = [(x, y) for x in range(x0, x1 + 1)
                          for y in range(y0, y1 + 1)]
        else:
            # children of every tile that had data one level up, clipped to bbox
            cx0, cy0, cx1, cy1 = bbox_tile_range(args.bbox, z)
            seen = set()
            candidates = []
            for px, py in mbt.data_tiles_at(z - 1):
                for x in (px * 2, px * 2 + 1):
                    for y in (py * 2, py * 2 + 1):
                        if cx0 <= x <= cx1 and cy0 <= y <= cy1 and \
                                (x, y) not in seen:
                            seen.add((x, y))
                            candidates.append((x, y))

        visited = prog.visited_at(z)
        todo = [(x, y) for (x, y) in candidates if (x, y) not in visited]
        t_data = t_empty = t_err = 0
        start = time.time()
        print(f"[z{z}] {len(todo)} tiles to fetch "
              f"({len(candidates) - len(todo)} already done)", flush=True)

        if todo:
            with ThreadPoolExecutor(max_workers=args.workers) as ex:
                futs = {ex.submit(fetch_tile, args.service, z, x, y): (x, y)
                        for (x, y) in todo}
                done = 0
                for fut in as_completed(futs):
                    x, y = futs[fut]
                    status, body = fut.result()
                    with write_lock:
                        if status == DATA:
                            mbt.add_tile(z, x, y, body)
                            prog.mark(z, x, y)
                            t_data += 1
                        elif status == EMPTY:
                            prog.mark(z, x, y)
                            t_empty += 1
                        else:
                            t_err += 1            # leave unmarked -> retried
                        done += 1
                        if done % 200 == 0:
                            mbt.commit()
                            prog.commit()
                            rate = done / max(time.time() - start, 1e-6)
                            print(f"  z{z}: {done}/{len(todo)} "
                                  f"(data={t_data} empty={t_empty} err={t_err}) "
                                  f"{rate:.1f}/s", flush=True)
            mbt.commit()
            prog.commit()

        totals[DATA] += t_data
        totals[EMPTY] += t_empty
        totals[ERROR] += t_err
        print(f"[z{z}] done: data={t_data} empty={t_empty} err={t_err} "
              f"in {time.time() - start:.0f}s", flush=True)
        if t_err:
            print(f"[z{z}] WARNING: {t_err} tiles errored; re-run to retry.",
                  flush=True)

    levels = mbt.zoom_levels()
    if levels:
        mbt.set_metadata("minzoom", min(levels))
        mbt.set_metadata("maxzoom", max(levels))
    mbt.close()
    prog.close()
    print(f"\nTotal: data={totals[DATA]} empty={totals[EMPTY]} "
          f"err={totals[ERROR]}. Zoom levels present: {levels}")


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--service", default=DEFAULT_SERVICE)
    p.add_argument("--out", default=DEFAULT_OUT)
    p.add_argument("--name", default=DEFAULT_NAME)
    p.add_argument("--description", default=DEFAULT_DESCRIPTION)
    p.add_argument("--bbox", type=float, nargs=4,
                   metavar=("W", "S", "E", "N"), default=list(DEFAULT_BBOX),
                   help="WGS84 bounding box: west south east north")
    p.add_argument("--min-zoom", type=int, default=DEFAULT_MIN_ZOOM)
    p.add_argument("--max-zoom", type=int, default=DEFAULT_MAX_ZOOM)
    p.add_argument("--workers", type=int, default=8)
    args = p.parse_args()
    args.bbox = tuple(args.bbox)
    print(f"Building {args.out}  bbox={args.bbox}  "
          f"zoom {args.min_zoom}-{args.max_zoom}  workers={args.workers}")
    build(args)


if __name__ == "__main__":
    main()
