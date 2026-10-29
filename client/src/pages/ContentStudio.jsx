import { useState } from 'react';
import { api } from '../api.js';
import { useView } from '../view.js';
import { Async, Badge, Card, Empty, Field, Notice, useApi } from '../components/ui.jsx';

function Draft({ initial, qDataset, canWrite, onSaved }) {
  const [text, setText] = useState(initial.text); const [saved, setSaved] = useState(initial.id && initial.status ? initial : null);
  const [msg, setMsg] = useState(null); const [busy, setBusy] = useState(false);
  const count = text.length; const limit = initial.characterLimit; const over = count > limit;
  const base = { channel: initial.channel, segment: initial.segment, tone: initial.tone };
  const guard = async (fn) => { setBusy(true); setMsg(null); try { await fn(); } catch (e) { setMsg({ tone: 'error', text: e.body?.details?.blocking?.concat(e.body?.details?.placeholders || []).join(' ') || e.message }); } finally { setBusy(false); } };
  const save = () => guard(async () => {
    const r = saved ? await api.put(`/api/content/drafts/${saved.id}${qDataset}`, { text, subject: initial.subject || undefined }) : await api.post(`/api/content/drafts${qDataset}`, { ...base, text, subject: initial.subject || undefined, campaignTag: `${initial.tagging.utm_campaign}/${initial.tagging.utm_source}/${initial.tagging.utm_content}` });
    setSaved(r.draft); setMsg({ tone: 'ok', text: 'Draft saved.' }); onSaved?.();
  });
  const approve = () => guard(async () => { await save(); const d = saved || (await api.get(`/api/content/drafts${qDataset}`)).items[0]; await api.post(`/api/content/drafts/${d.id}/approve${qDataset}`, {}); setSaved({ ...d, status: 'approved' }); setMsg({ tone: 'ok', text: 'Approved for MANUAL posting. Nothing was sent.' }); onSaved?.(); });
  const lintLocal = saved?.lint;
  return (
    <article className="card" style={{ marginBottom: 0 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}><strong>{initial.tone}</strong><Badge kind={initial.source === 'gemini' ? 'ai' : 'fallback'}>{initial.sourceLabel}</Badge></div>
      {initial.subject && <p className="small"><strong>Subject:</strong> {initial.subject}</p>}
      <label className="sr" htmlFor={`t-${initial.id}`}>Editable draft text</label>
      <textarea id={`t-${initial.id}`} rows={9} value={text} onChange={(e) => { setText(e.target.value); setMsg(null); }} aria-describedby={`c-${initial.id}`} />
      <p id={`c-${initial.id}`} className={`small ${over ? 'err' : 'muted'}`}>{count} / {limit} characters{over && ' — over the recommended limit'}</p>
      <p className="small muted">CTA link tagged: <code>{initial.tagging.utm_source}/{initial.tagging.utm_medium} · {initial.tagging.utm_campaign} · {initial.tagging.utm_content}{initial.tagging.ref ? ` · ref=${initial.tagging.ref}` : ''}</code></p>
      {text.includes('[DATE & TIME') && <Notice tone="warn">Replace the schedule placeholder with the real date/time from the organiser before approving. Dates are never invented.</Notice>}
      {initial.lint.blocking.length > 0 && <Notice tone="error">{initial.lint.blocking.join(' ')}</Notice>}
      {initial.lint.warnings.length > 0 && <Notice tone="warn">{initial.lint.warnings.join(' ')}</Notice>}
      {lintLocal && lintLocal.blocking.length > 0 && <Notice tone="error">After your edits: {lintLocal.blocking.join(' ')}</Notice>}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <div className="row">
        <button className="btn small" onClick={() => navigator.clipboard?.writeText(text).then(() => setMsg({ tone: 'ok', text: 'Copied. Post it manually.' }))}>Copy</button>
        {canWrite && <><button className="btn small" disabled={busy} onClick={save}>Save draft</button><button className="btn small primary" disabled={busy || over} onClick={approve}>Approve for manual posting</button></>}
        {saved?.status === 'approved' && <Badge kind="recorded">approved · not sent</Badge>}
      </div>
    </article>
  );
}

export default function ContentStudio() {
  const v = useView();
  const opts = useApi('/api/content/options');
  const saved = useApi(`/api/content/drafts${v.qDataset}`, { deps: [v.n] });
  const [sel, setSel] = useState({ channel: 'whatsapp', segment: 'cs_it', tones: ['friendly'], refCode: '', ambassadorName: '', useAI: false });
  const [out, setOut] = useState(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const toggleTone = (t) => setSel((s) => ({ ...s, tones: s.tones.includes(t) ? s.tones.filter((x) => x !== t) : [...s.tones, t] }));
  async function gen() {
    setBusy(true); setErr(null);
    try { setOut(await api.post('/api/content/generate', { channel: sel.channel, segment: sel.segment, tone: sel.tones[0] || 'friendly', tones: sel.tones.length ? sel.tones : undefined, refCode: sel.refCode || undefined, ambassadorName: sel.ambassadorName || undefined, useAI: sel.useAI })); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <Async res={opts}>
      {(o) => (
        <>
          <Notice tone="info" title="Never auto-sent.">{o.rules.join(' ')}</Notice>
          <Card title="Generate drafts">
            <div className="grid g3">
              <Field label="Channel" id="gc"><select id="gc" value={sel.channel} onChange={(e) => setSel({ ...sel, channel: e.target.value })}>{o.channels.map((c) => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}</select></Field>
              <Field label="Audience segment" id="gs"><select id="gs" value={sel.segment} onChange={(e) => setSel({ ...sel, segment: e.target.value })}>{Object.entries(o.segments).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
              <Field label="Referral code (optional)" id="gr"><input id="gr" value={sel.refCode} onChange={(e) => setSel({ ...sel, refCode: e.target.value.toUpperCase() })} placeholder="AMB-XXXXXX" /></Field>
            </div>
            {sel.channel === 'ambassador_outreach' && <Field label="Ambassador name (optional)" id="gn"><input id="gn" value={sel.ambassadorName} onChange={(e) => setSel({ ...sel, ambassadorName: e.target.value })} /></Field>}
            <fieldset style={{ border: 0, padding: 0, margin: '0 0 .8rem' }}><legend className="small"><strong>Tone</strong> (pick one or more to compare)</legend>
              <div className="row">{o.tones.map((t) => <label key={t} className="row" style={{ gap: '.3rem' }}><input type="checkbox" style={{ width: 'auto', minHeight: 0 }} checked={sel.tones.includes(t)} onChange={() => toggleTone(t)} />{t}</label>)}</div></fieldset>
            <label className="row" style={{ marginBottom: '.8rem' }}><input type="checkbox" style={{ width: 'auto', minHeight: 0 }} checked={sel.useAI} onChange={(e) => setSel({ ...sel, useAI: e.target.checked })} />Ask Gemini to draft (falls back to templates if unavailable or if the draft breaks content rules)</label>
            <button className="btn primary" disabled={busy || !sel.tones.length} onClick={gen}>{busy ? 'Generating…' : 'Generate drafts'}</button>
            {err && <Notice tone="error">{err}</Notice>}
          </Card>
          {out && (<>
            {out.notes.map((n) => <Notice key={n} tone="warn">{n}</Notice>)}
            <div className="grid g2">{out.variants.map((vr) => <Draft key={vr.id} initial={vr} qDataset={v.qDataset} canWrite={v.canWrite} onSaved={saved.reload} />)}</div></>)}
          <Card title="Saved drafts" subtitle="Sending is always manual — the platform has no send function.">
            <Async res={saved} emptyIf={(d) => d.items.length === 0} empty={<Empty title="No saved drafts">Generate a draft and save it.</Empty>}>
              {(d) => d.items.map((x) => (
                <details key={x.id} style={{ marginBottom: '.5rem' }}><summary>{x.channel} · {x.segment} · {x.tone} · <Badge kind={x.status === 'approved' ? 'recorded' : 'fallback'}>{x.status}</Badge> · {x.characterCount}/{x.characterLimit}</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{x.text}</pre>{x.approvedBy && <p className="small muted">Approved by {x.approvedBy}</p>}</details>
              ))}
            </Async>
          </Card>
        </>
      )}
    </Async>
  );
}
