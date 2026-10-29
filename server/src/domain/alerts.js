import { round } from '../lib/util.js';

/**
 * Configurable anomaly detection. Computed on demand (when the dashboard/API is refreshed);
 * there is no background scheduler.
 */
export function computeAlerts({ rules, daily, asOfDate, budget, channels, referralSpikes, totalRegistrations, now }) {
  const alerts = [];

  // 1. registration decline: last completed day vs mean of the 3 days before it
  const completed = daily.filter((d) => d.day < asOfDate);
  if (completed.length >= 4) {
    const last = completed[completed.length - 1];
    const prior = completed.slice(-4, -1);
    const priorAvg = prior.reduce((s, d) => s + d.count, 0) / 3;
    if (priorAvg >= rules.minPriorAvg) {
      const drop = ((priorAvg - last.count) / priorAvg) * 100;
      if (drop >= rules.declinePct) {
        alerts.push({
          id: `decline:${last.day}`, type: 'registration_decline', severity: 'warning',
          title: 'Registrations declined',
          detail: `${last.day}: ${last.count} registrations vs ${round(priorAvg, 1)}/day average for the 3 prior days (−${round(drop, 0)}%, threshold ${rules.declinePct}%).`,
          metric: { value: last.count, baseline: round(priorAvg, 1), dropPct: round(drop, 1) },
        });
      }
    }
  }

  // 2. cost per registration
  const overall = budget.blendedCostPerRegistrationINR;
  if (overall !== null && totalRegistrations >= rules.minRegsForCpr && overall > rules.maxCprINR) {
    alerts.push({ id: 'cpr:overall', type: 'high_cost_per_registration', severity: 'warning', title: 'Blended cost per registration is high', detail: `₹${overall} per registration vs ₹${rules.maxCprINR} threshold (${totalRegistrations} registrations).`, metric: { value: overall, threshold: rules.maxCprINR } });
  }
  for (const c of channels) {
    if (c.costPerRegistrationINR !== null && c.registrations >= rules.minRegsForCpr && c.costPerRegistrationINR > rules.maxCprINR) {
      alerts.push({ id: `cpr:${c.channel}`, type: 'high_cost_per_registration', severity: 'warning', title: `High cost per registration: ${c.channel}`, detail: `₹${c.costPerRegistrationINR} per registration vs ₹${rules.maxCprINR} threshold (${c.registrations} registrations).`, metric: { value: c.costPerRegistrationINR, threshold: rules.maxCprINR } });
    }
  }

  // 3. budget thresholds
  if (budget.usedPct >= rules.budgetCriticalPct) {
    alerts.push({ id: 'budget:critical', type: 'budget_threshold', severity: 'critical', title: 'Budget cap reached', detail: `₹${budget.actualTotalINR} spent of ₹${budget.capINR} cap (${budget.usedPct}%).`, metric: { value: budget.usedPct, threshold: rules.budgetCriticalPct } });
  } else if (budget.usedPct >= rules.budgetWarnPct) {
    alerts.push({ id: 'budget:warn', type: 'budget_threshold', severity: 'warning', title: 'Budget nearly used', detail: `${budget.usedPct}% of the ₹${budget.capINR} cap spent (warning at ${rules.budgetWarnPct}%).`, metric: { value: budget.usedPct, threshold: rules.budgetWarnPct } });
  }
  if (budget.plannedOverCap) {
    alerts.push({ id: 'budget:plan_over_cap', type: 'budget_threshold', severity: 'warning', title: 'Planned spend exceeds the cap', detail: `Plan totals ₹${budget.plannedTotalINR} vs ₹${budget.capINR} cap.`, metric: { value: budget.plannedTotalINR, threshold: budget.capINR } });
  }

  // 4. referral spikes
  for (const s of referralSpikes) {
    alerts.push({ id: `spike:${s.ambassadorId}:${s.hour}`, type: 'referral_spike', severity: 'warning', title: `Unusual referral burst: ${s.displayName}`, detail: `${s.count} referred sign-ups in one hour (${s.hour}:00, threshold ${rules.referralSpikePerHour}). This can be a genuine group share or abuse — review manually; it is not proof of fraud.`, metric: { value: s.count, threshold: rules.referralSpikePerHour } });
  }

  // 5. data availability
  if (totalRegistrations === 0) {
    alerts.push({ id: 'data:none', type: 'no_data', severity: 'info', title: 'No registrations recorded yet', detail: 'Alerts that depend on trends need several days of data.', metric: {} });
  }

  const order = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    mode: 'on_refresh',
    generatedAt: now.toISOString(),
    notice: 'Alerts are evaluated when this page or API is refreshed. There is no background monitoring or push notification.',
    rules, alerts,
  };
}
