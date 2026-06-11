// Pure geo math — no DOM. All distances in meters, bearings in degrees [0,360).

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => ((r * 180) / Math.PI + 360) % 360;

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x =
    Math.cos(rad(lat1)) * Math.sin(rad(lat2)) -
    Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return deg(Math.atan2(y, x));
}

// smallest angle between two bearings, 0..180
export function angDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// point at `dist` meters from (lat,lon) along bearing `brg`
export function destPoint(lat, lon, brg, dist) {
  const δ = dist / R;
  const θ = rad(brg);
  const φ1 = rad(lat);
  const λ1 = rad(lon);
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ)
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
    );
  return [deg(φ2) > 180 ? deg(φ2) - 360 : deg(φ2), ((deg(λ2) + 540) % 360) - 180];
}

export function fmtDist(m) {
  if (m >= 950) return (m / 1000).toFixed(1).replace(/\.0$/, "") + " كم";
  return Math.round(m / 50) * 50 + " م";
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
