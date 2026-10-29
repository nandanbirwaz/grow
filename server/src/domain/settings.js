import { ValidationError, parse, v } from '../lib/validate.js';
import { isDay } from '../lib/util.js';

export const DEFAULT_SETTINGS = {
  campaignName: 'Build Your First AI Project in 60 Minutes',
  audience: 'Final-year engineering students',
  targetRegistrations: 500,
  durationDays: 7,
  budgetCapINR: 2000,
  startDate: null,
  referralRules: { selfReferralBlock: true, maxValidPerIpPerDay: 3, attributionWindowDays: 7, pointsPerReferral: 1 },
  alertRules: {
    declinePct: 30, minPriorAvg: 3, maxCprINR: 150, minRegsForCpr: 10,
    budgetWarnPct: 80, budgetCriticalPct: 100, referralSpikePerHour: 5,
  },
  thresholds: {
    minRegsPerChannel: 10, experimentMinVisitorsPerVariant: 100,
    experimentMinConversionsPerVariant: 10, forecastMinDays: 3,
  },
};

export const SETTINGS_SCHEMA = v.object({
  campaignName: v.string({ min: 3, max: 120, optional: true }),
  targetRegistrations: v.number({ int: true, min: 1, max: 100000, optional: true }),
  durationDays: v.number({ int: true, min: 1, max: 60, optional: true }),
  budgetCapINR: v.number({ min: 0, max: 2000, optional: true }),
  startDate: v.string({ pattern: /^\d{4}-\d{2}-\d{2}$/, optional: true }),
  referralRules: v.object({
    selfReferralBlock: v.boolean({ optional: true }),
    maxValidPerIpPerDay: v.number({ int: true, min: 1, max: 100, optional: true }),
    attributionWindowDays: v.number({ int: true, min: 1, max: 60, optional: true }),
    pointsPerReferral: v.number({ int: true, min: 1, max: 100, optional: true }),
  }, { optional: true }),
  alertRules: v.object({
    declinePct: v.number({ min: 1, max: 100, optional: true }),
    minPriorAvg: v.number({ min: 0, max: 1000, optional: true }),
    maxCprINR: v.number({ min: 1, max: 100000, optional: true }),
    minRegsForCpr: v.number({ int: true, min: 1, max: 1000, optional: true }),
    budgetWarnPct: v.number({ min: 1, max: 100, optional: true }),
    budgetCriticalPct: v.number({ min: 1, max: 200, optional: true }),
    referralSpikePerHour: v.number({ int: true, min: 1, max: 1000, optional: true }),
  }, { optional: true }),
  thresholds: v.object({
    minRegsPerChannel: v.number({ int: true, min: 1, max: 1000, optional: true }),
    experimentMinVisitorsPerVariant: v.number({ int: true, min: 10, max: 100000, optional: true }),
    experimentMinConversionsPerVariant: v.number({ int: true, min: 1, max: 10000, optional: true }),
    forecastMinDays: v.number({ int: true, min: 2, max: 14, optional: true }),
  }, { optional: true }),
  reason: v.string({ min: 3, max: 300 }),
});

export function mergeSettings(stored = {}) {
  const out = { ...DEFAULT_SETTINGS, ...stored };
  for (const k of ['referralRules', 'alertRules', 'thresholds']) out[k] = { ...DEFAULT_SETTINGS[k], ...(stored[k] || {}) };
  return out;
}

export async function getSettings(store, dataset) {
  const doc = await store.findOne('settings', { dataset });
  return mergeSettings(doc || {});
}

export function validateSettingsPatch(body) {
  const p = parse(SETTINGS_SCHEMA, body);
  if (p.startDate !== undefined && !isDay(p.startDate)) {
    throw new ValidationError([{ path: 'startDate', message: 'must be a real calendar date (YYYY-MM-DD)' }]);
  }
  return p;
}
