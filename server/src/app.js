import http from 'node:http';
import { ApiError, Router, clientIp, createRateLimiter, errorToResponse, readJson, securityHeaders, serveStatic } from './http/framework.js';
import { registerPublic } from './routes/public.js';
import { ensureUsers, registerAdmin } from './routes/admin.js';

/** Structured, PII-free request logging: method, path (no query string), status, duration. Never bodies, headers or IPs. */
export const consoleLogger = (entry) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);

export function createApp({ config, store, fetchImpl = globalThis.fetch, logger = consoleLogger }) {
  const router = new Router();
  const limiter = createRateLimiter();
  const deps = { config, store, fetchImpl, limiter };
  registerPublic(router, deps);
  registerAdmin(router, deps);

  const allowedOrigins = new Set(config.corsOrigins);

  function applyCors(req, res) {
    const origin = req.headers.origin;
    if (!origin) return true;
    // Same-origin requests (the app serving its own client) always carry Origin on POST; allow when it matches Host.
    try { if (new URL(origin).host === req.headers.host) return true; } catch { return false; }
    if (!allowedOrigins.has(origin)) return false;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Max-Age', '600');
    return true;
  }

  async function handle(req, res) {
    const started = Date.now();
    securityHeaders(res);
    let pathname = '/';
    try {
      const url = new URL(req.url, 'http://localhost');
      pathname = url.pathname;
      const corsOk = applyCors(req, res);
      if (req.method === 'OPTIONS') {
        res.statusCode = corsOk && req.headers.origin ? 204 : 403;
        return res.end();
      }

      if (!pathname.startsWith('/api/')) {
        if (config.staticDir && req.method === 'GET' && (await serveStatic(config.staticDir, pathname, res))) return undefined;
        throw new ApiError(404, 'not_found', 'Not found');
      }
      if (!corsOk) throw new ApiError(403, 'cors_forbidden', 'Origin not allowed');

      const { route, params, pathMatched } = router.match(req.method, pathname);
      if (!route) throw pathMatched ? new ApiError(405, 'method_not_allowed', 'Method not allowed') : new ApiError(404, 'not_found', 'Not found');

      let cached;
      const ctx = {
        req, res, url, params, query: Object.fromEntries(url.searchParams), config, store, deps, user: null,
        ip: clientIp(req, config.trustProxy),
        body: async () => { if (cached === undefined) cached = await readJson(req); return cached; },
      };
      let result;
      for (const h of route.handlers) { result = await h(ctx); }
      if (result && result.__raw) {
        res.statusCode = result.status;
        for (const [k, val] of Object.entries(result.headers || {})) res.setHeader(k, val);
        res.end(result.body);
      } else {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result ?? { ok: true }));
      }
    } catch (e) {
      const { status, body } = errorToResponse(e);
      if (status === 500) logger({ level: 'error', msg: 'unhandled', error: String(e.message).slice(0, 200) });
      if (status === 429 && body.details?.retryAfterSeconds) res.setHeader('Retry-After', String(body.details.retryAfterSeconds));
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    } finally {
      logger({ level: 'info', msg: 'request', method: req.method, path: pathname, status: res.statusCode, ms: Date.now() - started });
    }
    return undefined;
  }

  const server = http.createServer(handle);
  return {
    handle, server, limiter,
    async init() { await ensureUsers(store, config); },
    listen: (port = config.port) => new Promise((resolve) => server.listen(port, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => { limiter.stop(); server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}
