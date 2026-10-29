/** Thin API client. The JWT is held in memory + sessionStorage (cleared when the tab closes). */
let token = (() => { try { return sessionStorage.getItem('gh_token'); } catch { return null; } })();
let onUnauthorized = () => {};

export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };
export function setToken(t) {
  token = t;
  try { t ? sessionStorage.setItem('gh_token', t) : sessionStorage.removeItem('gh_token'); } catch { /* ignore */ }
}
export const hasToken = () => Boolean(token);

export class ApiFailure extends Error {
  constructor(status, body) { super(body?.message || `Request failed (${status})`); this.status = status; this.body = body; }
}

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  if (res.status === 401 && token) { setToken(null); onUnauthorized(); }
  if (!res.ok) throw new ApiFailure(res.status, json);
  return json;
}
export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b = {}) => request('PUT', p, b),
  del: (p, b = {}) => request('DELETE', p, b),
};

/** Download an authenticated CSV export. */
export async function downloadCsv(path, fallbackName) {
  const res = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiFailure(res.status, await res.json().catch(() => null));
  const blob = await res.blob();
  const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = m ? m[1] : fallbackName; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
