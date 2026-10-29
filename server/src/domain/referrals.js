import { randomInt } from 'node:crypto';
import { eachDay, round, safeDiv } from '../lib/util.js';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
export function generateCode(existing = new Set(), prefix = 'AMB') {
  for (let i = 0; i < 50; i += 1) {
    let s = '';
    for (let j = 0; j < 6; j += 1) s += ALPHABET[randomInt(ALPHABET.length)];
    const code = `${prefix}-${s}`;
    if (!existing.has(code)) return code;
  }
  throw new Error('Could not generate a unique referral code');
}
export const normalizeCode = (raw) => {
  const s = String(raw || '').trim().toUpperCase();
  return /^[A-Z0-9-]{4,24}$/.test(s) ? s : null;
};

export const REFERRAL_STATUSES = {
  valid: 'Counted',
  invalid_code: 'Not counted — unknown or inactive code',
  self_referral_blocked: 'Not counted — referrer and registrant are the same person (email match)',
  flagged_ip_limit: 'Not counted — too many referred sign-ups from one network in a day (possible abuse; review manually)',
  expired: 'Not counted — referral link older than the attribution window',
};

/**
 * Decide whether a registration with a referral code counts.
 * Rules are configurable via settings.referralRules. A rejected referral never blocks the registration itself.
 */
export function evaluateReferral({ ambassador, registrantEmailHash, ipHash, validFromSameIpToday, refCapturedAtMs, nowMs, rules }) {
  if (!ambassador || ambassador.status !== 'active') return 'invalid_code';
  if (rules.selfReferralBlock && ambassador.emailHash && ambassador.emailHash === registrantEmailHash) return 'self_referral_blocked';
  if (refCapturedAtMs && nowMs - refCapturedAtMs > rules.attributionWindowDays * 86400000) return 'expired';
  if (ipHash && validFromSameIpToday >= rules.maxValidPerIpPerDay) return 'flagged_ip_limit';
  return 'valid';
}

export function leaderboard(ambassadors, registrations, pointsPerReferral = 1) {
  const rows = ambassadors.map((a) => {
    const mine = registrations.filter((r) => r.referral && r.referral.ambassadorId === a._id);
    const valid = mine.filter((r) => r.referral.status === 'valid').length;
    return {
      ambassadorId: a._id, displayName: a.displayName, code: a.code, status: a.status,
      points: valid * pointsPerReferral, validReferrals: valid, rejectedReferrals: mine.length - valid, totalSubmitted: mine.length,
      validRate: round(safeDiv(valid, mine.length), 4),
    };
  });
  rows.sort((x, y) => y.validReferrals - x.validReferrals || x.rejectedReferrals - y.rejectedReferrals || x.displayName.localeCompare(y.displayName));
  let rank = 0; let prev = null; let seen = 0;
  return rows.map((r) => {
    seen += 1;
    if (r.validReferrals !== prev) { rank = seen; prev = r.validReferrals; }
    return { rank, ...r };
  });
}

/** Privacy-safe: counts only. No names, emails, colleges or per-registrant rows. */
export function ambassadorReport(ambassador, registrations, from, to, pointsPerReferral = 1) {
  const mine = registrations.filter((r) => r.referral && r.referral.ambassadorId === ambassador._id);
  const byStatus = {};
  for (const r of mine) byStatus[r.referral.status] = (byStatus[r.referral.status] || 0) + 1;
  const validByDay = {};
  for (const r of mine) if (r.referral.status === 'valid') validByDay[r.day] = (validByDay[r.day] || 0) + 1;
  const days = from && to ? eachDay(from, to) : Object.keys(validByDay).sort();
  return {
    ambassador: { id: ambassador._id, displayName: ambassador.displayName, code: ambassador.code, status: ambassador.status },
    totals: { points: (byStatus.valid || 0) * pointsPerReferral, valid: byStatus.valid || 0, rejected: mine.length - (byStatus.valid || 0), submitted: mine.length },
    byStatus,
    validByDay: days.map((day) => ({ day, count: validByDay[day] || 0 })),
    privacy: 'Counts only. Registrant names, emails, phone numbers and colleges are never included in ambassador reports.',
  };
}

/** Referral submissions per ambassador per clock hour; used for spike alerts. */
export function hourlyReferralSpikes(registrations, ambassadors, threshold) {
  const buckets = {};
  for (const r of registrations) {
    if (!r.referral || !r.referral.ambassadorId) continue;
    const hour = r.createdAt.slice(0, 13);
    const key = `${r.referral.ambassadorId}|${hour}`;
    buckets[key] = (buckets[key] || 0) + 1;
  }
  const byId = Object.fromEntries(ambassadors.map((a) => [a._id, a]));
  return Object.entries(buckets)
    .filter(([, n]) => n > threshold)
    .map(([key, n]) => {
      const [id, hour] = key.split('|');
      return { ambassadorId: id, displayName: byId[id]?.displayName || 'unknown', code: byId[id]?.code, hour, count: n };
    })
    .sort((a, b) => b.count - a.count);
}

export const referralRuleExplanations = (rules) => [
  `Points: an employee/ambassador earns ${rules.pointsPerReferral ?? 1} point(s) for each counted registration that used their code (by link or typed on the form).`,
  `Each employee/ambassador has one unique code. A registration counts for an ambassador only when the code is active and passes every rule below; a rejected referral never blocks the registration itself.`,
  `Self-referral block: ${rules.selfReferralBlock ? 'ON' : 'OFF'} — a registration whose normalised email matches the ambassador's own email does not count.`,
  `Duplicate protection: one registration per normalised email (case, "+tags" and Gmail dots ignored). A second sign-up is rejected, so it cannot be counted twice.`,
  `Network limit: at most ${rules.maxValidPerIpPerDay} counted referrals per hashed network address per day (shared campus/hostel Wi-Fi can trigger this — review "flagged" items manually).`,
  `Attribution window: ${rules.attributionWindowDays} days from when the referral link was first opened.`,
];
