// Turns a hand-drawn stroke (normalised 0..1 points) into a shape: circle | rect | tri | line.
// Returns null when the stroke is not clearly one of those (so no random shapes get created).
const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const off = (p, a, b) => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / (d(a, b) || 1e-9);
function rdp(p, e) {
  if (p.length < 3) return p;
  let m = 0, k = 0;
  for (let i = 1; i < p.length - 1; i++) { const h = off(p[i], p[0], p[p.length - 1]); if (h > m) { m = h; k = i; } }
  return m > e ? [...rdp(p.slice(0, k + 1), e).slice(0, -1), ...rdp(p.slice(k), e)] : [p[0], p[p.length - 1]];
}
// count real corners of a closed stroke (ignores points that lie on a straight edge)
function corners(pts, e) {
  let k = 0; pts.forEach((p, i) => { if (d(p, pts[0]) > d(pts[k], pts[0])) k = i; });
  const poly = [...rdp(pts.slice(0, k + 1), e).slice(0, -1), ...rdp(pts.slice(k), e).slice(0, -1)];
  let n = 0;
  poly.forEach((b, i) => {
    const a = poly[(i + poly.length - 1) % poly.length], c = poly[(i + 1) % poly.length];
    const v1 = { x: b.x - a.x, y: b.y - a.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
    const cos = (v1.x * v2.x + v1.y * v2.y) / ((Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y)) || 1e-9);
    if (Math.acos(Math.max(-1, Math.min(1, cos))) > 0.5) n++;
  });
  return n;
}
export function recognize(pts) {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const w = x1 - x0, h = y1 - y0, diag = Math.hypot(w, h);
  if (diag < 0.08) return null;
  let len = 0; for (let i = 1; i < pts.length; i++) len += d(pts[i - 1], pts[i]);
  const first = pts[0], last = pts[pts.length - 1], gap = d(first, last);
  const base = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w, h, closed: gap < 0.2 * len };
  const free = { ...base, type: 'free' };
  if (gap / len > 0.8) {                                   // open + straight -> line
    const bend = Math.max(...pts.map(p => off(p, first, last)));
    return bend < 0.18 * gap ? { ...base, type: 'line' } : free;
  }
  if (gap > 0.35 * len) return free;                       // open curve -> free-form 3D tube
  let area = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; area += a.x * b.y - b.x * a.y; }
  const circ = (4 * Math.PI * Math.abs(area / 2)) / (len + gap) ** 2;
  if (circ > 0.8) return { ...base, type: 'circle' };
  const n = corners(pts, diag * 0.1);
  if (n === 3) return { ...base, type: 'tri' };
  if (n === 4 || (n === 5 && circ < 0.72)) return { ...base, type: 'rect' };
  return free;
}