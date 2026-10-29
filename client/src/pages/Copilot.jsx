import { useState } from 'react';
import { api } from '../api.js';
import { useView } from '../view.js';
import { Badge, Card, ErrorState, Field, Loading, Notice, ReasonPrompt, useApi } from '../components/ui.jsx';
import { fmtINR } from '../lib/format.js';

const SUGGESTED = ['What should we do next to reach the registration target?', 'Where is the funnel leaking?', 'Should we change how we spend the remaining budget?'];

export default function Copilot() {
  const v = useView();
  const [question, setQuestion] = useState(SUGGESTED[0]); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const [turns, setTurns] = useState([]); const [decided, setDecided] = useState({}); const [pending, setPending] = useState(null);
  const settings = useApi(`/api/settings${v.qDataset}`);

  async function ask(q) {
    setBusy(true); setErr(null);
    try { const r = await api.post(`/api/copilot/analyze${v.qDataset}`, { question: q }); setTurns((t) => [...t, { q, r }]); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function decide(turn, rec, decision, reason) {
    await api.post(`/api/copilot/decisions${v.qDataset}`, { analysisId: turn.r.analysisId, recommendationId: rec.id, title: rec.title, decision, reason: reason || undefined });
    setDecided((d) => ({ ...d, [`${turn.r.analysisId}:${rec.id}`]: decision }));
  }
  const gem = settings.data?.gemini;
  return (
    <>
      <Notice tone={gem?.configured ? 'info' : 'warn'} title={gem?.configured ? `Gemini (${gem.model}) is configured on the server.` : 'Gemini is not configured.'}>
        {gem?.configured ? 'Only aggregate metrics are sent to the model — never names, emails or referral codes. If a call fails, a clearly labelled rule-based analysis is shown instead.' : 'Analyses use a deterministic rule-based engine and are labelled “not AI-generated”. Set GEMINI_API_KEY on the server to enable the LLM.'}
      </Notice>
      <Notice tone="info" title="Human approval:">Recommendations are suggestions. Accepting or rejecting records your decision in the audit log; it does not send, spend or change anything.</Notice>
      <Card title="Ask the Growth Copilot">
        <div className="row" style={{ marginBottom: '.6rem' }}>{SUGGESTED.map((s) => <button key={s} className="btn small" onClick={() => setQuestion(s)}>{s}</button>)}</div>
        <Field label="Question" id="cq"><textarea id="cq" rows={2} maxLength={300} value={question} onChange={(e) => setQuestion(e.target.value)} /></Field>
        <button className="btn primary" disabled={busy || !question.trim()} onClick={() => ask(question.trim())}>{busy ? 'Analysing…' : 'Analyse current metrics'}</button>
        <span className="muted small"> · analyses the {v.dataset === 'demo' ? 'SIMULATED demo' : 'live'} dataset</span>
      </Card>
      {busy && <Loading label="Analysing metrics…" />}
      {err && <ErrorState message={err} />}
      {[...turns].reverse().map((turn) => (
        <Card key={turn.r.analysisId} title={turn.q} subtitle={new Date(turn.r.generatedAt).toLocaleString('en-IN')}
          actions={<Badge kind={turn.r.source === 'gemini' ? 'ai' : 'fallback'} />}>
          <Notice tone={turn.r.source === 'gemini' ? 'info' : 'warn'}>{turn.r.label}{turn.r.fallbackReason && ` (reason: ${turn.r.fallbackReason})`}</Notice>
          {turn.r.simulated && <Notice tone="warn">Based on SIMULATED demo data — not real results.</Notice>}
          {turn.r.recommendations.map((rec) => {
            const key = `${turn.r.analysisId}:${rec.id}`;
            return (
              <article key={rec.id} className="rec" aria-label={rec.title}>
                <h3>#{rec.rank} {rec.title}</h3>
                <dl>
                  <dt>Supporting metric</dt><dd><strong>{rec.supportingMetric.name}:</strong> {String(rec.supportingMetric.value)}</dd>
                  <dt>Why</dt><dd>{rec.reason}</dd>
                  <dt>Impact assumption</dt><dd>{rec.impactAssumption} <Badge kind="estimate" /></dd>
                  <dt>Estimated cost</dt><dd>{fmtINR(rec.estimatedCostINR)}</dd>
                  <dt>Confidence</dt><dd>{rec.confidence}</dd>
                  <dt>Limitations</dt><dd><ul style={{ margin: 0 }}>{rec.limitations.map((l) => <li key={l}>{l}</li>)}</ul></dd>
                  <dt>Next step</dt><dd>{rec.nextStep}</dd>
                </dl>
                {decided[key] ? <Badge kind={decided[key] === 'accepted' ? 'recorded' : 'fallback'}>{decided[key]} (recorded)</Badge> : v.canWrite ? (
                  <div className="row"><button className="btn small primary" onClick={() => setPending({ turn, rec, decision: 'accepted' })}>Accept</button><button className="btn small" onClick={() => setPending({ turn, rec, decision: 'rejected' })}>Reject</button></div>
                ) : <span className="muted small">Read-only access: decisions are disabled.</span>}
              </article>
            );
          })}
          <details><summary>Metrics this analysis was based on</summary><pre className="formula" style={{ overflow: 'auto' }}>{JSON.stringify(turn.r.basedOn, null, 2)}</pre></details>
        </Card>
      ))}
      {pending && (
        <ReasonPrompt title={`${pending.decision === 'accepted' ? 'Accept' : 'Reject'}: ${pending.rec.title}`} required={pending.decision === 'rejected'} confirmLabel={pending.decision === 'accepted' ? 'Record acceptance' : 'Record rejection'} onCancel={() => setPending(null)}
          onConfirm={async (reason) => { await decide(pending.turn, pending.rec, pending.decision, reason); setPending(null); }}>
          <p className="small">This only records your decision. Any outreach or spend must be carried out by a person.</p>
        </ReasonPrompt>
      )}
    </>
  );
}
