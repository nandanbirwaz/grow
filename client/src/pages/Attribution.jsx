import { useView } from '../view.js';
import { Async, Card, ExportButton, Notice, Table, useApi } from '../components/ui.jsx';
import { FunnelChart, HBars } from '../components/charts.jsx';
import { fmtINR, fmtNum, fmtPct } from '../lib/format.js';

export default function Attribution() {
  const v = useView();
  const res = useApi(`/api/attribution${v.q}`, { deps: [v.n] });
  return (
    <Async res={res}>
      {(d) => (
        <>
          <div className="grid g2">
            <Card title="Conversion funnel" actions={<ExportButton path={`/api/attribution/export.csv${v.q}${v.q ? '&' : '?'}report=funnel`} label="Funnel CSV" />}>
              <FunnelChart stages={d.funnel.stages} />
              <p className="small">Overall visit → registration: <strong>{fmtPct(d.funnel.overallRate)}</strong></p>
              {d.funnel.notes.map((n) => <p key={n} className="muted small">{n}</p>)}
            </Card>
            <Card title="Registrations by channel" actions={<ExportButton path={`/api/attribution/export.csv${v.q}`} label="Channel CSV" />}>
              {d.channels.length ? <HBars rows={d.channels} labelKey="channel" valueKey="registrations" /> : <p className="muted">No channel data in this view.</p>}
            </Card>
          </div>
          <Card title="Channel report">
            <Table caption="Channel report" empty="No data in this view." rows={d.channels.map((c) => ({ ...c, id: c.channel }))} columns={[
              { key: 'channel', label: 'Channel' }, { key: 'visitors', label: 'Visits', num: true, render: (r) => fmtNum(r.visitors) }, { key: 'ctaClicks', label: 'CTA clicks', num: true },
              { key: 'starts', label: 'Starts', num: true }, { key: 'registrations', label: 'Registrations', num: true }, { key: 'share', label: 'Share', num: true, render: (r) => fmtPct(r.share) },
              { key: 'visitToRegRate', label: 'Visit→Reg', num: true, render: (r) => fmtPct(r.visitToRegRate) }, { key: 'spendINR', label: 'Actual spend', num: true, render: (r) => fmtINR(r.spendINR) }]} />
          </Card>
          <div className="grid g2">
            <Card title="By campaign (utm_campaign)"><Table caption="By campaign" rows={d.byCampaign.map((r) => ({ ...r, id: r.name }))} columns={[{ key: 'name', label: 'Campaign' }, { key: 'registrations', label: 'Registrations', num: true }]} /></Card>
            <Card title="By content (utm_content)"><Table caption="By content" rows={d.byContent.map((r) => ({ ...r, id: r.name }))} columns={[{ key: 'name', label: 'Content' }, { key: 'registrations', label: 'Registrations', num: true }]} /></Card>
          </div>
          <Card title="How attribution works">
            <ul>{d.rules.map((r) => <li key={r}>{r}</li>)}</ul>
            <Notice tone="warn" title="Limitations">
              <ul style={{ margin: '.3rem 0 0' }}>{d.limitations.map((r) => <li key={r}>{r}</li>)}</ul>
            </Notice>
          </Card>
        </>
      )}
    </Async>
  );
}
