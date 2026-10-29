import { addDays, daysBetween, eachDay, round } from '../lib/util.js';

const Z80 = 1.2816; // one-sided 90% / two-sided 80% normal quantile

/**
 * Run-rate forecast. NOT a validated machine-learning model.
 *
 * Inputs: daily registration counts, campaign window, target, per-channel totals.
 * Method: mean daily registrations over elapsed days (zero days included), extrapolated over remaining days.
 * Uncertainty band: mean ± 1.28 × standard error of the mean daily count.
 */
export function forecast({ daily, startDate, asOfDate, durationDays, target, channelTotals = {}, minDays = 3, startDateAssumed = false }) {
  const endDate = addDays(startDate, durationDays - 1);
  const asOf = asOfDate > endDate ? endDate : asOfDate;
  const elapsed = Math.max(0, Math.min(durationDays, daysBetween(startDate, asOf) + 1));
  const remaining = Math.max(0, durationDays - elapsed);

  const byDay = Object.fromEntries(daily.map((d) => [d.day, d.count]));
  const window = elapsed > 0 ? eachDay(startDate, addDays(startDate, elapsed - 1)) : [];
  const series = window.map((day) => ({ day, count: byDay[day] || 0 }));
  const total = series.reduce((s, d) => s + d.count, 0);
  const outsideWindow = daily.reduce((s, d) => s + (d.day < startDate || d.day > endDate ? d.count : 0), 0);

  const attainment = target > 0 ? total / target : null;
  const gap = Math.max(0, target - total);
  const requiredPerDay = remaining > 0 ? gap / remaining : null;

  const n = series.length;
  const mean = n > 0 ? total / n : 0;
  const variance = n > 1 ? series.reduce((s, d) => s + (d.count - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  const se = n > 0 ? sd / Math.sqrt(n) : 0;
  const sufficient = n >= minDays && total > 0;

  const last3 = series.slice(-3);
  const recentMean = last3.length ? last3.reduce((s, d) => s + d.count, 0) / last3.length : null;

  const mk = (label, rate) => {
    const projected = total + rate * remaining;
    return {
      label, dailyRate: round(rate, 2), projectedTotal: Math.round(projected),
      attainment: target > 0 ? round(projected / target, 4) : null,
      onTrack: projected >= target,
      shortfall: Math.max(0, Math.round(target - projected)),
    };
  };

  const scenarios = sufficient
    ? {
        conservative: mk('Conservative', Math.max(0, mean - Z80 * se)),
        base: mk('Base (run-rate)', mean),
        optimistic: mk('Optimistic', mean + Z80 * se),
      }
    : null;

  const channelProjection = sufficient
    ? Object.entries(channelTotals).map(([channel, regs]) => ({
        channel, registrationsSoFar: regs,
        baselineProjection: Math.round(regs + (regs / n) * remaining),
      })).sort((a, b) => b.registrationsSoFar - a.registrationsSoFar)
    : [];

  const warnings = [];
  if (!sufficient) warnings.push(`Insufficient data: at least ${minDays} elapsed campaign days with registrations are needed before projections are shown (have ${n} day(s), ${total} registration(s)). Required-per-day is still computed from the target.`);
  if (startDateAssumed) warnings.push('Campaign start date is not set; the first registration day is used as day 1. Set the start date in Settings for accurate elapsed/remaining days.');
  if (elapsed === 0) warnings.push('The campaign has not started yet.');
  if (outsideWindow > 0) warnings.push(`${outsideWindow} registration(s) fall outside the ${durationDays}-day campaign window and are excluded.`);
  if (sufficient && n < 5) warnings.push('Fewer than 5 days of history: the uncertainty band is wide and unreliable.');

  return {
    model: {
      type: 'run-rate extrapolation with normal-approximation band',
      validatedMachineLearning: false,
      note: 'A transparent arithmetic projection, not a trained or validated ML model.',
    },
    campaign: { startDate, endDate, asOfDate: asOf, durationDays, elapsedDays: elapsed, remainingDays: remaining, target },
    totals: { registrations: total, attainment: round(attainment, 4), gap, requiredPerDay: round(requiredPerDay, 2) },
    dailySeries: series,
    stats: { meanDaily: round(mean, 2), stdDevDaily: round(sd, 2), standardError: round(se, 2), recent3DayMean: round(recentMean, 2) },
    sufficient,
    scenarios,
    channelProjection,
    warnings,
    formulas: [
      'elapsed = days from start through today (inclusive); remaining = durationDays − elapsed',
      'registrations needed per day = max(0, target − registrations so far) ÷ remaining',
      'base daily rate = registrations so far ÷ elapsed days (days with zero registrations are included)',
      'projected total = registrations so far + daily rate × remaining',
      'standard error = sample std-dev of daily counts ÷ √elapsed;  conservative/optimistic rate = base rate ∓ 1.28 × standard error (≈80% interval if daily counts were independent and identically distributed)',
      'channel baseline = channel registrations ÷ elapsed × remaining + channel registrations so far',
    ],
    assumptions: [
      'Future daily registrations resemble the average of past days (no launch spike decay, weekday effects, or channel saturation).',
      'Today is counted as a full day, so the rate may be slightly understated early in the day.',
      'Daily counts are treated as independent; real campaigns are autocorrelated, so the true uncertainty is larger than shown.',
      'No effect of future budget or content changes is included.',
    ],
  };
}
