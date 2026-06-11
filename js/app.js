import { haversine, bearing, angDiff, destPoint, fmtDist, clamp } from "./geo.js";
import { Sounder } from "./audio.js";

const VERSION = "1.0.0";
const CORRIDOR = { latMin: 21.2, latMax: 24.35, lonMin: 37.6, lonMax: 39.5 }; // جدة–ينبع
const MIN_ALERT_KMH = 25;

// ---------- state ----------
const S = {
  cams: [],            // {id,lat,lon,sp,dir,src,heading?}
  fix: null,           // {lat,lon,acc,kmh,heading,ts}
  derived: null,       // last point used to derive heading
  follow: true,
  alerted: {},         // id -> {stage, prevDist, overAt}
  activeId: null,
  demo: null,
  settings: { sound: true, voice: true, strictDir: false },
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
  localStorage.setItem("ashar.usercams.v1",
    JSON.stringify(S.cams.filter((c) => c.src !== "osm")));
}

async function loadCams() {
  let base = [];
  try {
    const r = await fetch("data/cameras.json");
    const j = await r.json();
    base = j.cams.map((c, i) => ({ id: "o" + i, lat: c[0], lon: c[1], sp: c[2], dir: c[3], src: "osm" }));
  } catch (e) { console.warn("cameras.json load failed", e); }
  const user = loadUserCams();
  S.cams = base.concat(user);
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

  for (const c of S.cams) addCamMarker(c);

  userMarker = L.marker([21.54, 39.19], {
    icon: L.divIcon({ className: "me-wrap", html: '<div class="me-cone" id="meCone"></div><div class="me-dot"></div>', iconSize: [44, 44], iconAnchor: [22, 22] }),
    interactive: false, keyboard: false,
  });
  accCircle = L.circle([21.54, 39.19], { radius: 30, weight: 0, fillColor: "#ffb347", fillOpacity: 0.08, interactive: false });
}

function camIconHtml(c) {
  const inner = c.sp ? c.sp : "&#9679;";
  return `<div class="cam-sign ${c.src !== "osm" ? "mine" : ""}">${inner}</div>`;
}
function addCamMarker(c) {
  const m = L.marker([c.lat, c.lon], {
    icon: L.divIcon({ className: "cam-wrap", html: camIconHtml(c), iconSize: [30, 30], iconAnchor: [15, 15] }),
    keyboard: false,
  });
  if (c.src !== "osm") {
    m.bindPopup(`<div class="pop"><b>كاميرا (أنت أضفتها)</b><br>الحد: ${c.sp || "غير محدد"}<br><button class="pop-del" data-id="${c.id}">حذف</button></div>`);
  } else {
    m.bindPopup(`<div class="pop"><b>ساهر</b><br>الحد: ${c.sp || "غير معروف"}${c.dir >= 0 ? "<br>اتجاهية" : ""}<br><span class="pop-src">المصدر: OSM</span></div>`);
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
});

// ---------- GPS ----------
let watchId = null;
function startGPS() {
  if (!("geolocation" in navigator)) { gpsStatus("bad", "المتصفح ما يدعم الموقع"); return; }
  watchId = navigator.geolocation.watchPosition(onGeo, onGeoErr, {
    enableHighAccuracy: true, maximumAge: 1000, timeout: 15000,
  });
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

// derive heading/speed from movement when the device doesn't report them
function enrich(fix) {
  const d = S.derived;
  if (d) {
    const dist = haversine(d.lat, d.lon, fix.lat, fix.lon);
    const dt = (fix.ts - d.ts) / 1000;
    if (dist >= 12 && dt > 0.4) {
      if (fix.heading == null) fix.heading = bearing(d.lat, d.lon, fix.lat, fix.lon);
      if (fix.kmh == null) fix.kmh = clamp((dist / dt) * 3.6, 0, 220);
      S.derived = { lat: fix.lat, lon: fix.lon, ts: fix.ts };
    } else {
      if (fix.heading == null && S.fix) fix.heading = S.fix.heading;
      if (fix.kmh == null) fix.kmh = dt > 3 ? 0 : S.fix ? S.fix.kmh : 0;
    }
  } else {
    S.derived = { lat: fix.lat, lon: fix.lon, ts: fix.ts };
  }
  if (fix.kmh == null) fix.kmh = 0;
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
    $("nextMini").textContent = `أقرب ساهر قدامك: ${fmtDist(best.dist)}`;
  } else {
    $("nextMini").textContent = "ما فيه كاميرات قدامك بنطاق 2.5 كم";
  }

  if (!best || fix.kmh < MIN_ALERT_KMH) {
    if (!best) clearAlertUI();
    document.body.classList.remove("over");
    $("speedVal").classList.remove("bad", "warn");
    return;
  }

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

  // overspeed handling near an active camera
  const over = st.stage > 0 && cam.sp > 0 && fix.kmh > cam.sp + 3 && dist <= d1;
  document.body.classList.toggle("over", over);
  $("speedVal").classList.toggle("bad", over);
  $("speedVal").classList.toggle("warn", !over && st.stage > 0);
  if (over) {
    const now = Date.now();
    if (now - (st.overAt || 0) > 2500) { st.overAt = now; snd.overspeed(); }
    snd.speak("خفف السرعة", "over", 8000);
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
  document.body.classList.remove("over");
  if (passed) { snd.ok(); }
  S.activeId = null;
}

// ---------- add camera (one tap) ----------
let lastAdded = null;
$("fabCam").addEventListener("click", () => {
  if (!S.fix) { toast("بانتظار إشارة GPS…"); return; }
  const c = {
    id: "u" + Date.now(), lat: S.fix.lat, lon: S.fix.lon,
    sp: 0, dir: -1, src: "user", heading: S.fix.heading ?? -1, at: new Date().toISOString(),
  };
  S.cams.push(c); addCamMarker(c); saveUserCams();
  lastAdded = c.id;
  toastCam();
  snd.ok();
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
    }
    $("toastCam").classList.remove("show");
  })
);
$("undoCam").addEventListener("click", () => {
  if (!lastAdded) return;
  S.cams = S.cams.filter((c) => c.id !== lastAdded);
  if (camMarkers[lastAdded]) { map.removeLayer(camMarkers[lastAdded]); delete camMarkers[lastAdded]; }
  saveUserCams(); lastAdded = null;
  $("toastCam").classList.remove("show");
  toast("تراجعنا ✓");
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
        <div class="row-sign ${c.src !== "osm" ? "mine" : ""}">${c.sp || "•"}</div>
        <div class="row-txt"><b>${c.src !== "osm" ? "كاميرتك" : "ساهر"}</b><span>${fmtDist(d)}</span></div>
        ${c.src !== "osm" ? `<button class="row-del" data-id="${c.id}">حذف</button>` : ""}
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
  let added = 0;
  for (const p of pts) {
    if (S.cams.some((c) => haversine(c.lat, c.lon, p.lat, p.lon) < 40)) continue;
    const c = { id: "i" + Date.now() + "_" + added, lat: p.lat, lon: p.lon, sp: p.sp, dir: -1, src: "import" };
    S.cams.push(c); addCamMarker(c); added++;
  }
  saveUserCams();
  toast(`أضفنا ${added} كاميرا من الملف`);
  e.target.value = "";
});

// ---------- wake lock ----------
let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") keepAwake();
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
  toast("انتهت التجربة");
  console.log("ASHAR_DEMO_END", JSON.stringify({ alerts: window.__ASHAR.alerts.length }));
}

// ---------- boot ----------
async function boot() {
  await loadCams();
  initMap();
  applySettings();
  bindToggle("setSound", "sound");
  bindToggle("setVoice", "voice");
  bindToggle("setStrict", "strictDir");
  renderList("paneNear");

  const params = new URLSearchParams(location.search);
  const begin = (demo) => {
    $("startOverlay").classList.add("gone");
    snd.unlock();
    keepAwake();
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
