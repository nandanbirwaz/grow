import { randomUUID } from 'node:crypto';
import { ApiError } from '../http/framework.js';
import { rl, created } from '../http/helpers.js';
import { parse, v } from '../lib/validate.js';
import { dayKey, deriveChannel, hmac, maskEmail, normalizeEmail, normalizeSource, normalizeToken } from '../lib/util.js';
import { DuplicateError } from '../store/schema.js';
import { getSettings } from '../domain/settings.js';
import { assignVariant } from '../domain/experiments.js';
import { evaluateReferral, normalizeCode } from '../domain/referrals.js';

const VID = /^[A-Za-z0-9_-]{16,64}$/;
const opt = (max = 80) => v.string({ optional: true, max });
const ATTR = v.object({
  source: opt(), medium: opt(), campaign: opt(), content: opt(), variant: opt(32), experimentKey: opt(32), ref: opt(24), refCapturedAt: opt(40),
}, { optional: true });

const EVENT_SCHEMA = v.object({
  type: v.enum(['page_view', 'cta_click', 'reg_start']),
  consent: v.boolean(),
  visitorId: v.string({ optional: true, pattern: VID, patternMessage: 'is not a valid visitor id' }),
  attribution: ATTR,
});
const ASSIGN_SCHEMA = v.object({
  experimentKey: v.string({ max: 32 }),
  visitorId: v.string({ optional: true, pattern: VID }),
});
const REGISTER_SCHEMA = v.object({
  name: v.string({ min: 2, max: 80 }),
  email: v.string({ max: 120, lower: true, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/, patternMessage: 'must be a valid email address' }),
  college: v.string({ min: 2, max: 120 }),
  graduationYear: v.number({ int: true, min: 2024, max: 2032, optional: true }),
  consentTerms: v.boolean(),
  consentAnalytics: v.boolean({ optional: true }),
  visitorId: v.string({ optional: true, pattern: VID }),
  attribution: ATTR,
});

async function runningExperiment(store) {
  const list = await store.find('experiments', { dataset: 'live', status: 'running' });
  return list[0] || null;
}
const clientVariant = (x) => ({ key: x.key, label: x.label, headline: x.headline, subhead: x.subhead, cta: x.cta });

function cleanAttribution(a = {}) {
  return {
    source: normalizeSource(a.source), medium: normalizeToken(a.medium), campaign: normalizeToken(a.campaign),
    content: normalizeToken(a.content), ref: normalizeCode(a.ref),
  };
}

export function registerPublic(router, deps) {
  const { config, store } = deps;
  const tz = config.tzOffsetMin;

  router.get('/api/health', () => ({ ok: true, store: store.kind, time: config.now().toISOString() }));

  router.get('/api/public/config', rl('public'), async () => {
    const settings = await getSettings(store, 'live');
    const exp = await runningExperiment(store);
    return {
      campaignName: settings.campaignName,
      experiment: exp ? { key: exp.key, variants: exp.variants.map(clientVariant) } : null,
      privacy: 'Optional analytics use a random visitor ID stored in your browser only if you accept. Registration details are used to run the workshop and are never shown in analytics.',
    };
  });

  // Lets the form confirm a typed code. Returns only a boolean (no names), and is rate limited against enumeration.
  router.post('/api/public/referral/check', rl('public'), async (ctx) => {
    const b = parse(v.object({ code: v.string({ max: 24 }) }), await ctx.body());
    const code = normalizeCode(b.code);
    const amb = code ? await store.findOne('ambassadors', { dataset: 'live', code }) : null;
    return { valid: Boolean(amb && amb.status === 'active') };
  });

  router.post('/api/public/assign', rl('public'), async (ctx) => {
    const body = parse(ASSIGN_SCHEMA, await ctx.body());
    const exp = await runningExperiment(store);
    if (!exp || exp.key !== body.experimentKey) throw new ApiError(404, 'no_experiment', 'No running experiment with that key');
    if (!body.visitorId) {
      // No identifier (visitor declined analytics): assign at random; the browser keeps it for the session only.
      const key = assignVariant(exp, randomUUID());
      return { experimentKey: exp.key, variant: clientVariant(exp.variants.find((x) => x.key === key)), persisted: false };
    }
    const vh = hmac(config.analyticsSalt, body.visitorId).slice(0, 24);
    const existing = await store.findOne('assignments', { dataset: 'live', experimentKey: exp.key, visitorHash: vh });
    let key = existing && exp.variants.some((x) => x.key === existing.variant) ? existing.variant : null;
    if (!key) {
      key = assignVariant(exp, vh);
      try {
        await store.insert('assignments', { dataset: 'live', experimentKey: exp.key, visitorHash: vh, variant: key, createdAt: config.now().toISOString() });
      } catch (e) {
        if (!(e instanceof DuplicateError)) throw e;
        const again = await store.findOne('assignments', { dataset: 'live', experimentKey: exp.key, visitorHash: vh });
        key = again.variant;
      }
    }
    return { experimentKey: exp.key, variant: clientVariant(exp.variants.find((x) => x.key === key)), persisted: true };
  });

  router.post('/api/public/events', rl('public'), async (ctx) => {
    const b = parse(EVENT_SCHEMA, await ctx.body());
    const a = cleanAttribution(b.attribution);
    const exp = await runningExperiment(store);
    const vh = b.consent && b.visitorId ? hmac(config.analyticsSalt, b.visitorId).slice(0, 24) : null;
    let variant = null; let experimentKey = null;
    if (exp && b.attribution?.experimentKey === exp.key) {
      experimentKey = exp.key;
      const asg = vh ? await store.findOne('assignments', { dataset: 'live', experimentKey: exp.key, visitorHash: vh }) : null;
      const claimed = normalizeToken(b.attribution?.variant, 32);
      // Server-side assignment wins over anything the client claims.
      variant = asg ? asg.variant : (claimed && exp.variants.some((x) => x.key === claimed) ? claimed : null);
      if (!variant) experimentKey = null;
    }
    const now = config.now();
    const day = dayKey(now.getTime(), tz);
    const refKnown = a.ref ? await store.findOne('ambassadors', { dataset: 'live', code: a.ref }) : null;
    const channel = deriveChannel({ source: a.source, ref: refKnown ? a.ref : null });
    try {
      await store.insert('events', {
        dataset: 'live', type: b.type, ts: now.toISOString(), day, dedupeKey: vh ? `${b.type}|${vh}|${day}` : `anon|${randomUUID()}`,
        visitorHash: vh, consent: Boolean(vh), channel, source: a.source, medium: a.medium, campaign: a.campaign, content: a.content, variant, experimentKey,
      });
    } catch (e) {
      if (e instanceof DuplicateError) return { ok: true, deduped: true };
      throw e;
    }
    return { ok: true, deduped: false };
  });

  router.post('/api/public/register', rl('register'), async (ctx) => {
    const b = parse(REGISTER_SCHEMA, await ctx.body());
    if (b.consentTerms !== true) throw new ApiError(400, 'consent_required', 'You must agree to the registration terms to register');
    const now = config.now(); const nowMs = now.getTime();
    const day = dayKey(nowMs, tz);
    const normalized = normalizeEmail(b.email);
    const emailHash = hmac(config.analyticsSalt, normalized);
    if (await store.findOne('registrations', { dataset: 'live', emailHash })) {
      throw new ApiError(409, 'already_registered', 'This email is already registered.');
    }
    const a = cleanAttribution(b.attribution);
    const ipHash = hmac(config.analyticsSalt, `ip:${ctx.ip}`).slice(0, 24);
    const vh = b.consentAnalytics && b.visitorId ? hmac(config.analyticsSalt, b.visitorId).slice(0, 24) : null;

    // Experiment variant (server assignment wins)
    const exp = await runningExperiment(store);
    let variant = null; let experimentKey = null;
    if (exp && b.attribution?.experimentKey === exp.key) {
      const asg = vh ? await store.findOne('assignments', { dataset: 'live', experimentKey: exp.key, visitorHash: vh }) : null;
      const claimed = normalizeToken(b.attribution?.variant, 32);
      variant = asg ? asg.variant : (claimed && exp.variants.some((x) => x.key === claimed) ? claimed : null);
      if (variant) experimentKey = exp.key;
    }

    // Referral evaluation (transparent, configurable rules)
    let referral = null; let ambassador = null;
    if (a.ref) {
      ambassador = await store.findOne('ambassadors', { dataset: 'live', code: a.ref });
      const settings = await getSettings(store, 'live');
      const sameIp = (await store.find('registrations', { dataset: 'live', ipHash })).filter((r) => r.day === day && r.referral?.status === 'valid').length;
      const capturedMs = b.attribution?.refCapturedAt ? Date.parse(b.attribution.refCapturedAt) : null;
      const status = evaluateReferral({
        ambassador, registrantEmailHash: emailHash, ipHash, validFromSameIpToday: sameIp,
        refCapturedAtMs: Number.isFinite(capturedMs) ? capturedMs : null, nowMs, rules: settings.referralRules,
      });
      referral = { code: a.ref, ambassadorId: ambassador ? ambassador._id : null, status };
    }
    const channel = deriveChannel({ source: a.source, ref: ambassador ? a.ref : null });

    let reg;
    try {
      reg = await store.insert('registrations', {
        dataset: 'live', createdAt: now.toISOString(), day, name: b.name, email: b.email, emailHash, emailMasked: maskEmail(b.email),
        college: b.college, graduationYear: b.graduationYear ?? null, consent: { terms: true, analytics: Boolean(b.consentAnalytics) },
        attribution: { source: a.source, medium: a.medium, campaign: a.campaign, content: a.content, variant, experimentKey, channel, ref: a.ref },
        referral, ipHash, visitorHash: vh,
      });
    } catch (e) {
      if (e instanceof DuplicateError) throw new ApiError(409, 'already_registered', 'This email is already registered.');
      throw e;
    }
    // Server-side success event: deduplicated by registration id, no personal data.
    await store.insert('events', {
      dataset: 'live', type: 'reg_success', ts: now.toISOString(), day, dedupeKey: `reg|${reg._id}`, visitorHash: vh, consent: Boolean(vh),
      channel, source: a.source, medium: a.medium, campaign: a.campaign, content: a.content, variant, experimentKey,
    });
    return created({
      ok: true, registrationRef: reg._id.slice(0, 8),
      message: 'You are registered. Check your email for next steps from the organisers.',
    });
  });
}
