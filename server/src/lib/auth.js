import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/* ---------- passwords (scrypt) ---------- */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
export function verifyPassword(password, stored) {
  try {
    const [scheme, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const a = Buffer.from(hash, 'hex');
    const b = scryptSync(password, salt, 64);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/* ---------- JWT (HS256 only; algorithm is fixed, never read from the token) ---------- */
const b64u = (buf) => Buffer.from(buf).toString('base64url');
export function signJwt(payload, secret, ttlSeconds, nowMs = Date.now()) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const iat = Math.floor(nowMs / 1000);
  const body = { ...payload, iat, exp: iat + ttlSeconds };
  const data = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(body))}`;
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}
export function verifyJwt(token, secret, nowMs = Date.now()) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (header.alg !== 'HS256') return null;
    const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
    const given = Buffer.from(parts[2], 'base64url');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < nowMs) return null;
    return payload;
  } catch {
    return null;
  }
}
