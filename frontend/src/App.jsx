import { useState } from 'react';
import Login from './Login.jsx';
import Workspace from './Workspace.jsx';
import { setToken } from './api.js';
export default function App() {
  const [user, setUser] = useState(null);
  const out = () => { setToken(''); setUser(null); };
  return user ? <Workspace user={user} onLogout={out} /> : <Login onAuth={r => { setToken(r.token); setUser(r.name); }} />;
}
