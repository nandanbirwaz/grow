import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useView } from '../view.js';
import { Async, Badge, Card, ExportButton, Field, Notice, ReasonPrompt, Stat, Table, useApi } from '../components/ui.jsx';
import { fmtINR, fmtNum } from '../lib/format.js';

function WhatIf({ summary, qDataset }) {
  const [alloc, setAlloc] = useState({}); const [out, setOut] = useState(null); const [err, setErr] = useState(null);
  const channels = [...new Set([...summary.channels.map((c) => c.channel), 'whatsapp', 'instagram', 'linkedin', 'email'])];
  const total = Object.values(alloc).reduce((s, x) => s + (Number(x) || 0), 0);
  useEffect(() => {
    const t = setTimeout(async () => {
      const allocations = Object.fromEntries(Object.entries(alloc).filter(([, x]) => Number(x) >= 0 && x !== '').map(([k, x]) => [k, Number(x)]));
      if (!Object.keys(allocations).length) { setOut(null); setErr(null); return; }
      try { setOut(await api.post(`/api/budget/whatif${qDataset}`, { allocations })); setErr(null); } catch (e) { setOut(null); setErr(e.message); }
    }, 300);
    return () => clearTimeout(t);
  }, [alloc, qDataset]);
  return (
    <Card title={<>What-if simulator <Badge kind="estimate" /></>} subtitle={`Reallocate the remaining ${fmtINR(summary.remainingINR)}. Nothing here is recorded as spend.`}>
      <div className="grid g4">
        {channels.map((c) => <Field key={c} label={`${c} (₹)`} id={`w-${c}`}><input id={`w-${c}`} type="number" min="0" step="10" value={alloc[c] ?? ''} onChange={(e) => setAlloc({ ...alloc, [c]: e.target.value })} /></Field>)}
      </div>
      <p className="small">Proposed total: <strong>{fmtINR(total)}</strong> of {fmtINR(summary.remainingINR)} remaining · left after: <strong>{fmtINR(summary.remainingINR - total)}</strong></p>
      {err && <Notice tone="error">{err}</Notice>}
      {out && (<>
        <Notice tone="warn" title={`${out.label}.`}>Estimated additional registrations: <strong>{out.estimatedAdditionalRegistrations}</strong>{out.unestimatedChannels.length > 0 && ` (no reliable cost data for: ${out.unestimatedChannels.join(', ')} — excluded, not guessed)`}</Notice>
        <Table caption="What-if lines" rows={out.lines.map((l) => ({ ...l, id: l.channel }))} columns={[{ key: 'channel', label: 'Channel' }, { key: 'proposedAmountINR', label: 'Proposed', num: true, render: (r) => fmtINR(r.proposedAmountINR) },
          { key: 'observedCostPerRegistrationINR', label: 'Observed ₹/reg', num: true, render: (r) => fmtINR(r.observedCostPerRegistrationINR, true) }, { key: 'estimatedAdditionalRegistrations', label: 'Est. registrations', num: true, render: (r) => r.estimatedAdditionalRegistrations ?? 'no estimate' }, { key: 'basis', label: 'Basis' }]} />
        <ul className="small">{out.assumptions.map((a) => <li key={a}>{a}</li>)}</ul></>)}
    </Card>
  );
}

export default function Budget() {
  const v = useView();
  const res = useApi(`/api/budget${v.qDataset}`, { deps: [v.n] });
  const [addSpend, setAddSpend] = useState(false); const [form, setForm] = useState({ channel: 'whatsapp', amount: '', date: '', note: '' }); const [over, setOver] = useState(false);
  const [rm, setRm] = useState(null); const [plan, setPlan] = useState(null);
  return (
    <Async res={res}>
      {(d) => {
        const s = d.summary;
        return (
          <>
            <Notice>{d.semantics}</Notice>
            <div className="grid g4" style={{ margin: '1rem 0' }}>
              <Stat label="Budget cap" value={fmtINR(s.capINR)} /><Stat label={<>Planned <Badge kind="target" /></>} value={fmtINR(s.plannedTotalINR)} tone={s.plannedOverCap ? 'bad' : ''} />
              <Stat label={<>Actual spend <Badge kind="actual" /></>} value={fmtINR(s.actualTotalINR)} hint={`${s.usedPct}% of cap`} tone={s.overCap ? 'bad' : ''} />
              <Stat label="Remaining" value={fmtINR(s.remainingINR)} tone={s.remainingINR < 0 ? 'bad' : 'good'} />
              <Stat label="Blended ₹ / registration" value={fmtINR(s.blendedCostPerRegistrationINR, true)} />
            </div>
            <div className="bar-bg" role="progressbar" aria-valuenow={Math.min(100, s.usedPct)} aria-valuemin={0} aria-valuemax={100} aria-label="Budget used" style={{ height: 14, marginBottom: '1rem' }}><div className="bar" style={{ width: `${Math.min(100, s.usedPct)}%`, background: s.overCap ? 'var(--c3)' : undefined }} /></div>
            <Card title="Channels: planned vs actual" actions={<><ExportButton path={`/api/budget/export.csv${v.qDataset}`} />{v.canWrite && <><button className="btn small" onClick={() => setPlan(Object.fromEntries(s.channels.filter((c) => c.plannedINR).map((c) => [c.channel, String(c.plannedINR)])))}>Edit plan</button><button className="btn primary small" onClick={() => setAddSpend(true)}>Record spend</button></>}</>}>
              <Table caption="Budget by channel" rows={s.channels.map((c) => ({ ...c, id: c.channel }))} columns={[{ key: 'channel', label: 'Channel' }, { key: 'plannedINR', label: 'Planned', num: true, render: (r) => fmtINR(r.plannedINR) }, { key: 'actualINR', label: 'Actual', num: true, render: (r) => fmtINR(r.actualINR) },
                { key: 'varianceINR', label: 'Actual − planned', num: true, render: (r) => fmtINR(r.varianceINR) }, { key: 'registrations', label: 'Registrations', num: true, render: (r) => fmtNum(r.registrations) },
                { key: 'cpr', label: '₹ / registration', num: true, render: (r) => fmtINR(r.costPerRegistrationINR, true) }, { key: 'ok', label: 'Sample ≥ ' + s.minRegsThreshold, render: (r) => (r.paid ? (r.sampleSufficient ? 'Yes' : 'No — too early') : 'unpaid') }]} />
            </Card>
            <Card title={<>Recommendations <Badge kind="estimate">proposal only</Badge></>} subtitle="Gated by minimum sample size. Never recorded as spend.">
              {d.recommendations.map((r, i) => <Notice key={i} tone={r.kind === 'shift_remaining' ? 'info' : 'warn'}>{r.message}{r.evidence && <><br /><small>Evidence: {r.evidence}</small></>}</Notice>)}
              <ul className="small">{d.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
            </Card>
            <WhatIf summary={s} qDataset={v.qDataset} />
            <Card title="Recorded spend entries">
              <Table caption="Spend entries" empty="No actual spend recorded." rows={d.entries} columns={[{ key: 'date', label: 'Date' }, { key: 'channel', label: 'Channel' }, { key: 'amountINR', label: 'Amount', num: true, render: (r) => fmtINR(r.amountINR) }, { key: 'note', label: 'Note' },
                { key: 'x', label: '', render: (r) => v.canWrite && <button className="btn small danger" onClick={() => setRm(r)}>Remove</button> }]} />
            </Card>
            {addSpend && (
              <ReasonPrompt title="Record actual spend" confirmLabel="Record" onCancel={() => { setAddSpend(false); setOver(false); }} onConfirm={async (reason) => {
                try { await api.post(`/api/budget/spend${v.qDataset}`, { channel: form.channel, amountINR: Number(form.amount), date: form.date || undefined, note: form.note || undefined, acknowledgeOverCap: over || undefined, reason }); setAddSpend(false); setOver(false); v.refresh(); } catch (e) { if (e.body?.error === 'over_cap') setOver(true); throw e; }
              }}>
                <p className="small">Record only money that has actually been spent. The ₹{fmtNum(s.capINR)} ceiling is enforced.</p>
                <div className="grid g2"><Field label="Channel" id="sc"><input id="sc" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })} /></Field><Field label="Amount (₹)" id="sa"><input id="sa" type="number" min="1" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field></div>
                <Field label="Date (optional)" id="sd"><input id="sd" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
                <Field label="Note (optional)" id="sn"><input id="sn" value={form.note} maxLength={200} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
                {over && <Notice tone="warn">This exceeds the cap. Submit again only if the money was really spent — it will be flagged as an over-cap entry.</Notice>}
              </ReasonPrompt>
            )}
            {rm && <ReasonPrompt title={`Remove ${fmtINR(rm.amountINR)} entry (${rm.channel})`} confirmLabel="Remove" onCancel={() => setRm(null)} onConfirm={async (reason) => { await api.del(`/api/budget/spend/${rm.id}${v.qDataset}`, { reason }); setRm(null); v.refresh(); }} />}
            {plan && (
              <ReasonPrompt title="Edit planned allocation" onCancel={() => setPlan(null)} onConfirm={async (reason) => { await api.put(`/api/budget/plan${v.qDataset}`, { allocations: Object.fromEntries(Object.entries(plan).filter(([, x]) => x !== '').map(([k, x]) => [k, Number(x)])), reason }); setPlan(null); v.refresh(); }}>
                <p className="small">Plans are intentions, not spend. Total must stay within {fmtINR(s.capINR)}.</p>
                {[...new Set([...Object.keys(plan), 'whatsapp', 'instagram', 'linkedin', 'email'])].map((c) => <Field key={c} label={`${c} (₹)`} id={`p-${c}`}><input id={`p-${c}`} type="number" min="0" value={plan[c] ?? ''} onChange={(e) => setPlan({ ...plan, [c]: e.target.value })} /></Field>)}
              </ReasonPrompt>
            )}
          </>
        );
      }}
    </Async>
  );
}
