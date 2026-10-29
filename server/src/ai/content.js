import { createHash } from 'node:crypto';
import { geminiAvailable, geminiJson } from './gemini.js';

export const CHANNELS = ['whatsapp', 'instagram', 'linkedin', 'email', 'ambassador_outreach'];
export const SEGMENTS = {
  cs_it: 'CSE / IT students',
  core_engineering: 'Core engineering (ECE, EEE, Mech, Civil)',
  beginners: 'Students new to coding and AI',
  placement_focused: 'Students preparing for placements',
};
export const TONES = ['friendly', 'professional', 'energetic', 'concise'];
export const LIMITS = { whatsapp: 700, instagram: 2200, linkedin: 3000, email: 1500, ambassador_outreach: 600 };
export const DATE_PLACEHOLDER = '[DATE & TIME – confirm before sending]';
const UTM = { whatsapp: ['whatsapp', 'social'], instagram: ['instagram', 'social'], linkedin: ['linkedin', 'social'], email: ['email', 'email'], ambassador_outreach: ['ambassador', 'referral'] };

/* ---- policy lint: no invented dates, certificates, endorsements, scarcity ---- */
const MONTHS = '(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)';
const BLOCKING = [
  [/certificat/i, 'Mentions a certificate — not a confirmed campaign benefit.'],
  [/\b(limited|few) (seats?|spots?|slots?)\b|\bonly \d+ (seats?|spots?|slots?)\b|\b(seats?|spots?) (are )?(filling|running)\b|\bhurry\b|\blast chance\b|\bselling out\b|\bends (today|tonight|soon)\b|\bdon'?t miss out\b/i, 'Scarcity or urgency claim — not supported by campaign facts.'],
  [/\b(endorsed|partnered|in partnership|backed by|as seen on|recommended by|trusted by)\b/i, 'Partner / endorsement claim — not confirmed.'],
  [/\bguarantee/i, 'Guarantee claim — not allowed.'],
  [/\b(job|placement|internship)s? (is |are )?(assured|guaranteed)\b/i, 'Job / placement promise — not allowed.'],
  [new RegExp(`\\b\\d{1,2}(st|nd|rd|th)?\\s+${MONTHS}\\b|\\b${MONTHS}\\s+\\d{1,2}\\b`, 'i'), 'Contains a specific calendar date — dates must come from the organiser.'],
  [/\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/, 'Contains a numeric date.'],
  [/\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i, 'Contains a specific time — times must come from the organiser.'],
  [/\b(today|tonight|tomorrow|this (saturday|sunday|friday|weekend))\b/i, 'Relative date wording — confirm the actual schedule first.'],
];
const WARNINGS = [
  [/\bfree\b/i, 'Says "free" — confirm pricing before sending.'],
  [/\b(no coding|zero coding|without coding)\b/i, 'Claims no coding is needed — confirm prerequisites.'],
];
export function lintContent(text) {
  const blocking = BLOCKING.filter(([rx]) => rx.test(text)).map(([, m]) => m);
  const warnings = WARNINGS.filter(([rx]) => rx.test(text)).map(([, m]) => m);
  const placeholders = text.includes('[DATE & TIME') ? ['Schedule placeholder still present — fill in the real date/time before approving.'] : [];
  return { ok: blocking.length === 0, blocking, warnings, placeholders, readyToApprove: blocking.length === 0 && placeholders.length === 0 };
}

export function buildLink(config, { channel, segment, tone, refCode }) {
  const [source, medium] = UTM[channel];
  const p = new URLSearchParams({ utm_source: source, utm_medium: medium, utm_campaign: 'ai60', utm_content: `${segment}-${tone}` });
  if (refCode) p.set('ref', refCode);
  return { url: `${config.baseUrl}/?${p.toString()}`, tagging: { utm_source: source, utm_medium: medium, utm_campaign: 'ai60', utm_content: `${segment}-${tone}`, ref: refCode || null } };
}

const OPENERS = {
  friendly: { cs_it: 'Hey! Ready to ship something real with AI?', core_engineering: 'Hey! AI is not just for CS folks — here is a way to try it.', beginners: 'New to AI? This one is for you.', placement_focused: 'Want a hands-on AI project to talk about in interviews?' },
  professional: { cs_it: 'An invitation for final-year CSE/IT students.', core_engineering: 'An invitation for final-year core engineering students.', beginners: 'An introductory hands-on session for final-year students.', placement_focused: 'A practical session for final-year students preparing for placements.' },
  energetic: { cs_it: 'Build. Ship. Learn. Your first AI project starts here!', core_engineering: 'Engineers, let us put AI to work!', beginners: 'Your first AI project is closer than you think!', placement_focused: 'Turn placement prep into a real AI project!' },
  concise: { cs_it: 'Final-year CSE/IT:', core_engineering: 'Final-year engineering:', beginners: 'AI beginners:', placement_focused: 'Placement season:' },
};
const VALUE = {
  cs_it: 'In one hands-on session you will go from idea to a working AI project you can show.',
  core_engineering: 'You will work through a guided build that applies AI to a practical problem.',
  beginners: 'The session is a guided, step-by-step build so you can start from where you are.',
  placement_focused: 'You will finish with a project you built yourself — something concrete to explain.',
};
const CTA = { friendly: 'Save your spot here:', professional: 'Register here:', energetic: 'Grab your spot now:', concise: 'Register:' };

export function templateVariant(config, { channel, segment, tone, refCode, ambassadorName }) {
  const { url, tagging } = buildLink(config, { channel, segment, tone, refCode });
  const open = OPENERS[tone][segment]; const value = VALUE[segment]; const cta = CTA[tone];
  const title = 'Build Your First AI Project in 60 Minutes';
  let text; let subject = null;
  switch (channel) {
    case 'whatsapp':
      text = `${open}\n\n*${title}*\n${value}\n\nWhen: ${DATE_PLACEHOLDER}\n\n${cta} ${url}`; break;
    case 'instagram':
      text = `${open}\n\n${title}.\n${value}\n\nWhen: ${DATE_PLACEHOLDER}\n\n${cta} link in bio / ${url}\n\n#AI #EngineeringStudents #FirstAIProject #LearnAI`; break;
    case 'linkedin':
      text = `${open}\n\nI would like to share a session titled "${title}".\n\n${value}\n\nWho it is for: ${SEGMENTS[segment].toLowerCase()}.\nWhen: ${DATE_PLACEHOLDER}\n\n${cta} ${url}\n\n#AI #Students #Learning`; break;
    case 'email':
      subject = `${title}`;
      text = `Hi [First name],\n\n${open}\n\n${value}\n\nSession: ${title}\nWhen: ${DATE_PLACEHOLDER}\n\n${cta} ${url}\n\nSee you there,\n[Sender name]`; break;
    default:
      text = `Hi [Name], ${ambassadorName ? `I am ${ambassadorName}. ` : ''}${open}\nCould you share "${title}" with your classmates? ${value}\nYour personal link: ${url}\nWhen: ${DATE_PLACEHOLDER}\nThanks!`;
  }
  return finish(config, { channel, segment, tone, text, subject, url, tagging, source: 'template' });
}

function finish(config, v) {
  const lint = lintContent(`${v.subject || ''}\n${v.text}`.replace(DATE_PLACEHOLDER, ''));
  const full = lintContent(`${v.subject || ''}\n${v.text}`);
  return {
    id: createHash('sha1').update(`${v.channel}|${v.segment}|${v.tone}|${v.text}`).digest('hex').slice(0, 12),
    channel: v.channel, segment: v.segment, segmentLabel: SEGMENTS[v.segment], tone: v.tone,
    subject: v.subject, text: v.text, characterCount: v.text.length, characterLimit: LIMITS[v.channel], overLimit: v.text.length > LIMITS[v.channel],
    callToAction: v.url, tagging: v.tagging, source: v.source,
    sourceLabel: v.source === 'gemini' ? 'Drafted by Gemini — edit and review' : 'Template draft (not AI-generated)',
    lint: { ...full, blocking: lint.blocking, ok: lint.ok },
    status: 'draft', requiresHumanApproval: true,
  };
}

export async function generateContent({ config, fetchImpl, channel, segment, tone, refCode, ambassadorName, useAI }) {
  const tpl = templateVariant(config, { channel, segment, tone, refCode, ambassadorName });
  if (!useAI || !geminiAvailable(config)) {
    return { variant: tpl, aiRequested: Boolean(useAI), aiUsed: false, note: useAI ? 'Gemini is not configured, so a template draft was produced.' : null };
  }
  try {
    const raw = await geminiJson({
      config, fetchImpl,
      system: `You write short campaign messages for a student workshop titled "Build Your First AI Project in 60 Minutes". Facts you may use: it is a 60-minute hands-on session; audience is final-year engineering students. Do NOT mention any date, time, day, price, certificate, partner, endorsement, guarantee, scarcity or urgency. Use the literal text ${DATE_PLACEHOLDER} where the schedule goes. Include the exact link provided. Return JSON {"text":"...", "subject":"... or null"}.`,
      prompt: `Channel: ${channel}. Audience: ${SEGMENTS[segment]}. Tone: ${tone}. Maximum ${LIMITS[channel]} characters. Link to include: ${tpl.callToAction}`,
    });
    if (typeof raw.text !== 'string' || !raw.text.includes(tpl.callToAction) || raw.text.length > LIMITS[channel] * 1.2) throw new Error('llm_rejected');
    const ai = finish(config, { channel, segment, tone, text: raw.text.slice(0, LIMITS[channel] * 1.2), subject: typeof raw.subject === 'string' ? raw.subject.slice(0, 120) : tpl.subject, url: tpl.callToAction, tagging: tpl.tagging, source: 'gemini' });
    if (!ai.lint.ok) return { variant: tpl, aiRequested: true, aiUsed: false, note: 'The AI draft broke content rules (e.g. invented dates or claims), so a template draft is shown instead.' };
    return { variant: ai, aiRequested: true, aiUsed: true, note: null };
  } catch (e) {
    return { variant: tpl, aiRequested: true, aiUsed: false, note: `Gemini draft unavailable (${String(e.message).slice(0, 40)}); showing a template draft.` };
  }
}
