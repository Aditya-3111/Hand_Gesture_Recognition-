// Turns a hand-drawn stroke into a shape: circle | rect | tri | line | free (3D curve).
// pts: [{x,y}] in 0..1 screen-fraction units. ar: video width/height, used to make
// distances/angles physically correct (a screen fraction in x covers more real
// distance than the same fraction in y when the frame isn't square).
const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const off = (p, a, b) => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / (d(a, b) || 1e-9);
function rdp(p, e) {
  if (p.length < 3) return p;
  let m = 0, k = 0;
  for (let i = 1; i < p.length - 1; i++) { const h = off(p[i], p[0], p[p.length - 1]); if (h > m) { m = h; k = i; } }
  return m > e ? [...rdp(p.slice(0, k + 1), e).slice(0, -1), ...rdp(p.slice(k), e)] : [p[0], p[p.length - 1]];
}
// count real corners of a closed stroke (perimeter-relative epsilon, angle-based)
function corners(pts, per) {
  let k = 0; pts.forEach((p, i) => { if (d(p, pts[0]) > d(pts[k], pts[0])) k = i; });
  const e = Math.max(per * 0.045, 1e-4);
  const poly = [...rdp(pts.slice(0, k + 1), e).slice(0, -1), ...rdp(pts.slice(k), e).slice(0, -1)];
  let n = 0;
  poly.forEach((b, i) => {
    const a = poly[(i + poly.length - 1) % poly.length], c = poly[(i + 1) % poly.length];
    const v1 = { x: b.x - a.x, y: b.y - a.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
    const l1 = Math.hypot(v1.x, v1.y), l2 = Math.hypot(v2.x, v2.y);
    if (l1 < per * 0.03 || l2 < per * 0.03) return;              // ignore tiny wobble segments
    const cos = (v1.x * v2.x + v1.y * v2.y) / ((l1 * l2) || 1e-9);
    if (Math.acos(Math.max(-1, Math.min(1, cos))) > 0.6) n++;    // ~34 degrees+
  });
  return n;
}
export function recognize(raw, ar = 1) {
  if (raw.length < 6) return null;
  const pts = raw.map(p => ({ x: p.x * ar, y: p.y })); // physically-correct space for geometry
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const w = x1 - x0, h = y1 - y0, diag = Math.hypot(w, h);
  const rx0 = Math.min(...raw.map(p => p.x)), rx1 = Math.max(...raw.map(p => p.x));
  const ry0 = Math.min(...raw.map(p => p.y)), ry1 = Math.max(...raw.map(p => p.y));
  const base = { cx: (rx0 + rx1) / 2, cy: (ry0 + ry1) / 2, w: rx1 - rx0, h: ry1 - ry0 };
  if (diag < 0.07) return null;
  let len = 0; for (let i = 1; i < pts.length; i++) len += d(pts[i - 1], pts[i]);
  const first = pts[0], last = pts[pts.length - 1], gap = d(first, last);
  const free = { ...base, type: 'free', closed: gap < 0.22 * len };
  if (gap / len > 0.78) {                                  // open + straight -> line
    const bend = Math.max(...pts.map(p => off(p, first, last)));
    return bend < 0.16 * Math.max(gap, diag) ? { ...base, type: 'line' } : free;
  }
  if (gap > 0.3 * len) return free;                        // open curve -> free-form 3D tube
  let area = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; area += a.x * b.y - b.x * a.y; }
  const per = len + gap, circ = (4 * Math.PI * Math.abs(area / 2)) / (per * per);
  const n = corners(pts, per);
  if (circ > 0.82 && n <= 1) return { ...base, type: 'circle' };
  if (n === 3) return { ...base, type: 'tri' };
  if (n === 4 || n === 5) return { ...base, type: 'rect' };
  if (circ > 0.72) return { ...base, type: 'circle' };
  return free;
}