import { haversine, bearing, angDiff, destPoint, fmtDist, clamp } from "./geo.js";
import { Sounder } from "./audio.js";
import { syncEnabled, genRoom, pullCameras, pushCamera, pushMany, removeCamera } from "./sync.js";

const VERSION = "1.2.0";
const CORRIDOR = { latMin: 21.2, latMax: 24.35, lonMin: 37.6, lonMax: 39.5 }; // جدة–ينبع
const MIN_ALERT_KMH = 25;
const OVER_MARGIN = 4;     // km/h grace before "you're speeding"
const OVER_BIG = 12;       // km/h over → urgent
const LIMIT_PRESETS = [80, 100, 120, 140];
const SEED_ROOM = "__seed__"; // shared reference DB (e.g. SCDB), pulled once + cached
const SEED_VERSION = "scdb-2026-06"; // bump to force every device to re-pull the seed

// ---------- state ----------
const S = {
  cams: [],            // {id,lat,lon,sp,dir,src,heading?}
  fix: null,           // {lat,lon,acc,kmh,heading,ts}
  derived: null,       // last point used to derive heading
  follow: true,
  alerted: {},         // id -> {stage, prevDist, overAt}
  activeId: null,
  demo: null,
  limit: 120,          // active road speed limit (km/h) — the safety baseline
  over: false,         // currently exceeding the active limit
  overAt: 0,           // last overspeed sound time
  smoothKmh: 0,        // EMA-smoothed speed (kills GPS jitter)
  overlayOn: false,    // native floating bubble currently shown
  trip: null,          // accumulates the drive for the end-of-trip safety report
  removed: loadRemoved(), // ids reported "gone" — never shown again
  room: localStorage.getItem("ashar.room") || "", // family sync code (empty = solo)
  poll: null,
  settings: { sound: true, voice: true, strictDir: false, limit: 120, safety: true },
};
window.__ASHAR = { version: VERSION, alerts: [], fixes: 0 };

const $ = (id) => document.getElementById(id);
const snd = new Sounder();

// ---------- settings ----------
try { Object.assign(S.settings, JSON.parse(localStorage.getItem("ashar.settings.v1") || "{}")); } catch {}
function saveSettings() { localStorage.setItem("ashar.settings.v1", JSON.stringify(S.settings)); }

// ---------- cameras ----------
function loadUserCams() {
  try { return JSON.parse(localStorage.getItem("ashar.usercams.v1") || "[]"); } catch { return []; }
}
function saveUserCams() {
  // seed (SCDB) is cached separately under "ashar.seed"; never duplicate it here
  localStorage.setItem("ashar.usercams.v1",
    JSON.stringify(S.cams.filter((c) => c.src !== "osm" && c.src !== "seed")));
}

// cameras the user reported as gone — suppressed across all sources + reloads
function loadRemoved() {
  try { return new Set(JSON.parse(localStorage.getItem("ashar.removed") || "[]")); } catch { return new Set(); }
}
function saveRemoved() { localStorage.setItem("ashar.removed", JSON.stringify([...S.removed])); }

async function loadCams() {
  let base = [];
  try {
    const r = await fetch("data/cameras.json");
    const j = await r.json();
    base = j.cams.map((c, i) => ({ id: "o" + i, lat: c[0], lon: c[1], sp: c[2], dir: c[3], src: "osm" }));
  } catch (e) { console.warn("cameras.json load failed", e); }
  const user = loadUserCams();
  S.cams = base.concat(user).filter((c) => !S.removed.has(c.id));
  $("camCount").textContent = S.cams.length;
}

// ---------- map ----------
let map, userMarker, accCircle;
const camMarkers = {};
function initMap() {
  map = L.map("map", { zoomControl: false, attributionControl: true });
  map.attributionControl.setPrefix(false);
  map.setView([21.54, 39.19], 11);
  const carto = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; CARTO',
    maxZoom: 19, subdomains: "abcd",
  }).addTo(map);
  let fellBack = false;
  carto.on("tileerror", () => {
    if (fellBack) return; fellBack = true;
    map.removeLayer(carto);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19, className: "osm-dim",
    }).addTo(map);
  });
  map.on("dragstart", () => { S.follow = false; $("recenter").classList.add("show"); });
  map.on("moveend zoomend", refreshMarkers);

  userMarker = L.marker([21.54, 39.19], {
    icon: L.divIcon({ className: "me-wrap", html: '<div class="me-cone" id="meCone"></div><div class="me-dot"></div>', iconSize: [44, 44], iconAnchor: [22, 22] }),
    interactive: false, keyboard: false,
  });
  accCircle = L.circle([21.54, 39.19], { radius: 30, weight: 0, fillColor: "#ffb347", fillOpacity: 0.08, interactive: false });
  refreshMarkers();
}

// Render markers only in view, capped to the nearest few, and hidden when
// zoomed far out — so thousands of cameras (e.g. the SCDB seed) never choke
// the map. Alert logic uses S.cams data, not markers, so coverage is unaffected.
const MARKER_CAP = 160;      // most markers to draw at once
const MARKER_MIN_ZOOM = 11;  // below this, only show your own + the active one
function refreshMarkers() {
  if (!map) return;
  const z = map.getZoom();
  const detailed = z >= MARKER_MIN_ZOOM;
  const b = map.getBounds().pad(0.2);
  const c0 = map.getCenter();
  const keep = new Set();

  let inView = [];
  for (const c of S.cams) {
    if (!b.contains([c.lat, c.lon])) continue;
    if (c.id === S.activeId || isMine(c)) { keep.add(c.id); continue; } // always show these
    if (detailed) inView.push(c);
  }
  // cap the reference cameras to the nearest MARKER_CAP to the screen centre
  if (inView.length > MARKER_CAP) {
    const d2 = (c) => (c.lat - c0.lat) ** 2 + (c.lon - c0.lng) ** 2;
    inView.sort((a, b2) => d2(a) - d2(b2));
    inView.length = MARKER_CAP;
  }
  for (const c of inView) keep.add(c.id);

  for (const c of S.cams) {
    if (keep.has(c.id)) addCamMarker(c);
    else if (camMarkers[c.id]) { map.removeLayer(camMarkers[c.id]); delete camMarkers[c.id]; }
  }
}

const isMine = (c) => c.src === "user" || c.src === "family"; // people-marked (vs reference DBs)
function camIconHtml(c) {
  const inner = c.sp ? c.sp : "&#9679;";
  return `<div class="cam-sign ${isMine(c) ? "mine" : ""}">${inner}</div>`;
}
function addCamMarker(c) {
  if (camMarkers[c.id]) return; // already drawn
  const m = L.marker([c.lat, c.lon], {
    icon: L.divIcon({ className: "cam-wrap", html: camIconHtml(c), iconSize: [30, 30], iconAnchor: [15, 15] }),
    keyboard: false,
  });
  if (isMine(c)) {
    const who = c.src === "family" ? `كاميرا العائلة${c.by ? " — " + c.by : ""}` : "كاميرا (أنت أضفتها)";
    m.bindPopup(`<div class="pop"><b>${who}</b><br>الحد: ${c.sp || "غير محدد"}<br><button class="pop-del" data-id="${c.id}">حذف</button></div>`);
  } else {
    const src = c.src === "seed" ? "قاعدة SCDB" : c.src === "import" ? "ملف مستورد" : "OSM";
    m.bindPopup(`<div class="pop"><b>ساهر</b><br>الحد: ${c.sp || "غير معروف"}${c.dir >= 0 ? "<br>اتجاهية" : ""}<br><span class="pop-src">المصدر: ${src}</span></div>`);
  }
  m.addTo(map);
  camMarkers[c.id] = m;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest(".pop-del");
  if (!b) return;
  const id = b.dataset.id;
  S.cams = S.cams.filter((c) => c.id !== id);
  if (camMarkers[id]) { map.removeLayer(camMarkers[id]); delete camMarkers[id]; }
  saveUserCams(); map.closePopup(); toast("انحذفت");
  syncRemove(id);
});

// ---------- GPS ----------
let watchId = null;
const nativeBG = () => window.Capacitor?.isNativePlatform?.() && window.Capacitor.Plugins?.BackgroundGeolocation;
function startGPS() {
  const BG = nativeBG();
  if (BG) { startNativeGPS(BG); return; } // Android app: real background tracking
  if (!("geolocation" in navigator)) { gpsStatus("bad", "المتصفح ما يدعم الموقع"); return; }
  watchId = navigator.geolocation.watchPosition(onGeo, onGeoErr, {
    enableHighAccuracy: true, maximumAge: 1000, timeout: 15000,
  });
}
// Native Android: foreground-service location that keeps feeding the alert
// engine even while Google Maps is in front. Requests permission (fixes the
// "never asked for location" issue) and shows a persistent notification.
function startNativeGPS(BG) {
  BG.addWatcher(
    {
      backgroundMessage: "يراقب كاميرات الطريق وينبّهك",
      backgroundTitle: "أسهَر شغّال",
      requestPermissions: true,
      stale: false,
      distanceFilter: 8,
    },
    (loc, err) => {
      if (err) {
        gpsStatus("bad", err.code === "NOT_AUTHORIZED" ? "اسمح للموقع «طوال الوقت» من الإعدادات" : "ما فيه إشارة GPS");
        return;
      }
      if (!loc) return;
      handleFix({
        lat: loc.latitude, lon: loc.longitude, acc: loc.accuracy || 99,
        kmh: loc.speed != null && loc.speed >= 0 ? loc.speed * 3.6 : null,
        heading: loc.bearing != null && loc.bearing >= 0 ? loc.bearing : null,
        ts: loc.time || Date.now(),
      });
    }
  ).then((id) => { watchId = id; }).catch(() => gpsStatus("bad", "تعذّر تشغيل الموقع"));
}

// ---------- native floating overlay (Android only) ----------
const overlayPlugin = () => (window.Capacitor?.isNativePlatform?.() ? window.Capacitor.Plugins?.Overlay : null);
async function ensureOverlayPermission() {
  const O = overlayPlugin();
  if (!O) return false;
  try {
    const r = await O.hasPermission();
    if (r?.granted) return true;
    const r2 = await O.requestPermission();
    return !!r2?.granted;
  } catch { return false; }
}
function showOverlay() {
  const O = overlayPlugin();
  if (!O || S.overlayOn) return;
  O.show().then(() => { S.overlayOn = true; }).catch(() => {});
}
function hideOverlay() {
  const O = overlayPlugin();
  if (!O) { S.overlayOn = false; return; }
  O.hide().catch(() => {});
  S.overlayOn = false;
}
function updateOverlay(fix, best) {
  if (!S.overlayOn) return;
  const O = overlayPlugin();
  if (!O) return;
  const state = S.over ? "over" : S.activeId ? "warn" : "normal";
  const info = best && best.dist <= 2500 ? "ساهر " + fmtDist(best.dist) : "كم/س";
  O.update({ speed: String(Math.round(fix.kmh)), info, state }).catch(() => {});
}
function onGeo(p) {
  const c = p.coords;
  handleFix({
    lat: c.latitude, lon: c.longitude, acc: c.accuracy || 99,
    kmh: c.speed != null && !isNaN(c.speed) ? c.speed * 3.6 : null,
    heading: c.heading != null && !isNaN(c.heading) ? c.heading : null,
    ts: p.timestamp || Date.now(),
  });
}
function onGeoErr(e) {
  gpsStatus("bad", e.code === 1 ? "اسمح بالوصول للموقع" : "ما فيه إشارة GPS");
}
function gpsStatus(cls, msg) {
  $("gpsDot").className = "gps-dot " + cls;
  if (msg) { $("nextMini").textContent = msg; }
}

// Turn a raw GPS fix into a stable speed + heading.
// Raw GPS speed jitters (shows 1-3 km/h while parked) and derived speed is
// even noisier at low speed, so we: gate movement by GPS accuracy, drop a
// noise floor (below it = stopped → 0), then EMA-smooth — much closer to
// what Google's fused/Kalman speedometer shows.
const SPEED_FLOOR_GOOD = 4;  // km/h, when accuracy is decent
const SPEED_FLOOR_POOR = 7;  // km/h, when accuracy is weak (more jitter)
function enrich(fix) {
  const acc = fix.acc || 20;
  let derivedKmh = null;
  const d = S.derived;
  if (d) {
    const dist = haversine(d.lat, d.lon, fix.lat, fix.lon);
    const dt = (fix.ts - d.ts) / 1000;
    const noise = Math.max(8, acc * 0.5); // movement must beat GPS noise to count
    if (dt > 0.3 && dist >= noise) {
      if (fix.heading == null) fix.heading = bearing(d.lat, d.lon, fix.lat, fix.lon);
      derivedKmh = clamp((dist / dt) * 3.6, 0, 240);
      S.derived = { lat: fix.lat, lon: fix.lon, ts: fix.ts };
    } else if (dt > 2) {
      S.derived = { lat: fix.lat, lon: fix.lon, ts: fix.ts }; // re-anchor when ~stationary
    }
    if (fix.heading == null && S.fix) fix.heading = S.fix.heading;
  } else {
    S.derived = { lat: fix.lat, lon: fix.lon, ts: fix.ts };
  }

  // prefer the device's GPS speed; fall back to derived
  let raw = fix.kmh != null ? fix.kmh : (derivedKmh != null ? derivedKmh : 0);
  const floor = acc > 30 ? SPEED_FLOOR_POOR : SPEED_FLOOR_GOOD;
  if (raw < floor) raw = 0;                       // parked / GPS jitter → 0
  S.smoothKmh = raw === 0 ? 0 : (S.smoothKmh ? S.smoothKmh * 0.5 + raw * 0.5 : raw);
  fix.kmh = S.smoothKmh;
  return fix;
}

// ---------- alert engine ----------
function handleFix(raw) {
  const fix = enrich(raw);
  S.fix = fix;
  window.__ASHAR.fixes++;
  gpsStatus(fix.acc <= 25 ? "good" : "mid");

  // map presence
  if (!map.hasLayer(userMarker)) { userMarker.addTo(map); accCircle.addTo(map); }
  userMarker.setLatLng([fix.lat, fix.lon]);
  accCircle.setLatLng([fix.lat, fix.lon]).setRadius(Math.min(fix.acc, 150));
  const cone = document.getElementById("meCone");
  if (cone) cone.style.transform = `rotate(${fix.heading ?? 0}deg)`;
  if (S.follow) map.setView([fix.lat, fix.lon], Math.max(map.getZoom(), 14), { animate: true });

  // HUD speed
  const kmh = Math.round(fix.kmh);
  $("speedVal").textContent = kmh;

  const v = fix.kmh / 3.6;
  const d1 = clamp(v * 25, 350, 1400);
  const d2 = clamp(v * 10, 150, 600);

  // candidate cameras ahead
  let best = null;
  for (const cam of S.cams) {
    const dist = haversine(fix.lat, fix.lon, cam.lat, cam.lon);
    const st = (S.alerted[cam.id] ||= { stage: 0, prevDist: dist });
    // re-arm once clearly past/away
    if (st.stage > 0) {
      const brg = bearing(fix.lat, fix.lon, cam.lat, cam.lon);
      const behind = fix.heading != null && angDiff(fix.heading, brg) > 110;
      if (dist > 1600 || (behind && dist > 150 && dist > st.prevDist + 5)) {
        if (S.activeId === cam.id) clearAlertUI(true);
        camMarkers[cam.id]?.getElement()?.classList.remove("active");
        st.stage = 0;
      }
    }
    if (dist > 2500) { st.prevDist = dist; continue; }
    const brg = bearing(fix.lat, fix.lon, cam.lat, cam.lon);
    let ahead;
    if (fix.heading != null) ahead = angDiff(fix.heading, brg) <= 55;
    else ahead = dist < st.prevDist - 6; // no heading yet: closing in counts
    // optional strict camera-direction filter (off by default — safer)
    if (ahead && S.settings.strictDir && cam.dir >= 0 && fix.heading != null) {
      ahead = angDiff(cam.dir, fix.heading) <= 75;
    }
    if (ahead && (!best || dist < best.dist)) best = { cam, dist, st };
    st.prevDist = dist;
  }

  // nearest-info mini line
  if (best) {
    $("nextMini").textContent = `أقرب كاميرا قدامك: ${fmtDist(best.dist)}`;
  } else {
    $("nextMini").textContent = "ما فيه كاميرات قدامك بنطاق 2.5 كم — انتبه لسرعتك";
  }

  // fire / update camera alerts (independent of overspeed)
  if (best && fix.kmh >= MIN_ALERT_KMH) {
    const { cam, dist, st } = best;
    if (dist <= d2 && st.stage < 2) {
      st.stage = 2;
      fireAlert(cam, dist, 2);
    } else if (dist <= d1 && st.stage < 1) {
      st.stage = 1;
      fireAlert(cam, dist, 1);
    } else if (S.activeId === cam.id && st.stage > 0) {
      updateAlertUI(cam, dist, d1);
    }
  } else if (!best) {
    clearAlertUI();
  }

  // ---- continuous safety: warn whenever over the limit, ANYWHERE (the root cause) ----
  const nearCam = best && best.cam.sp > 0 && best.dist <= d1;
  const activeLimit = nearCam ? Math.min(S.limit, best.cam.sp) : S.limit;
  S.activeLimit = activeLimit;
  updateLimitChip(activeLimit, nearCam);
  runOverspeed(fix, activeLimit);

  // accumulate the trip for the end-of-drive safety report
  trackTrip(fix);

  // mirror to the floating bubble when backgrounded over another app
  updateOverlay(fix, best);
}

// Always-on overspeed engine — this is what genuinely curbs speeding, not just camera dodging.
function runOverspeed(fix, limit) {
  const sv = $("speedVal");
  if (!S.settings.safety || fix.kmh < MIN_ALERT_KMH || !limit) {
    S.over = false;
    document.body.classList.remove("over");
    sv.classList.remove("bad", "warn");
    return;
  }
  const over = fix.kmh > limit + OVER_MARGIN;
  const big = fix.kmh > limit + OVER_BIG;
  S.over = over;
  document.body.classList.toggle("over", over);
  sv.classList.toggle("bad", over);
  sv.classList.toggle("warn", !over && S.activeId != null); // near a camera but compliant
  if (over) {
    const now = Date.now();
    const gap = big ? 2200 : 5200;
    if (now - S.overAt > gap) { S.overAt = now; big ? snd.overspeed() : snd.beeps(600, 1, 0.14); }
    snd.speak("خفّف السرعة", "over", big ? 7000 : 13000);
  }
}

function trackTrip(fix) {
  const t = S.trip;
  if (!t || fix.kmh < MIN_ALERT_KMH) return;
  t.movingFixes++;
  t.maxKmh = Math.max(t.maxKmh, fix.kmh);
  if (t.lastPt) {
    const d = haversine(t.lastPt.lat, t.lastPt.lon, fix.lat, fix.lon);
    if (d >= 3 && d < 600) t.distM += d;
  }
  t.lastPt = { lat: fix.lat, lon: fix.lon };
  if (S.over) {
    t.overFixes++;
    t.maxOvershoot = Math.max(t.maxOvershoot, fix.kmh - (S.activeLimit || S.limit));
  }
  if (!t.start) t.start = fix.ts;
  t.end = fix.ts;
  detectSlowdown(fix);
}

// Is there already a known camera within `m` meters of this point?
function nearKnownCam(lat, lon, m = 250) {
  for (const c of S.cams) if (haversine(lat, lon, c.lat, c.lon) < m) return true;
  return false;
}

// Passive Saher detection: a sharp slow-down THEN speed-up on a fast road,
// away from any known camera, is the classic "braked for a Saher" signature.
// We never interrupt the drive — candidates are reviewed in the trip report.
function detectSlowdown(fix) {
  const t = S.trip;
  const kmh = fix.kmh;
  if (!t.inDip) {
    // climbing / cruising — remember the recent peak
    t.peak = Math.max(t.peak || 0, kmh);
    // a real braking event only matters at highway-ish speed
    if (t.peak >= 90 && kmh < t.peak - 30) {
      t.inDip = true;
      t.dipMin = kmh;
      t.dipLoc = { lat: fix.lat, lon: fix.lon };
    }
  } else {
    if (kmh < t.dipMin) { t.dipMin = kmh; t.dipLoc = { lat: fix.lat, lon: fix.lon }; }
    // recovered → close the dip and log a candidate at the slowest point
    if (kmh > t.dipMin + 15) {
      const { lat, lon } = t.dipLoc;
      const known = nearKnownCam(lat, lon, 250);
      const dup = t.slow.some((s) => haversine(s.lat, s.lon, lat, lon) < 300);
      if (!known && !dup) t.slow.push({ lat, lon, from: Math.round(t.peak), to: Math.round(t.dipMin) });
      t.inDip = false;
      t.peak = kmh;
    }
  }
}

function fireAlert(cam, dist, stage) {
  if (S.activeId && S.activeId !== cam.id) {
    camMarkers[S.activeId]?.getElement()?.classList.remove("active");
  }
  S.activeId = cam.id;
  updateAlertUI(cam, dist, clamp((S.fix?.kmh || 0) / 3.6 * 25, 350, 1400));
  $("alertCard").classList.add("show", stage === 2 ? "s2" : "s1");
  if (stage === 2) $("alertCard").classList.remove("s1");
  camMarkers[cam.id]?.getElement()?.classList.add("active");
  if (stage === 1) {
    snd.announce();
    snd.speak(`ساهر بعد ${dist >= 950 ? "كيلو تقريباً" : Math.round(dist / 100) * 100 + " متر"}`, cam.id, 20000);
  } else {
    snd.urgent();
    snd.speak(cam.sp ? `قريب! الحد ${cam.sp}` : "الكاميرا قريبة", cam.id + "u", 15000);
  }
  const rec = { t: Date.now(), id: cam.id, stage, dist: Math.round(dist) };
  window.__ASHAR.alerts.push(rec);
  console.log("ASHAR_ALERT", JSON.stringify(rec));
}

function updateAlertUI(cam, dist, d1) {
  $("alertSp").textContent = cam.sp || "؟";
  $("alertDist").textContent = fmtDist(dist);
  $("alertBar").style.width = clamp((dist / d1) * 100, 2, 100) + "%";
}

function clearAlertUI(passed = false) {
  if (S.activeId == null) return;
  camMarkers[S.activeId]?.getElement()?.classList.remove("active");
  $("alertCard").classList.remove("show", "s1", "s2");
  if (passed) { snd.ok(); }
  S.activeId = null;
}

// "Not there anymore" — suppress this camera everywhere + remember across reloads.
// People-marked cams also sync the removal to the family; reference cams (SCDB/OSM)
// are suppressed locally per device.
function reportGone() {
  const id = S.activeId;
  if (!id) return;
  const cam = S.cams.find((c) => c.id === id);
  S.removed.add(id);
  saveRemoved();
  if (cam && isMine(cam)) syncRemove(id);
  S.cams = S.cams.filter((c) => c.id !== id);
  if (camMarkers[id]) { map.removeLayer(camMarkers[id]); delete camMarkers[id]; }
  if (S.alerted[id]) delete S.alerted[id];
  clearAlertUI();
  $("camCount").textContent = S.cams.length;
  snd.ok();
  toast("شكراً — ما نبهك عنها بعد");
}

// ---------- speed-limit chip (live safety baseline) ----------
function updateLimitChip(limit, nearCam) {
  const chip = $("limitChip");
  if (!chip) return;
  $("limitVal").textContent = limit || "—";
  chip.classList.toggle("over", S.over);
  chip.classList.toggle("cam", !!nearCam);
}
function setLimit(v) {
  S.limit = v;
  S.settings.limit = v;
  saveSettings();
  updateLimitChip(S.activeLimit || v, false);
  $("limitPop")?.classList.remove("show");
}

// ---------- trip safety report (reinforces the behaviour that actually matters) ----------
function startTrip() {
  S.trip = { movingFixes: 0, overFixes: 0, maxKmh: 0, maxOvershoot: 0, distM: 0, start: 0, end: 0, lastPt: null,
             slow: [], peak: 0, inDip: false, dipMin: 0, dipLoc: null };
}
function endTripAndReport() {
  const t = S.trip;
  S.trip = null;
  hideOverlay(); // trip over → no bubble
  if (!t || t.movingFixes < 5) { toast("الرحلة قصيرة — ما فيه تقرير"); return; }
  const pctOver = t.movingFixes ? (t.overFixes / t.movingFixes) * 100 : 0;
  const score = Math.round(clamp(100 - pctOver * 1.2 - t.maxOvershoot * 0.6, 0, 100));
  const mins = t.start && t.end ? Math.max(1, Math.round((t.end - t.start) / 60000)) : 0;
  showTripReport({
    score,
    km: t.distM / 1000,
    mins,
    maxKmh: Math.round(t.maxKmh),
    pctOver: Math.round(pctOver),
    alerts: window.__ASHAR.alerts.length,
    candidates: t.slow.slice(0, 6),
  });
  console.log("ASHAR_TRIP", JSON.stringify({ score, km: +(t.distM / 1000).toFixed(1), mins, maxKmh: Math.round(t.maxKmh), pctOver: Math.round(pctOver), candidates: t.slow.length }));
}
function showTripReport(r) {
  const grade = r.score >= 85 ? "good" : r.score >= 60 ? "mid" : "bad";
  const msg = r.score >= 85 ? "قيادة آمنة — الله يحفظك 🤍"
    : r.score >= 60 ? "كويس، بس تقدر أهدى شوي"
    : "خفّف السرعة الرحلة الجاية — سلامتك أهم";
  $("tripScore").textContent = r.score;
  $("tripScore").className = "trip-score " + grade;
  $("tripGradeMsg").textContent = msg;
  $("tripKm").textContent = r.km >= 10 ? Math.round(r.km) : r.km.toFixed(1);
  $("tripMins").textContent = r.mins;
  $("tripMax").textContent = r.maxKmh;
  $("tripOver").textContent = r.pctOver + "٪";
  $("tripAlerts").textContent = r.alerts;
  renderCandidates(r.candidates || []);
  $("tripReport").classList.add("show");
}

// "You slowed sharply here — was it a Saher?" — safe post-trip confirmation
function renderCandidates(list) {
  const box = $("tripCands");
  if (!box) return;
  if (!list.length) { box.innerHTML = ""; box.classList.remove("show"); return; }
  box.classList.add("show");
  box.innerHTML =
    `<div class="cand-title">خفّفت فجأة بـ ${list.length} ${list.length === 1 ? "موقع" : "مواقع"} مجهولة — كان فيه ساهر؟</div>` +
    list.map((c, i) => `
      <div class="cand-row" data-i="${i}">
        <span class="cand-info">من ${c.from} لـ ${c.to} كم/س</span>
        <span class="cand-acts">
          <button class="cand-yes" data-i="${i}">نعم، ساهر</button>
          <button class="cand-no" data-i="${i}">لا</button>
        </span>
      </div>`).join("");
  box._list = list;
}
document.addEventListener("click", (e) => {
  const yes = e.target.closest(".cand-yes");
  const no = e.target.closest(".cand-no");
  if (!yes && !no) return;
  const box = $("tripCands");
  const i = +(yes || no).dataset.i;
  const c = box._list?.[i];
  const row = (yes || no).closest(".cand-row");
  if (yes && c) {
    ensureRoom();
    const cam = { id: "u" + Date.now() + "_" + i, lat: c.lat, lon: c.lon, sp: 0, dir: -1,
                  src: S.room ? "family" : "user", by: familyName(), at: new Date().toISOString() };
    S.cams.push(cam); saveUserCams(); refreshMarkers(); syncPush(cam);
    row.innerHTML = '<span class="cand-done">انضافت ✓</span>';
  } else if (row) {
    row.remove();
  }
});

// ---------- family identity ----------
const familyName = () => localStorage.getItem("ashar.name") || "";
function askName(then) {
  const dlg = $("nameDlg");
  dlg._then = then || null;
  $("nameInput").value = familyName();
  dlg.classList.add("show");
  setTimeout(() => $("nameInput").focus(), 60);
}
function closeNameDlg(save) {
  const dlg = $("nameDlg");
  if (save) {
    const v = $("nameInput").value.trim().slice(0, 20);
    if (v) { localStorage.setItem("ashar.name", v); $("setName").value = v; }
  }
  localStorage.setItem("ashar.nameAsked", "1");
  dlg.classList.remove("show");
  const f = dlg._then;
  dlg._then = null;
  if (f) f();
}
$("nameSave").addEventListener("click", () => closeNameDlg(true));
$("nameSkip").addEventListener("click", () => closeNameDlg(false));
$("nameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") closeNameDlg(true); });

// ---------- add camera (one tap) ----------
let lastAdded = null;
function addCamHere() {
  ensureRoom(); // auto-creates a family room on first mark when sync is configured
  const c = {
    id: "u" + Date.now(), lat: S.fix.lat, lon: S.fix.lon,
    sp: 0, dir: -1, src: S.room ? "family" : "user", by: familyName(),
    heading: S.fix.heading ?? -1, at: new Date().toISOString(),
  };
  S.cams.push(c); addCamMarker(c); saveUserCams();
  lastAdded = c.id;
  toastCam();
  snd.ok();
  syncPush(c);
}
$("fabCam").addEventListener("click", () => {
  if (!S.fix) { toast("بانتظار إشارة GPS…"); return; }
  if (!familyName() && !localStorage.getItem("ashar.nameAsked")) askName(addCamHere);
  else addCamHere();
});

function toastCam() {
  const t = $("toastCam");
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 15000);
}
document.querySelectorAll("#toastCam .chip[data-sp]").forEach((b) =>
  b.addEventListener("click", () => {
    const cam = S.cams.find((c) => c.id === lastAdded);
    if (cam) {
      cam.sp = +b.dataset.sp; saveUserCams();
      camMarkers[cam.id]?.setIcon(L.divIcon({ className: "cam-wrap", html: camIconHtml(cam), iconSize: [30, 30], iconAnchor: [15, 15] }));
      syncPush(cam); // share the corrected limit with the family
    }
    $("toastCam").classList.remove("show");
  })
);
$("undoCam").addEventListener("click", () => {
  if (!lastAdded) return;
  const id = lastAdded;
  S.cams = S.cams.filter((c) => c.id !== id);
  if (camMarkers[id]) { map.removeLayer(camMarkers[id]); delete camMarkers[id]; }
  saveUserCams(); lastAdded = null;
  $("toastCam").classList.remove("show");
  toast("تراجعنا ✓");
  syncRemove(id);
});

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 2500);
}

// ---------- recenter ----------
$("recenter").addEventListener("click", () => {
  S.follow = true;
  $("recenter").classList.remove("show");
  if (S.fix) map.setView([S.fix.lat, S.fix.lon], 15);
});

// ---------- bottom sheet ----------
const sheet = $("sheet");
$("sheetGrab").addEventListener("click", () => sheet.classList.toggle("open"));
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("on"));
    t.classList.add("on");
    document.querySelectorAll(".pane").forEach((p) => p.classList.remove("on"));
    $(t.dataset.pane).classList.add("on");
    if (t.dataset.pane !== "paneSet") renderList(t.dataset.pane);
  })
);

function renderList(which) {
  const here = S.fix || { lat: 21.54, lon: 39.19 };
  let arr = S.cams.map((c) => ({ c, d: haversine(here.lat, here.lon, c.lat, c.lon) }));
  if (which === "paneRoute") {
    arr = arr.filter(({ c }) =>
      c.lat >= CORRIDOR.latMin && c.lat <= CORRIDOR.latMax &&
      c.lon >= CORRIDOR.lonMin && c.lon <= CORRIDOR.lonMax);
  } else {
    arr = arr.filter((x) => x.d < 30000);
  }
  arr.sort((a, b) => a.d - b.d);
  const el = which === "paneRoute" ? $("listRoute") : $("listNear");
  el.innerHTML = arr.length
    ? arr.slice(0, 80).map(({ c, d }) => `
      <div class="row" data-id="${c.id}">
        <div class="row-sign ${isMine(c) ? "mine" : ""}">${c.sp || "•"}</div>
        <div class="row-txt"><b>${c.src === "family" ? (c.by || "العائلة") : c.src === "user" ? "كاميرتك" : "ساهر"}</b><span>${fmtDist(d)}</span></div>
        ${isMine(c) ? `<button class="row-del" data-id="${c.id}">حذف</button>` : ""}
      </div>`).join("")
    : `<div class="empty">${which === "paneRoute" ? "ما فيه كاميرات موثّقة على الخط — استخدم زر «كاميرا هنا» وقت تشوف وحدة" : "ما فيه كاميرات قريبة بنطاق 30 كم"}</div>`;
}
document.addEventListener("click", (e) => {
  const del = e.target.closest(".row-del");
  if (del) {
    const id = del.dataset.id;
    S.cams = S.cams.filter((c) => c.id !== id);
    if (camMarkers[id]) { map.removeLayer(camMarkers[id]); delete camMarkers[id]; }
    saveUserCams();
    del.closest(".row").remove();
    syncRemove(id);
    return;
  }
  const row = e.target.closest(".row");
  if (row) {
    const c = S.cams.find((x) => x.id === row.dataset.id);
    if (c) { sheet.classList.remove("open"); S.follow = false; $("recenter").classList.add("show"); map.setView([c.lat, c.lon], 15); camMarkers[c.id]?.openPopup(); }
  }
});

// ---------- settings ----------
function bindToggle(id, key) {
  const el = $(id);
  el.checked = S.settings[key];
  el.addEventListener("change", () => { S.settings[key] = el.checked; saveSettings(); applySettings(); });
}
function applySettings() {
  snd.sound = S.settings.sound;
  snd.voice = S.settings.voice;
  if (S.settings.limit) S.limit = S.settings.limit;
}

// ---------- import / export ----------
$("btnExport").addEventListener("click", () => {
  const mine = S.cams.filter((c) => c.src !== "osm");
  const blob = new Blob([JSON.stringify({ app: "ashar", version: VERSION, cams: mine }, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "ashar-cameras.json";
  a.click();
  toast(`صدّرنا ${mine.length} كاميرا`);
});
$("fileImport").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const txt = await f.text();
  let pts = [];
  try {
    if (f.name.endsWith(".gpx") || txt.trimStart().startsWith("<")) {
      const doc = new DOMParser().parseFromString(txt, "text/xml");
      pts = [...doc.querySelectorAll("wpt")].map((w) => ({
        lat: +w.getAttribute("lat"), lon: +w.getAttribute("lon"),
        sp: parseInt((w.querySelector("name,desc")?.textContent || "").match(/\d{2,3}/)?.[0] || 0) || 0,
      }));
    } else if (f.name.endsWith(".csv")) {
      pts = txt.split(/\r?\n/).map((l) => l.split(/[,;]/)).filter((p) => p.length >= 2)
        .map((p) => {
          const a = parseFloat(p[0]), b = parseFloat(p[1]);
          if (isNaN(a) || isNaN(b)) return null;
          // lon,lat or lat,lon — Saudi: lat 16..33, lon 34..56
          const [lat, lon] = a >= 16 && a <= 33 ? [a, b] : [b, a];
          const sp = parseInt(p.slice(2).find((x) => /^\s*\d{2,3}\s*$/.test(x)) || 0) || 0;
          return { lat, lon, sp };
        }).filter(Boolean);
    } else {
      const j = JSON.parse(txt);
      const arr = j.cams || j;
      pts = arr.map((c) => Array.isArray(c)
        ? { lat: c[0], lon: c[1], sp: c[2] || 0 }
        : { lat: c.lat, lon: c.lon, sp: c.sp || 0 });
    }
  } catch (err) { toast("ملف غير مفهوم"); return; }
  pts = pts.filter((p) => p.lat >= 15 && p.lat <= 34 && p.lon >= 33 && p.lon <= 57);
  // Imports stay LOCAL on this device (never pushed to the family cloud):
  // respects third-party data licenses (e.g. SCDB) and keeps the shared DB
  // clean + light. Each family member imports their own copy.
  // Fast spatial dedup (~50m grid) so importing thousands doesn't freeze.
  const CELL = 0.0005;
  const gkey = (la, lo) => Math.round(la / CELL) + "_" + Math.round(lo / CELL);
  const occupied = new Set(S.cams.map((c) => gkey(c.lat, c.lon)));
  const taken = (la, lo) => {
    const a = Math.round(la / CELL), b = Math.round(lo / CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++)
      if (occupied.has(a + i + "_" + (b + j))) return true;
    return false;
  };
  let added = 0;
  for (const p of pts) {
    if (taken(p.lat, p.lon)) continue;
    const c = { id: "i" + Date.now() + "_" + added, lat: p.lat, lon: p.lon, sp: p.sp, dir: -1, src: "import", by: "" };
    S.cams.push(c); occupied.add(gkey(p.lat, p.lon)); added++;
  }
  saveUserCams();
  refreshMarkers();
  $("camCount").textContent = S.cams.length;
  toast(`أضفنا ${added} كاميرا محلياً (خاصة بجهازك)`);
  e.target.value = "";
});

// ---------- family share-link (WhatsApp-friendly, zero backend) ----------
const b64enc = (s) => btoa(unescape(encodeURIComponent(s)));
const b64dec = (s) => decodeURIComponent(escape(atob(s)));

function buildShareUrl() {
  const mine = S.cams.filter((c) => c.src !== "osm");
  const payload = {
    v: 1,
    by: familyName() || "العائلة",
    cams: mine.map((c) => [+c.lat.toFixed(5), +c.lon.toFixed(5), c.sp | 0, c.dir ?? -1, (c.by || familyName() || "").slice(0, 20)]),
  };
  return location.origin + location.pathname + "#add=" + b64enc(JSON.stringify(payload));
}
window.__ASHAR.buildShareUrl = buildShareUrl;

function buildInviteUrl() {
  const by = encodeURIComponent(familyName() || "العائلة");
  return `${location.origin}${location.pathname}#join=${S.room}&by=${by}`;
}

$("btnShare").addEventListener("click", async () => {
  if (!familyName() && !localStorage.getItem("ashar.nameAsked")) { askName(() => $("btnShare").click()); return; }

  let url, text;
  if (syncEnabled()) {
    // live family: share a one-time invite to the shared room; everything syncs after
    ensureRoom();
    url = buildInviteUrl();
    text = `🦅 أسهَر — انضم لعائلة ${familyName() || ""}\nافتح الرابط مرة وحدة وبتتزامن كل الكاميرات تلقائياً (اللي يعلّمها أي واحد توصل الكل):`;
  } else {
    // no backend configured: share a snapshot of current cameras
    const mine = S.cams.filter((c) => c.src !== "osm");
    if (!mine.length) { toast("علّم كاميرات أول بزر «كاميرا هنا»"); return; }
    url = buildShareUrl();
    text = `🦅 أسهَر — ${mine.length} كاميرا من ${familyName() || "العائلة"}\nافتح الرابط على جوالك وبتنضاف تلقائياً:`;
  }
  if (navigator.share) {
    try { await navigator.share({ title: "أسهَر", text, url }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  try { await navigator.clipboard.writeText(text + "\n" + url); toast("انتسخ الرابط ✓ — أرسله بقروب العائلة"); }
  catch { prompt("انسخ الرابط وأرسله للعائلة:", url); }
});

function importFromHash() {
  // family invite: join a shared room, then pull everything
  const j = location.hash.match(/^#join=([a-z0-9]+)(?:&by=(.*))?$/i);
  if (j) {
    history.replaceState(null, "", location.pathname + location.search);
    const room = j[1];
    const by = j[2] ? decodeURIComponent(j[2]) : "العائلة";
    if (!syncEnabled()) { $("importNote").textContent = "رابط عائلة — لكن المزامنة غير مهيّأة على هذه النسخة"; return; }
    joinRoom(room, by);
    return;
  }
  const m = location.hash.match(/^#add=(.+)$/);
  if (!m) return;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const j = JSON.parse(b64dec(m[1]));
    if (j.v !== 1 || !Array.isArray(j.cams)) throw new Error("bad payload");
    let added = 0;
    for (const r of j.cams) {
      const [lat, lon, sp, dir, by] = r;
      if (typeof lat !== "number" || typeof lon !== "number") continue;
      if (!(lat >= 15 && lat <= 34 && lon >= 33 && lon <= 57)) continue;
      if (S.cams.some((c) => haversine(c.lat, c.lon, lat, lon) < 40)) continue;
      const c = {
        id: "f" + Date.now() + "_" + added, lat, lon, sp: sp | 0,
        dir: typeof dir === "number" ? dir : -1, src: "family",
        by: String(by || j.by || "").slice(0, 20),
      };
      S.cams.push(c); added++;
    }
    if (added) { saveUserCams(); refreshMarkers(); }
    const msg = added
      ? `وصلتك ${added} كاميرا من ${j.by || "العائلة"} ✓`
      : "كاميرات الرابط عندك من قبل ✓";
    $("importNote").textContent = msg;
    toast(msg);
    $("camCount").textContent = S.cams.length;
  } catch {
    $("importNote").textContent = "الرابط غير صالح — اطلب رابط جديد";
    toast("رابط غير صالح");
  }
}

// ---------- family sync (Supabase, offline-first) ----------
function ensureRoom() {
  if (syncEnabled() && !S.room) {
    S.room = genRoom();
    localStorage.setItem("ashar.room", S.room);
    // share whatever the user already marked locally into the new family room
    const mine = S.cams.filter((c) => c.src !== "osm");
    mine.forEach((c) => (c.src = "family"));
    pushMany(S.room, mine).catch(() => {});
    updateSyncUI();
    startPoll();
  }
}

function syncPush(cam) {
  if (!syncEnabled() || !S.room || cam.src === "osm") return;
  pushCamera(S.room, cam).catch(() => toast("ما تمت المزامنة — بنحاول لاحقاً"));
}
function syncRemove(id) {
  if (!syncEnabled() || !S.room) return;
  removeCamera(S.room, id).catch(() => {});
}

async function joinRoom(room, by) {
  S.room = room;
  localStorage.setItem("ashar.room", room);
  updateSyncUI();
  try {
    await pullAndReconcile();
    // contribute any cameras this device already had to the family
    const mine = S.cams.filter((c) => c.src !== "osm" && c.src !== "family");
    mine.forEach((c) => (c.src = "family"));
    if (mine.length) { saveUserCams(); await pushMany(room, mine).catch(() => {}); }
    const msg = `انضممت لعائلة ${by} ✓`;
    $("importNote").textContent = msg; toast(msg);
    startPoll();
  } catch {
    $("importNote").textContent = "ما قدرنا نتصل بالمزامنة — تأكد من النت";
  }
}

async function pullAndReconcile() {
  if (!syncEnabled() || !S.room) return;
  const rows = await pullCameras(S.room);
  const serverIds = new Set(rows.map((r) => r.id));
  const byId = new Map(S.cams.map((c) => [c.id, c]));
  let added = 0;
  for (const r of rows) {
    const ex = byId.get(r.id);
    if (ex) {
      if (ex.sp !== (r.sp | 0) || ex.dir !== r.dir) {
        ex.sp = r.sp | 0; ex.dir = r.dir; ex.by = r.by || ex.by;
        camMarkers[ex.id]?.setIcon(L.divIcon({ className: "cam-wrap", html: camIconHtml(ex), iconSize: [30, 30], iconAnchor: [15, 15] }));
      }
      continue;
    }
    if (S.removed.has(r.id)) continue; // locally reported gone
    const c = { id: r.id, lat: r.lat, lon: r.lon, sp: r.sp | 0, dir: r.dir, src: "family", by: r.by || "" };
    S.cams.push(c); added++;
  }
  // a family camera that vanished server-side was deleted by someone → drop it
  let removed = 0;
  for (const c of [...S.cams]) {
    if (c.src === "family" && !serverIds.has(c.id)) {
      S.cams = S.cams.filter((x) => x.id !== c.id);
      if (camMarkers[c.id]) { map.removeLayer(camMarkers[c.id]); delete camMarkers[c.id]; }
      removed++;
    }
  }
  if (added || removed) { saveUserCams(); refreshMarkers(); }
  $("camCount").textContent = S.cams.length;
  return added;
}

// shared reference seed (SCDB): pulled ONCE per device then cached locally —
// never polled, never in the family room, so it can't slow the live sync.
async function loadSeed() {
  if (!syncEnabled()) return;
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem("ashar.seed") || "null"); } catch {}
  // use cache only if it matches the current seed version (guards partial/stale caches)
  if (cached && cached.length && localStorage.getItem("ashar.seedV") === SEED_VERSION) {
    mergeSeed(cached);
    return;
  }
  try {
    const rows = await pullCameras(SEED_ROOM);
    if (rows.length) {
      const compact = rows.map((r) => [r.lat, r.lon, r.sp | 0]);
      localStorage.setItem("ashar.seed", JSON.stringify(compact));
      localStorage.setItem("ashar.seedV", SEED_VERSION);
      mergeSeed(compact);
    }
  } catch { /* offline / not provisioned yet — silent, retry next launch */ }
}
function mergeSeed(compact) {
  const CELL = 0.0004; // ~40m dedup vs OSM + crowd + already-loaded cams
  const gkey = (la, lo) => Math.round(la / CELL) + "_" + Math.round(lo / CELL);
  const occ = new Set(S.cams.map((c) => gkey(c.lat, c.lon)));
  const near = (la, lo) => {
    const a = Math.round(la / CELL), b = Math.round(lo / CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++)
      if (occ.has(a + i + "_" + (b + j))) return true;
    return false;
  };
  let added = 0;
  for (const [la, lo, sp] of compact) {
    if (near(la, lo)) continue;
    const id = "s_" + Math.round(la * 1e5) + "_" + Math.round(lo * 1e5);
    if (S.removed.has(id)) continue; // user reported this one gone
    S.cams.push({ id, lat: la, lon: lo, sp: sp | 0, dir: -1, src: "seed" });
    occ.add(gkey(la, lo));
    added++;
  }
  if (added) { refreshMarkers(); $("camCount").textContent = S.cams.length; }
}

function startPoll() {
  if (!syncEnabled() || !S.room || S.poll) return;
  const tick = () => { if (document.visibilityState === "visible") pullAndReconcile().catch(() => {}); };
  S.poll = setInterval(tick, 25000);
  tick();
}

function updateSyncUI() {
  const el = $("syncStatus");
  if (!el) return;
  if (!syncEnabled()) { el.textContent = "المزامنة غير مهيّأة — التطبيق يشتغل محلياً + روابط المشاركة"; el.className = "fine"; return; }
  el.textContent = S.room ? `عائلتك متصلة · الرمز: ${S.room}` : "جاهز للمزامنة — علّم كاميرا أو شارك رابط الدعوة لإنشاء عائلتك";
  el.className = "fine sync-on";
}

// minimal support/debug handle (also used to verify sync without the UI)
window.__ASHAR.sync = { join: joinRoom, reconcile: pullAndReconcile, room: () => S.room, count: () => S.cams.length };
window.__ASHAR.dbg = { map: () => map, rendered: () => Object.keys(camMarkers).length };

// ---------- iOS install hint ----------
function iosInstallHint() {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (isIOS && !standalone && !localStorage.getItem("ashar.iosHintDone")) {
    $("iosHint").classList.add("show");
  }
}
$("iosHintClose").addEventListener("click", () => {
  localStorage.setItem("ashar.iosHintDone", "1");
  $("iosHint").classList.remove("show");
});

// ---------- wake lock ----------
let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { keepAwake(); hideOverlay(); }
  else if (S.trip && overlayPlugin()) showOverlay(); // backgrounded mid-trip → float over Maps
});

// ---------- demo mode ----------
function startDemo(fast = 1) {
  const inJeddah = (c) => c.lat >= 21.2 && c.lat <= 21.95 && c.lon >= 39.0 && c.lon <= 39.4;
  let chain = S.cams.filter(inJeddah).sort((a, b) => a.lat - b.lat).slice(0, 8);
  if (chain.length < 2) { toast("ما فيه كاميرات كافية للتجربة"); return; }
  // start 2 km south of the first camera, then thread through the chain
  const first = chain[0];
  const approach = destPoint(first.lat, first.lon, 190, 2000);
  const pts = [{ lat: approach[0], lon: approach[1] }, ...chain.map((c) => ({ lat: c.lat, lon: c.lon }))];
  // continue 2 km past the last one
  const last = chain[chain.length - 1];
  const prev = pts[pts.length - 2];
  const exitBrg = bearing(prev.lat, prev.lon, last.lat, last.lon);
  const exit = destPoint(last.lat, last.lon, exitBrg, 2000);
  pts.push({ lat: exit[0], lon: exit[1] });

  const SPEED = 33.3; // m/s ≈ 120 km/h
  const STEP = 0.6 / fast; // seconds of wall-clock per tick
  const ADV = SPEED * 0.6; // meters advanced per tick (sim time fixed)
  let seg = 0, off = 0, t = Date.now();
  $("demoBadge").classList.add("show");
  S.demo = setInterval(() => {
    let a = pts[seg], b = pts[seg + 1];
    let segLen = haversine(a.lat, a.lon, b.lat, b.lon);
    off += ADV;
    while (off >= segLen && seg < pts.length - 2) {
      off -= segLen; seg++;
      a = pts[seg]; b = pts[seg + 1];
      segLen = haversine(a.lat, a.lon, b.lat, b.lon);
    }
    if (off >= segLen && seg >= pts.length - 2) { stopDemo(); return; }
    const brg = bearing(a.lat, a.lon, b.lat, b.lon);
    const p = destPoint(a.lat, a.lon, brg, off);
    t += 600; // sim-clock advances 0.6 s per tick regardless of fast factor
    handleFix({ lat: p[0], lon: p[1], acc: 8, kmh: SPEED * 3.6, heading: brg, ts: t });
  }, STEP * 1000);
}
function stopDemo() {
  clearInterval(S.demo); S.demo = null;
  $("demoBadge").classList.remove("show");
  console.log("ASHAR_DEMO_END", JSON.stringify({ alerts: window.__ASHAR.alerts.length }));
  endTripAndReport();
}

// ---------- boot ----------
async function boot() {
  await loadCams();
  initMap();
  applySettings();
  bindToggle("setSound", "sound");
  bindToggle("setVoice", "voice");
  bindToggle("setStrict", "strictDir");
  bindToggle("setSafety", "safety");
  renderList("paneNear");

  $("setName").value = familyName();
  $("setName").addEventListener("change", () => {
    localStorage.setItem("ashar.name", $("setName").value.trim().slice(0, 20));
    localStorage.setItem("ashar.nameAsked", "1");
  });

  // speed-limit chip + presets
  updateLimitChip(S.limit, false);
  $("limitChip").addEventListener("click", () => $("limitPop").classList.toggle("show"));
  $("limitPop").innerHTML = LIMIT_PRESETS.map((p) => `<button class="lp" data-lim="${p}">${p}</button>`).join("");
  $("limitPop").addEventListener("click", (e) => {
    const b = e.target.closest(".lp");
    if (b) { setLimit(+b.dataset.lim); toast(`الحد ${b.dataset.lim} كم/س`); }
  });
  $("setLimit").value = S.limit;
  $("setLimit").addEventListener("change", () => setLimit(clamp(parseInt($("setLimit").value) || 120, 30, 180)));
  $("goneBtn").addEventListener("click", reportGone);
  $("btnEndTrip").addEventListener("click", () => { sheet.classList.remove("open"); endTripAndReport(); });
  $("tripClose").addEventListener("click", () => $("tripReport").classList.remove("show"));

  window.addEventListener("resize", () => { map.invalidateSize(); refreshMarkers(); });
  importFromHash();
  iosInstallHint();
  updateSyncUI();
  loadSeed(); // shared SCDB reference (once + cached) — independent of family room
  if (syncEnabled() && S.room) { pullAndReconcile().catch(() => {}); startPoll(); }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && syncEnabled() && S.room) pullAndReconcile().catch(() => {});
  });

  const params = new URLSearchParams(location.search);
  const begin = (demo) => {
    $("startOverlay").classList.add("gone");
    // the map was created behind the overlay; make sure Leaflet knows its real
    // size now so viewport marker rendering works from the first frame
    map.invalidateSize();
    refreshMarkers();
    snd.unlock();
    keepAwake();
    startTrip();
    // ask once for the "draw over other apps" permission so the bubble can
    // float over Google Maps when backgrounded
    if (!demo && overlayPlugin() && !localStorage.getItem("ashar.overlayAsked")) {
      localStorage.setItem("ashar.overlayAsked", "1");
      ensureOverlayPermission();
    }
    if (demo) startDemo(+params.get("fast") || (params.get("demo") ? 4 : 1));
    else startGPS();
  };
  $("startBtn").addEventListener("click", () => begin(false));
  $("demoBtn").addEventListener("click", () => begin(true));
  $("demoBadge").addEventListener("click", stopDemo);

  if (params.get("demo")) begin(true);

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}
boot();
