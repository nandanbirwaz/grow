import { useState } from 'react';
import { api } from '../api.js';
import { useView } from '../view.js';
import { Async, Badge, Card, Empty, ExportButton, Field, Notice, ReasonPrompt, Table, useApi } from '../components/ui.jsx';
import { CiChart } from '../components/charts.jsx';
import { fmtNum, fmtPct } from '../lib/format.js';

const blank = () => ({ key: '', label: '', headline: '', subhead: '', cta: 'Register now', weight: 1 });
const VERDICT = { insufficient_data: ['warn', 'No winner — not enough data'], no_significant_difference: ['info', 'No significant difference'], winner: ['ok', 'Winner'] };

function NewExperiment({ onDone, onCancel, qDataset }) {
  const [key, setKey] = useState(''); const [name, setName] = useState(''); const [variants, setVariants] = useState([{ ...blank(), key: 'control', label: 'Control' }, { ...blank(), key: 'variant-b', label: 'Variant B' }]);
  const upd = (i, k, val) => setVariants((vs) => vs.map((x, j) => (j === i ? { ...x, [k]: val } : x)));
  return (
    <ReasonPrompt title="New landing-page experiment" confirmLabel="Create & start" onCancel={onCancel} onConfirm={async (reason) => { await api.post(`/api/experiments${qDataset}`, { key, name, reason, variants: variants.map((x) => ({ ...x, weight: Number(x.weight) || 1 })) }); onDone(); }}>
      <Field label="Experiment key" id="ek" hint="lowercase, digits, - or _"><input id="ek" value={key} onChange={(e) => setKey(e.target.value.toLowerCase())} /></Field>
      <Field label="Name" id="en"><input id="en" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      {variants.map((x, i) => (
        <fieldset key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, marginBottom: '.6rem' }}>
          <legend>Variant {i + 1}</legend>
          <div className="grid g2">
            <Field label="Key" id={`vk${i}`}><input id={`vk${i}`} value={x.key} onChange={(e) => upd(i, 'key', e.target.value.toLowerCase())} /></Field>
            <Field label="Label" id={`vl${i}`}><input id={`vl${i}`} value={x.label} onChange={(e) => upd(i, 'label', e.target.value)} /></Field>
          </div>
          <Field label="Headline" id={`vh${i}`}><input id={`vh${i}`} value={x.headline} onChange={(e) => upd(i, 'headline', e.target.value)} /></Field>
          <Field label="Sub-headline" id={`vs${i}`}><input id={`vs${i}`} value={x.subhead} onChange={(e) => upd(i, 'subhead', e.target.value)} /></Field>
          <div className="grid g2">
            <Field label="Button text" id={`vc${i}`}><input id={`vc${i}`} value={x.cta} onChange={(e) => upd(i, 'cta', e.target.value)} /></Field>
            <Field label="Traffic weight" id={`vw${i}`}><input id={`vw${i}`} type="number" min="0.1" step="0.1" value={x.weight} onChange={(e) => upd(i, 'weight', e.target.value)} /></Field>
          </div>
        </fieldset>
      ))}
      <div className="row"><button className="btn small" disabled={variants.length >= 5} onClick={() => setVariants([...variants, blank()])}>Add variant</button>{variants.length > 2 && <button className="btn small" onClick={() => setVariants(variants.slice(0, -1))}>Remove last</button>}</div>
      <p className="muted small">Visitors are assigned once and keep the same variant. Content changes mid-run invalidate results, so create a new experiment instead.</p>
    </ReasonPrompt>
  );
}

export default function Experiments() {
  const v = useView();
  const res = useApi(`/api/experiments${v.qDataset}`, { deps: [v.n] });
  const [creating, setCreating] = useState(false); const [status, setStatus] = useState(null);
  return (
    <Async res={res}>
      {(d) => (
        <>
          <Notice tone={d.simulated ? 'warn' : 'info'} title={d.simulated ? 'SIMULATED:' : 'Recorded:'}>{d.note}</Notice>
          <div className="row end" style={{ margin: '.6rem 0' }}>
            <ExportButton path={`/api/experiments/export.csv${v.qDataset}`} />
            {v.canWrite && <button className="btn primary small" onClick={() => setCreating(true)}>New experiment</button>}
          </div>
          {d.experiments.length === 0 && <Empty title="No experiments yet">{v.canWrite ? 'Create one with two or more landing-page variants.' : 'An admin can create one.'}</Empty>}
          {d.experiments.map((e) => {
            const [tone, text] = VERDICT[e.verdict];
            return (
              <Card key={e.experimentKey} title={<>{e.name} <Badge kind={e.simulated ? 'simulated' : 'recorded'} /></>} subtitle={`${e.experimentKey} · ${e.status}`}
                actions={v.canWrite && <button className="btn small" onClick={() => setStatus({ e, next: e.status === 'running' ? 'paused' : 'running' })}>{e.status === 'running' ? 'Pause' : 'Resume'}</button>}>
                <Notice tone={tone} title={`${text}.`}>{e.message}</Notice>
                <div className="grid g2">
                  <Table caption="Variant results" rows={e.variants.map((x) => ({ ...x, id: x.variant }))} columns={[
                    { key: 'variant', label: 'Variant' }, { key: 'visitors', label: 'Visitors', num: true, render: (r) => fmtNum(r.visitors) }, { key: 'registrations', label: 'Registrations', num: true },
                    { key: 'conversionRate', label: 'Conv. rate', num: true, render: (r) => fmtPct(r.conversionRate, 2) },
                    { key: 'ci', label: '95% CI', num: true, render: (r) => (r.ci95 ? `${fmtPct(r.ci95.low)}–${fmtPct(r.ci95.high)}` : '—') },
                    { key: 'sampleSufficient', label: 'Sample OK?', render: (r) => (r.sampleSufficient ? 'Yes' : 'No') }]} />
                  <CiChart variants={e.variants} />
                </div>
                {e.comparisons.map((c) => <p key={c.variant} className="small">{c.variant} vs {c.versus}: lift {c.relativeLift === null ? '—' : fmtPct(c.relativeLift)}, z={c.z ?? '—'}, p={c.pValue ?? '—'} (α={c.alpha}) — {c.sampleSufficient ? (c.significant ? 'significant' : 'not significant') : 'sample too small to test'}</p>)}
                <details><summary>Variant copy & method</summary>
                  <ul>{e.config.map((x) => <li key={x.key}><strong>{x.label}</strong>: “{x.headline}” / {x.cta} (weight {x.weight ?? 1})</li>)}</ul>
                  <ul>{e.method.map((m) => <li key={m}>{m}</li>)}</ul>
                </details>
              </Card>
            );
          })}
          {creating && <NewExperiment qDataset={v.qDataset} onCancel={() => setCreating(false)} onDone={() => { setCreating(false); v.refresh(); }} />}
          {status && <ReasonPrompt title={`${status.next === 'paused' ? 'Pause' : 'Resume'} “${status.e.experimentKey}”`} onCancel={() => setStatus(null)} onConfirm={async (reason) => { await api.put(`/api/experiments/${status.e.experimentKey}/status${v.qDataset}`, { status: status.next, reason }); setStatus(null); v.refresh(); }}>
            <p className="small">Pausing stops new assignments and shows the default page copy. Existing results are kept.</p></ReasonPrompt>}
        </>
      )}
    </Async>
  );
}
