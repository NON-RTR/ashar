# أسهَر (As-har) — Saher Camera Warning PWA — Design

**Date:** 2026-06-11 · **Status:** Built same-session (autonomous mode — user driving, decisions documented for review)

## Goal
Radarbot-style speed-camera warning app for Saudi Arabia, focused on Faris's Jeddah–Yanbu route. One missed camera = hundreds of SAR in fines. Must warn early, audibly, in Arabic.

## Data reality (verified 2026-06-11)
- OSM Overpass: **349** `highway=speed_camera` nodes + **82** enforcement-relation devices SA-wide (~431 after merge). 253 have `maxspeed`.
- **Jeddah–Yanbu highway proper: 0 cameras in OSM.** All 30 corridor hits are inside Jeddah city. KAUST cluster = campus CCTV, not Saher.
- No free/legal public dataset exists (SCDB/gps-data-team are paid/proprietary; Waze not exportable). Decision: do NOT fabricate coordinates.

## Decisions
| Topic | Choice | Why |
|---|---|---|
| Platform | Static PWA (vanilla JS + vendored Leaflet 1.9.4) | No Android SDK locally; testable via preview/Playwright; installable; offline-capable |
| Base data | OSM merge (dedupe <40 m, prefer maxspeed-tagged) via `scripts/fetch_cameras.py` → `data/cameras.json` | Only legal bundleable source |
| Route gap | First-class one-tap **«كاميرا هنا»** button (records pos+heading), localStorage, export/import JSON + GPX/CSV import for third-party packs | First trip builds his route DB; both-direction option |
| Alerts | Time-based stages ~25 s / ~10 s (clamped 350–1400 m / 150–600 m), ahead = |Δbearing| ≤ 50°, camera `direction` respected ±75°, re-arm >1.6 km/behind. Min speed 25 km/h | Fixed meters fail at 140 km/h vs 60 km/h |
| Audio | WebAudio beeps + Arabic TTS (speechSynthesis), unlocked by «ابدأ الرحلة» gesture; mute toggle | iOS autoplay rules |
| UI | Dark RTL HUD: huge speed (red when over next cam limit), Saudi-sign limit badge, distance countdown, map (CARTO dark / OSM fallback), bottom sheet list + settings, demo mode | Night driving legibility |
| Keep-awake | Wake Lock API + re-acquire on visibilitychange | GPS dies if screen locks |
| Hosting | Local only. Phone use needs HTTPS → deferred, user must ask (no-deploy rule) | Geolocation = secure context only |

## Architecture
```
index.html  manifest.webmanifest  sw.js (precache shell+data, runtime tile cache cap)
css/app.css
js/geo.js    pure math: haversine, bearing, angDiff, maxspeed/direction parsing
js/audio.js  beeps (WebAudio) + TTS queue
js/app.js    state, map, GPS watch, alert engine, UI, demo mode, import/export
data/cameras.json  {meta, cams:[[lat,lon,sp,dir],…]}
scripts/fetch_cameras.py  reproducible Overpass refresh
```

## Testing
Demo mode (`?demo=1`) simulates a drive through Jeddah cameras at highway speed — used for automated verification (console events `ASHAR_ALERT`) + screenshots. Real-pointer click checks (elementFromPoint) per overlay-hit-test lesson.

## Deferred (logged to vault)
HTTPS deploy for phone · community sync (Supabase) · native wrapper · average-speed segments · mobile-camera reporting · scheduled OSM refresh.
