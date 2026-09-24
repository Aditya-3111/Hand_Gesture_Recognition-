let token = '';
export const setToken = t => { token = t; };
async function call(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
export const api = {
  login: image => call('/face/login', 'POST', { image }),
  register: (name, images) => call('/face/register', 'POST', { name, images }),
  verify: image => call('/face/verify', 'POST', { image }),
  scene: () => call('/scene'),
  saveScene: objects => call('/scene', 'PUT', { objects }),
};
