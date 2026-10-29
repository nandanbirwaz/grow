import { useEffect, useRef, useState } from 'react';
import { getConsent, resolveAttribution, sendEvent, setConsent, visitorId } from '../lib/tracking.js';
import { Field, Notice } from '../components/ui.jsx';

const DEFAULT_VARIANT = { key: null, headline: 'Build Your First AI Project in 60 Minutes', subhead: 'A hands-on session for final-year engineering students.', cta: 'Register now' };

export default function Landing() {
  const [consent, setConsentState] = useState(getConsent());
  const [cfg, setCfg] = useState(null);
  const [variant, setVariant] = useState(DEFAULT_VARIANT);
  const [expKey, setExpKey] = useState(null);
  const [form, setForm] = useState({ name: '', email: '', college: '', graduationYear: '2027', terms: false, ref: (resolveAttribution(window.location.search).ref || '').toUpperCase() });
  const [refState, setRefState] = useState(null); // null | 'checking' | 'valid' | 'invalid'
  const [status, setStatus] = useState({ state: 'idle' });
  const attr = useRef(resolveAttribution(window.location.search));
  const started = useRef(false);
  const sentView = useRef(false);

  useEffect(() => {
    let dead = false;
    (async () => {
      let config = null;
      try { config = await (await fetch('/api/public/config')).json(); } catch { /* fall back to default copy */ }
      if (dead) return;
      setCfg(config);
      let v = DEFAULT_VARIANT; let key = null;
      if (config?.experiment) {
        try {
          const res = await fetch('/api/public/assign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ experimentKey: config.experiment.key, visitorId: visitorId() || undefined }) });
          if (res.ok) { const j = await res.json(); v = j.variant; key = j.experimentKey; }
        } catch { /* default variant */ }
      }
      if (dead) return;
      setVariant(v); setExpKey(key);
      if (!sentView.current) { sentView.current = true; sendEvent('page_view', attr.current, { variant: key ? v.key : undefined, experimentKey: key || undefined }); }
    })();
    return () => { dead = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const track = (type) => sendEvent(type, attr.current, { variant: expKey ? variant.key : undefined, experimentKey: expKey || undefined });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const onFocus = () => { if (!started.current) { started.current = true; track('reg_start'); } };

  async function checkRef() {
    const code = form.ref.trim();
    if (!code) { setRefState(null); return; }
    setRefState('checking');
    try { const r = await fetch('/api/public/referral/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }); setRefState((await r.json()).valid ? 'valid' : 'invalid'); } catch { setRefState(null); }
  }
  useEffect(() => { if (form.ref) checkRef(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e) {
    e.preventDefault();
    setStatus({ state: 'sending' });
    try {
      const res = await fetch('/api/public/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name, email: form.email, college: form.college, graduationYear: Number(form.graduationYear) || undefined,
          consentTerms: form.terms, consentAnalytics: getConsent() === 'yes', visitorId: visitorId() || undefined,
          attribution: { ...attr.current, ref: form.ref.trim().toUpperCase() || undefined, refCapturedAt: form.ref.trim().toUpperCase() === attr.current.ref ? attr.current.refCapturedAt : undefined, variant: expKey ? variant.key : undefined, experimentKey: expKey || undefined },
        }),
      });
      const j = await res.json();
      if (res.status === 201) setStatus({ state: 'done', message: j.message });
      else if (res.status === 409) setStatus({ state: 'error', message: 'This email is already registered — you’re all set.' });
      else if (res.status === 429) setStatus({ state: 'error', message: 'Too many attempts. Please wait a few minutes and try again.' });
      else setStatus({ state: 'error', message: j.details?.[0] ? `${j.details[0].path} ${j.details[0].message}` : j.message || 'Something went wrong.' });
    } catch { setStatus({ state: 'error', message: 'Network problem. Please try again.' }); }
  }

  return (
    <main className="public">
      <header className="hero">
        <p className="muted small">{cfg?.campaignName || DEFAULT_VARIANT.headline}</p>
        <h1>{variant.headline}</h1>
        <p className="lead">{variant.subhead}</p>
        <button className="btn primary" onClick={() => { track('cta_click'); document.getElementById('reg')?.scrollIntoView({ behavior: 'smooth' }); document.getElementById('name')?.focus({ preventScroll: true }); }}>{variant.cta}</button>
      </header>

      <section id="reg" aria-labelledby="reg-h" className="card">
        <h2 id="reg-h">Register</h2>
        {status.state === 'done' ? <Notice tone="ok" title="You’re registered.">{status.message} The organisers will share session details with you directly.</Notice> : (
          <form onSubmit={submit} noValidate={false}>
            <Field label="Full name" id="name"><input id="name" required minLength={2} maxLength={80} autoComplete="name" value={form.name} onChange={set('name')} onFocus={onFocus} /></Field>
            <Field label="Email" id="email"><input id="email" type="email" required autoComplete="email" value={form.email} onChange={set('email')} onFocus={onFocus} /></Field>
            <Field label="College" id="college"><input id="college" required minLength={2} maxLength={120} value={form.college} onChange={set('college')} onFocus={onFocus} /></Field>
            <Field label="Graduation year" id="gy"><select id="gy" value={form.graduationYear} onChange={set('graduationYear')}>{[2026, 2027, 2028].map((y) => <option key={y}>{y}</option>)}</select></Field>
            <Field label="Referral code (optional)" id="ref" hint="If a team member referred you, enter their code so they get credit.">
              <input id="ref" maxLength={24} placeholder="AMB-XXXXXX" value={form.ref} onChange={(e) => { setForm((f) => ({ ...f, ref: e.target.value.toUpperCase() })); setRefState(null); }} onBlur={checkRef} />
            </Field>
            {refState === 'valid' && <p className="small" role="status" style={{ marginTop: '-.5rem' }}>✓ Code recognised.</p>}
            {refState === 'invalid' && <p className="small err" role="status" style={{ marginTop: '-.5rem' }}>We don’t recognise that code. You can still register; it just won’t be credited.</p>}
            <label className="row" style={{ marginBottom: '.8rem', alignItems: 'flex-start' }}>
              <input type="checkbox" style={{ width: 'auto', minHeight: 0, marginTop: 4 }} required checked={form.terms} onChange={set('terms')} />
              <span className="small">I agree that the organisers may use these details to run and contact me about this workshop. Details are never shown in analytics.</span>
            </label>
            {status.state === 'error' && <Notice tone="error">{status.message}</Notice>}
            <button className="btn primary" disabled={status.state === 'sending'}>{status.state === 'sending' ? 'Submitting…' : variant.cta}</button>
          </form>
        )}
      </section>

      <p className="muted small" style={{ marginTop: '1rem' }}>{cfg?.privacy}</p>
      {consent === null && (
        <aside className="consent" role="region" aria-label="Analytics consent">
          <p style={{ margin: '0 0 .5rem' }}>May we store a random visitor ID in your browser to count visits accurately? No name, email or phone is ever attached. Registration works either way.</p>
          <div className="row"><button className="btn primary small" onClick={() => { setConsent(true); setConsentState('yes'); }}>Allow analytics</button><button className="btn small" onClick={() => { setConsent(false); setConsentState('no'); }}>No thanks</button></div>
        </aside>
      )}
      {consent !== null && <button className="btn small" style={{ marginTop: '.5rem' }} onClick={() => { setConsent(consent !== 'yes'); setConsentState(consent === 'yes' ? 'no' : 'yes'); }}>Analytics: {consent === 'yes' ? 'on — turn off' : 'off — turn on'}</button>}
    </main>
  );
}
