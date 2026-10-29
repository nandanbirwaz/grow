import { createHmac, randomUUID } from 'node:crypto';

export const hmac = (salt, value) => createHmac('sha256', salt).update(String(value)).digest('hex');
export const newId = () => randomUUID();

/* ---------- time helpers (campaign days are IST by default: UTC+330 min) ---------- */
export function dayKey(ms, tzOffsetMin = 330) {
  return new Date(ms + tzOffsetMin * 60000).toISOString().slice(0, 10);
}
export function dayStartMs(day, tzOffsetMin = 330) {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) - tzOffsetMin * 60000;
}
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}
export function eachDay(from, to) {
  const out = [];
  if (!from || !to || from > to) return out;
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
export function isDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s;
}

/* ---------- numbers ---------- */
export const round = (n, d = 2) => (n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
export const safeDiv = (a, b) => (b ? a / b : null);

/* ---------- identity normalisation ---------- */
export function normalizeEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  local = local.split('+')[0];
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}
export function maskEmail(raw) {
  const e = String(raw || '');
  const at = e.lastIndexOf('@');
  if (at < 1) return '***';
  return `${e[0]}***@${e.slice(at + 1)}`;
}
export function initials(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase())
    .slice(0, 3)
    .join('');
}

/* ---------- attribution token normalisation ---------- */
const CHANNEL_ALIASES = {
  wa: 'whatsapp', whatsapp: 'whatsapp', 'whats_app': 'whatsapp',
  ig: 'instagram', insta: 'instagram', instagram: 'instagram',
  li: 'linkedin', linkedin: 'linkedin',
  mail: 'email', email: 'email', newsletter: 'email',
  tg: 'telegram', telegram: 'telegram',
  yt: 'youtube', youtube: 'youtube',
};
export function normalizeToken(raw, max = 64) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim().toLowerCase().replace(/\s+/g, '_');
  if (!s || s.length > max || !/^[a-z0-9_.\-]+$/.test(s)) return null;
  return s;
}
export function normalizeSource(raw) {
  const t = normalizeToken(raw);
  if (!t) return null;
  return CHANNEL_ALIASES[t] || t;
}
/** Attribution rule: channel = utm_source if present; else "referral" if a referral code is present; else "direct". */
export function deriveChannel({ source, ref }) {
  if (source) return source;
  if (ref) return 'referral';
  return 'direct';
}

/* ---------- misc ---------- */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
export function sum(arr, f = (x) => x) { return arr.reduce((s, x) => s + f(x), 0); }
