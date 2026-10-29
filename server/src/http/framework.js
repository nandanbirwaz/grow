import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { ValidationError } from '../lib/validate.js';
import { DuplicateError } from '../store/schema.js';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const MAX_BODY = 100 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json',
};

/** In-process fixed-window rate limiter. Keyed per client; resets on restart (documented limitation). */
export function createRateLimiter() {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, 60_000);
  timer.unref();
  return {
    check(key, { max, windowMs }, now = Date.now()) {
      let e = hits.get(key);
      if (!e || e.resetAt <= now) { e = { count: 0, resetAt: now + windowMs }; hits.set(key, e); }
      e.count += 1;
      return { allowed: e.count <= max, retryAfter: Math.ceil((e.resetAt - now) / 1000), remaining: Math.max(0, max - e.count) };
    },
    clear() { hits.clear(); },
    stop() { clearInterval(timer); },
  };
}

export class Router {
  constructor() { this.routes = []; }
  add(method, path, ...handlers) {
    const keys = [];
    const rx = new RegExp(`^${path.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    this.routes.push({ method, rx, keys, handlers });
  }
  get(p, ...h) { this.add('GET', p, ...h); }
  post(p, ...h) { this.add('POST', p, ...h); }
  put(p, ...h) { this.add('PUT', p, ...h); }
  delete(p, ...h) { this.add('DELETE', p, ...h); }
  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.rx.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return { route: null, pathMatched };
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new ApiError(413, 'payload_too_large', 'Request body too large');
    chunks.push(c);
  }
  if (!size) return {};
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json')) throw new ApiError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError(400, 'invalid_json', 'Body is not valid JSON'); }
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

/** Response result helpers. Handlers return a plain object (JSON 200) or one of these. */
export const csv = (filename, text) => ({ __raw: true, status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` }, body: text });
export const json = (status, body, headers = {}) => ({ __raw: true, status, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

export function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader('Cache-Control', 'no-store');
}

export async function serveStatic(staticDir, pathname, res) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(staticDir, rel);
  if (!file.startsWith(staticDir + sep) && file !== staticDir) return false;
  try {
    const s = await stat(file);
    if (s.isDirectory()) file = join(file, 'index.html');
  } catch {
    // SPA fallback (only for extensionless paths)
    if (extname(pathname)) return false;
    file = join(staticDir, 'index.html');
  }
  try {
    const buf = await readFile(file);
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', file.includes(`${sep}assets${sep}`) ? 'public, max-age=3600' : 'no-cache');
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

export function errorToResponse(e) {
  if (e instanceof ApiError) return { status: e.status, body: { error: e.code, message: e.message, details: e.details } };
  if (e instanceof ValidationError) return { status: 400, body: { error: 'validation_failed', message: 'Request validation failed', details: e.errors } };
  if (e instanceof DuplicateError) return { status: 409, body: { error: 'duplicate', message: 'Duplicate record' } };
  return { status: 500, body: { error: 'internal_error', message: 'Something went wrong' } };
}

export { readJson };
