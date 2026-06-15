#!/usr/bin/env python3
"""Seed guard — runs daily in CI. If the SCDB seed in Supabase has dropped
below THRESHOLD rows (it mysteriously lost ~5k once), restore it from the
gzipped copy stored in two private GitHub secrets. Otherwise do nothing.

The seed never lives in the public repo (SCDB license) — only in encrypted
secrets and the owner's Supabase. Run locally with SEED_GZ_1/SEED_GZ_2 set.
"""
import os, json, gzip, base64, re, sys, time, urllib.request

THRESHOLD = 7000
ROOM = "__seed__"

b64 = os.environ.get("SEED_GZ_1", "") + os.environ.get("SEED_GZ_2", "")
if not b64:
    sys.exit("missing SEED_GZ_1/SEED_GZ_2 secrets")
seed = json.loads(gzip.decompress(base64.b64decode(b64)))
print(f"seed payload: {len(seed)} rows")

cfg = open("js/config.js", encoding="utf-8").read()
URL = re.search(r'SUPABASE_URL:\s*"([^"]+)"', cfg).group(1)
KEY = re.search(r'SUPABASE_ANON_KEY:\s*"([^"]+)"', cfg).group(1)
H = {"apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": "application/json"}


def count_live():
    req = urllib.request.Request(
        f"{URL}/rest/v1/cameras?room=eq.{ROOM}&deleted=eq.false&select=id",
        headers={**H, "Prefer": "count=exact", "Range": "0-0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return int(r.headers.get("content-range", "*/0").split("/")[-1])


def upsert(batch):
    rows = [{"id": f"s_{int(la * 1e5)}_{int(lo * 1e5)}", "room": ROOM,
             "lat": la, "lon": lo, "sp": sp, "dir": -1, "by": "SCDB", "deleted": False}
            for la, lo, sp in batch]
    req = urllib.request.Request(
        f"{URL}/rest/v1/cameras?on_conflict=id", data=json.dumps(rows).encode(), method="POST",
        headers={**H, "Prefer": "resolution=merge-duplicates,return=minimal"})
    urllib.request.urlopen(req, timeout=120).read()


n = count_live()
print(f"server live seed count: {n} (threshold {THRESHOLD})")
if n >= THRESHOLD:
    print("OK — seed intact, nothing to do.")
    sys.exit(0)

print(f"LOW — restoring {len(seed)} rows...")
for i in range(0, len(seed), 1000):
    upsert(seed[i:i + 1000])
    print(f"  restored {min(i + 1000, len(seed))}/{len(seed)}")
    time.sleep(0.3)
print(f"restored. new count: {count_live()}")
