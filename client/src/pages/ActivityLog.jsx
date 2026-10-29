import { useState } from 'react';
import { api } from '../api.js';
import { useView } from '../view.js';
import { Async, Badge, Card, Empty, ExportButton, Notice, ReasonPrompt, useApi } from '../components/ui.jsx';
import { fmtDateTime } from '../lib/format.js';

const SEV = { critical: 'error', warning: 'warn', info: 'info' };

export default function ActivityLog() {
  const v = useView();
  const alerts = useApi(`/api/alerts${v.qDataset}`, { deps: [v.n] });
  const [type, setType] = useState('');
  const audit = useApi(`/api/audit${v.qDataset}${v.qDataset ? '&' : '?'}limit=200${type ? `&type=${type}` : ''}`, { deps: [v.n] });
  const [ack, setAck] = useState(null);
  return (
    <>
      <Card title="Alert center">
        <Async res={alerts}>
          {(d) => (<>
            <Notice tone="info" title="Refresh-based:">{d.notice} Last evaluated {fmtDateTime(d.generatedAt)}.</Notice>
            {d.alerts.length === 0 && <Empty title="No alerts">Nothing exceeds the configured thresholds.</Empty>}
            {d.alerts.map((a) => (
              <Notice key={a.id} tone={SEV[a.severity]} title={`${a.title}${a.acknowledged ? ' (acknowledged)' : ''}`}>
                {a.detail} {a.acknowledged && <em>Reason: {a.acknowledgedReason}</em>}
                {!a.acknowledged && v.canWrite && a.severity !== 'info' && <> <button className="btn small" onClick={() => setAck(a)}>Acknowledge</button></>}
              </Notice>
            ))}
            <details><summary>Thresholds in use</summary><pre className="formula">{JSON.stringify(d.rules, null, 2)}</pre><p className="muted small">Change thresholds with PUT /api/settings (alertRules); changes are recorded in the log below.</p></details>
          </>)}
        </Async>
      </Card>
      <Card title="Audit log" subtitle="Newest first. Campaign changes, AI suggestions, accept/reject decisions and the reasons entered by people." actions={<>
        <label className="field inline"><span className="sr">Filter by type</span>
          <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by type"><option value="">All types</option>{['campaign_change', 'ai_suggestion', 'recommendation_accepted', 'recommendation_rejected', 'spend_recorded', 'budget_plan_changed', 'experiment_created', 'experiment_status', 'ambassador_created', 'ambassador_status', 'content_draft_saved', 'content_approved', 'alert_ack', 'demo_loaded'].map((t) => <option key={t}>{t}</option>)}</select></label>
        <ExportButton path={`/api/audit/export.csv${v.qDataset}`} /></>}>
        <Async res={audit} emptyIf={(d) => d.items.length === 0} empty={<Empty title="No activity yet">Actions such as changing settings, recording spend, or deciding on a recommendation will appear here.</Empty>}>
          {(d) => (
            <ol className="timeline" aria-label="Audit log">
              {d.items.map((x) => (
                <li key={x.id}>
                  <div className="row"><strong>{x.summary}</strong><Badge kind="fallback">{x.type}</Badge></div>
                  <div className="muted small">{fmtDateTime(x.ts)} · {x.actor}{x.reason && <> · <em>“{x.reason}”</em></>}</div>
                </li>
              ))}
            </ol>
          )}
        </Async>
      </Card>
      {ack && <ReasonPrompt title={`Acknowledge: ${ack.title}`} onCancel={() => setAck(null)} onConfirm={async (reason) => { await api.post(`/api/alerts/ack${v.qDataset}`, { alertId: ack.id, reason }); setAck(null); v.refresh(); }}><p className="small">{ack.detail}</p></ReasonPrompt>}
    </>
  );
}
