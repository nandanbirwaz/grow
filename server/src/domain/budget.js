import { round, safeDiv, sum } from '../lib/util.js';

/**
 * Budget summary. "planned" and "actual" are kept strictly separate; proposals are a third, clearly labelled object.
 * Cost per registration (CPR) = actual spend on the channel ÷ registrations attributed to that channel.
 */
export function budgetSummary({ spend, registrations, capINR, minRegs }) {
  const planned = spend.filter((s) => s.kind === 'planned');
  const actual = spend.filter((s) => s.kind === 'actual');
  const plannedTotal = sum(planned, (s) => s.amount);
  const actualTotal = sum(actual, (s) => s.amount);
  const channels = new Set([...planned.map((s) => s.channel), ...actual.map((s) => s.channel), ...registrations.map((r) => r.attribution.channel)]);

  const rows = [...channels].sort().map((channel) => {
    const p = sum(planned.filter((s) => s.channel === channel), (s) => s.amount);
    const a = sum(actual.filter((s) => s.channel === channel), (s) => s.amount);
    const regs = registrations.filter((r) => r.attribution.channel === channel).length;
    return {
      channel, plannedINR: p, actualINR: a, varianceINR: a - p,
      registrations: regs,
      costPerRegistrationINR: a > 0 && regs > 0 ? round(a / regs, 2) : null,
      paid: a > 0,
      sampleSufficient: regs >= minRegs,
    };
  });

  const totalRegs = registrations.length;
  return {
    capINR, plannedTotalINR: plannedTotal, actualTotalINR: actualTotal,
    remainingINR: capINR - actualTotal,
    usedPct: round(safeDiv(actualTotal, capINR) * 100, 1),
    overCap: actualTotal > capINR,
    plannedOverCap: plannedTotal > capINR,
    blendedCostPerRegistrationINR: actualTotal > 0 && totalRegs > 0 ? round(actualTotal / totalRegs, 2) : null,
    channels: rows,
    minRegsThreshold: minRegs,
  };
}

/** Evidence-gated reallocation suggestion. Proposal only — never changes recorded spend. */
export function budgetRecommendations(summary) {
  const ranked = summary.channels.filter((c) => c.paid && c.costPerRegistrationINR !== null && c.sampleSufficient)
    .sort((a, b) => a.costPerRegistrationINR - b.costPerRegistrationINR);
  const caveats = [
    'Association, not causation: a low cost per registration may reflect audience quality, timing, or shared links rather than the channel itself.',
    'Average cost is not marginal cost; extra spend on a channel may yield diminishing returns.',
  ];
  const recs = [];
  const insufficient = summary.channels.filter((c) => c.paid && !c.sampleSufficient).map((c) => c.channel);
  if (insufficient.length) {
    recs.push({ kind: 'collect_more_data', channels: insufficient, message: `Not enough registrations (< ${summary.minRegsThreshold}) to compare ${insufficient.join(', ')} reliably. Avoid reallocating based on these yet.` });
  }
  if (summary.remainingINR <= 0) {
    recs.push({ kind: 'no_budget', message: 'No budget remains under the cap; do not propose additional paid spend.' });
  } else if (ranked.length >= 2) {
    const best = ranked[0]; const worst = ranked[ranked.length - 1];
    if (worst.costPerRegistrationINR > best.costPerRegistrationINR * 1.5) {
      const proposed = Math.floor(summary.remainingINR * 0.6 / 10) * 10;
      recs.push({
        kind: 'shift_remaining', toChannel: best.channel, awayFromChannel: worst.channel, proposedAmountINR: proposed,
        evidence: `${best.channel}: ₹${best.costPerRegistrationINR}/registration (${best.registrations} regs) vs ${worst.channel}: ₹${worst.costPerRegistrationINR}/registration (${worst.registrations} regs).`,
        message: `Consider directing about ₹${proposed} of the remaining ₹${summary.remainingINR} to ${best.channel} rather than ${worst.channel}. This is a proposal, not recorded spend.`,
      });
    } else {
      recs.push({ kind: 'no_clear_winner', message: 'Paid channels with enough data have similar cost per registration (within 1.5×); there is no evidence-based reason to shift budget.' });
    }
  } else {
    recs.push({ kind: 'collect_more_data', message: `Fewer than two paid channels have ≥ ${summary.minRegsThreshold} registrations; there is not enough evidence to recommend a reallocation.` });
  }
  return { recommendations: recs, caveats };
}

/**
 * What-if simulator. Estimated registrations = proposed spend ÷ observed average CPR (constant-returns assumption).
 * Channels without a reliable CPR get no estimate (null) instead of a guess.
 */
export function whatIf(summary, allocations) {
  const errors = [];
  let total = 0;
  for (const [ch, amt] of Object.entries(allocations)) {
    if (!Number.isFinite(amt) || amt < 0) errors.push(`${ch}: amount must be a non-negative number`);
    else total += amt;
  }
  if (total > summary.remainingINR) errors.push(`Proposed total ₹${total} exceeds remaining budget ₹${summary.remainingINR} (cap ₹${summary.capINR}).`);
  if (errors.length) return { ok: false, errors };
  const lines = Object.entries(allocations).map(([channel, amountINR]) => {
    const row = summary.channels.find((c) => c.channel === channel);
    const reliable = row && row.costPerRegistrationINR !== null && row.sampleSufficient;
    return {
      channel, proposedAmountINR: amountINR,
      observedCostPerRegistrationINR: row?.costPerRegistrationINR ?? null,
      estimatedAdditionalRegistrations: reliable && amountINR > 0 ? round(amountINR / row.costPerRegistrationINR, 1) : (amountINR === 0 ? 0 : null),
      basis: reliable ? 'observed average CPR (model estimate)' : 'no reliable CPR for this channel — no estimate',
    };
  });
  const estimable = lines.filter((l) => l.estimatedAdditionalRegistrations !== null);
  return {
    ok: true,
    label: 'MODEL ESTIMATE — not recorded spend and not a result',
    proposedTotalINR: total,
    remainingAfterINR: summary.remainingINR - total,
    lines,
    estimatedAdditionalRegistrations: round(sum(estimable, (l) => l.estimatedAdditionalRegistrations), 1),
    unestimatedChannels: lines.filter((l) => l.estimatedAdditionalRegistrations === null).map((l) => l.channel),
    assumptions: [
      'Cost per registration stays constant at the observed average (real campaigns usually see diminishing returns).',
      'Past performance transfers to the remaining days; audience saturation is ignored.',
      'Channel performance is observational; changes in spend may not cause proportional registrations.',
    ],
  };
}
