/**
 * Consent-aware, privacy-minimising tracking.
 * - Without consent: no identifier is stored. First-touch attribution lives in sessionStorage only.
 * - With consent: a random visitor id (no personal data) is kept in localStorage.
 * Safe against blocked/unavailable storage.
 */
const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
const ls = { get: (k) => safe(() => localStorage.getItem(k)), set: (k, v) => safe(() => localStorage.setItem(k, v)), del: (k) => safe(() => localStorage.removeItem(k)) };
const ss = { get: (k) => safe(() => sessionStorage.getItem(k)), set: (k, v) => safe(() => sessionStorage.setItem(k, v)) };

export const CONSENT_KEY = 'gh_analytics_consent';
export const getConsent = () => ls.get(CONSENT_KEY); // 'yes' | 'no' | null
export function setConsent(yes) {
  ls.set(CONSENT_KEY, yes ? 'yes' : 'no');
  if (!yes) { ls.del('gh_visitor'); }
}

export function visitorId() {
  if (getConsent() !== 'yes') return null;
  let id = ls.get('gh_visitor');
  if (!id) {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    id = `v_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
    ls.set('gh_visitor', id);
  }
  return id;
}

/** Parse UTM + referral parameters from a query string. */
export function parseAttribution(search) {
  const q = new URLSearchParams(search);
  const get = (k) => (q.get(k) || '').slice(0, 80) || undefined;
  const a = { source: get('utm_source'), medium: get('utm_medium'), campaign: get('utm_campaign'), content: get('utm_content'), ref: get('ref') };
  return Object.fromEntries(Object.entries(a).filter(([, v]) => v));
}

/** First-touch rule: the first landing URL with any attribution parameter wins for this browser session. */
export function resolveAttribution(search, now = new Date()) {
  const fresh = parseAttribution(search);
  const stored = (() => { const s = ss.get('gh_attr'); try { return s ? JSON.parse(s) : null; } catch { return null; } })();
  if (stored && Object.keys(stored).length) return stored;
  if (Object.keys(fresh).length) {
    const withTime = fresh.ref ? { ...fresh, refCapturedAt: now.toISOString() } : fresh;
    ss.set('gh_attr', JSON.stringify(withTime));
    return withTime;
  }
  return {};
}

export async function sendEvent(type, attribution, { variant, experimentKey } = {}) {
  const consent = getConsent() === 'yes';
  try {
    await fetch('/api/public/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ type, consent, visitorId: consent ? visitorId() : undefined, attribution: { ...attribution, variant, experimentKey } }),
    });
  } catch { /* analytics must never break the page */ }
}
