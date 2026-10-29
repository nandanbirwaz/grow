import { geminiAvailable, geminiJson } from './gemini.js';

/** Aggregate-only snapshot sent to the LLM: no names, emails, codes or per-person rows. */
export function buildSnapshot(a) {
  const base = a.forecast.scenarios?.base;
  return {
    dataset: a.dataset, simulated: a.simulated,
    campaign: { target: a.campaign.target, durationDays: a.campaign.durationDays, elapsedDays: a.forecast.campaign.elapsedDays, remainingDays: a.forecast.campaign.remainingDays, budgetCapINR: a.campaign.budgetCapINR },
    registrations: a.forecast.totals.registrations,
    requiredPerDay: a.forecast.totals.requiredPerDay,
    meanDaily: a.forecast.stats.meanDaily,
    forecastSufficient: a.forecast.sufficient,
    baseProjection: base ? base.projectedTotal : null,
    conservativeProjection: a.forecast.scenarios?.conservative.projectedTotal ?? null,
    optimisticProjection: a.forecast.scenarios?.optimistic.projectedTotal ?? null,
    funnel: a.funnel.stages.map((s) => ({ stage: s.type, count: s.count, stepRate: s.stepRate })),
    channels: a.channelsAll.map((c) => ({ channel: c.channel, visitors: c.visitors, registrations: c.registrations, spendINR: c.spendINR, costPerRegistrationINR: c.costPerRegistrationINR })),
    budget: { actualTotalINR: a.budget.actualTotalINR, remainingINR: a.budget.remainingINR, usedPct: a.budget.usedPct },
    minRegsPerChannel: a.budget.minRegsThreshold,
    experiments: a.experiments.map((e) => ({ key: e.experimentKey, verdict: e.verdict, winner: e.winner, variants: e.variants.map((v) => ({ variant: v.variant, visitors: v.visitors, registrations: v.registrations })) })),
    referral: { ambassadors: a.referrals.leaderboard.length, validTotal: a.referrals.leaderboard.reduce((s, r) => s + r.validReferrals, 0), spikes: a.referrals.spikes.length },
    openAlerts: a.alerts.alerts.map((x) => x.type),
  };
}

const rec = (id, priority, title, supporting, reason, impact, costINR, confidence, limitations, nextStep) => ({
  id, priority, title, supportingMetric: supporting, reason, impactAssumption: impact, estimatedCostINR: costINR,
  confidence, limitations, nextStep, requiresHumanApproval: true,
});

/** Deterministic rules over the snapshot. This is NOT an LLM; the response says so explicitly. */
export function ruleBasedRecommendations(s) {
  const out = [];
  const regs = s.registrations;

  if (regs < 10) {
    out.push(rec('collect-data', 1, 'Collect more data before optimising',
      { name: 'Registrations so far', value: regs },
      'With fewer than 10 registrations, channel and funnel comparisons are dominated by noise.',
      'No registration impact is claimed; the goal is to avoid acting on noise.', 0, 'high',
      ['Any ranking built on <10 registrations is unreliable.'],
      'Share the tagged campaign link in 2–3 channels and revisit once ≥ 10 registrations exist.'));
    return out;
  }

  if (s.forecastSufficient && s.requiredPerDay !== null && s.meanDaily > 0 && s.requiredPerDay > s.meanDaily * 1.15) {
    const gapPct = Math.round((s.requiredPerDay / s.meanDaily - 1) * 100);
    out.push(rec('close-pace-gap', 1, 'Close the daily registration pace gap',
      { name: 'Required vs current per day', value: `${s.requiredPerDay} needed vs ${s.meanDaily} current (+${gapPct}%)` },
      `At the current run-rate the base projection is ${s.baseProjection} of ${s.campaign.target}; the pace must rise by roughly ${gapPct}% to hit target.`,
      'Assumes extra outreach in the best-converting existing channels yields proportionally more sign-ups (unverified).', 0, s.elapsedDays >= 5 ? 'medium' : 'low',
      ['Run-rate extrapolation is not a validated forecast.', 'Early-campaign launch spikes may overstate or understate the true rate.'],
      'Ask student ambassadors to re-share their tagged links today (draft messages in Content Studio; a human must approve and send).'));
  } else if (s.forecastSufficient && s.baseProjection !== null && s.baseProjection >= s.campaign.target) {
    out.push(rec('hold-course', 3, 'Keep the current plan running',
      { name: 'Base projection', value: `${s.baseProjection} vs target ${s.campaign.target}` },
      'The simple run-rate projection currently reaches the target.', 'No incremental impact assumed.', 0, 'low',
      ['Projection assumes the current pace holds.'], 'Monitor daily; avoid large changes without evidence.'));
  }

  const paid = s.channels.filter((c) => c.costPerRegistrationINR !== null && c.registrations >= s.minRegsPerChannel).sort((a, b) => a.costPerRegistrationINR - b.costPerRegistrationINR);
  if (paid.length >= 2 && s.budget.remainingINR > 0) {
    const best = paid[0]; const worst = paid[paid.length - 1];
    if (worst.costPerRegistrationINR > best.costPerRegistrationINR * 1.5) {
      const amt = Math.floor((s.budget.remainingINR * 0.6) / 10) * 10;
      out.push(rec('shift-budget', 2, `Test shifting budget toward ${best.channel}`,
        { name: 'Cost per registration', value: `${best.channel} ₹${best.costPerRegistrationINR} vs ${worst.channel} ₹${worst.costPerRegistrationINR}` },
        `${best.channel} has acquired registrations at a lower observed cost (n=${best.registrations}) than ${worst.channel} (n=${worst.registrations}).`,
        `If ${best.channel} keeps its average cost, ₹${amt} could add about ${Math.round(amt / best.costPerRegistrationINR)} registrations (constant-returns assumption).`, amt, 'low',
        ['Association, not causation.', 'Average cost ≠ marginal cost; returns usually diminish.', `Remaining budget is ₹${s.budget.remainingINR}.`],
        `Approve or reject this allocation in the Budget what-if simulator; nothing is spent automatically.`));
    }
  }

  const f = s.funnel;
  let worstStep = null;
  for (let i = 1; i < f.length; i += 1) {
    if (f[i - 1].count >= 50 && f[i].stepRate !== null && (!worstStep || f[i].stepRate < worstStep.rate)) worstStep = { from: f[i - 1].stage, to: f[i].stage, rate: f[i].stepRate, n: f[i - 1].count };
  }
  if (worstStep && worstStep.rate < 0.5) {
    out.push(rec('fix-funnel-dropoff', 2, `Investigate the ${worstStep.from} → ${worstStep.to} drop-off`,
      { name: 'Step conversion', value: `${Math.round(worstStep.rate * 100)}% of ${worstStep.n}` },
      'This is the weakest step in the funnel with a meaningful sample (≥ 50 at the previous stage).',
      'Improvement size is unknown; an A/B test is needed to quantify it.', 0, 'medium',
      ['Funnel stages are event counts, not a strict cohort.'], 'Create or review a landing-page variant in Experiments to test a change to this step.'));
  }

  for (const e of s.experiments) {
    if (e.verdict === 'insufficient_data') {
      out.push(rec(`experiment-wait-${e.key}`, 3, `Keep experiment "${e.key}" running — no winner yet`,
        { name: 'Visitors per variant', value: e.variants.map((v) => `${v.variant}: ${v.visitors}`).join(', ') },
        'Sample sizes are below the configured minimum, so any difference could be chance.', 'None claimed.', 0, 'high',
        ['Do not switch variants based on early gaps.'], 'Wait for the minimum sample; avoid peeking-based decisions.'));
    } else if (e.verdict === 'winner') {
      out.push(rec(`experiment-ship-${e.key}`, 2, `Consider adopting variant "${e.winner}" from "${e.key}"`,
        { name: 'Verdict', value: `${e.winner} significantly ahead` },
        'Minimum samples were met and the difference passed the significance test.', 'Observed lift may regress toward zero after rollout.', 0, 'medium',
        e.simulated ? ['This experiment is on SIMULATED data — not a real result.'] : ['Significance is within this sample only.'],
        'A human should review the results page and decide; nothing is switched automatically.'));
    }
  }

  if (s.referral.spikes > 0) {
    out.push(rec('review-referral-spikes', 2, 'Review unusual referral bursts',
      { name: 'Spike alerts', value: s.referral.spikes },
      'At least one ambassador exceeded the hourly referral threshold; this can be a legitimate group share or abuse.',
      'No impact claimed — protects data quality.', 0, 'medium', ['Spikes are a heuristic, not proof of fraud.'], 'Open Referrals, check the ambassador report (counts only), and decide whether to pause the code.'));
  }
  if (s.referral.ambassadors === 0) {
    out.push(rec('recruit-ambassadors', 3, 'Create ambassador referral codes',
      { name: 'Ambassadors', value: 0 }, 'No ambassador codes exist, so referral attribution cannot be measured.', 'Unknown until measured.', 0, 'medium',
      ['Referral volume is unproven for this campaign.'], 'Create codes in Referrals and draft outreach in Content Studio (manual sending).'));
  }

  return out.sort((a, b) => a.priority - b.priority).map((r, i) => ({ ...r, rank: i + 1 }));
}

const REC_FIELDS = ['title', 'reason', 'impactAssumption', 'confidence', 'nextStep'];
function validateLlmRecs(raw, cap) {
  const arr = Array.isArray(raw) ? raw : raw?.recommendations;
  if (!Array.isArray(arr) || arr.length === 0 || arr.length > 8) throw new Error('llm_bad_shape');
  return arr.map((r, i) => {
    for (const f of REC_FIELDS) if (typeof r[f] !== 'string' || !r[f]) throw new Error('llm_bad_shape');
    const confidence = ['low', 'medium', 'high'].includes(r.confidence) ? r.confidence : 'low';
    const cost = Number.isFinite(r.estimatedCostINR) ? Math.max(0, Math.min(cap, Math.round(r.estimatedCostINR))) : 0;
    return {
      id: `llm-${i + 1}`, rank: i + 1, priority: Math.min(3, Math.max(1, Number(r.priority) || i + 1)),
      title: r.title.slice(0, 160),
      supportingMetric: { name: String(r.supportingMetric?.name || 'n/a').slice(0, 80), value: String(r.supportingMetric?.value ?? 'n/a').slice(0, 120) },
      reason: r.reason.slice(0, 500), impactAssumption: r.impactAssumption.slice(0, 400), estimatedCostINR: cost, confidence,
      limitations: (Array.isArray(r.limitations) ? r.limitations : [String(r.limitations || 'Not stated')]).map((x) => String(x).slice(0, 200)).slice(0, 4),
      nextStep: r.nextStep.slice(0, 300), requiresHumanApproval: true,
    };
  });
}

const SYSTEM = `You are a growth analyst assistant for a student-registration campaign. Use ONLY the metrics in the provided JSON; never invent numbers, dates, certificates, partners or results. If the data is thin (fewer than ~10 registrations, or sample sizes below thresholds) say so and lower confidence. Distinguish evidence from assumptions and note correlation is not causation. Never recommend sending messages or spending money automatically: every recommendation must need human approval. Return JSON: {"recommendations":[{"priority":1-3,"title":"","supportingMetric":{"name":"","value":""},"reason":"","impactAssumption":"","estimatedCostINR":0,"confidence":"low|medium|high","limitations":[""],"nextStep":""}]} with at most 5 items; total proposed spend must not exceed the remaining budget.`;

export async function analyze({ analytics, config, fetchImpl, question }) {
  const snapshot = buildSnapshot(analytics);
  const fallback = ruleBasedRecommendations({ ...snapshot, elapsedDays: snapshot.campaign.elapsedDays });
  const base = {
    dataset: snapshot.dataset, simulated: snapshot.simulated, generatedAt: config.now().toISOString(),
    basedOn: snapshot, approvalPolicy: 'Recommendations are suggestions only. Nothing is sent, spent or changed until a human accepts and performs it.',
  };
  if (!geminiAvailable(config)) {
    return { ...base, source: 'deterministic_fallback', model: null, label: 'Rule-based analysis (no Gemini API key configured) — NOT AI-generated', recommendations: fallback };
  }
  try {
    const raw = await geminiJson({
      config, fetchImpl, system: SYSTEM,
      prompt: `Campaign metrics (${snapshot.simulated ? 'SIMULATED demo data' : 'recorded data'}):\n${JSON.stringify(snapshot)}\n\nQuestion: ${String(question || 'What should we do next to reach the registration target?').slice(0, 300)}`,
    });
    const recs = validateLlmRecs(raw, Math.max(0, snapshot.budget.remainingINR));
    return { ...base, source: 'gemini', model: config.gemini.model, label: `Generated by Gemini (${config.gemini.model}) from aggregate metrics — review before acting`, recommendations: recs };
  } catch (e) {
    return { ...base, source: 'deterministic_fallback', model: null, fallbackReason: String(e.message).slice(0, 60), label: 'Gemini call failed — showing rule-based analysis instead (NOT AI-generated)', recommendations: fallback };
  }
}
