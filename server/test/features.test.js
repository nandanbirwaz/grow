import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, TEST_ENV } from './helpers.js';

const geminiOk = (recs) => async (url, init) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(recs) }] } }] }), _url: url, _init: init });

describe('demo data isolation', () => {
  let t; let admin;
  before(async () => { t = await startTestApp(); admin = await t.login(); });
  after(() => t.close());
  const counts = async () => (await t.call('GET', '/api/demo/status', { token: admin })).json;

  it('starts with an empty live dataset and no demo data', async () => {
    const c = await counts();
    assert.deepEqual(c.live, { registrations: 0, events: 0, ambassadors: 0 });
    assert.deepEqual(c.demo, { registrations: 0, events: 0, ambassadors: 0 });
    const ov = (await t.call('GET', '/api/overview', { token: admin })).json;
    assert.equal(ov.totals.registrations, 0);
    assert.equal(ov.simulated, false);
  });

  it('real registrations are recorded in live only; loading demo does not touch them', async () => {
    await t.register({ attribution: { source: 'instagram' } });
    await t.register({ attribution: { source: 'whatsapp' } });
    const before = await counts();
    assert.equal(before.live.registrations, 2);
    const load = await t.call('POST', '/api/demo/load', { token: admin });
    assert.equal(load.status, 200);
    assert.match(load.json.note, /Live data was not touched/);
    const after = await counts();
    assert.deepEqual(after.live, before.live, 'live counts unchanged by demo load');
    assert.ok(after.demo.registrations > 100);
  });

  it('live endpoints never include demo records and are not labelled simulated', async () => {
    const live = (await t.call('GET', '/api/overview', { token: admin })).json;
    assert.equal(live.dataset, 'live');
    assert.equal(live.simulated, false);
    assert.equal(live.totals.registrationsAllTime, 2);
    const regs = await t.call('GET', '/api/registrations', { token: admin });
    assert.ok(!regs.text.includes('Demo College'));
    assert.equal(regs.json.total, 2);
    assert.equal((await t.call('GET', '/api/experiments', { token: admin })).json.experiments.length, 0, 'demo experiment is not visible in live');
    assert.equal((await t.call('GET', '/api/referrals', { token: admin })).json.leaderboard.length, 0);
  });

  it('demo endpoints are labelled SIMULATED everywhere and contain only demo records', async () => {
    for (const p of ['overview', 'forecast', 'budget', 'referrals', 'experiments', 'alerts', 'registrations', 'audit', 'attribution?x=1']) {
      const r = await t.call('GET', `/api/${p}${p.includes('?') ? '&' : '?'}dataset=demo`, { token: admin });
      assert.equal(r.status, 200, p);
      assert.equal(r.json.dataset, 'demo', p);
      assert.equal(r.json.simulated, true, p);
      assert.match(r.json.label, /SIMULATED/, p);
    }
    const regs = (await t.call('GET', '/api/registrations?dataset=demo&limit=200', { token: admin })).json;
    assert.ok(regs.items.every((r) => /^d\*\*\*@example\.invalid$/.test(r.contact)), 'demo contacts are fake and masked');
    const ex = (await t.call('GET', '/api/experiments?dataset=demo', { token: admin })).json;
    assert.equal(ex.experiments[0].simulated, true);
    assert.match(ex.experiments[0].dataLabel, /SIMULATED/);
  });

  it('public tracking after demo load writes to live only', async () => {
    const demoBefore = (await counts()).demo;
    await t.register({ attribution: { source: 'linkedin' } });
    await t.call('POST', '/api/public/events', { body: { type: 'page_view', consent: false, attribution: { source: 'linkedin' } } });
    const c = await counts();
    assert.equal(c.live.registrations, 3);
    assert.deepEqual(c.demo, demoBefore);
  });

  it('is deterministic: reloading yields identical demo totals', async () => {
    const a = (await t.call('GET', '/api/overview?dataset=demo', { token: admin })).json.totals;
    await t.call('POST', '/api/demo/load', { token: admin });
    const b = (await t.call('GET', '/api/overview?dataset=demo', { token: admin })).json.totals;
    assert.deepEqual(a, b);
  });

  it('reset removes only demo data and leaves live data and users intact', async () => {
    const live = (await counts()).live;
    const r = await t.call('POST', '/api/demo/reset', { token: admin });
    assert.equal(r.status, 200);
    const c = await counts();
    assert.deepEqual(c.demo, { registrations: 0, events: 0, ambassadors: 0 });
    assert.deepEqual(c.live, live);
    assert.equal((await t.call('GET', '/api/overview', { token: admin })).status, 200);
    assert.equal((await t.store.count('spend', { dataset: 'demo' })), 0);
    assert.equal((await t.store.count('audit', { dataset: 'demo' })), 0);
  });

  it('demo data shows meaningful scenarios (forecast, alerts, no premature A/B winner)', async () => {
    await t.call('POST', '/api/demo/load', { token: admin });
    const fc = (await t.call('GET', '/api/forecast?dataset=demo', { token: admin })).json;
    assert.equal(fc.sufficient, true);
    assert.equal(fc.campaign.elapsedDays, 5);
    assert.ok(fc.totals.registrations > 100 && fc.totals.registrations < 200);
    assert.ok(fc.scenarios.conservative.projectedTotal <= fc.scenarios.base.projectedTotal && fc.scenarios.base.projectedTotal <= fc.scenarios.optimistic.projectedTotal);
    assert.equal(fc.scenarios.base.onTrack, false);
    const al = (await t.call('GET', '/api/alerts?dataset=demo', { token: admin })).json;
    assert.ok(al.alerts.some((a) => a.type === 'referral_spike'), 'seeded referral burst is detected');
    assert.ok(al.alerts.some((a) => a.type === 'registration_decline'), 'seeded decline is detected');
  });
});

describe('dashboard filtering and CSV export', () => {
  let t; let admin;
  before(async () => { t = await startTestApp(); admin = await t.login(); await t.call('POST', '/api/demo/load', { token: admin }); });
  after(() => t.close());
  const ov = (q) => t.call('GET', `/api/overview?dataset=demo${q}`, { token: admin }).then((r) => r.json);

  it('date and channel filters change totals, charts, funnel and channel tables consistently', async () => {
    const all = await ov('');
    const wa = await ov('&channel=whatsapp');
    assert.ok(wa.totals.registrations < all.totals.registrations && wa.totals.registrations > 0);
    assert.deepEqual(wa.channels.map((c) => c.channel), ['whatsapp']);
    assert.equal(wa.totals.registrations, wa.daily.reduce((s, d) => s + d.count, 0));
    assert.equal(wa.funnel.stages[3].count, wa.totals.registrations, 'funnel registrations match filtered total');
    const day = all.campaign.startDate;
    const one = await ov(`&from=${day}&to=${day}`);
    assert.equal(one.daily.length, 1);
    assert.equal(one.totals.registrations, one.daily[0].count);
    assert.equal(one.daily[0].count, all.daily[0].count);
    const none = await ov('&from=2020-01-01&to=2020-01-02');
    assert.equal(none.totals.registrations, 0);
    assert.equal(none.funnel.overallRate, null);
    const both = await ov(`&from=${day}&to=${day}&channel=instagram`);
    assert.ok(both.totals.registrations <= one.totals.registrations);
    // forecast and budget caps are intentionally global
    assert.equal(wa.forecast.totals.registrations, all.forecast.totals.registrations);
  });

  it('metrics are computed from the data, not hardcoded: adding a registration changes them', async () => {
    const t2 = await startTestApp();
    try {
      const a2 = await t2.login();
      const z = (await t2.call('GET', '/api/overview', { token: a2 })).json;
      assert.equal(z.totals.registrations, 0);
      await t2.register({ attribution: { source: 'telegram' } });
      const o = (await t2.call('GET', '/api/overview', { token: a2 })).json;
      assert.equal(o.totals.registrations, 1);
      assert.equal(o.channels[0].channel, 'telegram');
      assert.equal(o.forecast.totals.registrations, 1);
    } finally { await t2.close(); }
  });

  it('exports CSV for every report with correct headers, content type and filters applied', async () => {
    const wa = await t.call('GET', '/api/registrations/export.csv?dataset=demo&channel=whatsapp', { token: admin });
    assert.equal(wa.status, 200);
    assert.match(wa.headers.get('content-type'), /text\/csv/);
    assert.match(wa.headers.get('content-disposition'), /registrations-demo\.csv/);
    const lines = wa.text.trim().split('\r\n');
    assert.equal(lines[0], 'id,created_at,day,contact_masked,college,channel,utm_source,utm_medium,utm_campaign,utm_content,variant,referral_code,referral_status');
    const filteredTotal = (await ov('&channel=whatsapp')).totals.registrations;
    assert.equal(lines.length - 1, filteredTotal);
    assert.ok(lines.slice(1).every((l) => l.split(',')[5] === 'whatsapp'));
    assert.ok(!wa.text.includes('demo.student'), 'full emails never leave the server');
    for (const p of ['attribution/export.csv', 'attribution/export.csv?report=funnel', 'forecast/export.csv', 'experiments/export.csv', 'referrals/export.csv', 'budget/export.csv', 'audit/export.csv']) {
      const r = await t.call('GET', `/api/${p}${p.includes('?') ? '&' : '?'}dataset=demo`, { token: admin });
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type'), /text\/csv/, p);
      assert.ok(r.text.split('\r\n').length > 1, p);
    }
    const exp = (await t.call('GET', '/api/experiments/export.csv?dataset=demo', { token: admin })).text;
    assert.match(exp, /SIMULATED/);
    assert.equal((await t.call('GET', '/api/registrations/export.csv?dataset=demo')).status, 401);
  });

  it('neutralises formula injection in exported text fields', async () => {
    const t2 = await startTestApp();
    try {
      const a2 = await t2.login();
      await t2.register({ college: '=cmd|\' /C calc\'!A0', attribution: { campaign: 'ok' } });
      const csv = (await t2.call('GET', '/api/registrations/export.csv', { token: a2 })).text;
      assert.ok(csv.includes("'=cmd"), csv);
      assert.ok(!/(^|,)=cmd/.test(csv));
    } finally { await t2.close(); }
  });
});

describe('forecast API with live data', () => {
  it('warns about insufficient data and assumes the start date only when unset', async () => {
    const t = await startTestApp(); const admin = await t.login();
    try {
      await t.register(); await t.register();
      const f = (await t.call('GET', '/api/forecast', { token: admin })).json;
      assert.equal(f.sufficient, false);
      assert.equal(f.scenarios, null);
      assert.ok(f.warnings.some((w) => /Insufficient data/.test(w)));
      assert.ok(f.warnings.some((w) => /start date is not set/.test(w)));
      assert.equal(f.model.validatedMachineLearning, false);
      await t.call('PUT', '/api/settings', { token: admin, body: { startDate: '2026-10-27', reason: 'campaign launch' } });
      const f2 = (await t.call('GET', '/api/forecast', { token: admin })).json;
      assert.equal(f2.campaign.startDate, '2026-10-27');
      assert.equal(f2.campaign.elapsedDays, 3);
      assert.ok(!f2.warnings.some((w) => /start date is not set/.test(w)));
      assert.equal((await t.call('PUT', '/api/settings', { token: admin, body: { startDate: '2026-02-31', reason: 'bad date' } })).status, 400);
      assert.equal((await t.call('PUT', '/api/settings', { token: admin, body: { budgetCapINR: 5000, reason: 'raise cap' } })).status, 400, 'cap cannot exceed ₹2,000');
    } finally { await t.close(); }
  });
});

describe('AI copilot: Gemini abstraction and deterministic fallback', () => {
  const KEY = 'AIza-super-secret-test-key-0000';
  it('without an API key it returns a clearly labelled deterministic fallback and never claims to be AI', async () => {
    const t = await startTestApp(); const admin = await t.login();
    try {
      await t.call('POST', '/api/demo/load', { token: admin });
      const r = await t.call('POST', '/api/copilot/analyze?dataset=demo', { token: admin, body: {} });
      assert.equal(r.status, 200);
      assert.equal(r.json.source, 'deterministic_fallback');
      assert.equal(r.json.model, null);
      assert.match(r.json.label, /NOT AI-generated/);
      assert.ok(r.json.recommendations.length >= 2);
      for (const rec of r.json.recommendations) {
        for (const f of ['title', 'supportingMetric', 'reason', 'impactAssumption', 'estimatedCostINR', 'confidence', 'limitations', 'nextStep']) assert.ok(rec[f] !== undefined, `${rec.id} missing ${f}`);
        assert.equal(rec.requiresHumanApproval, true);
        assert.ok(Array.isArray(rec.limitations) && rec.limitations.length >= 1);
      }
      const total = r.json.recommendations.reduce((s, x) => s + x.estimatedCostINR, 0);
      assert.ok(total <= r.json.basedOn.budget.remainingINR);
      assert.ok(r.json.recommendations.some((x) => x.id === 'close-pace-gap'));
      assert.match(r.json.approvalPolicy, /Nothing is sent, spent or changed/);
    } finally { await t.close(); }
  });

  it('with thin data it recommends collecting data instead of optimising', async () => {
    const t = await startTestApp(); const admin = await t.login();
    try {
      const r = (await t.call('POST', '/api/copilot/analyze', { token: admin, body: {} })).json;
      assert.equal(r.recommendations.length, 1);
      assert.equal(r.recommendations[0].id, 'collect-data');
    } finally { await t.close(); }
  });

  it('with a key it calls Gemini server-side (key only in a header), validates output and labels it', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return (await geminiOk({ recommendations: [{ priority: 1, title: 'Re-share links', supportingMetric: { name: 'Required/day', value: '90' }, reason: 'Pace gap', impactAssumption: 'Assumes reshares convert', estimatedCostINR: 99999, confidence: 'medium', limitations: ['Small sample'], nextStep: 'Ask ambassadors' }] })(url, init)); };
    const t = await startTestApp({ env: { GEMINI_API_KEY: KEY }, fetchImpl }); const admin = await t.login();
    try {
      await t.call('POST', '/api/demo/load', { token: admin });
      const r = await t.call('POST', '/api/copilot/analyze?dataset=demo', { token: admin, body: { question: 'What next?' } });
      assert.equal(r.json.source, 'gemini');
      assert.match(r.json.label, /Generated by Gemini/);
      assert.equal(r.json.recommendations[0].requiresHumanApproval, true);
      assert.ok(r.json.recommendations[0].estimatedCostINR <= r.json.basedOn.budget.remainingINR, 'LLM cost is clamped to the remaining budget');
      assert.equal(calls.length, 1);
      assert.ok(!calls[0].url.includes(KEY), 'key must not be in the URL');
      assert.equal(calls[0].init.headers['x-goog-api-key'], KEY);
      const prompt = calls[0].init.body;
      assert.ok(!/@example|Demo Student|Demo Ambassador|DEMO-/.test(prompt), 'only aggregates are sent to the model');
      assert.ok(!r.text.includes(KEY), 'the key is never returned');
      const settings = await t.call('GET', '/api/settings', { token: admin });
      assert.ok(!settings.text.includes(KEY));
      assert.equal(settings.json.gemini.configured, true);
    } finally { await t.close(); }
  });

  it('falls back (and says so) when Gemini errors, times out, or returns malformed output', async () => {
    const cases = {
      http500: async () => ({ ok: false, status: 500, json: async () => ({}) }),
      network: async () => { throw new Error(`connect failed for key ${KEY}`); },
      badJson: async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }) }),
      badShape: geminiOk({ recommendations: [{ title: 'x' }] }),
      empty: geminiOk({ recommendations: [] }),
    };
    for (const [name, fetchImpl] of Object.entries(cases)) {
      const t = await startTestApp({ env: { GEMINI_API_KEY: KEY }, fetchImpl }); const admin = await t.login();
      try {
        await t.call('POST', '/api/demo/load', { token: admin });
        const r = await t.call('POST', '/api/copilot/analyze?dataset=demo', { token: admin, body: {} });
        assert.equal(r.status, 200, name);
        assert.equal(r.json.source, 'deterministic_fallback', name);
        assert.ok(r.json.fallbackReason, name);
        assert.match(r.json.label, /NOT AI-generated/, name);
        assert.ok(!r.text.includes(KEY), `${name}: secret leaked`);
      } finally { await t.close(); }
    }
  });

  it('records AI suggestions and human accept/reject decisions with reasons; takes no external action', async () => {
    const t = await startTestApp(); const admin = await t.login();
    try {
      await t.call('POST', '/api/demo/load', { token: admin });
      const a = (await t.call('POST', '/api/copilot/analyze?dataset=demo', { token: admin, body: {} })).json;
      const rec = a.recommendations[0];
      const body = { analysisId: a.analysisId, recommendationId: rec.id, title: rec.title };
      assert.equal((await t.call('POST', '/api/copilot/decisions?dataset=demo', { token: admin, body: { ...body, decision: 'rejected' } })).status, 400, 'rejection needs a reason');
      const rej = await t.call('POST', '/api/copilot/decisions?dataset=demo', { token: admin, body: { ...body, decision: 'rejected', reason: 'Already tried this yesterday' } });
      assert.equal(rej.status, 201);
      assert.equal(rej.json.externalActionTaken, false);
      assert.equal((await t.call('POST', '/api/copilot/decisions?dataset=demo', { token: admin, body: { ...body, decision: 'accepted' } })).status, 201);
      const audit = (await t.call('GET', '/api/audit?dataset=demo', { token: admin })).json.items;
      const types = audit.map((x) => x.type);
      assert.ok(types.includes('ai_suggestion') && types.includes('recommendation_rejected') && types.includes('recommendation_accepted'));
      assert.equal(audit.find((x) => x.type === 'recommendation_rejected').reason, 'Already tried this yesterday');
      assert.ok(audit.every((x, i) => i === 0 || audit[i - 1].ts >= x.ts), 'newest first');
    } finally { await t.close(); }
  });
});

describe('content studio', () => {
  let t; let admin; let analyst;
  before(async () => { t = await startTestApp(); admin = await t.login(); analyst = await t.login(TEST_ENV.ANALYST_EMAIL, TEST_ENV.ANALYST_PASSWORD); });
  after(() => t.close());

  it('generates tagged, counted template drafts for every channel and segment without forbidden claims', async () => {
    const opts = (await t.call('GET', '/api/content/options', { token: admin })).json;
    for (const channel of opts.channels) {
      for (const segment of Object.keys(opts.segments)) {
        const r = await t.call('POST', '/api/content/generate', { token: analyst, body: { channel, segment, tone: 'friendly', tones: ['friendly', 'professional', 'energetic', 'concise'], refCode: 'AMB-ABC234', ambassadorName: 'Asha' } });
        assert.equal(r.status, 200, `${channel}/${segment}`);
        assert.equal(r.json.variants.length, 4);
        for (const v of r.json.variants) {
          assert.equal(v.characterCount, v.text.length);
          assert.ok(v.characterCount <= v.characterLimit, `${channel}/${segment}/${v.tone} is ${v.characterCount} > ${v.characterLimit}`);
          assert.equal(v.lint.ok, true, `${channel}/${segment}/${v.tone}: ${v.lint.blocking}`);
          assert.ok(v.text.includes('[DATE & TIME'), 'schedule is a placeholder, never invented');
          assert.ok(v.callToAction.includes('utm_campaign=ai60') && v.callToAction.includes('utm_source=') && v.callToAction.includes('ref=AMB-ABC234'));
          assert.ok(v.text.includes(v.callToAction));
          assert.equal(v.source, 'template');
          assert.match(v.sourceLabel, /not AI-generated/);
          assert.equal(v.requiresHumanApproval, true);
        }
      }
    }
    assert.equal((await t.call('POST', '/api/content/generate', { token: admin, body: { channel: 'sms', segment: 'cs_it', tone: 'friendly' } })).status, 400);
  });

  it('uses Gemini only when asked and configured, and rejects AI drafts that invent claims', async () => {
    const bad = geminiOk({ text: 'Join us 5 November at 6 PM! Only 20 seats left, certificate included.' });
    const t2 = await startTestApp({ env: { GEMINI_API_KEY: 'k'.repeat(20) }, fetchImpl: bad }); const a2 = await t2.login();
    try {
      const r = (await t2.call('POST', '/api/content/generate', { token: a2, body: { channel: 'whatsapp', segment: 'cs_it', tone: 'energetic', useAI: true } })).json;
      assert.equal(r.aiUsed, false);
      assert.equal(r.variants[0].source, 'template');
      assert.ok(r.notes.length >= 1);
    } finally { await t2.close(); }
    const link = (u) => `Hey! 60-minute hands-on session. When: [DATE & TIME – confirm before sending] ${u}`;
    let seen;
    const good = async (url, init) => { const m = /Link to include: (\S+)/.exec(JSON.parse(init.body).contents[0].parts[0].text); seen = m[1]; return geminiOk({ text: link(m[1]), subject: null })(url, init); };
    const t3 = await startTestApp({ env: { GEMINI_API_KEY: 'k'.repeat(20) }, fetchImpl: good }); const a3 = await t3.login();
    try {
      const r = (await t3.call('POST', '/api/content/generate', { token: a3, body: { channel: 'whatsapp', segment: 'beginners', tone: 'friendly', useAI: true } })).json;
      assert.equal(r.aiUsed, true);
      assert.equal(r.variants[0].source, 'gemini');
      assert.match(r.variants[0].sourceLabel, /Gemini/);
      assert.ok(seen);
    } finally { await t3.close(); }
    const noKey = (await t.call('POST', '/api/content/generate', { token: admin, body: { channel: 'email', segment: 'cs_it', tone: 'concise', useAI: true } })).json;
    assert.equal(noKey.aiUsed, false);
    assert.match(noKey.notes[0], /not configured/);
  });

  it('requires human approval: drafts cannot be approved with placeholders or forbidden claims, and nothing is ever sent', async () => {
    const gen = (await t.call('POST', '/api/content/generate', { token: admin, body: { channel: 'whatsapp', segment: 'cs_it', tone: 'friendly' } })).json.variants[0];
    const saved = await t.call('POST', '/api/content/drafts', { token: admin, body: { channel: 'whatsapp', segment: 'cs_it', tone: 'friendly', text: gen.text, campaignTag: 'ai60/whatsapp' } });
    assert.equal(saved.status, 201);
    const id = saved.json.draft.id;
    assert.equal(saved.json.draft.status, 'draft');
    assert.equal(saved.json.draft.sent, false);
    const early = await t.call('POST', `/api/content/drafts/${id}/approve`, { token: admin, body: {} });
    assert.equal(early.status, 422, 'placeholder still present');
    const bad = await t.call('PUT', `/api/content/drafts/${id}`, { token: admin, body: { text: gen.text.replace('[DATE & TIME – confirm before sending]', '5 November, 6 PM — only 10 seats left!') } });
    assert.equal(bad.json.draft.lint.ok, false);
    assert.equal((await t.call('POST', `/api/content/drafts/${id}/approve`, { token: admin, body: {} })).status, 422);
    const fixed = await t.call('PUT', `/api/content/drafts/${id}`, { token: admin, body: { text: gen.text.replace('[DATE & TIME – confirm before sending]', 'Details shared by the organisers') } });
    assert.equal(fixed.json.draft.lint.readyToApprove, true);
    assert.equal((await t.call('POST', `/api/content/drafts/${id}/approve`, { token: analyst, body: {} })).status, 403);
    const ok = await t.call('POST', `/api/content/drafts/${id}/approve`, { token: admin, body: {} });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.sent, false);
    const list = (await t.call('GET', '/api/content/drafts', { token: admin })).json.items;
    assert.equal(list[0].status, 'approved');
    assert.equal(list[0].approvedBy, TEST_ENV.ADMIN_EMAIL);
    // editing an approved draft sends it back to draft status
    const edit = await t.call('PUT', `/api/content/drafts/${id}`, { token: admin, body: { text: `${list[0].text} Thanks!` } });
    assert.equal(edit.json.draft.status, 'draft');
    for (const p of ['/api/content/send', '/api/content/drafts/x/send']) assert.equal((await t.call('POST', p, { token: admin, body: {} })).status, 404, 'no send endpoint exists');
  });
});

describe('alerts and audit log', () => {
  it('states on-refresh behaviour, supports acknowledgement with reasons, and keeps a chronological audit trail', async () => {
    const t = await startTestApp(); const admin = await t.login();
    try {
      await t.call('POST', '/api/demo/load', { token: admin });
      const al = (await t.call('GET', '/api/alerts?dataset=demo', { token: admin })).json;
      assert.equal(al.mode, 'on_refresh');
      assert.match(al.notice, /no background monitoring/i);
      const spike = al.alerts.find((a) => a.type === 'referral_spike');
      assert.ok(spike && spike.acknowledged === false);
      assert.equal((await t.call('POST', '/api/alerts/ack?dataset=demo', { token: admin, body: { alertId: spike.id } })).status, 400, 'a reason is required');
      assert.equal((await t.call('POST', '/api/alerts/ack?dataset=demo', { token: admin, body: { alertId: spike.id, reason: 'Group share at a hostel; verified with ambassador' } })).status, 200);
      const after = (await t.call('GET', '/api/alerts?dataset=demo', { token: admin })).json.alerts.find((a) => a.id === spike.id);
      assert.equal(after.acknowledged, true);
      assert.match(after.acknowledgedReason, /hostel/);

      // configurable thresholds: raising the spike threshold removes the alert
      await t.call('PUT', '/api/settings?dataset=demo', { token: admin, body: { alertRules: { referralSpikePerHour: 50 }, reason: 'raise spike threshold for test' } });
      assert.ok(!(await t.call('GET', '/api/alerts?dataset=demo', { token: admin })).json.alerts.some((a) => a.type === 'referral_spike'));

      t.clock.t += 60_000;
      await t.call('POST', '/api/budget/spend?dataset=demo', { token: admin, body: { channel: 'email', amountINR: 100, reason: 'newsletter boost' } });
      t.clock.t += 60_000;
      await t.call('PUT', '/api/settings?dataset=demo', { token: admin, body: { targetRegistrations: 450, reason: 'target revised' } });
      const log = (await t.call('GET', '/api/audit?dataset=demo', { token: admin })).json;
      const types = log.items.map((x) => x.type);
      for (const ty of ['demo_loaded', 'alert_ack', 'campaign_change', 'spend_recorded']) assert.ok(types.includes(ty), ty);
      assert.equal(log.items[0].type, 'campaign_change', 'most recent first');
      assert.equal(log.items[0].reason, 'target revised');
      assert.equal(log.items[0].actor, TEST_ENV.ADMIN_EMAIL);
      assert.equal((await t.call('GET', '/api/audit?dataset=demo&type=spend_recorded', { token: admin })).json.items.length, 1);
      assert.equal((await t.call('GET', '/api/audit', { token: admin })).json.items.length, 0, 'demo actions never appear in the live log');
    } finally { await t.close(); }
  });
});
