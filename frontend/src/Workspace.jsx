import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { api } from './api.js';
import { startCam, stopCam, snap } from './camera.js';
import { recognize } from './shapes.js';

// One-Euro filter: removes jitter when the hand is slow, stays responsive when it moves fast
function oneEuro(minC = 1.5, beta = 8) {
  let x = null, dx = 0; const al = (fc, dt) => { const r = 2 * Math.PI * fc * dt; return r / (r + 1); };
  return { reset() { x = null; dx = 0; }, f(v, dt) { if (x === null) { x = v; return v; } dx += al(1, dt) * ((v - x) / dt - dx); x += al(minC + beta * Math.abs(dx), dt) * (v - x); return x; } };
}
const NAMES = { box: 'Box', sphere: 'Sphere', cone: 'Pyramid', cyl: 'Rod', tube: 'Curve' };
const COLORS = ['#4ff0d2', '#ffb454', '#a78bfa', '#f472b6', '#60a5fa', '#a3e635'];
const COLS = ['#ffb454', '#f472b6'];   // hand 1 = amber, hand 2 = pink
const D2R = Math.PI / 180;
const geo = o => o.type === 'tube' ? new THREE.TubeGeometry(new THREE.CatmullRomCurve3(o.path.map(p => new THREE.Vector3(...p)), !!o.closed, 'catmullrom', .5), Math.max(o.path.length * 4, 16), .12, 10, !!o.closed)
  : o.type === 'sphere' ? new THREE.SphereGeometry(.5, Math.max(o.seg, 6), Math.max(o.seg / 2 | 0, 4))
  : o.type === 'cone' ? new THREE.ConeGeometry(.5, 1, o.seg) : o.type === 'cyl' ? new THREE.CylinderGeometry(.5, .5, 1, o.seg) : new THREE.BoxGeometry(1, 1, 1);
const Sl = ({ l, v, min, max, step = .05, on }) => (
  <label className="sl"><span>{l}</span><input type="range" min={min} max={max} step={step} value={v} onChange={e => on(+e.target.value)} /><b className="mono">{(+v).toFixed(1)}</b></label>);
const download = (href, name) => { const a = document.createElement('a'); a.href = href; a.download = name; a.click(); };

export default function Workspace({ user, onLogout }) {
  const [objs, setObjs] = useState([]);
  const [sel, setSel] = useState(null);
  const [gesture, setGesture] = useState(true);
  const [snapOn, setSnapOn] = useState(true);
  const [mode, setMode] = useState('');
  const [status, setStatus] = useState('Loading hand tracker...');
  const [saved, setSaved] = useState('');
  const [locked, setLocked] = useState(false);
  const mount = useRef(), ov = useRef(), vid = useRef();
  const S = useRef({ meshes: new Map() }), gOn = useRef(true), snapRef = useRef(true), lockRef = useRef(false), loaded = useRef(false), count = useRef(0), act = useRef({});
  const hist = useRef({ s: [], i: -1, skip: false });
  gOn.current = gesture; snapRef.current = snapOn;

  const add = useCallback((type, pos = [0, 0, 0], size = [2, 2, 2], rot = [0, 0, 0], extra = {}) => {
    const id = Math.random().toString(36).slice(2, 8), n = ++count.current;
    setObjs(a => [...a, { id, type, name: `${NAMES[type]} ${n}`, pos, size, rot, color: COLORS[n % COLORS.length], edges: type !== 'tube', wire: false, seg: type === 'cone' ? 4 : 24, ...extra }]);
    setSel(id);
  }, []);

  // ---- 3D scene ----
  useEffect(() => {
    const el = mount.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(devicePixelRatio); el.appendChild(renderer.domElement);
    const camera = new THREE.PerspectiveCamera(50, 1, .1, 100); camera.position.set(0, 0, 10);
    const scene = new THREE.Scene(), group = new THREE.Group(); scene.add(group);
    const grid = new THREE.GridHelper(24, 24, 0x4ff0d2, 0x1d4a55); grid.position.y = -4.5; group.add(grid);
    const sp = new Float32Array(900).map(() => (Math.random() - .5) * 70);
    const stars = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(sp, 3)), new THREE.PointsMaterial({ color: 0x8fb4ff, size: .08, transparent: true, opacity: .7 })); scene.add(stars);
    scene.add(new THREE.AmbientLight(0xffffff, .7));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(5, 8, 6); scene.add(sun);
    const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true;
    Object.assign(S.current, { group, camera, renderer, render: () => renderer.render(scene, camera) });
    const fit = () => { const w = el.clientWidth, h = el.clientHeight; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); };
    const ro = new ResizeObserver(fit); ro.observe(el); fit();
    let raf; const loop = () => { raf = requestAnimationFrame(loop); stars.rotation.y += .0006; controls.update(); renderer.render(scene, camera); }; loop();
    let down; const dom = renderer.domElement;
    dom.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
    dom.addEventListener('pointerup', e => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
      const r = dom.getBoundingClientRect(), rc = new THREE.Raycaster();
      rc.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), camera);
      const hit = rc.intersectObjects([...S.current.meshes.values()], false)[0];
      setSel(hit ? hit.object.userData.id : null);
    });
    return () => { cancelAnimationFrame(raf); ro.disconnect(); renderer.dispose(); el.removeChild(dom); };
  }, []);

  // ---- sync React state -> meshes ----
  useEffect(() => {
    const { group, meshes } = S.current, ids = new Set(objs.map(o => o.id));
    meshes.forEach((m, id) => { if (!ids.has(id)) { group.remove(m); m.geometry.dispose(); m.material.dispose(); meshes.delete(id); } });
    objs.forEach(o => {
      let m = meshes.get(o.id); const key = o.type + o.seg + (o.path ? o.path.length + (o.closed ? 'c' : '') : '');
      if (!m || m.userData.key !== key) {
        if (m) { group.remove(m); m.geometry.dispose(); m.material.dispose(); }
        m = new THREE.Mesh(geo(o), new THREE.MeshStandardMaterial({ metalness: .25, roughness: .4 }));
        const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({ color: 0xffffff }));
        m.add(e); m.userData = { id: o.id, key, edge: e }; group.add(m); meshes.set(o.id, m);
      }
      m.position.set(...o.pos); m.scale.set(...o.size); m.rotation.set(...o.rot);
      m.material.color.set(o.color); m.material.wireframe = o.wire; m.material.emissive.set(o.id === sel ? '#27407a' : '#000000');
      m.userData.edge.visible = o.edges;
    });
  }, [objs, sel]);

  // ---- load + autosave scene from MySQL ----
  useEffect(() => { api.scene().then(s => { const l = s.objects || []; hist.current = { s: [JSON.stringify(l)], i: 0, skip: true }; setObjs(l); count.current = l.length; loaded.current = true; setSaved('Loaded'); }).catch(e => setSaved(e.message)); }, []);
  useEffect(() => {
    if (!loaded.current) return;
    setSaved('Saving...');
    const t = setTimeout(() => api.saveScene(objs).then(() => setSaved('Saved'), e => setSaved(e.message)), 1200);
    return () => clearTimeout(t);
  }, [objs]);
  // ---- undo / redo history ----
  useEffect(() => {
    if (!loaded.current) return;
    const h = hist.current; if (h.skip) { h.skip = false; return; }
    const t = setTimeout(() => { const j = JSON.stringify(objs); if (h.s[h.i] === j) return; h.s = h.s.slice(0, h.i + 1); h.s.push(j); if (h.s.length > 60) h.s.shift(); h.i = h.s.length - 1; }, 400);
    return () => clearTimeout(t);
  }, [objs]);

  // ---- keep checking that the person in front is still the logged-in user ----
  useEffect(() => {
    let bad = 0;
    const t = setInterval(async () => {
      if (!vid.current?.videoWidth) return;
      try { const r = await api.verify(snap(vid.current)); bad = r.match ? 0 : bad + 1; lockRef.current = bad >= 2; setLocked(bad >= 2); } catch {}
    }, 5000);
    return () => clearInterval(t);
  }, []);

  // ---- two-hand tracking ----
  useEffect(() => {
    let dead = false, stream, hl, raf, lastT = -1, lastTs = performance.now(), curMode = '', nid = 0, two = null, zoom = null, ar = 1.33;
    const H = {}, v = vid.current, c = ov.current, ctx = c.getContext('2d');
    const newH = () => ({ pen: false, pts: [], pinchN: 0, relN: 0, fistN: 0, lost: 0, prev: null, grab: null, hold: null, dw: null, cool: 0, fx: oneEuro(), fy: oneEuro(), lm: null, pl: null, s0: 1, size: 1 });
    const setM = m => { if (m !== curMode) { curMode = m; setMode(m); } };
    const D = (a, b) => Math.hypot((a.x - b.x) * ar, a.y - b.y, (a.z - b.z) * ar);   // aspect-correct 3D distance
    const ray = new THREE.Raycaster(), plane = new THREE.Plane(), tmp = new THREE.Vector3();
    const rayHit = (nx, ny) => { ray.setFromCamera(new THREE.Vector2(nx * 2 - 1, -(ny * 2 - 1)), S.current.camera); return ray.intersectObjects([...S.current.meshes.values()], false)[0]; };
    // screen point (0..1) -> world point on the plane through the origin facing the camera; zo pushes it toward/away from camera
    const pickW = (nx, ny, zo = 0) => {
      const { camera } = S.current; ray.setFromCamera(new THREE.Vector2(nx * 2 - 1, -(ny * 2 - 1)), camera);
      const toward = camera.getWorldDirection(new THREE.Vector3()).negate();
      plane.setFromNormalAndCoplanarPoint(toward, new THREE.Vector3());
      const p = ray.ray.intersectPlane(plane, new THREE.Vector3()) || new THREE.Vector3();
      return p.addScaledVector(toward, zo);
    };
    const toLocal = p => S.current.group.worldToLocal(p.clone());
    const L = (nx, ny, zo = 0) => toLocal(pickW(nx, ny, zo));
    const ring = (x, y, p, col, txt) => { ctx.beginPath(); ctx.arc(x, y, 22, -Math.PI / 2, -Math.PI / 2 + p * 2 * Math.PI); ctx.strokeStyle = col; ctx.lineWidth = 4; ctx.stroke(); if (txt) { ctx.fillStyle = col; ctx.font = '12px monospace'; ctx.fillText(txt, x + 28, y + 4); } };

    function classify(lm, size, r) {
      const e = [[8, 6], [12, 10], [16, 14], [20, 18]].map(([t, p]) => D(lm[t], lm[0]) > D(lm[p], lm[0]) * 1.03), n = e.filter(Boolean).length;
      if (r < .32 && D(lm[8], lm[0]) > D(lm[5], lm[0])) return 'pinch';
      if (n === 0) return lm[4].y < lm[0].y - size * .55 && lm[4].y < lm[3].y ? 'thumb' : r > .4 ? 'fist' : 'none';
      if (e[0] && !e[1] && !e[2] && !e[3]) return 'point';
      if (e[0] && e[1] && !e[2] && !e[3]) return 'peace';
      return n === 4 ? 'open' : 'none';
    }
    function commit(h) {
      let p = h.pts; h.pts = [];
      if (p.length >= 16) p = p.slice(3, -4);                       // drop pinch-in / release drift
      if (p.length < 10) return setStatus('Stroke too short. Draw slower and bigger.');
      const s = recognize(p); if (!s) return setStatus('Stroke too small.');
      if (!snapRef.current) s.type = 'free';
      const opt = { color: h.col }, X = s.cx, Y = s.cy;
      const wd = Math.max(.3, pickW(X - s.w / 2, Y).distanceTo(pickW(X + s.w / 2, Y))), ht = Math.max(.3, pickW(X, Y - s.h / 2).distanceTo(pickW(X, Y + s.h / 2)));
      if (s.type === 'circle') { const r = (wd + ht) / 2; add('sphere', L(X, Y).toArray(), [r, r, r], [0, 0, 0], opt); }
      else if (s.type === 'rect') add('box', L(X, Y).toArray(), [wd, ht, Math.min(wd, ht)], [0, 0, 0], opt);
      else if (s.type === 'tri') add('cone', L(X, Y).toArray(), [wd, ht, wd], [0, 0, 0], opt);
      else if (s.type === 'line') {
        const a = L(p[0].x, p[0].y), b = L(p[p.length - 1].x, p[p.length - 1].y), dir = b.clone().sub(a);
        const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize()));
        add('cyl', a.clone().add(b).multiplyScalar(.5).toArray(), [.18, dir.length(), .18], [e.x, e.y, e.z], opt);
      } else {                                                       // free-form 3D curve; hand closer to camera = nearer in 3D
        const st = Math.max(1, Math.floor(p.length / 28)), q = p.filter((_, i) => i % st === 0 || i === p.length - 1);
        const pl = q.map(t => L(t.x, t.y, Math.max(-5, Math.min(5, (t.s / h.s0 - 1) * 8))));
        const ctr = pl.reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(1 / pl.length);
        add('tube', ctr.toArray(), [1, 1, 1], [0, 0, 0], { ...opt, path: pl.map(x => x.sub(ctr).toArray().map(n => +n.toFixed(3))), closed: s.closed });
      }
      setStatus('Created from your stroke: ' + (s.type === 'free' ? 'curve' : s.type));
    }
    function finish(h) {
      if (h.pen) { h.pen = false; commit(h); }
      if (h.grab) {
        const { id, m } = h.grab; h.grab = null; two = null;
        setObjs(a => a.map(o => o.id === id ? { ...o, pos: m.position.toArray(), size: m.scale.toArray(), rot: [m.rotation.x, m.rotation.y, m.rotation.z] } : o));
        Object.values(H).forEach(o => { if (o !== h && o.grab && o.grab.id === id && o.pl) o.grab.off = m.position.clone().sub(o.pl); });
      }
      h.pts = []; h.relN = 0;
    }
    function start(h, nx, ny) {
      h.relN = 0; h.fistN = 0; h.prev = null;
      const hit = rayHit(nx, ny);
      if (hit) { const m = hit.object; h.pl = L(nx, ny); h.grab = { id: m.userData.id, m, off: m.position.clone().sub(h.pl) }; setSel(m.userData.id); }
      else { h.pen = true; h.pts = []; h.s0 = h.size; }
    }
    function drawStroke(h) {
      if (h.pts.length < 2) return;
      ctx.lineWidth = 5; ctx.lineJoin = ctx.lineCap = 'round'; ctx.strokeStyle = h.col; ctx.shadowColor = h.col; ctx.shadowBlur = 20;
      ctx.beginPath(); h.pts.forEach((p, i) => i ? ctx.lineTo(p.x * c.width, p.y * c.height) : ctx.moveTo(p.x * c.width, p.y * c.height)); ctx.stroke(); ctx.shadowBlur = 0;
    }
    function cancelAll() { Object.values(H).forEach(h => { h.pen = false; h.pts = []; if (h.grab) finish(h); }); Object.keys(H).forEach(k => delete H[k]); two = zoom = null; }

    (async () => {
      try {
        stream = await startCam(v); if (dead) return stopCam(stream);
        ar = (v.videoWidth / v.videoHeight) || 1.33;
        const fs = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
        hl = await HandLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task', delegate: 'GPU' }, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: .6, minHandPresenceConfidence: .6, minTrackingConfidence: .6 });
        setStatus('Ready. Show one or both hands.');
      } catch (e) { return setStatus('Camera or hand model failed: ' + e.message); }
      const tick = () => {
        if (dead) return; raf = requestAnimationFrame(tick);
        if (c.width !== c.clientWidth || c.height !== c.clientHeight) { c.width = c.clientWidth; c.height = c.clientHeight; }
        ctx.clearRect(0, 0, c.width, c.height);
        if (!gOn.current || lockRef.current) { if (Object.keys(H).length) cancelAll(); setM(''); return; }
        if (v.readyState < 2 || v.currentTime === lastT) { Object.values(H).forEach(drawStroke); return; }
        lastT = v.currentTime;
        const now = performance.now(), dt = Math.max((now - lastTs) / 1000, .005); lastTs = now;
        const res = hl.detectForVideo(v, now), used = new Set(), hs = [];
        res.landmarks.forEach(lm => {          // match each detected hand to a tracked hand by wrist position (labels can flicker)
          let best = null, bd = .25;
          Object.values(H).forEach(h => { if (!used.has(h) && h.wx !== undefined) { const dd = Math.hypot(lm[0].x - h.wx, lm[0].y - h.wy); if (dd < bd) { bd = dd; best = h; } } });
          if (!best) { best = newH(); best.col = COLS.find(cc => !Object.values(H).some(o => o.col === cc)) || COLS[0]; H[++nid] = best; }
          used.add(best); best.lm = lm; best.lost = 0; best.wx = lm[0].x; best.wy = lm[0].y; hs.push(best);
        });
        Object.keys(H).forEach(k => { const h = H[k]; if (!used.has(h)) { h.lm = null; if (++h.lost > 12) { finish(h); delete H[k]; } else drawStroke(h); } });
        if (!hs.length) { two = zoom = null; setM(''); return; }
        hs.forEach(h => {
          const lm = h.lm; h.size = D(lm[0], lm[9]) || .1; h.r = D(lm[4], lm[8]) / h.size; h.g = classify(lm, h.size, h.r);
          h.sx = h.fx.f((lm[4].x + lm[8].x) / 2, dt); h.sy = h.fy.f((lm[4].y + lm[8].y) / 2, dt);
          lm.forEach((p, i) => { ctx.beginPath(); ctx.arc((1 - p.x) * c.width, p.y * c.height, i === 4 || i === 8 ? 5 : 2.5, 0, 7); ctx.fillStyle = i === 4 || i === 8 ? h.col : h.col + '77'; ctx.fill(); });
        });
        const fists = hs.filter(h => h.g === 'fist'), zooming = fists.length === 2, gr = hs.filter(h => h.grab), twoActive = gr.length === 2 && gr[0].grab.id === gr[1].grab.id, labs = [];
        hs.forEach(h => {
          const lm = h.lm, g = h.g, nx = 1 - h.sx, ny = h.sy, X = nx * c.width, Y = ny * c.height; let t = '';
          if (h.pen || h.grab) { if (h.r > .55) { if (++h.relN >= 4) finish(h); } else h.relN = 0; }   // must stay open 4 frames to end
          else if (g === 'pinch') { if (++h.pinchN >= 2) start(h, nx, ny); } else h.pinchN = 0;
          if (h.pen) { const l = h.pts[h.pts.length - 1]; if (!l || Math.hypot(nx - l.x, ny - l.y) > .002) h.pts.push({ x: nx, y: ny, s: h.size }); drawStroke(h); t = 'Drawing'; }
          else if (h.grab) { h.pl = L(nx, ny); if (!twoActive) h.grab.m.position.copy(h.pl).add(h.grab.off); t = twoActive ? 'Scale + twist' : 'Grab'; }
          else {
            if (g === 'fist' && !zooming) { if (++h.fistN >= 8) { if (h.prev) { const q = S.current.group; q.rotation.y += -(lm[9].x - h.prev.x) * 7; q.rotation.x += (lm[9].y - h.prev.y) * 7; } h.prev = { x: lm[9].x, y: lm[9].y }; t = 'Rotate scene'; } } else { h.fistN = 0; h.prev = null; }
            if (g === 'point') {                                       // point at a figure ~0.7s to select it
              const px = 1 - lm[8].x, py = lm[8].y, hit = rayHit(px, py), id = hit && hit.object.userData.id;
              if (id) { if (!h.dw || h.dw.id !== id) h.dw = { id, t: now }; const p = Math.min(1, (now - h.dw.t) / 700); ring(px * c.width, py * c.height, p, '#4ff0d2', 'select'); if (p >= 1) setSel(id); } else h.dw = null;
              t = 'Pointing';
            } else h.dw = null;
            if (g === 'thumb' || g === 'peace') {                      // hold 1s: thumbs-up = save, peace = delete selected
              if (!h.hold || h.hold.g !== g) h.hold = { g, t: now };
              const p = Math.min(1, (now - h.hold.t) / 1000); ring(X, Y - 40, p, g === 'thumb' ? '#4ff0d2' : '#f87171', g === 'thumb' ? 'save' : 'delete');
              if (p >= 1 && now > h.cool) { h.cool = now + 2000; h.hold = null; g === 'thumb' ? act.current.save() : act.current.del(); }
              t = g === 'thumb' ? 'Hold to save' : 'Hold to delete';
            } else h.hold = null;
          }
          if (t) labs.push((hs.length > 1 ? (h.col === COLS[0] ? 'Amber ' : 'Pink ') : '') + t);
          ctx.beginPath(); ctx.arc(X, Y, h.pen || h.grab ? 9 : 14, 0, 7); ctx.strokeStyle = h.col; ctx.lineWidth = 2; ctx.stroke();
        });
        if (twoActive) {                                               // both hands hold one figure: move, scale, twist
          const [a, b] = gr, m = a.grab.m, dx = (a.sx - b.sx) * ar, dy = a.sy - b.sy, dist = Math.hypot(dx, dy) || .1, ang = Math.atan2(dy, -dx);
          if (!two || two.id !== a.grab.id) two = { id: a.grab.id, d0: dist, a0: ang, s0: m.scale.clone(), r0: m.rotation.z };
          else {
            m.scale.copy(two.s0).multiplyScalar(Math.min(4, Math.max(.2, dist / two.d0))); m.rotation.z = two.r0 - (ang - two.a0);
            if (a.pl && b.pl) m.position.copy(a.pl.clone().add(a.grab.off).add(b.pl.clone().add(b.grab.off)).multiplyScalar(.5));
          }
        } else two = null;
        if (zooming) {                                                 // two fists: spread apart = zoom in
          const dist = Math.hypot((fists[0].lm[0].x - fists[1].lm[0].x) * ar, fists[0].lm[0].y - fists[1].lm[0].y) || .1, cam = S.current.camera;
          if (!zoom) zoom = { d0: dist, l0: cam.position.length() }; else cam.position.setLength(Math.min(28, Math.max(4, zoom.l0 * zoom.d0 / dist)));
          labs.push('Zoom');
        } else zoom = null;
        setM(labs.join('  |  '));
      };
      tick();
    })();
    return () => { dead = true; cancelAnimationFrame(raf); hl && hl.close(); stopCam(stream); };
  }, [add]);

  const saveNow = () => { setSaved('Saving...'); api.saveScene(objs).then(() => setSaved('Saved'), e => setSaved(e.message)); };
  const del = () => { if (!sel) return setStatus('Select a figure first (click it or point at it).'); setObjs(a => a.filter(x => x.id !== sel)); setSel(null); };
  const jump = d => { const h = hist.current, i = h.i + d; if (i < 0 || i >= h.s.length) return; h.i = i; h.skip = true; setObjs(JSON.parse(h.s[i])); setSel(null); };
  const clearAll = () => { if (objs.length && window.confirm('Delete all figures?')) { setObjs([]); setSel(null); } };
  const exportSTL = () => { const g = S.current.group; g.updateMatrixWorld(true); download(URL.createObjectURL(new Blob([new STLExporter().parse(g)], { type: 'model/stl' })), 'airforge.stl'); };
  const shot = () => { S.current.render(); download(S.current.renderer.domElement.toDataURL('image/png'), 'airforge.png'); };
  act.current = { save: saveNow, del };
  useEffect(() => {
    const k = e => {
      if (e.target.tagName === 'INPUT') return;
      if (e.key === 'Delete') del();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); jump(-1); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); jump(1); }
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  });

  const o = objs.find(x => x.id === sel);
  const upd = p => setObjs(a => a.map(x => x.id === sel ? { ...x, ...p } : x));
  const arr = (k, i, val) => upd({ [k]: o[k].map((n, j) => j === i ? val : n) });

  return (
    <div className="app">
      <header className="top">
        <span className="logo">AirForge</span><span className="pill ok">{user}</span>
        <span className="pill mono">{saved}</span><span className="sp" />
        <button onClick={saveNow}>Save</button><button onClick={() => jump(-1)}>Undo</button><button onClick={() => jump(1)}>Redo</button>
        <button onClick={del} disabled={!sel}>Delete</button><button onClick={clearAll} disabled={!objs.length}>Clear all</button>
        <button className={snapOn ? 'on' : ''} onClick={() => setSnapOn(s => !s)} title="On: circles/boxes/triangles/lines snap to solid shapes. Off: every stroke becomes a free 3D curve.">Snap shapes {snapOn ? 'on' : 'off'}</button>
        <button onClick={exportSTL} disabled={!objs.length}>Export STL</button><button onClick={shot}>Save image</button>
        <button className={gesture ? 'on' : ''} onClick={() => setGesture(g => !g)}>Hand control {gesture ? 'on' : 'off'}</button>
        <button onClick={onLogout}>Lock</button>
      </header>
      <div className="main">
        <section className="stage">
          <div className="gl" ref={mount} /><canvas className="ov" ref={ov} />
          <video className="pip" ref={vid} muted playsInline />
          {mode && <div className="mode mono">{mode}</div>}
          <div className="hint mono"><b>Pinch</b> in empty space: draw (both hands work)<br /><b>Pinch</b> on a figure: grab and move it<br /><b>Both hands</b> on one figure: scale and twist<br /><b>Move hand closer</b> while drawing a curve: it goes deeper in 3D<br /><b>Point</b> 0.7s: select &nbsp;<b>Thumbs-up</b> 1s: save &nbsp;<b>Peace</b> 1s: delete<br /><b>Fist</b>: spin scene &nbsp;<b>Two fists</b>: zoom<br /><span>{status}</span></div>
          {locked && <div className="lockov"><div><h2>Face not recognised</h2><p>Hand control is paused until {user} is back in view.</p></div></div>}
        </section>
        <aside className="panel">
          <div><h3>Add shape</h3><div className="grid">{['box', 'sphere', 'cone', 'cyl'].map(t => <button key={t} onClick={() => add(t)}>{NAMES[t]}</button>)}</div>
            <button style={{ marginTop: 6, width: '100%' }} onClick={() => { S.current.group.rotation.set(0, 0, 0); S.current.camera.position.set(0, 0, 10); }}>Reset view</button></div>
          <div><h3>Your figures ({objs.length})</h3>
            <div className="chips">{objs.map(x => <button key={x.id} className={x.id === sel ? 'on' : ''} onClick={() => setSel(x.id)}>{x.name}</button>)}</div>
            {!objs.length && <p className="empty">Nothing here yet. Pinch in the air and draw a shape or a curve, or use Add shape.</p>}</div>
          {o && <div><h3>Edit {o.name}</h3>
            <input type="text" value={o.name} onChange={e => upd({ name: e.target.value })} style={{ width: '100%', marginBottom: 8 }} />
            <Sl l={o.type === 'tube' ? 'Scale X' : 'Length'} v={o.size[0]} min={.1} max={12} on={v => arr('size', 0, v)} />
            <Sl l={o.type === 'tube' ? 'Scale Y' : 'Height'} v={o.size[1]} min={.1} max={12} on={v => arr('size', 1, v)} />
            <Sl l={o.type === 'tube' ? 'Scale Z' : 'Breadth'} v={o.size[2]} min={.1} max={12} on={v => arr('size', 2, v)} />
            {o.type !== 'box' && o.type !== 'tube' && <Sl l="Edges" v={o.seg} min={3} max={48} step={1} on={v => upd({ seg: v })} />}
            <Sl l="Move X" v={o.pos[0]} min={-10} max={10} on={v => arr('pos', 0, v)} />
            <Sl l="Move Y" v={o.pos[1]} min={-10} max={10} on={v => arr('pos', 1, v)} />
            <Sl l="Move Z" v={o.pos[2]} min={-10} max={10} on={v => arr('pos', 2, v)} />
            <Sl l="Tilt X" v={o.rot[0] / D2R} min={-180} max={180} step={1} on={v => arr('rot', 0, v * D2R)} />
            <Sl l="Tilt Y" v={o.rot[1] / D2R} min={-180} max={180} step={1} on={v => arr('rot', 1, v * D2R)} />
            <Sl l="Tilt Z" v={o.rot[2] / D2R} min={-180} max={180} step={1} on={v => arr('rot', 2, v * D2R)} />
            <div className="tg"><input type="color" value={o.color} onChange={e => upd({ color: e.target.value })} />
              <button className={o.edges ? 'on' : ''} onClick={() => upd({ edges: !o.edges })}>Outline</button>
              <button className={o.wire ? 'on' : ''} onClick={() => upd({ wire: !o.wire })}>Wireframe</button></div>
            <div className="tg" style={{ marginTop: 10 }}>
              <button onClick={() => add(o.type, o.pos.map((n, i) => n + (i < 2 ? .8 : 0)), [...o.size], [...o.rot], { color: o.color, path: o.path, closed: o.closed, seg: o.seg, edges: o.edges, wire: o.wire })}>Duplicate</button>
              <button onClick={del}>Delete</button></div>
          </div>}
        </aside>
      </div>
    </div>
  );
}