import { eachDay, round, safeDiv, sum } from '../lib/util.js';

/** Apply dashboard filters. from/to are inclusive YYYY-MM-DD (campaign timezone); channel is a normalised channel key. */
export function applyFilters(data, { from, to, channel } = {}) {
  const inRange = (day) => (!from || day >= from) && (!to || day <= to);
  const chOk = (ch) => !channel || channel === 'all' || ch === channel;
  return {
    ...data,
    registrations: data.registrations.filter((r) => inRange(r.day) && chOk(r.attribution.channel)),
    events: data.events.filter((e) => inRange(e.day) && chOk(e.channel)),
    spend: data.spend.filter((s) => (s.kind === 'planned' || inRange(s.date)) && chOk(s.channel)),
  };
}

export function dailySeries(registrations, from, to) {
  const counts = {};
  for (const r of registrations) counts[r.day] = (counts[r.day] || 0) + 1;
  const days = from && to ? eachDay(from, to) : Object.keys(counts).sort();
  return days.map((day) => ({ day, count: counts[day] || 0 }));
}

export const FUNNEL_STAGES = [
  { type: 'page_view', label: 'Page visits' },
  { type: 'cta_click', label: 'CTA clicks' },
  { type: 'reg_start', label: 'Registration starts' },
  { type: 'reg_success', label: 'Registrations' },
];

export function countEvents(events) {
  const c = { page_view: 0, cta_click: 0, reg_start: 0, reg_success: 0 };
  for (const e of events) if (e.type in c) c[e.type] += 1;
  return c;
}

export function funnel(events) {
  const c = countEvents(events);
  const stages = FUNNEL_STAGES.map((s, i) => {
    const count = c[s.type];
    const prev = i === 0 ? null : c[FUNNEL_STAGES[i - 1].type];
    return {
      type: s.type, label: s.label, count,
      stepRate: prev === null ? null : round(safeDiv(count, prev), 4),
      dropOff: prev === null ? null : prev - count,
    };
  });
  return {
    stages,
    overallRate: round(safeDiv(c.reg_success, c.page_view), 4),
    notes: [
      'Visits, clicks and starts are counted once per visitor per day when the visitor consented to analytics; visitors who declined are counted per event (no deduplication is possible without an identifier).',
      'Funnel stages are independent event counts, not a strict cohort: a stage can occasionally exceed the previous one (e.g. direct form links, declined-consent visitors).',
    ],
  };
}

/** Channel report. visitors/regs from events+registrations; spend from actual spend entries only. */
export function channelReport(registrations, events, spend) {
  const channels = new Set([
    ...registrations.map((r) => r.attribution.channel),
    ...events.map((e) => e.channel),
    ...spend.filter((s) => s.kind === 'actual').map((s) => s.channel),
  ]);
  const totalRegs = registrations.length;
  const rows = [...channels].sort().map((channel) => {
    const ev = events.filter((e) => e.channel === channel);
    const c = countEvents(ev);
    const regs = registrations.filter((r) => r.attribution.channel === channel).length;
    const spent = sum(spend.filter((s) => s.kind === 'actual' && s.channel === channel), (s) => s.amount);
    return {
      channel,
      visitors: c.page_view, ctaClicks: c.cta_click, starts: c.reg_start,
      registrations: regs,
      share: round(safeDiv(regs, totalRegs), 4),
      visitToRegRate: round(safeDiv(regs, c.page_view), 4),
      spendINR: spent,
      costPerRegistrationINR: regs > 0 && spent > 0 ? round(spent / regs, 2) : null,
    };
  });
  return rows.sort((a, b) => b.registrations - a.registrations);
}

export function attributionRules() {
  return [
    'First-touch: UTM parameters and referral code are captured from the first landing URL of a visit and kept for that visit/browser.',
    'channel = utm_source (normalised, e.g. "ig"→instagram, "wa"→whatsapp). If there is no utm_source but a referral code, channel = "referral". Otherwise channel = "direct".',
    'The referral code is tracked separately from the channel: a registration can have channel=whatsapp AND a valid ambassador referral.',
    'Registrations are attributed server-side at the moment of submission; client-side events are never trusted to create registrations.',
    'Analytics events carry no name, email or phone. Visitor identifiers are random IDs stored only with consent and are HMAC-hashed server-side.',
  ];
}
export const attributionLimitations = [
  'No cross-device or cross-browser stitching: one person on two devices counts as two visitors.',
  'Visitors who decline analytics are counted as anonymous events; their funnel counts can over-count repeat visits.',
  'Untagged shares (copied links without UTM) fall into "direct" — this under-credits real channels.',
  'Attribution shows association, not causal impact of a channel.',
  'Ad blockers and privacy browsers can suppress client events; registrations (server-side) remain complete, visits may be under-counted.',
];
