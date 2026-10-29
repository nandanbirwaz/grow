import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { forecast } from '../src/domain/forecast.js';
import { funnel, channelReport, applyFilters, dailySeries } from '../src/domain/metrics.js';
import { assignVariant, experimentResults, twoProportionTest, wilson } from '../src/domain/experiments.js';
import { budgetSummary, budgetRecommendations, whatIf } from '../src/domain/budget.js';
import { evaluateReferral, leaderboard, ambassadorReport, generateCode } from '../src/domain/referrals.js';
import { computeAlerts } from '../src/domain/alerts.js';
import { toCsv } from '../src/lib/csv.js';
import { normalizeEmail, deriveChannel, normalizeSource, maskEmail } from '../src/lib/util.js';
import { lintContent } from '../src/ai/content.js';
import { loadConfig } from '../src/config.js';

const THRESH = { experimentMinVisitorsPerVariant: 100, experimentMinConversionsPerVariant: 10 };

describe('forecast', () => {
  const base = { startDate: '2026-10-25', durationDays: 7, target: 500, minDays: 3 };
  it('computes required/day, attainment and base projection with exact numbers', () => {
    const daily = [{ day: '2026-10-25', count: 20 }, { day: '2026-10-26', count: 40 }, { day: '2026-10-27', count: 30 }, { day: '2026-10-28', count: 30 }];
    const f = forecast({ ...base, daily, asOfDate: '2026-10-28' });
    assert.equal(f.campaign.elapsedDays, 4);
    assert.equal(f.campaign.remainingDays, 3);
    assert.equal(f.totals.registrations, 120);
    assert.equal(f.totals.gap, 380);
    assert.equal(f.totals.requiredPerDay, 126.67);
    assert.equal(f.totals.attainment, 0.24);
    assert.equal(f.stats.meanDaily, 30);
    assert.equal(f.scenarios.base.projectedTotal, 210); // 120 + 30*3
    // sd = sqrt(((10²)+(10²)+0+0)/3)=8.165 ; se = 4.082 ; band = 1.2816*4.082 = 5.23
    assert.equal(f.scenarios.conservative.projectedTotal, Math.round(120 + (30 - 1.2816 * 4.0825) * 3));
    assert.equal(f.scenarios.optimistic.projectedTotal, Math.round(120 + (30 + 1.2816 * 4.0825) * 3));
    assert.ok(f.scenarios.conservative.projectedTotal < f.scenarios.base.projectedTotal);
    assert.ok(f.scenarios.base.projectedTotal < f.scenarios.optimistic.projectedTotal);
    assert.equal(f.scenarios.base.onTrack, false);
    assert.equal(f.model.validatedMachineLearning, false);
    assert.ok(f.formulas.length >= 5);
  });
  it('shows an insufficient-data warning and no scenarios under the minimum days', () => {
    const f = forecast({ ...base, daily: [{ day: '2026-10-25', count: 12 }, { day: '2026-10-26', count: 9 }], asOfDate: '2026-10-26' });
    assert.equal(f.sufficient, false);
    assert.equal(f.scenarios, null);
    assert.ok(f.warnings.some((w) => /Insufficient data/.test(w)));
    assert.equal(f.totals.requiredPerDay, (500 - 21) / 5 > 0 ? Math.round(((500 - 21) / 5) * 100) / 100 : null);
  });
  it('handles zero registrations, finished campaigns and out-of-window registrations', () => {
    const none = forecast({ ...base, daily: [], asOfDate: '2026-10-27' });
    assert.equal(none.sufficient, false);
    const done = forecast({ ...base, daily: [{ day: '2026-10-25', count: 300 }, { day: '2026-10-26', count: 300 }, { day: '2026-10-27', count: 5 }, { day: '2026-11-20', count: 7 }], asOfDate: '2026-12-01' });
    assert.equal(done.campaign.remainingDays, 0);
    assert.equal(done.totals.requiredPerDay, null);
    assert.ok(done.warnings.some((w) => /outside/.test(w)));
  });
  it('flags an assumed start date', () => {
    const f = forecast({ ...base, daily: [], asOfDate: '2026-10-25', startDateAssumed: true });
    assert.ok(f.warnings.some((w) => /start date is not set/.test(w)));
  });
});

describe('funnel and channels', () => {
  const ev = (type, channel, extra = {}) => ({ type, channel, day: '2026-10-28', ...extra });
  it('computes counts, step rates and overall rate; guards divide-by-zero', () => {
    const events = [...Array(100).fill(0).map(() => ev('page_view', 'whatsapp')), ...Array(40).fill(0).map(() => ev('cta_click', 'whatsapp')), ...Array(20).fill(0).map(() => ev('reg_start', 'whatsapp')), ...Array(10).fill(0).map(() => ev('reg_success', 'whatsapp'))];
    const f = funnel(events);
    assert.deepEqual(f.stages.map((s) => s.count), [100, 40, 20, 10]);
    assert.deepEqual(f.stages.map((s) => s.stepRate), [null, 0.4, 0.5, 0.5]);
    assert.equal(f.overallRate, 0.1);
    assert.equal(funnel([]).overallRate, null);
  });
  it('builds channel report with actual spend only', () => {
    const regs = [...Array(4).fill(0).map(() => ({ day: 'd', attribution: { channel: 'whatsapp' } })), { day: 'd', attribution: { channel: 'direct' } }];
    const events = [ev('page_view', 'whatsapp'), ev('page_view', 'whatsapp'), ev('page_view', 'direct')];
    const spend = [{ kind: 'actual', channel: 'whatsapp', amount: 100 }, { kind: 'planned', channel: 'whatsapp', amount: 900 }];
    const rows = channelReport(regs, events, spend);
    const wa = rows.find((r) => r.channel === 'whatsapp');
    assert.equal(wa.spendINR, 100);
    assert.equal(wa.costPerRegistrationINR, 25);
    assert.equal(rows.find((r) => r.channel === 'direct').costPerRegistrationINR, null);
  });
  it('filters by date range and channel consistently', () => {
    const data = {
      registrations: [{ day: '2026-10-26', attribution: { channel: 'whatsapp' } }, { day: '2026-10-27', attribution: { channel: 'instagram' } }, { day: '2026-10-28', attribution: { channel: 'whatsapp' } }],
      events: [{ day: '2026-10-27', channel: 'instagram' }, { day: '2026-10-28', channel: 'whatsapp' }],
      spend: [{ kind: 'actual', date: '2026-10-28', channel: 'whatsapp', amount: 10 }, { kind: 'planned', channel: 'whatsapp', amount: 50 }],
    };
    assert.equal(applyFilters(data, { from: '2026-10-27' }).registrations.length, 2);
    assert.equal(applyFilters(data, { channel: 'whatsapp' }).registrations.length, 2);
    assert.equal(applyFilters(data, { from: '2026-10-27', to: '2026-10-27', channel: 'instagram' }).events.length, 1);
    assert.equal(applyFilters(data, { to: '2026-10-26' }).spend.filter((s) => s.kind === 'actual').length, 0);
    const series = dailySeries(applyFilters(data, { channel: 'whatsapp' }).registrations, '2026-10-26', '2026-10-28');
    assert.deepEqual(series.map((d) => d.count), [1, 0, 1]);
  });
  it('normalises attribution consistently', () => {
    assert.equal(normalizeSource('IG'), 'instagram');
    assert.equal(normalizeSource(' WhatsApp '), 'whatsapp');
    assert.equal(normalizeSource('bad<script>'), null);
    assert.equal(deriveChannel({ source: null, ref: 'AMB-1' }), 'referral');
    assert.equal(deriveChannel({ source: null, ref: null }), 'direct');
    assert.equal(deriveChannel({ source: 'linkedin', ref: 'AMB-1' }), 'linkedin');
  });
});

describe('A/B assignment and statistics', () => {
  const exp = { key: 'e', variants: [{ key: 'a', weight: 1 }, { key: 'b', weight: 1 }] };
  it('is deterministic per visitor and roughly follows weights', () => {
    for (let i = 0; i < 50; i += 1) assert.equal(assignVariant(exp, `v${i}`), assignVariant(exp, `v${i}`));
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 4000; i += 1) counts[assignVariant(exp, `visitor-${i}`)] += 1;
    assert.ok(Math.abs(counts.a - 2000) < 150, `got ${counts.a}`);
    const skew = { key: 'e', variants: [{ key: 'a', weight: 9 }, { key: 'b', weight: 1 }] };
    let a = 0; for (let i = 0; i < 4000; i += 1) if (assignVariant(skew, `visitor-${i}`) === 'a') a += 1;
    assert.ok(a > 3400 && a < 3800, `got ${a}`);
  });
  const events = (variant, visitors, regs) => [...Array(visitors).fill(0).map(() => ({ experimentKey: 'e', variant, type: 'page_view' })), ...Array(regs).fill(0).map(() => ({ experimentKey: 'e', variant, type: 'reg_success' }))];
  const E = { key: 'e', name: 'E', status: 'running', variants: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] };
  it('refuses to declare a winner with inadequate samples even for a large gap', () => {
    const r = experimentResults(E, [...events('a', 30, 3), ...events('b', 30, 12)], THRESH);
    assert.equal(r.verdict, 'insufficient_data');
    assert.equal(r.winner, null);
  });
  it('declares no significant difference when samples are adequate but the gap is small', () => {
    const r = experimentResults(E, [...events('a', 1000, 100), ...events('b', 1000, 106)], THRESH);
    assert.equal(r.verdict, 'no_significant_difference');
    assert.equal(r.winner, null);
  });
  it('declares a winner only when adequate and significant; labels simulated data', () => {
    const r = experimentResults(E, [...events('a', 1000, 80), ...events('b', 1000, 140)], THRESH, { simulated: true });
    assert.equal(r.verdict, 'winner');
    assert.equal(r.winner, 'b');
    assert.match(r.dataLabel, /SIMULATED/);
    assert.ok(r.variants[0].ci95.low < r.variants[0].conversionRate && r.variants[0].conversionRate < r.variants[0].ci95.high);
  });
  it('matches known statistical values', () => {
    const w = wilson(50, 100);
    assert.ok(Math.abs(w.low - 0.4038) < 0.001 && Math.abs(w.high - 0.5962) < 0.001);
    const t = twoProportionTest(100, 1000, 140, 1000);
    assert.ok(Math.abs(t.z - 2.7) < 0.1 && t.pValue < 0.01);
    assert.equal(twoProportionTest(10, 100, 10, 100).pValue, 1);
  });
});

describe('referral rules', () => {
  const rules = { selfReferralBlock: true, maxValidPerIpPerDay: 3, attributionWindowDays: 7 };
  const amb = { _id: 'a1', status: 'active', emailHash: 'H1' };
  const ev = (over) => evaluateReferral({ ambassador: amb, registrantEmailHash: 'H2', ipHash: 'ip', validFromSameIpToday: 0, refCapturedAtMs: null, nowMs: Date.now(), rules, ...over });
  it('applies each rule in a transparent way', () => {
    assert.equal(ev({}), 'valid');
    assert.equal(ev({ ambassador: null }), 'invalid_code');
    assert.equal(ev({ ambassador: { ...amb, status: 'paused' } }), 'invalid_code');
    assert.equal(ev({ registrantEmailHash: 'H1' }), 'self_referral_blocked');
    assert.equal(ev({ registrantEmailHash: 'H1', rules: { ...rules, selfReferralBlock: false } }), 'valid');
    assert.equal(ev({ validFromSameIpToday: 3 }), 'flagged_ip_limit');
    assert.equal(ev({ validFromSameIpToday: 3, rules: { ...rules, maxValidPerIpPerDay: 10 } }), 'valid');
    assert.equal(ev({ refCapturedAtMs: Date.now() - 8 * 86400000 }), 'expired');
  });
  it('ranks leaderboard by valid referrals with ties sharing a rank, and reports counts only', () => {
    const ambs = [{ _id: 'a', displayName: 'A', code: 'C1', status: 'active' }, { _id: 'b', displayName: 'B', code: 'C2', status: 'active' }, { _id: 'c', displayName: 'C', code: 'C3', status: 'active' }];
    const regs = [
      ...['a', 'a', 'a'].map((id) => ({ day: 'd', referral: { ambassadorId: id, status: 'valid' }, email: 'secret@x.com', name: 'Secret' })),
      { day: 'd', referral: { ambassadorId: 'b', status: 'valid' } }, { day: 'd', referral: { ambassadorId: 'c', status: 'valid' } },
      { day: 'd', referral: { ambassadorId: 'c', status: 'self_referral_blocked' } },
    ];
    const lb = leaderboard(ambs, regs);
    assert.deepEqual(lb.map((r) => [r.displayName, r.rank, r.validReferrals]), [['A', 1, 3], ['B', 2, 1], ['C', 2, 1]]);
    assert.equal(lb[2].rejectedReferrals, 1);
    const rep = ambassadorReport(ambs[0], regs);
    assert.ok(!JSON.stringify(rep).includes('secret') && !JSON.stringify(rep).includes('Secret'));
    assert.equal(rep.totals.valid, 3);
  });
  it('generates unique, unambiguous codes', () => {
    const set = new Set();
    for (let i = 0; i < 500; i += 1) { const c = generateCode(set); assert.match(c, /^AMB-[A-HJKMNP-Z2-9]{6}$/); assert.ok(!set.has(c)); set.add(c); }
  });
});

describe('budget', () => {
  const spend = [
    { kind: 'planned', channel: 'whatsapp', amount: 600 }, { kind: 'planned', channel: 'instagram', amount: 800 },
    { kind: 'actual', channel: 'whatsapp', amount: 200 }, { kind: 'actual', channel: 'instagram', amount: 600 },
  ];
  const regs = [...Array(40).fill(0).map(() => ({ attribution: { channel: 'whatsapp' } })), ...Array(12).fill(0).map(() => ({ attribution: { channel: 'instagram' } })), ...Array(5).fill(0).map(() => ({ attribution: { channel: 'direct' } }))];
  const s = budgetSummary({ spend, registrations: regs, capINR: 2000, minRegs: 10 });
  it('separates planned from actual and computes remaining / CPR', () => {
    assert.equal(s.plannedTotalINR, 1400);
    assert.equal(s.actualTotalINR, 800);
    assert.equal(s.remainingINR, 1200);
    assert.equal(s.usedPct, 40);
    assert.equal(s.channels.find((c) => c.channel === 'whatsapp').costPerRegistrationINR, 5);
    assert.equal(s.channels.find((c) => c.channel === 'instagram').costPerRegistrationINR, 50);
    assert.equal(s.blendedCostPerRegistrationINR, Math.round((800 / 57) * 100) / 100);
    assert.equal(s.channels.find((c) => c.channel === 'direct').costPerRegistrationINR, null);
  });
  it('only recommends a shift when sample thresholds are met, and as a proposal', () => {
    const r = budgetRecommendations(s);
    const shift = r.recommendations.find((x) => x.kind === 'shift_remaining');
    assert.equal(shift.toChannel, 'whatsapp');
    assert.equal(shift.proposedAmountINR, 720);
    assert.ok(r.caveats.some((c) => /causation/.test(c)));
    const thin = budgetSummary({ spend, registrations: regs.slice(0, 15), capINR: 2000, minRegs: 10 });
    assert.ok(!budgetRecommendations(thin).recommendations.some((x) => x.kind === 'shift_remaining'));
  });
  it('what-if rejects over-budget allocations and gives no estimate without a reliable CPR', () => {
    assert.equal(whatIf(s, { whatsapp: 1300 }).ok, false);
    assert.equal(whatIf(s, { whatsapp: -5 }).ok, false);
    const ok = whatIf(s, { whatsapp: 500, instagram: 500, linkedin: 100 });
    assert.equal(ok.ok, true);
    assert.equal(ok.remainingAfterINR, 100);
    assert.equal(ok.lines.find((l) => l.channel === 'whatsapp').estimatedAdditionalRegistrations, 100);
    assert.equal(ok.lines.find((l) => l.channel === 'linkedin').estimatedAdditionalRegistrations, null);
    assert.deepEqual(ok.unestimatedChannels, ['linkedin']);
    assert.match(ok.label, /MODEL ESTIMATE/);
  });
});

describe('alerts', () => {
  const rules = { declinePct: 30, minPriorAvg: 3, maxCprINR: 150, minRegsForCpr: 10, budgetWarnPct: 80, budgetCriticalPct: 100, referralSpikePerHour: 5 };
  const budget = { usedPct: 85, actualTotalINR: 1700, capINR: 2000, plannedTotalINR: 1000, plannedOverCap: false, blendedCostPerRegistrationINR: 20 };
  const mk = (counts) => counts.map((count, i) => ({ day: `2026-10-${20 + i}`, count }));
  const run = (o) => computeAlerts({ rules, daily: mk([10, 10, 10, 4, 3]), asOfDate: '2026-10-24', budget, channels: [], referralSpikes: [], totalRegistrations: 37, now: new Date('2026-10-24T00:00:00Z'), ...o });
  it('detects decline, budget warning, high CPR and referral spikes; states on-refresh mode', () => {
    const r = run({ budget: { ...budget, blendedCostPerRegistrationINR: 200 }, channels: [{ channel: 'x', registrations: 20, costPerRegistrationINR: 300 }], referralSpikes: [{ ambassadorId: 'a', displayName: 'A', hour: '2026-10-24T10', count: 9 }] });
    const types = r.alerts.map((a) => a.type);
    assert.ok(types.includes('registration_decline') && types.includes('budget_threshold') && types.includes('high_cost_per_registration') && types.includes('referral_spike'));
    assert.equal(r.mode, 'on_refresh');
    assert.match(r.notice, /no background monitoring/i);
  });
  it('respects configurable thresholds and avoids false alarms on thin data', () => {
    assert.ok(!run({ rules: { ...rules, declinePct: 90 } }).alerts.some((a) => a.type === 'registration_decline'));
    assert.ok(!run({ daily: mk([1, 1, 1, 0, 0]) }).alerts.some((a) => a.type === 'registration_decline'));
    assert.ok(!run({ budget: { ...budget, usedPct: 10 } }).alerts.some((a) => a.type === 'budget_threshold'));
    assert.equal(run({ budget: { ...budget, usedPct: 100 } }).alerts[0].severity, 'critical');
  });
});

describe('csv, privacy helpers, content lint, config', () => {
  it('neutralises spreadsheet formulas and quotes properly', () => {
    const out = toCsv([{ a: '=HYPERLINK("x")', b: 'hello, "world"', c: -5, d: '@cmd' }], [{ key: 'a', label: 'a' }, { key: 'b', label: 'b' }, { key: 'c', label: 'c' }, { key: 'd', label: 'd' }]);
    assert.ok(out.startsWith('a,b,c,d\r\n'));
    assert.ok(out.includes('"\'=HYPERLINK(""x"")"'));
    assert.ok(out.includes('"hello, ""world"""'));
    assert.ok(out.includes(',-5,'));
    assert.ok(out.includes("'@cmd"));
  });
  it('normalises emails to catch duplicate-signup tricks and masks contacts', () => {
    assert.equal(normalizeEmail('A.B+promo@GMAIL.com'), 'ab@gmail.com');
    assert.equal(normalizeEmail('ab@googlemail.com'), 'ab@gmail.com');
    assert.equal(normalizeEmail('first.last+x@college.edu'), 'first.last@college.edu');
    assert.equal(maskEmail('alice@x.com'), 'a***@x.com');
  });
  it('blocks invented dates, certificates, endorsements and scarcity; allows the placeholder flow', () => {
    assert.equal(lintContent('Join us on 5th November at 6 PM').ok, false);
    assert.equal(lintContent('Get a certificate on completion').ok, false);
    assert.equal(lintContent('Only 20 seats left, hurry!').ok, false);
    assert.equal(lintContent('Endorsed by a top company').ok, false);
    assert.equal(lintContent('Placement guaranteed').ok, false);
    const clean = lintContent('Build your first AI project in 60 minutes. Register: https://x.test/?utm_source=whatsapp');
    assert.equal(clean.ok, true);
    assert.equal(clean.readyToApprove, true);
    assert.equal(lintContent('When: [DATE & TIME – confirm before sending]').readyToApprove, false);
  });
  it('validates environment and never echoes secret values', () => {
    assert.throws(() => loadConfig({}), (e) => /JWT_SECRET/.test(e.message) && /ADMIN_PASSWORD/.test(e.message));
    assert.throws(() => loadConfig({ JWT_SECRET: 'short-but-secret-value', ANALYTICS_SALT: 'x'.repeat(16), ADMIN_EMAIL: 'a@b.co', ADMIN_PASSWORD: 'p'.repeat(12) }), (e) => !e.message.includes('short-but-secret-value') && /JWT_SECRET/.test(e.message));
    const ok = { JWT_SECRET: 'j'.repeat(32), ANALYTICS_SALT: 's'.repeat(16), ADMIN_EMAIL: 'a@b.co', ADMIN_PASSWORD: 'p'.repeat(12) };
    assert.throws(() => loadConfig({ ...ok, NODE_ENV: 'production' }), /MONGODB_URI/);
    assert.throws(() => loadConfig({ ...ok, CORS_ORIGINS: '*' }), /CORS_ORIGINS/);
    assert.equal(loadConfig(ok).gemini.apiKey, null);
  });
});
