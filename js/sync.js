// ============ أسهَر — family sync over Supabase PostgREST ============
// Offline-first: every call is best-effort. If the network or Supabase is down,
// the app keeps working from localStorage; sync just resumes when it can.
// No SDK — plain fetch against PostgREST keeps the PWA tiny and cacheable.

import { CONFIG } from "./config.js";

export function syncEnabled() {
  return !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);
}

const rest = (p) => `${CONFIG.SUPABASE_URL}/rest/v1/${p}`;
const hdrs = (extra = {}) => ({
  apikey: CONFIG.SUPABASE_ANON_KEY,
  Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
  "Content-Type": "application/json",
  ...extra,
});

// random, practically non-enumerable family code (~46 bits)
export function genRoom() {
  let s = "";
  const a = "abcdefghjkmnpqrstuvwxyz23456789"; // no look-alikes
  const buf = new Uint8Array(9);
  crypto.getRandomValues(buf);
  for (const b of buf) s += a[b % a.length];
  return s;
}

// pull all live cameras for a family room
export async function pullCameras(room) {
  if (!syncEnabled() || !room) return [];
  const url = rest(
    `cameras?room=eq.${encodeURIComponent(room)}&deleted=eq.false&select=id,lat,lon,sp,dir,by`
  );
  const r = await fetch(url, { headers: hdrs() });
  if (!r.ok) throw new Error("pull " + r.status);
  return r.json();
}

// upsert one camera (shared with the family)
export async function pushCamera(room, cam) {
  if (!syncEnabled() || !room) return;
  const row = {
    id: cam.id, room,
    lat: +(+cam.lat).toFixed(5), lon: +(+cam.lon).toFixed(5),
    sp: cam.sp | 0, dir: cam.dir ?? -1, by: (cam.by || "").slice(0, 20),
    deleted: false,
  };
  const r = await fetch(rest("cameras?on_conflict=id"), {
    method: "POST",
    headers: hdrs({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify([row]),
  });
  if (!r.ok) throw new Error("push " + r.status);
}

// push many (used when first joining/creating a room to share existing local cams)
export async function pushMany(room, cams) {
  if (!syncEnabled() || !room || !cams.length) return;
  const rows = cams.map((c) => ({
    id: c.id, room,
    lat: +(+c.lat).toFixed(5), lon: +(+c.lon).toFixed(5),
    sp: c.sp | 0, dir: c.dir ?? -1, by: (c.by || "").slice(0, 20), deleted: false,
  }));
  const r = await fetch(rest("cameras?on_conflict=id"), {
    method: "POST",
    headers: hdrs({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error("pushMany " + r.status);
}

// soft-delete so the removal propagates to the rest of the family
export async function removeCamera(room, id) {
  if (!syncEnabled() || !room) return;
  const url = rest(`cameras?id=eq.${encodeURIComponent(id)}&room=eq.${encodeURIComponent(room)}`);
  const r = await fetch(url, {
    method: "PATCH",
    headers: hdrs({ Prefer: "return=minimal" }),
    body: JSON.stringify({ deleted: true }),
  });
  if (!r.ok) throw new Error("remove " + r.status);
}
