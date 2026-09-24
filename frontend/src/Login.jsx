import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { startCam, stopCam, snap } from './camera.js';

export default function Login({ onAuth }) {
  const [tab, setTab] = useState('scan');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('Starting camera...');
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const v = useRef(), live = useRef(true), cancel = useRef(false);

  // camera only shows a preview; nothing is scanned until you press the button
  useEffect(() => {
    let s; live.current = true;
    (async () => {
      try { s = await startCam(v.current); if (!live.current) return stopCam(s); setMsg('Camera ready. Press Scan & login.'); }
      catch { setMsg('Camera blocked. Allow camera access and reload.'); }
    })();
    return () => { live.current = false; cancel.current = true; stopCam(s); };
  }, []);

  function switchTab(t) { cancel.current = true; setScanning(false); setTab(t); setMsg(t === 'scan' ? 'Press Scan & login when you are ready.' : 'Type your name, then save your face.'); }

  async function scan() {
    if (scanning) return;
    cancel.current = false; setScanning(true);
    let last = 'Face not recognised. Register it in the New face tab.';
    for (let i = 0; i < 6 && !cancel.current && live.current; i++) {   // up to 6 tries, then stop
      setMsg(`Scanning... (${i + 1}/6)`);
      try {
        const r = await api.login(snap(v.current));
        if (r.match) { setMsg(`Welcome back, ${r.name}`); return onAuth(r); }
        last = r.reason === 'no_face' ? 'No face found. Look at the camera and try again.' : 'Face not recognised. Register it in the New face tab.';
      } catch (e) { last = 'Backend not reachable: ' + e.message; break; }
      await new Promise(r => setTimeout(r, 900));
    }
    if (live.current && !cancel.current) { setScanning(false); setMsg(last); }
  }

  async function register() {
    if (!name.trim()) return setMsg('Type your name first.');
    setBusy(true); setMsg('Hold still, capturing...');
    const imgs = [];
    for (let i = 0; i < 4; i++) { imgs.push(snap(v.current)); await new Promise(r => setTimeout(r, 450)); }
    try { await api.register(name.trim(), imgs); setBusy(false); switchTab('scan'); setMsg('Face saved. Press Scan & login.'); }
    catch (e) { setMsg(e.message); setBusy(false); }
  }

  return (
    <div className="login"><div className="card">
      <h1 className="logo">AirForge</h1>
      <p className="sub">Sculpt 3D shapes in mid-air. Your face is the key.</p>
      <div className="tabs">
        <button className={tab === 'scan' ? 'on' : ''} onClick={() => switchTab('scan')}>Face unlock</button>
        <button className={tab === 'reg' ? 'on' : ''} onClick={() => switchTab('reg')}>New face</button>
      </div>
      <div className="cam"><video ref={v} muted playsInline /><i className="br tl" /><i className="br tr" /><i className="br bl" /><i className="br bo" />{scanning && <i className="scan" />}</div>
      <p className="msg mono">{msg}</p>
      {tab === 'scan' && <button className="pri" style={{ width: '100%' }} disabled={scanning} onClick={scan}>{scanning ? 'Scanning...' : 'Scan & login'}</button>}
      {tab === 'reg' && <div className="row"><input type="text" placeholder="Your name" value={name} onChange={e => setName(e.target.value)} /><button className="pri" disabled={busy} onClick={register}>Save my face</button></div>}
    </div></div>
  );
}