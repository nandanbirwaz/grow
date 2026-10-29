import { useState } from 'react';
import { api } from '../api.js';
import { useView } from '../view.js';
import { Async, Badge, Card, Empty, ExportButton, Field, Notice, ReasonPrompt, Stat, Table, useApi } from '../components/ui.jsx';
import { DailyChart } from '../components/charts.jsx';
import { fmtNum, fmtPct } from '../lib/format.js';

function Report({ amb, qDataset, onClose }) {
  const res = useApi(`/api/referrals/ambassadors/${amb.ambassadorId}/report${qDataset}`);
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label={`Report for ${amb.displayName}`}>
      <div className="modal" style={{ width: 'min(640px,100%)' }}>
        <h3>{amb.displayName} <span className="muted small">{amb.code}</span></h3>
        <Async res={res}>{(r) => (<>
          <div className="grid g3"><Stat label="Points" value={r.totals.points} /><Stat label="Counted" value={r.totals.valid} /><Stat label="Not counted" value={r.totals.rejected} /><Stat label="Submitted" value={r.totals.submitted} /></div>
          <DailyChart data={r.validByDay} label="Counted referrals per day" />
          <Table caption="By status" rows={Object.entries(r.byStatus).map(([k, n]) => ({ id: k, status: k, n }))} columns={[{ key: 'status', label: 'Status' }, { key: 'n', label: 'Count', num: true }]} />
          <Notice>{r.privacy}</Notice></>)}</Async>
        <div className="row end"><button className="btn" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

export default function Referrals() {
  const v = useView();
  const res = useApi(`/api/referrals${v.qDataset}`, { deps: [v.n] });
  const [adding, setAdding] = useState(false); const [name, setName] = useState(''); const [email, setEmail] = useState('');
  const [report, setReport] = useState(null); const [toggle, setToggle] = useState(null); const [created, setCreated] = useState(null);
  return (
    <Async res={res}>
      {(d) => (
        <>
          <div className="grid g3" style={{ marginBottom: '1rem' }}>
            <Stat label="Employees / ambassadors" value={d.leaderboard.length} /><Stat label="Points awarded" value={d.totals.points} hint={`${d.rules.pointsPerReferral} point per counted registration`} /><Stat label="Counted referrals" value={d.totals.valid} /><Stat label="Referred submissions" value={d.totals.referredSubmissions} hint="incl. not counted" />
          </div>
          {created && <Notice tone="ok" title={`Code created for ${created.displayName}:`}><code>{created.code}</code> — share <code>{created.link}</code>. Students can use the link or type the code on the registration form.</Notice>}
          <Card title="Points leaderboard" subtitle="Ranked by points (1 point per counted registration). No registrant contact data is shown anywhere." actions={<><ExportButton path={`/api/referrals/export.csv${v.qDataset}`} />{v.canWrite && <button className="btn primary small" onClick={() => setAdding(true)}>Add employee</button>}</>}>
            {d.leaderboard.length === 0 ? <Empty title="No employees yet">{v.canWrite ? 'Add an employee to generate their unique referral code and link. They earn points when students register with it.' : 'An admin can add ambassadors.'}</Empty> : (
              <Table caption="Ambassador leaderboard" rows={d.leaderboard.map((r) => ({ ...r, id: r.ambassadorId }))} columns={[
                { key: 'rank', label: '#', num: true }, { key: 'displayName', label: 'Ambassador', render: (r) => <>{r.displayName} {r.status !== 'active' && <Badge kind="fallback">{r.status}</Badge>}</> }, { key: 'code', label: 'Code' },
                { key: 'points', label: 'Points', num: true, render: (r) => <strong>{r.points}</strong> }, { key: 'validReferrals', label: 'Counted registrations', num: true }, { key: 'rejectedReferrals', label: 'Not counted', num: true }, { key: 'validRate', label: 'Counted rate', num: true, render: (r) => fmtPct(r.validRate, 0) },
                { key: 'a', label: '', render: (r) => (<span className="row"><button className="btn small" onClick={() => setReport(r)}>Report</button>{v.canWrite && <button className="btn small" onClick={() => setToggle(r)}>{r.status === 'active' ? 'Pause' : 'Activate'}</button>}</span>) }]} />
            )}
          </Card>
          {d.spikes.length > 0 && <Notice tone="warn" title="Unusual bursts:">{d.spikes.map((s) => `${s.displayName}: ${s.count} sign-ups in the hour of ${s.hour}:00`).join(' · ')}. A burst is a heuristic — review before acting.</Notice>}
          <div className="grid g2">
            <Card title="Attribution rules (configurable in settings)"><ul>{d.ruleExplanations.map((r) => <li key={r}>{r}</li>)}</ul></Card>
            <Card title="Status legend"><Table caption="Referral statuses" rows={Object.entries(d.statusLegend).map(([k, t]) => ({ id: k, k, t }))} columns={[{ key: 'k', label: 'Status' }, { key: 't', label: 'Meaning' }]} /></Card>
          </div>
          {adding && (
            <ReasonPrompt title="Add employee / ambassador" confirmLabel="Create code" onCancel={() => setAdding(false)} onConfirm={async (reason) => { const r = await api.post(`/api/referrals/ambassadors${v.qDataset}`, { displayName: name, email: email || undefined, reason }); setCreated({ displayName: r.ambassador.displayName, code: r.ambassador.code, link: `${window.location.origin}/?ref=${r.ambassador.code}` }); setAdding(false); setName(''); setEmail(''); v.refresh(); }}>
              <Field label="Employee name (shown on the leaderboard)" id="an"><input id="an" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></Field>
              <Field label="Employee’s own email (optional)" id="ae" hint="Used only to block self-referrals; stored as a one-way hash."><input id="ae" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            </ReasonPrompt>
          )}
          {toggle && <ReasonPrompt title={`${toggle.status === 'active' ? 'Pause' : 'Activate'} ${toggle.displayName}`} onCancel={() => setToggle(null)} onConfirm={async (reason) => { await api.put(`/api/referrals/ambassadors/${toggle.ambassadorId}/status${v.qDataset}`, { status: toggle.status === 'active' ? 'paused' : 'active', reason }); setToggle(null); v.refresh(); }}><p className="small">Paused codes stop counting new referrals; past referrals remain.</p></ReasonPrompt>}
          {report && <Report amb={report} qDataset={v.qDataset} onClose={() => setReport(null)} />}
        </>
      )}
    </Async>
  );
}
export { fmtNum };
