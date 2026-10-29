import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, TEST_ENV } from './helpers.js';

const UTM = { source: 'WhatsApp', medium: 'social', campaign: 'ai60', content: 'cs_it-friendly' };
const VID = 'v-' + 'a'.repeat(20);

describe('registration, attribution and event tracking', () => {
  let t; let admin;
  before(async () => { t = await startTestApp(); admin = await t.login(); });
  after(() => t.close());

  it('registers a student with normalised first-touch attribution and no PII in the response', async () => {
    const r = await t.register({ email: 'Priya.S@example.com', attribution: UTM });
    assert.equal(r.status, 201);
    assert.deepEqual(Object.keys(r.json).sort(), ['message', 'ok', 'registrationRef']);
    const list = await t.call('GET', '/api/registrations', { token: admin });
    assert.equal(list.status, 200);
    const row = list.json.items[0];
    assert.equal(row.channel, 'whatsapp');
    assert.equal(row.source, 'whatsapp');
    assert.equal(row.content, 'cs_it-friendly');
    assert.equal(row.contact, 'P***@example.com'.replace('P', 'p'));
    assert.ok(!list.text.includes('Priya'), 'names must not appear in the dashboard payload');
    assert.ok(!list.text.includes('Priya.S@example.com'));
  });

  it('rejects duplicates, including plus-tag and Gmail-dot variants', async () => {
    assert.equal((await t.register({ email: 'dup.user@gmail.com' })).status, 201);
    assert.equal((await t.register({ email: 'dup.user@gmail.com' })).status, 409);
    assert.equal((await t.register({ email: 'DupUser+promo@gmail.com' })).status, 409);
    assert.equal((await t.register({ email: 'd.u.p.user@googlemail.com' })).status, 409);
  });

  it('validates input and requires consent to terms', async () => {
    assert.equal((await t.register({ email: 'not-an-email' })).status, 400);
    assert.equal((await t.register({ name: 'x' })).status, 400);
    const noConsent = await t.register({ consentTerms: false });
    assert.equal(noConsent.status, 400);
    assert.equal(noConsent.json.error, 'consent_required');
    const bad = await t.call('POST', '/api/public/register', { body: { name: 'A B', email: 'a@b.co', college: 'C', consentTerms: true, attribution: { source: 'x'.repeat(500) } } });
    assert.equal(bad.status, 400);
  });

  it('treats malformed UTM values as absent instead of storing them', async () => {
    const r = await t.register({ attribution: { source: '<script>alert(1)</script>', medium: 'a b', campaign: 'ok' } });
    assert.equal(r.status, 201);
    const rows = (await t.call('GET', '/api/registrations?limit=1', { token: admin })).json.items;
    assert.equal(rows[0].channel, 'direct');
    assert.equal(rows[0].source, null);
    assert.equal(rows[0].medium, 'a_b');
  });

  it('records funnel events with consent-aware dedupe; success events are server-created only', async () => {
    const attribution = { ...UTM };
    const ev = (type, extra = {}) => t.call('POST', '/api/public/events', { body: { type, consent: true, visitorId: VID, attribution, ...extra } });
    assert.equal((await ev('page_view')).json.deduped, false);
    assert.equal((await ev('page_view')).json.deduped, true, 'same visitor, same day → deduplicated');
    assert.equal((await ev('cta_click')).json.deduped, false);
    // visitor who declined: no identifier is stored, events are anonymous and not deduplicated
    const anon = () => t.call('POST', '/api/public/events', { body: { type: 'page_view', consent: false, visitorId: VID, attribution } });
    assert.equal((await anon()).json.deduped, false);
    assert.equal((await anon()).json.deduped, false);
    const forged = await t.call('POST', '/api/public/events', { body: { type: 'reg_success', consent: true, attribution } });
    assert.equal(forged.status, 400, 'clients cannot forge registration successes');
    const stored = (await t.store.find('events', { dataset: 'live' })).filter((e) => e.type === 'page_view' && e.source === 'whatsapp');
    assert.ok(stored.every((e) => !('visitorId' in e)));
    assert.ok(stored.filter((e) => e.visitorHash === null).length >= 2, 'declined-consent events carry no visitor hash');
    assert.ok(stored.some((e) => e.visitorHash && e.visitorHash !== VID), 'visitor id is stored hashed, never raw');
    const attrib = await t.call('GET', '/api/attribution', { token: admin });
    assert.equal(attrib.status, 200);
    assert.ok(attrib.json.rules.length >= 4 && attrib.json.limitations.length >= 4);
    const stages = Object.fromEntries(attrib.json.funnel.stages.map((s) => [s.type, s.count]));
    const regCount = await t.store.count('registrations', { dataset: 'live' });
    assert.equal(regCount, 3, 'only the 3 valid, non-duplicate registrations were stored');
    assert.equal(stages.reg_success, regCount, 'exactly one reg_success event per stored registration');
    assert.equal(stages.page_view, 3, '1 deduplicated consented visit + 2 anonymous visits');
  });

  it('never writes personal data into analytics events', async () => {
    const events = await t.store.find('events', { dataset: 'live' });
    const dump = JSON.stringify(events);
    assert.ok(!/@example\.com|@gmail\.com|Student \d|Priya/.test(dump));
  });

  it('keeps request logs free of personal data', () => {
    const dump = JSON.stringify(t.logs);
    assert.ok(!/@|Student|password|Bearer/i.test(dump));
    assert.ok(t.logs.every((l) => !String(l.path).includes('?')));
  });
});

describe('A/B experiments end to end', () => {
  let t; let admin;
  before(async () => { t = await startTestApp(); admin = await t.login(); });
  after(() => t.close());
  const variants = [
    { key: 'control', label: 'Control', headline: 'Build Your First AI Project', cta: 'Register' },
    { key: 'benefit', label: 'Benefit', headline: 'Finish with a project', cta: 'Reserve' },
  ];

  it('creates experiments (admin only), allows one running at a time', async () => {
    assert.equal((await t.call('POST', '/api/experiments', { body: { key: 'hero', name: 'Hero test', variants, reason: 'launch test' } })).status, 401);
    const ok = await t.call('POST', '/api/experiments', { token: admin, body: { key: 'hero', name: 'Hero test', variants, reason: 'launch test' } });
    assert.equal(ok.status, 201);
    assert.equal((await t.call('POST', '/api/experiments', { token: admin, body: { key: 'other', name: 'Other test', variants, reason: 'second' } })).status, 409);
    assert.equal((await t.call('POST', '/api/experiments', { token: admin, body: { key: 'bad', name: 'Bad test', variants: [variants[0], variants[0]], reason: 'dupe keys' } })).status, 400, 'duplicate variant keys are rejected');
  });

  it('assigns consistently per visitor and persists it even if the experiment is later edited', async () => {
    const seen = {};
    for (let i = 0; i < 40; i += 1) {
      const id = `visitor-${String(i).padStart(3, '0')}-${'z'.repeat(12)}`;
      const a = await t.call('POST', '/api/public/assign', { body: { experimentKey: 'hero', visitorId: id } });
      const b = await t.call('POST', '/api/public/assign', { body: { experimentKey: 'hero', visitorId: id } });
      assert.equal(a.json.variant.key, b.json.variant.key);
      assert.equal(a.json.persisted, true);
      seen[a.json.variant.key] = (seen[a.json.variant.key] || 0) + 1;
    }
    assert.ok(seen.control > 5 && seen.benefit > 5, JSON.stringify(seen));
    // Even if weights were changed in storage afterwards, existing assignments are served from storage.
    await t.store.update('experiments', { dataset: 'live', key: 'hero' }, { variants: variants.map((v, i) => ({ ...v, weight: i === 0 ? 100 : 0.1 })) });
    const id = `visitor-000-${'z'.repeat(12)}`;
    const first = await t.store.findOne('assignments', { dataset: 'live', experimentKey: 'hero' });
    const again = await t.call('POST', '/api/public/assign', { body: { experimentKey: 'hero', visitorId: id } });
    assert.ok(again.json.variant.key);
    assert.equal((await t.store.count('assignments', { dataset: 'live' })), 40, 'no extra rows created for repeat visits');
    assert.ok(first);
  });

  it('declined-consent visitors get a non-persisted assignment', async () => {
    const r = await t.call('POST', '/api/public/assign', { body: { experimentKey: 'hero' } });
    assert.equal(r.json.persisted, false);
  });

  it('server-side assignment overrides a variant claimed by the client', async () => {
    const id = `visitor-777-${'q'.repeat(12)}`;
    const asg = (await t.call('POST', '/api/public/assign', { body: { experimentKey: 'hero', visitorId: id } })).json.variant.key;
    const other = asg === 'control' ? 'benefit' : 'control';
    await t.call('POST', '/api/public/events', { body: { type: 'page_view', consent: true, visitorId: id, attribution: { experimentKey: 'hero', variant: other } } });
    const ev = (await t.store.find('events', { dataset: 'live', type: 'page_view' })).pop();
    assert.equal(ev.variant, asg);
  });

  it('shows sample sizes and refuses a winner on tiny samples', async () => {
    const res = await t.call('GET', '/api/experiments', { token: admin });
    const e = res.json.experiments[0];
    assert.equal(e.verdict, 'insufficient_data');
    assert.equal(e.winner, null);
    assert.equal(e.simulated, false);
    assert.ok(e.variants.every((v) => typeof v.visitors === 'number'));
  });
});

describe('referrals and ambassadors', () => {
  let t; let admin;
  before(async () => { t = await startTestApp(); admin = await t.login(); });
  after(() => t.close());

  it('creates unique codes and tracks valid referrals; self-referral and IP abuse are not counted', async () => {
    const a = await t.call('POST', '/api/referrals/ambassadors', { token: admin, body: { displayName: 'Asha', email: 'asha@college.edu', reason: 'campus lead' } });
    assert.equal(a.status, 201);
    const code = a.json.ambassador.code;
    const b = await t.call('POST', '/api/referrals/ambassadors', { token: admin, body: { displayName: 'Ravi', reason: 'campus lead' } });
    assert.notEqual(b.json.ambassador.code, code);

    assert.equal((await t.register({ attribution: { ref: code } })).status, 201);
    assert.equal((await t.register({ attribution: { ref: code.toLowerCase() } })).status, 201);
    // self-referral: ambassador registers with her own email (even with a +tag) → registration works, referral not counted
    const self = await t.register({ email: 'Asha+test@college.edu', attribution: { ref: code } });
    assert.equal(self.status, 201);
    // unknown code
    assert.equal((await t.register({ attribution: { ref: 'AMB-NOPE00' } })).status, 201);
    // duplicate registration cannot be counted twice
    assert.equal((await t.register({ email: 'student1@example.com', attribution: { ref: code } })).status, 409);
    // IP limit: 3 valid per IP per day by default → 4th from same IP is flagged
    const ip = '203.0.113.9';
    for (let i = 0; i < 4; i += 1) await t.register({ ip, attribution: { ref: b.json.ambassador.code } });

    const lb = (await t.call('GET', '/api/referrals', { token: admin })).json;
    const asha = lb.leaderboard.find((r) => r.displayName === 'Asha');
    const ravi = lb.leaderboard.find((r) => r.displayName === 'Ravi');
    assert.equal(asha.validReferrals, 2);
    assert.equal(asha.rejectedReferrals, 1);
    assert.equal(ravi.validReferrals, 3);
    assert.equal(ravi.rejectedReferrals, 1);
    assert.equal(lb.leaderboard[0].displayName, 'Ravi');
    assert.equal(lb.leaderboard[0].rank, 1);
    assert.ok(lb.ruleExplanations.length >= 4);
  });

  it('awards 1 point per counted registration, including a code typed on the form; wrong codes and self-referrals earn nothing', async () => {
    const t2 = await startTestApp(); const a2 = await t2.login();
    try {
      const emp = (await t2.call('POST', '/api/referrals/ambassadors', { token: a2, body: { displayName: 'Meera Employee', email: 'meera@company.com', reason: 'new employee' } })).json.ambassador;
      assert.equal((await t2.call('POST', '/api/public/referral/check', { body: { code: emp.code.toLowerCase() } })).json.valid, true);
      assert.equal((await t2.call('POST', '/api/public/referral/check', { body: { code: 'AMB-ZZZZZZ' } })).json.valid, false);
      const chk = await t2.call('POST', '/api/public/referral/check', { body: { code: emp.code } });
      assert.deepEqual(Object.keys(chk.json), ['valid'], 'check endpoint must not leak names');
      assert.equal((await t2.register({ attribution: { ref: emp.code } })).status, 201);          // typed on the form
      assert.equal((await t2.register({ attribution: { ref: emp.code, source: 'whatsapp' } })).status, 201); // link + channel
      assert.equal((await t2.register({ attribution: { ref: 'AMB-ZZZZZZ' } })).status, 201);      // unknown: registers, no credit
      assert.equal((await t2.register({ email: 'meera@company.com', attribution: { ref: emp.code } })).status, 201); // self
      const lb = (await t2.call('GET', '/api/referrals', { token: a2 })).json;
      assert.equal(lb.leaderboard[0].points, 2);
      assert.equal(lb.leaderboard[0].validReferrals, 2);
      assert.equal(lb.totals.points, 2);
      await t2.call('PUT', '/api/settings', { token: a2, body: { referralRules: { pointsPerReferral: 5 }, reason: 'bonus week' } });
      assert.equal((await t2.call('GET', '/api/referrals', { token: a2 })).json.leaderboard[0].points, 10);
      const rep = await t2.call('GET', `/api/referrals/ambassadors/${lb.leaderboard[0].ambassadorId}/report`, { token: a2 });
      assert.equal(rep.json.totals.points, 10);
      assert.match((await t2.call('GET', '/api/referrals/export.csv', { token: a2 })).text, /points/);
    } finally { await t2.close(); }
  });

  it('ambassador reports contain counts only — never registrant contact data', async () => {
    const lb = (await t.call('GET', '/api/referrals', { token: admin })).json;
    const rep = await t.call('GET', `/api/referrals/ambassadors/${lb.leaderboard[0].ambassadorId}/report`, { token: admin });
    assert.equal(rep.status, 200);
    assert.ok(!/@|Student \d|college/i.test(rep.text.replace('Counts only. Registrant names, emails, phone numbers and colleges are never included in ambassador reports.', '')));
    assert.ok(rep.json.totals.valid >= 1);
  });

  it('referral rules are configurable and audited', async () => {
    const bad = await t.call('PUT', '/api/settings', { token: admin, body: { referralRules: { maxValidPerIpPerDay: 1 } } });
    assert.equal(bad.status, 400, 'a reason is required');
    const ok = await t.call('PUT', '/api/settings', { token: admin, body: { referralRules: { maxValidPerIpPerDay: 1, selfReferralBlock: false }, reason: 'tighten abuse rules' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.settings.referralRules.maxValidPerIpPerDay, 1);
    assert.equal(ok.json.settings.referralRules.attributionWindowDays, 7, 'unspecified rules keep their value');
    const audit = (await t.call('GET', '/api/audit?type=campaign_change', { token: admin })).json;
    assert.equal(audit.items[0].reason, 'tighten abuse rules');
  });

  it('paused ambassador codes stop counting', async () => {
    const lb = (await t.call('GET', '/api/referrals', { token: admin })).json;
    const amb = lb.leaderboard.find((r) => r.displayName === 'Ravi');
    assert.equal((await t.call('PUT', `/api/referrals/ambassadors/${amb.ambassadorId}/status`, { token: admin, body: { status: 'paused', reason: 'suspected abuse' } })).status, 200);
    await t.register({ attribution: { ref: amb.code } });
    const after = (await t.call('GET', '/api/referrals', { token: admin })).json.leaderboard.find((r) => r.displayName === 'Ravi');
    assert.equal(after.validReferrals, amb.validReferrals);
  });
});

describe('budget API', () => {
  let t; let admin; let analyst;
  before(async () => { t = await startTestApp(); admin = await t.login(); analyst = await t.login(TEST_ENV.ANALYST_EMAIL, TEST_ENV.ANALYST_PASSWORD); });
  after(() => t.close());
  const spend = (body, token = admin) => t.call('POST', '/api/budget/spend', { token, body: { reason: 'boosted post', ...body } });

  it('tracks plan vs actual and enforces the ₹2,000 ceiling', async () => {
    assert.equal((await t.call('PUT', '/api/budget/plan', { token: admin, body: { allocations: { whatsapp: 1500, instagram: 600 }, reason: 'initial plan' } })).status, 400);
    assert.equal((await t.call('PUT', '/api/budget/plan', { token: admin, body: { allocations: { whatsapp: 800, instagram: 600 }, reason: 'initial plan' } })).status, 200);
    assert.equal((await spend({ channel: 'WhatsApp', amountINR: 900 })).status, 201);
    assert.equal((await spend({ channel: 'instagram', amountINR: 900 })).status, 201);
    const over = await spend({ channel: 'instagram', amountINR: 300 });
    assert.equal(over.status, 409);
    assert.equal(over.json.error, 'over_cap');
    assert.equal((await spend({ channel: 'instagram', amountINR: 300, acknowledgeOverCap: true })).status, 201);
    const b = (await t.call('GET', '/api/budget', { token: admin })).json;
    assert.equal(b.summary.plannedTotalINR, 1400);
    assert.equal(b.summary.actualTotalINR, 2100);
    assert.equal(b.summary.remainingINR, -100);
    assert.equal(b.summary.overCap, true);
    const al = (await t.call('GET', '/api/alerts', { token: admin })).json;
    assert.ok(al.alerts.some((x) => x.id === 'budget:critical'));
  });

  it('what-if is read-only and validated; analysts may run it but not change spend', async () => {
    const w = await t.call('POST', '/api/budget/whatif', { token: analyst, body: { allocations: { whatsapp: 50 } } });
    assert.equal(w.status, 400, 'remaining budget is negative');
    assert.equal((await spend({ channel: 'whatsapp', amountINR: 50 }, analyst)).status, 403);
  });

  it('rejects invalid spend input', async () => {
    assert.equal((await spend({ channel: 'whatsapp', amountINR: -5 })).status, 400);
    assert.equal((await spend({ channel: 'whatsapp', amountINR: 5000 })).status, 400);
    assert.equal((await spend({ channel: '!!', amountINR: 5 })).status, 400);
  });
});

describe('access control', () => {
  let t; let admin; let analyst;
  before(async () => { t = await startTestApp(); admin = await t.login(); analyst = await t.login(TEST_ENV.ANALYST_EMAIL, TEST_ENV.ANALYST_PASSWORD); });
  after(() => t.close());

  it('requires authentication on every dashboard endpoint', async () => {
    for (const p of ['/api/overview', '/api/registrations', '/api/attribution', '/api/forecast', '/api/experiments', '/api/referrals', '/api/budget', '/api/alerts', '/api/audit', '/api/settings', '/api/demo/status', '/api/registrations/export.csv', '/api/content/drafts']) {
      assert.equal((await t.call('GET', p)).status, 401, p);
    }
    assert.equal((await t.call('POST', '/api/copilot/analyze', { body: {} })).status, 401);
    assert.equal((await t.call('POST', '/api/demo/load')).status, 401);
  });

  it('rejects bad, tampered and expired tokens', async () => {
    assert.equal((await t.call('GET', '/api/overview', { token: 'abc.def.ghi' })).status, 401);
    const [h, p, s] = admin.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), role: 'admin', email: 'evil@x.co' })).toString('base64url');
    assert.equal((await t.call('GET', '/api/overview', { token: `${h}.${forged}.${s}` })).status, 401);
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    assert.equal((await t.call('GET', '/api/overview', { token: `${none}.${p}.` })).status, 401);
    t.clock.t += 9 * 3600 * 1000;
    assert.equal((await t.call('GET', '/api/overview', { token: admin })).status, 401, 'tokens expire');
    t.clock.t -= 9 * 3600 * 1000;
  });

  it('allows analysts to read and run analyses but blocks every write', async () => {
    assert.equal((await t.call('GET', '/api/overview', { token: analyst })).status, 200);
    assert.equal((await t.call('POST', '/api/copilot/analyze', { token: analyst, body: {} })).status, 200);
    const writes = [
      ['POST', '/api/demo/load'], ['POST', '/api/demo/reset'], ['PUT', '/api/settings', { reason: 'abc', targetRegistrations: 5 }],
      ['POST', '/api/referrals/ambassadors', { displayName: 'X Y', reason: 'abc' }], ['POST', '/api/experiments', {}],
      ['POST', '/api/budget/spend', {}], ['PUT', '/api/budget/plan', {}], ['POST', '/api/content/drafts', {}], ['POST', '/api/alerts/ack', {}], ['POST', '/api/copilot/decisions', {}],
    ];
    for (const [m, p, body] of writes) assert.equal((await t.call(m, p, { token: analyst, body })).status, 403, `${m} ${p}`);
  });

  it('login rejects wrong credentials without revealing which part was wrong', async () => {
    const a = await t.call('POST', '/api/auth/login', { body: { email: TEST_ENV.ADMIN_EMAIL, password: 'wrong-password-1' } });
    const b = await t.call('POST', '/api/auth/login', { body: { email: 'nobody@test.dev', password: 'wrong-password-1' } });
    assert.equal(a.status, 401); assert.equal(b.status, 401);
    assert.equal(a.text, b.text);
  });

  it('validates dataset and filter parameters', async () => {
    assert.equal((await t.call('GET', '/api/overview?dataset=prod', { token: admin })).status, 400);
    assert.equal((await t.call('GET', '/api/overview?from=2026-13-40', { token: admin })).status, 400);
    assert.equal((await t.call('GET', '/api/overview?from=2026-10-28&to=2026-10-01', { token: admin })).status, 400);
    assert.equal((await t.call('GET', '/api/overview?channel=%3Cscript%3E', { token: admin })).status, 400);
  });

  it('applies CORS only to configured origins and sets security headers', async () => {
    const ok = await t.call('GET', '/api/health', { headers: { Origin: 'http://localhost:5173' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    const bad = await t.call('GET', '/api/health', { headers: { Origin: 'https://evil.example' } });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
    const same = await t.call('POST', '/api/public/events', { headers: { Origin: t.base }, body: { type: 'page_view', consent: false } });
    assert.equal(same.status, 200, 'same-origin browser POSTs (Origin = own host) must work');
    const spoof = await t.call('POST', '/api/public/events', { headers: { Origin: 'http://127.0.0.1.evil.example' }, body: { type: 'page_view', consent: false } });
    assert.equal(spoof.status, 403, 'look-alike hosts are not same-origin');
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.match(ok.headers.get('content-security-policy'), /default-src 'self'/);
  });

  it('rejects oversize and non-JSON bodies', async () => {
    const big = await t.call('POST', '/api/public/events', { body: { type: 'page_view', consent: false, pad: 'x'.repeat(150_000) } });
    assert.equal(big.status, 413);
    const res = await fetch(`${t.base}/api/public/events`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hi' });
    assert.equal(res.status, 415);
  });
});

describe('rate limiting', () => {
  it('throttles login attempts and registration bursts', async () => {
    const t = await startTestApp({ rateLimits: { public: { max: 100, windowMs: 60000 }, register: { max: 3, windowMs: 60000 }, login: { max: 3, windowMs: 60000 }, api: { max: 100, windowMs: 60000 }, ai: { max: 100, windowMs: 60000 } } });
    try {
      const codes = [];
      for (let i = 0; i < 5; i += 1) codes.push((await t.call('POST', '/api/auth/login', { body: { email: 'x@y.co', password: 'nope-nope-nope' } })).status);
      assert.deepEqual(codes, [401, 401, 401, 429, 429]);
      const reg = [];
      for (let i = 0; i < 5; i += 1) reg.push((await t.register({ ip: '198.51.100.7' })).status);
      assert.deepEqual(reg, [201, 201, 201, 429, 429]);
    } finally { await t.close(); }
  });
});
