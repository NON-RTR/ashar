#!/usr/bin/env python3
"""Fetch Saudi speed-camera locations from OpenStreetMap (Overpass) into data/cameras.json.

Usage:
  python3 scripts/fetch_cameras.py            # fetch fresh from Overpass
  python3 scripts/fetch_cameras.py --raw F    # process an already-downloaded Overpass JSON

Data license: © OpenStreetMap contributors, ODbL. Keep the attribution in the app.
"""
import json, math, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "cameras.json"

QUERY = """
[out:json][timeout:180];
area["ISO3166-1"="SA"][admin_level=2]->.sa;
(
  node["highway"="speed_camera"](area.sa);
  relation["type"="enforcement"](area.sa);
);
out body;
>;
out skel qt;
"""

MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

CARDINALS = {"N":0,"NNE":22,"NE":45,"ENE":67,"E":90,"ESE":112,"SE":135,"SSE":157,
             "S":180,"SSW":202,"SW":225,"WSW":247,"W":270,"WNW":292,"NW":315,"NNW":337}


def fetch_raw():
    body = urllib.parse.urlencode({"data": QUERY}).encode()
    for url in MIRRORS:
        try:
            req = urllib.request.Request(url, data=body, headers={
                "User-Agent": "ashar-saher-app/1.0 (personal, faris)"})
            with urllib.request.urlopen(req, timeout=200) as r:
                return json.load(r)
        except Exception as e:
            print(f"mirror failed {url}: {e}", file=sys.stderr)
            time.sleep(10)
    raise SystemExit("all Overpass mirrors failed")


def parse_maxspeed(v):
    if not v:
        return 0
    for tok in str(v).replace(";", " ").replace(",", " ").split():
        if tok.isdigit():
            n = int(tok)
            if 20 <= n <= 160:
                return n
    return 0


def parse_direction(v):
    if v is None:
        return -1
    s = str(v).strip().upper()
    if s in CARDINALS:
        return CARDINALS[s]
    try:
        # may be "45" or "45-90" or "45;225" — take the first number
        first = s.replace("-", " ").replace(";", " ").split()[0]
        return int(float(first)) % 360
    except (ValueError, IndexError):
        return -1


def dist_m(a, b):
    R = 6371000
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = math.radians(b[0] - a[0])
    dl = math.radians(b[1] - a[1])
    x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(x))


def main():
    if len(sys.argv) > 2 and sys.argv[1] == "--raw":
        raw = json.load(open(sys.argv[2]))
    else:
        raw = fetch_raw()

    els = raw["elements"]
    nodes = {e["id"]: e for e in els if e["type"] == "node"}
    rels = [e for e in els if e["type"] == "relation"]

    cands = []  # (lat, lon, sp, dir, prio) prio: tagged maxspeed first
    for n in nodes.values():
        t = n.get("tags", {})
        if t.get("highway") == "speed_camera":
            cands.append((n["lat"], n["lon"], parse_maxspeed(t.get("maxspeed")),
                          parse_direction(t.get("direction"))))
    for r in rels:
        rt = r.get("tags", {})
        if rt.get("enforcement") not in ("maxspeed", None):
            continue
        sp = parse_maxspeed(rt.get("maxspeed"))
        for m in r.get("members", []):
            if m["type"] == "node" and m.get("role") == "device" and m["ref"] in nodes:
                n = nodes[m["ref"]]
                nt = n.get("tags", {})
                cands.append((n["lat"], n["lon"],
                              parse_maxspeed(nt.get("maxspeed")) or sp,
                              parse_direction(nt.get("direction"))))

    # dedupe within 40 m, prefer entries that know their maxspeed.
    # Merging is conservative: conflicting directions (e.g. one camera per
    # carriageway on a gantry) collapse to "both directions" so no approach
    # is left unalerted; a known maxspeed survives over an unknown one.
    cands.sort(key=lambda c: (c[2] == 0,))
    kept = []
    for c in cands:
        dup = next((k for k in kept if dist_m(c, k) < 40), None)
        if dup is not None:
            sp = dup[2] or c[2]
            d1, d2 = dup[3], c[3]
            diff = abs(d1 - d2) % 360
            same_dir = d1 != -1 and d2 != -1 and min(diff, 360 - diff) <= 60
            dr = d1 if same_dir else -1
            kept[kept.index(dup)] = (dup[0], dup[1], sp, dr)
            continue
        kept.append(c)

    cams = [[round(c[0], 5), round(c[1], 5), c[2], c[3]] for c in kept]
    cams.sort(key=lambda c: (c[0], c[1]))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "meta": {
            "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
            "source": "OpenStreetMap contributors (ODbL)",
            "count": len(cams),
        },
        "cams": cams,
    }, ensure_ascii=False, separators=(",", ":")))
    print(f"wrote {OUT} with {len(cams)} cameras "
          f"({sum(1 for c in cams if c[2])} with speed limit)")


if __name__ == "__main__":
    main()
