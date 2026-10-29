import { verifyJwt } from '../lib/auth.js';
import { ApiError } from './framework.js';
import { isDay, normalizeSource } from '../lib/util.js';

/** Rate-limit middleware factory. Key = limiter name + client IP. */
export const rl = (name) => (ctx) => {
  const cfg = ctx.config.rateLimits[name];
  const r = ctx.deps.limiter.check(`${name}:${ctx.ip}`, cfg);
  if (!r.allowed) throw new ApiError(429, 'rate_limited', 'Too many requests. Please slow down.', { retryAfterSeconds: r.retryAfter });
};

/** Auth middleware factory: requires a valid JWT with one of the given roles. */
export const auth = (...roles) => (ctx) => {
  const h = ctx.req.headers.authorization || '';
  const m = /^Bearer (.+)$/.exec(h);
  const payload = m ? verifyJwt(m[1], ctx.config.jwtSecret, ctx.config.now().getTime()) : null;
  if (!payload) throw new ApiError(401, 'unauthenticated', 'Sign in required');
  if (!roles.includes(payload.role)) throw new ApiError(403, 'forbidden', 'Your role does not allow this action');
  ctx.user = { email: payload.email, role: payload.role };
};
export const READ = ['admin', 'analyst'];
export const WRITE = ['admin'];

/** Parse and validate dataset + dashboard filters from the query string. */
export function parseView(query) {
  const dataset = query.dataset === undefined ? 'live' : query.dataset;
  if (!['live', 'demo'].includes(dataset)) throw new ApiError(400, 'invalid_dataset', 'dataset must be "live" or "demo"');
  const out = { dataset, from: null, to: null, channel: 'all' };
  for (const k of ['from', 'to']) {
    if (query[k]) {
      if (!isDay(query[k])) throw new ApiError(400, 'invalid_date', `${k} must be YYYY-MM-DD`);
      out[k] = query[k];
    }
  }
  if (out.from && out.to && out.from > out.to) throw new ApiError(400, 'invalid_range', 'from must be on or before to');
  if (query.channel && query.channel !== 'all') {
    const ch = normalizeSource(query.channel);
    if (!ch) throw new ApiError(400, 'invalid_channel', 'channel is not valid');
    out.channel = ch;
  }
  return out;
}

export const created = (body) => ({ __raw: true, status: 201, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export function deepMerge(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(a[k] || {}, v) : v;
  }
  return out;
}
