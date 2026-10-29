import { createHash } from 'node:crypto';
import { round, safeDiv } from '../lib/util.js';
import { countEvents } from './metrics.js';

/** Deterministic weighted assignment: same (experimentKey, visitorKey) always yields the same variant for fixed weights. */
export function assignVariant(experiment, visitorKey) {
  const variants = experiment.variants;
  const total = variants.reduce((s, x) => s + (x.weight ?? 1), 0);
  const h = createHash('sha256').update(`${experiment.key}:${visitorKey}`).digest();
  const u = h.readUInt32BE(0) / 0x100000000;
  let acc = 0;
  for (const variant of variants) {
    acc += (variant.weight ?? 1) / total;
    if (u < acc) return variant.key;
  }
  return variants[variants.length - 1].key;
}

/* ---- statistics ---- */
function erf(x) {
  const s = x < 0 ? -1 : 1; const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}
export const normalCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

export function wilson(successes, n, z = 1.96) {
  if (!n) return null;
  const p = successes / n; const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: round(Math.max(0, center - half), 4), high: round(Math.min(1, center + half), 4) };
}

export function twoProportionTest(s1, n1, s2, n2) {
  if (!n1 || !n2) return null;
  const p1 = s1 / n1; const p2 = s2 / n2;
  const pooled = (s1 + s2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, pValue: 1 };
  const z = (p2 - p1) / se;
  return { z: round(z, 3), pValue: round(2 * (1 - normalCdf(Math.abs(z))), 4) };
}

/**
 * Results for one experiment from events (already scoped to one dataset).
 * Primary metric: registrations ÷ unique visits. A winner is declared only if BOTH arms meet the minimum
 * visitor and conversion thresholds AND the difference is significant after Bonferroni correction.
 */
export function experimentResults(experiment, events, thresholds, { simulated = false } = {}) {
  const minV = thresholds.experimentMinVisitorsPerVariant;
  const minC = thresholds.experimentMinConversionsPerVariant;
  const evs = events.filter((e) => e.experimentKey === experiment.key);
  const rows = experiment.variants.map((variant) => {
    const c = countEvents(evs.filter((e) => e.variant === variant.key));
    return {
      variant: variant.key, label: variant.label,
      visitors: c.page_view, ctaClicks: c.cta_click, starts: c.reg_start, registrations: c.reg_success,
      conversionRate: round(safeDiv(c.reg_success, c.page_view), 4),
      ci95: wilson(c.reg_success, c.page_view),
      sampleSufficient: c.page_view >= minV && c.reg_success >= minC,
    };
  });
  const control = rows[0];
  const k = rows.length - 1;
  const alpha = 0.05 / Math.max(1, k);
  const comparisons = rows.slice(1).map((r) => {
    const test = twoProportionTest(control.registrations, control.visitors, r.registrations, r.visitors);
    const lift = control.conversionRate ? round((r.conversionRate - control.conversionRate) / control.conversionRate, 4) : null;
    const enough = control.sampleSufficient && r.sampleSufficient;
    return { variant: r.variant, versus: control.variant, relativeLift: lift, ...test, alpha: round(alpha, 4), sampleSufficient: enough, significant: enough && test && test.pValue < alpha };
  });

  let verdict; let winner = null; let message;
  if (rows.some((r) => !r.sampleSufficient)) {
    verdict = 'insufficient_data';
    message = `Not enough data to call a winner. Each variant needs ≥ ${minV} visitors and ≥ ${minC} registrations (current visitors: ${rows.map((r) => `${r.variant}=${r.visitors}`).join(', ')}).`;
  } else {
    const sig = comparisons.filter((c) => c.significant);
    if (sig.length === 0) {
      verdict = 'no_significant_difference';
      message = 'Samples meet the minimum thresholds, but the observed difference is not statistically significant. Keep running or treat variants as equivalent.';
    } else {
      const best = sig.map((c) => ({ c, row: rows.find((r) => r.variant === c.variant) })).sort((a, b) => b.row.conversionRate - a.row.conversionRate)[0];
      const controlBetter = best.row.conversionRate < control.conversionRate;
      winner = controlBetter ? control.variant : best.row.variant;
      verdict = 'winner';
      message = `${winner} outperformed ${controlBetter ? best.row.variant : control.variant} (p=${best.c.pValue}, α=${best.c.alpha}). Significance shows association within this sample; confirm before acting.`;
    }
  }

  return {
    experimentKey: experiment.key, name: experiment.name, status: experiment.status,
    simulated, dataLabel: simulated ? 'SIMULATED demo data — not real visitor behaviour' : 'Recorded visitor events',
    variants: rows, comparisons, verdict, winner, message,
    method: [
      'Primary metric = registrations ÷ unique visits (page views).',
      '95% confidence intervals use the Wilson score interval.',
      'Each challenger is compared with the first variant (control) using a two-sided pooled two-proportion z-test; α is Bonferroni-adjusted for multiple challengers.',
      'Minimum sample guard: no winner unless every variant has the minimum visitors and conversions.',
      'Peeking caveat: checking results repeatedly inflates false positives; decide the sample size before looking.',
    ],
  };
}

export const EXPERIMENT_VARIANT_KEY = /^[a-z0-9][a-z0-9_-]{0,31}$/;
