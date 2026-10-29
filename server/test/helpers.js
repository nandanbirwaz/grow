import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MemoryStore } from '../src/store/memory.js';

export const TEST_ENV = {
  JWT_SECRET: 'j'.repeat(40),
  ANALYTICS_SALT: 'test-salt-0123456789',
  ADMIN_EMAIL: 'admin@test.dev',
  ADMIN_PASSWORD: 'admin-password-123',
  ANALYST_EMAIL: 'analyst@test.dev',
  ANALYST_PASSWORD: 'analyst-password-1',
  CORS_ORIGINS: 'http://localhost:5173',
  TRUST_PROXY: 'true',
};
const BIG = { max: 100000, windowMs: 60000 };

export async function startTestApp({ env = {}, fetchImpl, now = '2026-10-29T06:00:00Z', rateLimits } = {}) {
  const clock = { t: Date.parse(now) };
  const config = loadConfig({ ...TEST_ENV, ...env }, {
    now: () => new Date(clock.t),
    rateLimits: rateLimits || { public: BIG, register: BIG, login: BIG, api: BIG, ai: BIG },
  });
  const store = new MemoryStore();
  const logs = [];
  const app = createApp({ config, store, fetchImpl, logger: (e) => logs.push(e) });
  await app.init();
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, { body, token, headers } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* csv etc. */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const login = async (email = TEST_ENV.ADMIN_EMAIL, password = TEST_ENV.ADMIN_PASSWORD) => (await call('POST', '/api/auth/login', { body: { email, password } })).json?.token;
  let n = 0;
  /** Register a student. Each call gets a distinct client IP unless ip is given. */
  const register = (over = {}) => {
    n += 1;
    const { ip, attribution, ...rest } = over;
    return call('POST', '/api/public/register', {
      headers: { 'X-Forwarded-For': ip || `10.0.${Math.floor(n / 250)}.${(n % 250) + 1}` },
      body: { name: `Student ${n}`, email: `student${n}@example.com`, college: 'Test College', graduationYear: 2027, consentTerms: true, consentAnalytics: false, attribution, ...rest },
    });
  };
  return { app, config, store, clock, logs, base, call, login, register, close: () => app.close() };
}
