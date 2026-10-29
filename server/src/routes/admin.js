import { ApiError, csv } from '../http/framework.js';
import { READ, WRITE, auth, created, deepMerge, parseView, rl } from '../http/helpers.js';
import { ValidationError, parse, v } from '../lib/validate.js';
import { hashPassword, signJwt, verifyPassword } from '../lib/auth.js';
import { toCsv } from '../lib/csv.js';
import { dayKey, hmac, normalizeEmail, normalizeSource, round, sum } from '../lib/util.js';
import { computeAll, datasetLabel, loadData, publicView } from '../domain/analytics.js';
import { attributionLimitations, attributionRules } from '../domain/metrics.js';
import { getSettings, mergeSettings, validateSettingsPatch } from '../domain/settings.js';
import { EXPERIMENT_VARIANT_KEY, experimentResults } from '../domain/experiments.js';
import { ambassadorReport, generateCode, referralRuleExplanations, REFERRAL_STATUSES } from '../domain/referrals.js';
import { budgetRecommendations, budgetSummary, whatIf } from '../domain/budget.js';
import { writeAudit } from '../domain/audit.js';
import { loadDemo, resetDemo } from '../domain/demoSeed.js';
import { analyze } from '../ai/copilot.js';
import { CHANNELS, LIMITS, SEGMENTS, TONES, generateContent, lintContent, buildLink } from '../ai/content.js';
import { DuplicateError } from '../store/schema.js';

const DUMMY_HASH = hashPassword('not-a-real-password-for-timing');
const reasonField = v.string({ min: 3, max: 300 });

export async function ensureUsers(store, config) {
  const upsert = async (email, password, role) => {
    const existing = await store.findOne('users', { email });
    const passwordHash = hashPassword(password);
    if (existing) await store.update('users', { email }, { passwordHash, role });
    else await store.insert('users', { email, passwordHash, role, createdAt: config.now().toISOString() });
  };
  await upsert(config.adminEmail, config.adminPassword, 'admin');
  if (config.analystEmail) await upsert(config.analystEmail, config.analystPassword, 'analyst');
}

const registrationRow = (r) => ({
  id: r._id.slice(0, 8), createdAt: r.createdAt, day: r.day, contact: r.emailMasked, college: r.college,
  channel: r.attribution.channel, source: r.attribution.source, medium: r.attribution.medium, campaign: r.attribution.campaign, content: r.attribution.content,
  variant: r.attribution.variant, referralCode: r.referral?.code || null, referralStatus: r.referral?.status || null,
});
const REG_COLUMNS = [
  { key: 'id', label: 'id' }, { key: 'createdAt', label: 'created_at' }, { key: 'day', label: 'day' }, { key: 'contact', label: 'contact_masked' },
  { key: 'college', label: 'college' }, { key: 'channel', label: 'channel' }, { key: 'source', label: 'utm_source' }, { key: 'medium', label: 'utm_medium' },
  { key: 'campaign', label: 'utm_campaign' }, { key: 'content', label: 'utm_content' }, { key: 'variant', label: 'variant' },
  { key: 'referralCode', label: 'referral_code' }, { key: 'referralStatus', label: 'referral_status' },
];

export function registerAdmin(router, deps) {
  const { config, store, fetchImpl } = deps;
  const api = rl('api');
  const ai = rl('ai');
  const tz = config.tzOffsetMin;

  const analytics = async (ctx) => {
    const view = parseView(ctx.query);
    const data = await loadData(store, view.dataset);
    return { view, data, a: computeAll(data, view, config) };
  };
  const csvLabelled = (name, view, rows, columns) => csv(`${name}-${view.dataset}.csv`, toCsv(rows, columns));

  /* ---------------- auth ---------------- */
  router.post('/api/auth/login', rl('login'), async (ctx) => {
    const b = parse(v.object({ email: v.string({ max: 120, lower: true }), password: v.string({ max: 200, trim: false }) }), await ctx.body());
    const user = await store.findOne('users', { email: b.email });
    const ok = verifyPassword(b.password, user ? user.passwordHash : DUMMY_HASH);
    if (!user || !ok) throw new ApiError(401, 'invalid_credentials', 'Incorrect email or password');
    const token = signJwt({ sub: user._id, email: user.email, role: user.role }, config.jwtSecret, config.jwtTtlSeconds, config.now().getTime());
    return { token, user: { email: user.email, role: user.role }, expiresInSeconds: config.jwtTtlSeconds };
  });
  router.get('/api/auth/me', api, auth(...READ), (ctx) => ({ user: ctx.user }));

  /* ---------------- overview & registrations ---------------- */
  router.get('/api/overview', api, auth(...READ), async (ctx) => {
    const { a } = await analytics(ctx);
    const { channelsAll, ...rest } = publicView(a);
    return { ...rest, alertCounts: a.alerts.alerts.reduce((m, x) => ({ ...m, [x.severity]: (m[x.severity] || 0) + 1 }), {}) };
  });

  router.get('/api/registrations', api, auth(...READ), async (ctx) => {
    const { view, a } = await analytics(ctx);
    const rows = [...a._filtered.registrations].sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1));
    const limit = Math.min(200, Math.max(1, Number(ctx.query.limit) || 50));
    const offset = Math.max(0, Number(ctx.query.offset) || 0);
    return {
      ...datasetLabel(view.dataset), filters: a.filters, total: rows.length, limit, offset, daily: a.daily,
      note: 'Contact details are masked in the dashboard and exports. Full contact data stays server-side for the organisers.',
      items: rows.slice(offset, offset + limit).map(registrationRow),
    };
  });
  router.get('/api/registrations/export.csv', api, auth(...READ), async (ctx) => {
    const { view, a } = await analytics(ctx);
    const rows = [...a._filtered.registrations].sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1)).map(registrationRow);
    return csvLabelled('registrations', view, rows, REG_COLUMNS);
  });

  /* ---------------- attribution ---------------- */
  router.get('/api/attribution', api, auth(...READ), async (ctx) => {
    const { a } = await analytics(ctx);
    const group = (key) => {
      const m = {};
      for (const r of a._filtered.registrations) { const k = r.attribution[key] || '(none)'; m[k] = (m[k] || 0) + 1; }
      return Object.entries(m).map(([name, registrations]) => ({ name, registrations })).sort((x, y) => y.registrations - x.registrations);
    };
    const { dataset, simulated, label, filters, funnel, channels } = publicView(a);
    return { dataset, simulated, label, filters, funnel, channels, byCampaign: group('campaign'), byContent: group('content'), byMedium: group('medium'), rules: attributionRules(), limitations: attributionLimitations };
  });
  router.get('/api/attribution/export.csv', api, auth(...READ), async (ctx) => {
    const { view, a } = await analytics(ctx);
    if (ctx.query.report === 'funnel') {
      return csvLabelled('funnel', view, a.funnel.stages, [{ key: 'label', label: 'stage' }, { key: 'count', label: 'count' }, { key: 'stepRate', label: 'step_rate' }, { key: 'dropOff', label: 'drop_off' }]);
    }
    return csvLabelled('channels', view, a.channels, [
      { key: 'channel', label: 'channel' }, { key: 'visitors', label: 'visitors' }, { key: 'ctaClicks', label: 'cta_clicks' }, { key: 'starts', label: 'registration_starts' },
      { key: 'registrations', label: 'registrations' }, { key: 'share', label: 'share_of_registrations' }, { key: 'visitToRegRate', label: 'visit_to_registration_rate' },
      { key: 'spendINR', label: 'actual_spend_inr' }, { key: 'costPerRegistrationINR', label: 'cost_per_registration_inr' },
    ]);
  });

  /* ---------------- forecast ---------------- */
  router.get('/api/forecast', api, auth(...READ), async (ctx) => {
    const { a } = await analytics(ctx);
    return { dataset: a.dataset, simulated: a.simulated, label: a.label, filtersNote: 'The forecast always uses the full campaign window and all channels; date/channel filters apply to other reports.', ...a.forecast, thresholds: a.campaign };
  });
  router.get('/api/forecast/export.csv', api, auth(...READ), async (ctx) => {
    const { view, a } = await analytics(ctx);
    const f = a.forecast;
    const rows = f.dailySeries.map((d) => ({ row: 'actual_daily', label: d.day, value: d.count }));
    if (f.scenarios) for (const s of Object.values(f.scenarios)) rows.push({ row: 'scenario_projected_total', label: s.label, value: s.projectedTotal });
    rows.push({ row: 'target', label: 'target', value: f.campaign.target }, { row: 'required_per_day', label: 'required_per_day', value: f.totals.requiredPerDay });
    return csvLabelled('forecast', view, rows, [{ key: 'row', label: 'row' }, { key: 'label', label: 'label' }, { key: 'value', label: 'value' }]);
  });

  /* ---------------- experiments ---------------- */
  const VARIANT = v.object({
    key: v.string({ pattern: EXPERIMENT_VARIANT_KEY, patternMessage: 'must be lowercase letters, digits, - or _ (max 32)' }),
    label: v.string({ min: 1, max: 60 }), headline: v.string({ min: 3, max: 120 }), subhead: v.string({ max: 200, optional: true, default: '' }),
    cta: v.string({ min: 2, max: 40 }), weight: v.number({ min: 0.1, max: 100, optional: true, default: 1 }),
  });
  const EXP = v.object({ key: v.string({ pattern: EXPERIMENT_VARIANT_KEY }), name: v.string({ min: 3, max: 80 }), variants: v.array(VARIANT, { min: 2, max: 5 }), reason: reasonField });

  router.get('/api/experiments', api, auth(...READ), async (ctx) => {
    const { view, a } = await analytics(ctx);
    const data = await store.find('experiments', { dataset: view.dataset });
    return {
      dataset: a.dataset, simulated: a.simulated, label: a.label,
      experiments: a.experiments.map((r) => ({ ...r, config: data.find((e) => e.key === r.experimentKey).variants })),
      note: view.dataset === 'demo' ? 'These results are SIMULATED and are never combined with real experiment results.' : 'Results come only from events recorded by this installation.',
    };
  });
  router.post('/api/experiments', api, auth(...WRITE), async (ctx) => {
    const view = parseView(ctx.query);
    const b = parse(EXP, await ctx.body());
    if (new Set(b.variants.map((x) => x.key)).size !== b.variants.length) throw new ValidationError([{ path: 'variants', message: 'variant keys must be unique' }]);
    if ((await store.find('experiments', { dataset: view.dataset, status: 'running' })).length) throw new ApiError(409, 'experiment_running', 'Another experiment is already running. Pause or complete it first.');
    let doc;
    try {
      doc = await store.insert('experiments', { dataset: view.dataset, key: b.key, name: b.name, variants: b.variants, status: 'running', simulated: view.dataset === 'demo', createdAt: config.now().toISOString() });
    } catch (e) { if (e instanceof DuplicateError) throw new ApiError(409, 'duplicate', 'An experiment with this key already exists'); throw e; }
    await writeAudit(store, config, { dataset: view.dataset, actor: ctx.user, type: 'experiment_created', summary: `Experiment "${b.key}" created with ${b.variants.length} variants`, details: { variants: b.variants.map((x) => x.key) }, reason: b.reason });
    return created({ ok: true, experiment: doc });
  });
  router.put('/api/experiments/:key/status', api, auth(...WRITE), async (ctx) => {
    const view = parseView(ctx.query);
    const b = parse(v.object({ status: v.enum(['running', 'paused', 'completed']), reason: reasonField }), await ctx.body());
    const exp = await store.findOne('experiments', { dataset: view.dataset, key: ctx.params.key });
    if (!exp) throw new ApiError(404, 'not_found', 'Experiment not found');
    if (b.status === 'running' && (await store.find('experiments', { dataset: view.dataset, status: 'running' })).some((e) => e.key !== exp.key)) throw new ApiError(409, 'experiment_running', 'Another experiment is already running');
    await store.update('experiments', { dataset: view.dataset, key: exp.key }, { status: b.status });
    await writeAudit(store, config, { dataset: view.dataset, actor: ctx.user, type: 'experiment_status', summary: `Experiment "${exp.key}" ${exp.status} → ${b.status}`, details: {}, reason: b.reason });
    return { ok: true };
  });
  router.get('/api/experiments/export.csv', api, auth(...READ), async (ctx) => {
    const { view, a } = await analytics(ctx);
    const rows = a.experiments.flatMap((e) => e.variants.map((x) => ({ experiment: e.experimentKey, data: e.simulated ? 'SIMULATED' : 'recorded', variant: x.variant, visitors: x.visitors, clicks: x.ctaClicks, starts: x.starts, registrations: x.registrations, rate: x.conversionRate, ciLow: x.ci95?.low, ciHigh: x.ci95?.high, verdict: e.verdict })));
    return csvLabelled('experiments', view, rows, [
      { key: 'experiment', label: 'experiment' }, { key: 'data', label: 'data_label' }, { key: 'variant', label: 'variant' }, { key: 'visitors', label: 'visitors' }, { key: 'clicks', label: 'cta_clicks' },
      { key: 'starts', label: 'registration_starts' }, { key: 'registrations', label: 'registrations' }, { key: 'rate', label: 'conversion_rate' }, { key: 'ciLow', label: 'ci95_low' }, { key: 'ciHigh', label: 'ci95_high' }, { key: 'verdict', label: 'verdict' },
    ]);
  });

  /* ---------------- referrals ---------------- */
  router.get('/api/referrals', api, auth(...READ), async (ctx) => {
    const { data, a } = await analytics(ctx);
    return {
      dataset: a.dataset, simulated: a.simulated, label: a.label, leaderboard: a.referrals.leaderboard, spikes: a.referrals.spikes,
      rules: data.settings.referralRules, ruleExplanations: referralRuleExplanations(data.settings.referralRules), statusLegend: REFERRAL_STATUSES,
      totals: { points: a.referrals.leaderboard.reduce((s, r) => s + r.points, 0), referredSubmissions: data.registrations.filter((r) => r.referral).length, valid: data.registrations.filter((r) => r.referral?.status === 'valid').length },
    };
  });
  router.post('/api/referrals/ambassadors', api, auth(...WRITE), async (ctx) => {
    const view = parseView(ctx.query);
    const b = parse(v.object({ displayName: v.string({ min: 2, max: 60 }), email: v.string({ optional: true, max: 120, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/ }), reason: reasonField }), await ctx.body());
    const existing = new Set((await store.find('ambassadors', { dataset: view.dataset })).map((x) => x.code));
    const code = generateCode(existing, view.dataset === 'demo' ? 'DEMO' : 'AMB');
    const amb = await store.insert('ambassadors', {
      dataset: view.dataset, simulated: view.dataset === 'demo', displayName: b.displayName, code, status: 'active',
      emailHash: b.email ? hmac(config.analyticsSalt, normalizeEmail(b.email)) : null, createdAt: config.now().toISOString(),
    });
    await writeAudit(store, config, { dataset: view.dataset, actor: ctx.user, type: 'ambassador_created', summary: `Ambassador "${b.displayName}" created`, details: { code }, reason: b.reason });
    return created({ ok: true, ambassador: { id: amb._id, displayName: amb.displayName, code, status: amb.status, link: buildLink(config, { channel: 'ambassador_outreach', segment: 'cs_it', tone: 'friendly', refCode: code }).url.replace(/&utm_content=[^&]*/, '') } });
  });
  router.put('/api/referrals/ambassadors/:id/status', api, auth(...WRITE), async (ctx) => {
    const view = parseView(ctx.query);
    const b = parse(v.object({ status: v.enum(['active', 'paused']), reason: reasonField }), await ctx.body());
    const amb = await store.findOne('ambassadors', { dataset: view.dataset, _id: ctx.params.id });
    if (!amb) throw new ApiError(404, 'not_found', 'Ambassador not found');
    await store.update('ambassadors', { dataset: view.dataset, _id: amb._id }, { status: b.status });
    await writeAudit(store, config, { dataset: view.dataset, actor: ctx.user, type: 'ambassador_status', summary: `Ambassador "${amb.displayName}" ${amb.status} → ${b.status}`, details: { code: amb.code }, reason: b.reason });
    return { ok: true };
  });
  router.get('/api/referrals/ambassadors/:id/report', api, auth(...READ), async (ctx) => {
    const view = parseView(ctx.query);
    const data = await loadData(store, view.dataset);
    const amb = data.ambassadors.find((x) => x._id === ctx.params.id);
    if (!amb) throw new ApiError(404, 'not_found', 'Ambassador not found');
    return { ...datasetLabel(view.dataset), ...ambassadorReport(amb, data.registrations, view.from, view.to, data.settings.referralRules.pointsPerReferral) };
  });
  router.get('/api/referrals/export.csv', api, auth(...READ), async (ctx) => {
    const { view, a } = await analytics(ctx);
    return csvLabelled('referral-leaderboard', view, a.referrals.leaderboard, [
      { key: 'rank', label: 'rank' }, { key: 'displayName', label: 'ambassador' }, { key: 'code', label: 'code' }, { key: 'points', label: 'points' }, { key: 'validReferrals', label: 'valid_referrals' },
      { key: 'rejectedReferrals', label: 'rejected_referrals' }, { key: 'totalSubmitted', label: 'total_submitted' }, { key: 'status', label: 'status' },
    ]);
  });

  /* ---------------- budget ---------------- */
  router.get('/api/budget', api, auth(...READ), async (ctx) => {
    const { data, a } = await analytics(ctx);
    return {
      dataset: a.dataset, simulated: a.simulated, label: a.label, summary: a.budget, filteredSummary: a.budgetFiltered, ...a.budgetRecommendations,
      entries: data.spend.filter((s) => s.kind === 'actual').sort((x, y) => (x.date < y.date ? 1 : -1)).map((s) => ({ id: s._id, channel: s.channel, amountINR: s.amount, date: s.date, note: s.note })),
      semantics: 'Planned = intended allocation. Actual = recorded spend. Proposals (recommendations / what-if) are neither and are never written to either.',
    };
  });
  const channelKey = v.string({ min: 2, max: 40 });
  router.post('/api/budget/spend', api, auth(...WRITE), async (ctx) => {
    const view = parseView(ctx.query);
    const b = parse(v.object({ channel: channelKey, amountINR: v.number({ min: 1, max: 2000 }), date: v.string({ optional: true, pattern: /^\d{4}-\d{2}-\d{2}$/ }), note: v.string({ optional: true, max: 200 }), acknowledgeOverCap: v.boolean({ optional: true }), reason: reasonField }), await ctx.body());
    const channel = normalizeSource(b.channel);
    if (!channel) throw new ValidationError([{ path: 'channel', message: 'is not a valid channel name' }]);
    const settings = await getSettings(store, view.dataset);
    const spent = sum((await store.find('spend', { dataset: view.dataset, kind: 'actual' })), (s) => s.amount);
    if (spent + b.amountINR > settings.budgetCapINR && !b.acknowledgeOverCap) {
      throw new ApiError(409, 'over_cap', `This would take actual spend to ₹${spent + b.amountINR}, above the ₹${settings.budgetCapINR} cap. Re-send with acknowledgeOverCap=true only if the money was actually spent.`);
    }
    const entry = await store.insert('spend', { dataset: view.dataset, simulated: view.dataset === 'demo', kind: 'actual', channel, amount: b.amountINR, date: b.date || dayKey(config.now().getTime(), tz), note: b.note || '', createdBy: ctx.user.email, createdAt: config.now().toISOString() });
    await writeAudit(store, config, { dataset: view.dataset, actor: ctx.user, type: 'spend_recorded', summary: `Recorded ₹${b.amountINR} actual spend on ${channel}`, details: { overCap: spent + b.amountINR > settings.budgetCapINR }, reason: b.reason });
    return created({ ok: true, id: entry._id, totalActualINR: spent + b.amountINR });
  });
  router.delete('/api/budget/spend/:id', api, auth(...WRITE), async (ctx) => {
    const view = parseView(ctx.query);
    const b = parse(v.object({ reason: reasonField }), await ctx.body());
    const e = await store.findOne('spend', { dataset: view.dataset, _id: ctx.params.id, kind: 'actual' });
    if (!e) throw new ApiError(404, 'not_found', 'Spend entry not found');
    await store.deleteMany('spend', { dataset: view.dataset, _id: e._id });
    await writeAudit(store, config, { dataset: view.dataset, actor: ctx.user, type: 'spend_removed', summary: `Removed ₹${e.amount} spend entry on ${e.channel}`, details: { date: e.date }, reason: b.reason });
    return { ok: true };
  });
  router.put('/api/budget/plan', api, auth(...WRITE), async (ctx) => {
    const view = parseView(ctx.query);
    const b = parse(v.object({ allocations: v.object(null, { values: v.number({ min: 0, max: 2000 }) }), reason: reasonField }), await ctx.body());
    const settings = await getSettings(store, view.dataset);
    const entries = Object.entries(b.allocations).map(([ch, amt]) => [normalizeSource(ch), amt]);
    if (entries.some(([ch]) => !ch)) throw new ValidationError([{ path: 'allocations', message: 'contains an invalid channel name' }]);
    const total = sum(entries, ([, amt]) => amt);
    if (total > settings.budgetCapINR) throw new ApiError(400, 'plan_over_cap', `Planned total ₹${total} exceeds the ₹${settings.budgetCapINR} cap`);
    await store.deleteMany('spend', { dataset: view.dataset, kind: 'planned' });
    for (const [channel, amount] of entries) if (amount > 0) await store.insert('spend', { dataset: view.dataset, simulated: view.dataset === 'demo', kind: 'planned', channel, amount, date: null, note: 'plan', createdAt: config.now().toISOString() });
    await writeAudit(store, config, { dataset: view.dataset, actor: ctx.user, type: 'budget_plan_changed', summary: `Budget plan set (₹${total} across ${entries.filter(([, x]) => x > 0).length} channels)`, details: { allocations: Object.fromEntries(entries) }, reason: b.reason });
    return { ok: true, plannedTotalINR: total };
  });
  router.post('/api/budget/whatif', api, auth(...READ), async (ctx) => {
    const { a } = await analytics(ctx);
    const b = parse(v.object({ allocations: v.object(null, { values: v.number({ min: 0, max: 2000 }) }) }), await ctx.body());
    const alloc = {};
    for (const [ch, amt] of Object.entries(b.allocations)) { const k = normalizeSource(ch); if (!k) throw new ValidationError([{ path: 'allocations', message: 'contains an invalid channel name' }]); alloc[k] = (alloc[k] || 0) + amt; }
    const r = whatIf(a.budget, alloc);
    if (!r.ok) throw new ApiError(400, 'whatif_invalid', r.errors.join(' '), r.errors);
    return { dataset: a.dataset, simulated: a.simulated, ...r };
  });
  router.get('/api/budget/export.csv', api, auth(...READ), async (ctx) => {
    const { view, a } = await analytics(ctx);
    return csvLabelled('budget', view, a.budget.channels, [
      { key: 'channel', label: 'channel' }, { key: 'plannedINR', label: 'planned_inr' }, { key: 'actualINR', label: 'actual_inr' }, { key: 'varianceINR', label: 'actual_minus_planned_inr' },
      { key: 'registrations', label: 'registrations' }, { key: 'costPerRegistrationINR', label: 'cost_per_registration_inr' }, { key: 'sampleSufficient', label: 'sample_sufficient' },
    ]);
  });

  /* ---------------- AI copilot ---------------- */
  router.post('/api/copilot/analyze', api, ai, auth(...READ), async (ctx) => {
    const { a } = await analytics(ctx);
    const b = parse(v.object({ question: v.string({ optional: true, max: 300 }) }), await ctx.body());
    const result = await analyze({ analytics: a, config, fetchImpl, question: b.question });
    const audit = await writeAudit(store, config, { dataset: a.dataset, actor: ctx.user, type: 'ai_suggestion', summary: `Copilot produced ${result.recommendations.length} recommendation(s) via ${result.source}`, details: { source: result.source, recommendations: result.recommendations.map((r) => ({ id: r.id, title: r.title })) } });
    return { analysisId: audit._id, ...result };
  });
  router.post('/api/copilot/decisions', api, auth(...WRITE), async (ctx) => {
    const view = parseView(ctx.query);
    const b = parse(v.object({ analysisId: v.string({ optional: true, max: 80 }), recommendationId: v.string({ min: 1, max: 80 }), title: v.string({ min: 1, max: 200 }), decision: v.enum(['accepted', 'rejected']), reason: v.string({ optional: true, max: 300 }) }), await ctx.body());
    if (b.decision === 'rejected' && (!b.reason || b.reason.length < 3)) throw new ValidationError([{ path: 'reason', message: 'a reason is required when rejecting a recommendation' }]);
    const d = await store.insert('decisions', { dataset: view.dataset, ...b, decidedBy: ctx.user.email, ts: config.now().toISOString() });
    await writeAudit(store, config, { dataset: view.dataset, actor: ctx.user, type: `recommendation_${b.decision}`, summary: `${b.decision === 'accepted' ? 'Accepted' : 'Rejected'}: ${b.title}`, details: { recommendationId: b.recommendationId, analysisId: b.analysisId || null }, reason: b.reason || null });
    return created({ ok: true, id: d._id, externalActionTaken: false, note: 'Decision recorded. The platform performs no external action; any outreach or spend is carried out manually by a person.' });
  });
  router.get('/api/copilot/decisions', api, auth(...READ), async (ctx) => {
    const view = parseView(ctx.query);
    return { items: (await store.find('decisions', { dataset: view.dataset })).sort((x, y) => (x.ts < y.ts ? 1 : -1)) };
  });

  /* ---------------- content studio ---------------- */
  router.get('/api/content/options', api, auth(...READ), () => ({ channels: CHANNELS, segments: SEGMENTS, tones: TONES, limits: LIMITS, rules: ['Drafts never send automatically; there is no send endpoint.', 'Dates and times are left as a placeholder you must fill in.', 'Certificates, partner endorsements, guarantees and scarcity claims are blocked by a content check.'] }));
  const CONTENT_BASE = { channel: v.enum(CHANNELS), segment: v.enum(Object.keys(SEGMENTS)), tone: v.enum(TONES) };
  router.post('/api/content/generate', api, ai, auth(...READ), async (ctx) => {
    const b = parse(v.object({ ...CONTENT_BASE, tones: v.array(v.enum(TONES), { optional: true, max: 4 }), refCode: v.string({ optional: true, max: 24 }), ambassadorName: v.string({ optional: true, max: 60 }), useAI: v.boolean({ optional: true }) }), await ctx.body());
    const tones = b.tones?.length ? b.tones : [b.tone];
    const results = [];
    for (const tone of tones) results.push(await generateContent({ config, fetchImpl, channel: b.channel, segment: b.segment, tone, refCode: b.refCode ? b.refCode.toUpperCase() : null, ambassadorName: b.ambassadorName, useAI: b.useAI }));
    return { variants: results.map((r) => r.variant), notes: [...new Set(results.map((r) => r.note).filter(Boolean))], aiUsed: results.some((r) => r.aiUsed), approvalPolicy: 'Drafts are never sent by this platform. A human must review, edit, approve and post them manually.' };
  });
  const DRAFT = v.object({ ...CONTENT_BASE, text: v.string({ min: 10, max: 4000, trim: false }), subject: v.string({ optional: true, max: 150 }), refCode: v.string({ optional: true, max: 24 }), campaignTag: v.string({ optional: true, max: 120 }) });
  const draftView = (d) => ({ id: d._id, channel: d.channel, segment: d.segment, tone: d.tone, text: d.text, subject: d.subject || null, campaignTag: d.campaignTag || null, characterCount: d.text.length, characterLimit: LIMITS[d.channel], status: d.status, lint: lintContent(`${d.subject || ''}\n${d.text}`), approvedBy: d.approvedBy || null, approvedAt: d.approvedAt || null, sent: false, updatedAt: d.updatedAt });
  router.post('/api/content/drafts', api, auth(...WRITE), async (ctx) => {
    const view = parseView(ctx.query);
    const b = parse(DRAFT, await ctx.body());
    const d = await store.insert('drafts', { dataset: view.dataset, ...b, status: 'draft', createdBy: ctx.user.email, updatedAt: config.now().toISOString() });
    await writeAudit(store, config, { dataset: view.dataset, actor: ctx.user, type: 'content_draft_saved', summary: `Saved ${b.channel} draft (${b.segment}, ${b.tone})`, details: { draftId: d._id } });
    return created({ draft: draftView(d) });
  });
  router.get('/api/content/drafts', api, auth(...READ), async (ctx) => {
    const view = parseView(ctx.query);
    return { items: (await store.find('drafts', { dataset: view.dataset })).sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : -1)).map(draftView) };
  });
  router.put('/api/content/drafts/:id', api, auth(...WRITE), async (ctx) => {
    const view = parseView(ctx.query);
    const b = parse(v.object({ text: v.string({ min: 10, max: 4000, trim: false }), subject: v.string({ optional: true, max: 150 }) }), await ctx.body());
    const d = await store.findOne('drafts', { dataset: view.dataset, _id: ctx.params.id });
    if (!d) throw new ApiError(404, 'not_found', 'Draft not found');
    await store.update('drafts', { _id: d._id }, { text: b.text, subject: b.subject ?? d.subject ?? null, status: 'draft', approvedBy: null, approvedAt: null, updatedAt: config.now().toISOString() });
    return { draft: draftView(await store.findOne('drafts', { _id: d._id })) };
  });
  router.post('/api/content/drafts/:id/approve', api, auth(...WRITE), async (ctx) => {
    const view = parseView(ctx.query);
    const d = await store.findOne('drafts', { dataset: view.dataset, _id: ctx.params.id });
    if (!d) throw new ApiError(404, 'not_found', 'Draft not found');
    const lint = lintContent(`${d.subject || ''}\n${d.text}`);
    if (!lint.readyToApprove) throw new ApiError(422, 'not_ready', 'Draft cannot be approved yet', { blocking: lint.blocking, placeholders: lint.placeholders });
    await store.update('drafts', { _id: d._id }, { status: 'approved', approvedBy: ctx.user.email, approvedAt: config.now().toISOString() });
    await writeAudit(store, config, { dataset: view.dataset, actor: ctx.user, type: 'content_approved', summary: `Approved ${d.channel} draft for manual posting`, details: { draftId: d._id } });
    return { ok: true, sent: false, note: 'Approved for manual posting. The platform does not send messages.' };
  });

  /* ---------------- alerts, audit, settings ---------------- */
  router.get('/api/alerts', api, auth(...READ), async (ctx) => {
    const { view, a } = await analytics(ctx);
    const acks = (await store.find('audit', { dataset: view.dataset, type: 'alert_ack' }));
    const ackIds = new Map(acks.map((x) => [x.details.alertId, x]));
    return { ...datasetLabel(view.dataset), ...a.alerts, alerts: a.alerts.alerts.map((x) => ({ ...x, acknowledged: ackIds.has(x.id), acknowledgedReason: ackIds.get(x.id)?.reason || null })) };
  });
  router.post('/api/alerts/ack', api, auth(...WRITE), async (ctx) => {
    const view = parseView(ctx.query);
    const b = parse(v.object({ alertId: v.string({ min: 1, max: 120 }), reason: reasonField }), await ctx.body());
    await writeAudit(store, config, { dataset: view.dataset, actor: ctx.user, type: 'alert_ack', summary: `Acknowledged alert ${b.alertId}`, details: { alertId: b.alertId }, reason: b.reason });
    return { ok: true };
  });
  router.get('/api/audit', api, auth(...READ), async (ctx) => {
    const view = parseView(ctx.query);
    const items = (await store.find('audit', { dataset: view.dataset })).filter((x) => (!ctx.query.type || x.type === ctx.query.type) && (!view.from || x.ts.slice(0, 10) >= view.from) && (!view.to || x.ts.slice(0, 10) <= view.to)).sort((x, y) => (x.ts < y.ts ? 1 : -1));
    const limit = Math.min(500, Math.max(1, Number(ctx.query.limit) || 100));
    return { ...datasetLabel(view.dataset), total: items.length, items: items.slice(0, limit).map(({ _id, ts, actor, role, type, summary, reason, details }) => ({ id: _id, ts, actor, role, type, summary, reason, details })) };
  });
  router.get('/api/audit/export.csv', api, auth(...READ), async (ctx) => {
    const view = parseView(ctx.query);
    const items = (await store.find('audit', { dataset: view.dataset })).sort((x, y) => (x.ts < y.ts ? 1 : -1));
    return csvLabelled('audit-log', view, items, [{ key: 'ts', label: 'timestamp' }, { key: 'actor', label: 'actor' }, { key: 'type', label: 'type' }, { key: 'summary', label: 'summary' }, { key: 'reason', label: 'reason' }]);
  });
  router.get('/api/settings', api, auth(...READ), async (ctx) => {
    const view = parseView(ctx.query);
    return { ...datasetLabel(view.dataset), settings: await getSettings(store, view.dataset), gemini: { configured: Boolean(config.gemini.apiKey), model: config.gemini.apiKey ? config.gemini.model : null }, store: store.kind };
  });
  router.put('/api/settings', api, auth(...WRITE), async (ctx) => {
    const view = parseView(ctx.query);
    const { reason, ...patch } = validateSettingsPatch(await ctx.body());
    const before = await store.findOne('settings', { dataset: view.dataset });
    const merged = deepMerge(before || {}, patch);
    await store.upsert('settings', { dataset: view.dataset }, merged);
    await writeAudit(store, config, { dataset: view.dataset, actor: ctx.user, type: 'campaign_change', summary: `Settings changed: ${Object.keys(patch).join(', ') || 'none'}`, details: { patch }, reason });
    return { ok: true, settings: mergeSettings(merged) };
  });

  /* ---------------- demo data control ---------------- */
  router.get('/api/demo/status', api, auth(...READ), async () => {
    const counts = async (dataset) => ({ registrations: await store.count('registrations', { dataset }), events: await store.count('events', { dataset }), ambassadors: await store.count('ambassadors', { dataset }) });
    return { live: await counts('live'), demo: await counts('demo') };
  });
  router.post('/api/demo/load', api, auth(...WRITE), async () => ({ ok: true, dataset: 'demo', loaded: await loadDemo(store, config), note: 'Simulated data written to the demo dataset only. Live data was not touched.' }));
  router.post('/api/demo/reset', api, auth(...WRITE), async () => ({ ok: true, dataset: 'demo', removed: await resetDemo(store), note: 'Only the demo dataset was cleared. Live data was not touched.' }));
}
