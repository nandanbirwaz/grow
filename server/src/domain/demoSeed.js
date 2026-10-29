import { addDays, dayKey, dayStartMs, hmac, maskEmail, mulberry32, normalizeEmail } from '../lib/util.js';
import { generateCode } from './referrals.js';

const DEMO = 'demo';
export const DEMO_COLLECTIONS = ['settings', 'events', 'registrations', 'ambassadors', 'experiments', 'assignments', 'spend', 'drafts', 'decisions', 'audit'];

/** Remove ONLY demo-dataset documents. Live data is untouched by construction (every delete is scoped to dataset=demo). */
export async function resetDemo(store) {
  const removed = {};
  for (const c of DEMO_COLLECTIONS) removed[c] = await store.deleteMany(c, { dataset: DEMO });
  return removed;
}

const CHANNEL_WEIGHTS = [['whatsapp', 0.34], ['instagram', 0.2], ['linkedin', 0.12], ['email', 0.08], ['referral', 0.1], ['direct', 0.08], ['telegram', 0.08]];
const DAILY_TARGETS = [24, 43, 48, 26]; // completed days; today's partial day is generated separately

function weighted(rng, pairs) {
  let u = rng(); for (const [k, w] of pairs) { if ((u -= w) < 0) return k; } return pairs[0][0];
}

/** Deterministic simulated dataset. Every record carries dataset="demo" and simulated=true. */
export async function loadDemo(store, config) {
  await resetDemo(store);
  const nowMs = config.now().getTime();
  const tz = config.tzOffsetMin;
  const today = dayKey(nowMs, tz);
  const startDate = addDays(today, -4);
  const rng = mulberry32(20261029);
  const stamp = (day, frac, cap) => {
    const s = dayStartMs(day, tz);
    const ms = s + Math.floor(frac * 86400000);
    return Math.min(ms, cap ?? ms);
  };

  await store.insert('settings', { dataset: DEMO, startDate, simulated: true });

  const experiment = {
    dataset: DEMO, key: 'landing-hero', name: 'Hero message test (SIMULATED)', status: 'running', simulated: true, createdAt: new Date(nowMs).toISOString(),
    variants: [
      { key: 'control', label: 'Control', headline: 'Build Your First AI Project in 60 Minutes', subhead: 'A hands-on session for final-year engineering students.', cta: 'Register now', weight: 1 },
      { key: 'benefit', label: 'Benefit-led', headline: 'Finish With an AI Project You Built Yourself', subhead: 'Guided, hands-on, 60 minutes.', cta: 'Reserve my seat', weight: 1 },
    ],
  };
  await store.insert('experiments', experiment);
  const baseRate = { control: 0.11, benefit: 0.14 };

  const used = new Set();
  const ambassadors = [];
  for (let i = 0; i < 6; i += 1) {
    const code = generateCode(used, 'DEMO'); used.add(code);
    const a = await store.insert('ambassadors', {
      dataset: DEMO, simulated: true, displayName: `Demo Ambassador ${String.fromCharCode(65 + i)}`, code, status: 'active',
      emailHash: hmac(config.analyticsSalt, normalizeEmail(`demo.ambassador${i}@example.invalid`)), createdAt: new Date(nowMs).toISOString(),
    });
    ambassadors.push(a);
  }
  const ambWeights = [['0', 0.3], ['1', 0.25], ['2', 0.15], ['3', 0.12], ['4', 0.1], ['5', 0.08]];

  let n = 0; let evN = 0;
  const events = [];
  const pushEvent = (type, ts, vis, attr) => {
    events.push({ dataset: DEMO, simulated: true, type, ts: new Date(ts).toISOString(), day: dayKey(ts, tz), dedupeKey: `demo-${(evN += 1)}`, visitorHash: vis, consent: true, ...attr });
  };

  const todayCap = Math.max(nowMs - 60000, dayStartMs(today, tz) + 1000);
  const days = [...DAILY_TARGETS.map((c, i) => ({ day: addDays(startDate, i), count: c, cap: null })), { day: today, count: 14, cap: todayCap }];
  const regsToInsert = [];
  for (const { day, count, cap } of days) {
    for (let i = 0; i < count; i += 1) {
      n += 1;
      const channel = weighted(rng, CHANNEL_WEIGHTS);
      const variant = rng() < 0.5 ? 'control' : 'benefit';
      const ts = stamp(day, 0.25 + rng() * 0.7, cap ? cap : undefined);
      let referral = null;
      if (channel === 'referral' || rng() < 0.06) {
        const amb = ambassadors[Number(weighted(rng, ambWeights))];
        const r = rng();
        referral = { code: amb.code, ambassadorId: amb._id, status: r < 0.88 ? 'valid' : r < 0.95 ? 'self_referral_blocked' : 'flagged_ip_limit' };
      }
      regsToInsert.push({ day, ts, channel, variant, referral, n });
    }
  }
  // Deliberate anomaly for the demo: 7 referred sign-ups from one ambassador in the same hour yesterday.
  const yesterday = addDays(today, -1);
  const spikeHour = dayStartMs(yesterday, tz) + 15 * 3600000;
  regsToInsert.filter((r) => r.day === yesterday).slice(0, 7).forEach((r, i) => {
    r.ts = spikeHour + i * 240000; r.referral = { code: ambassadors[2].code, ambassadorId: ambassadors[2]._id, status: i < 5 ? 'valid' : 'flagged_ip_limit' };
    r.channel = 'referral';
  });

  for (const r of regsToInsert) {
    const email = `demo.student${r.n}@example.invalid`;
    const vis = hmac(config.analyticsSalt, `demo-visitor-${r.n}`).slice(0, 24);
    const attr = { source: r.channel === 'direct' || r.channel === 'referral' ? null : r.channel, medium: r.channel === 'direct' || r.channel === 'referral' ? null : 'social', campaign: 'ai60', content: null, variant: r.variant, experimentKey: 'landing-hero', channel: r.channel, ref: r.referral?.code || null };
    const evAttr = { channel: r.channel, source: attr.source, medium: attr.medium, campaign: 'ai60', content: null, variant: r.variant, experimentKey: 'landing-hero' };
    pushEvent('page_view', r.ts - 240000, vis, evAttr);
    pushEvent('cta_click', r.ts - 150000, vis, evAttr);
    pushEvent('reg_start', r.ts - 90000, vis, evAttr);
    pushEvent('reg_success', r.ts, vis, evAttr);
    await store.insert('registrations', {
      dataset: DEMO, simulated: true, createdAt: new Date(r.ts).toISOString(), day: dayKey(r.ts, tz),
      name: `Demo Student ${r.n}`, email, emailHash: hmac(config.analyticsSalt, normalizeEmail(email)), emailMasked: maskEmail(email),
      college: `Demo College ${1 + (r.n % 8)}`, graduationYear: 2027, consent: { terms: true, analytics: true },
      attribution: attr, referral: r.referral, ipHash: `demo-ip-${r.n % 40}`, visitorHash: vis,
    });
    // non-converting visitors for this variant, to reach the simulated conversion rate
    const extra = Math.floor((1 / baseRate[r.variant] - 1) * (0.7 + 0.6 * rng()));
    for (let k = 0; k < extra; k += 1) {
      const t = stamp(r.day, 0.2 + rng() * 0.75, r.ts + 3600000 > nowMs ? todayCap : undefined);
      const v2 = hmac(config.analyticsSalt, `demo-visitor-${r.n}-${k}`).slice(0, 24);
      const ch = weighted(rng, CHANNEL_WEIGHTS);
      const a2 = { channel: ch, source: ch === 'direct' || ch === 'referral' ? null : ch, medium: ch === 'direct' || ch === 'referral' ? null : 'social', campaign: 'ai60', content: null, variant: r.variant, experimentKey: 'landing-hero' };
      pushEvent('page_view', t, v2, a2);
      if (rng() < 0.45) { pushEvent('cta_click', t + 20000, v2, a2); if (rng() < 0.4) pushEvent('reg_start', t + 60000, v2, a2); }
    }
  }
  for (const e of events) await store.insert('events', e);

  const spendRows = [
    ['planned', 'whatsapp', 300], ['planned', 'instagram', 700], ['planned', 'linkedin', 400], ['planned', 'email', 100],
    ['actual', 'whatsapp', 250, addDays(today, -3)], ['actual', 'instagram', 400, addDays(today, -3)],
    ['actual', 'linkedin', 250, addDays(today, -2)], ['actual', 'instagram', 200, addDays(today, -1)],
  ];
  for (const [kind, channel, amount, date] of spendRows) {
    await store.insert('spend', { dataset: DEMO, simulated: true, kind, channel, amount, date: date || null, note: kind === 'actual' ? 'SIMULATED spend entry' : 'SIMULATED plan', createdAt: new Date(nowMs).toISOString() });
  }
  await store.insert('audit', { dataset: DEMO, ts: new Date(nowMs).toISOString(), actor: 'system', role: 'system', type: 'demo_loaded', summary: 'Simulated demo dataset loaded', details: { registrations: regsToInsert.length, events: events.length, ambassadors: ambassadors.length }, reason: null });

  return { registrations: regsToInsert.length, events: events.length, ambassadors: ambassadors.length, spendEntries: spendRows.length, startDate };
}
