import { useView } from '../view.js';
import { Async, Badge, Card, Empty, ExportButton, Notice, Stat, Table, useApi } from '../components/ui.jsx';
import { DailyChart, FunnelChart } from '../components/charts.jsx';
import { fmtDay, fmtINR, fmtNum, fmtPct } from '../lib/format.js';

export default function Overview() {
  const v = useView();
  const res = useApi(`/api/overview${v.q}`, { deps: [v.n] });
  return (
    <Async res={res}>
      {(d) => {
        const f = d.forecast;
        const empty = d.totals.registrationsAllTime === 0;
        return (
          <>
            {empty && <Empty title="No registrations recorded yet">Share the tagged public link (see Content Studio) or switch to Demo mode to explore the dashboard with simulated data.</Empty>}
            <div className="grid g4" style={{ margin: '1rem 0' }}>
              <Stat label={<>Registrations <Badge kind="actual" /></>} value={fmtNum(d.totals.registrations)} hint={d.filters.channel !== 'all' || d.filters.from || d.filters.to ? 'filtered view' : 'all time'} />
              <Stat label={<>Target <Badge kind="target" /></>} value={fmtNum(d.campaign.target)} hint={`${fmtPct(f.totals.attainment)} attained (all channels)`} />
              <Stat label="Needed per day" value={f.totals.requiredPerDay === null ? '—' : fmtNum(Math.ceil(f.totals.requiredPerDay))} hint={`${f.campaign.remainingDays} day(s) left`} tone={f.scenarios && f.totals.requiredPerDay > f.stats.meanDaily * 1.15 ? 'bad' : ''} />
              <Stat label="Visit → registration" value={fmtPct(d.totals.visitToRegRate)} hint={`${fmtNum(d.totals.visitors)} visits`} />
              <Stat label={<>Spend <Badge kind="actual" /></>} value={fmtINR(d.budget.actualTotalINR)} hint={`${fmtINR(d.budget.remainingINR)} left of ${fmtINR(d.budget.capINR)}`} tone={d.budget.overCap ? 'bad' : ''} />
              <Stat label="Cost / registration" value={fmtINR(d.budget.blendedCostPerRegistrationINR, true)} hint="actual spend ÷ all registrations" />
              <Stat label="Open alerts" value={(d.alertCounts.critical || 0) + (d.alertCounts.warning || 0)} hint={`evaluated at ${new Date(d.generatedAt).toLocaleTimeString('en-IN')} (on refresh)`} tone={d.alertCounts.critical ? 'bad' : ''} />
              <Stat label="Base projection" value={f.scenarios ? fmtNum(f.scenarios.base.projectedTotal) : 'n/a'} hint={f.scenarios ? <Badge kind="estimate" /> : 'insufficient data'} />
            </div>
            <div className="grid g2">
              <Card title="Registrations per day" subtitle={`${fmtDay(d.daily[0]?.day)} – ${fmtDay(d.daily[d.daily.length - 1]?.day)}`} actions={<ExportButton path={`/api/registrations/export.csv${v.q}`} />}>
                <DailyChart data={d.daily} />
              </Card>
              <Card title="Funnel" subtitle="Filtered by the same date/channel selection"><FunnelChart stages={d.funnel.stages} /></Card>
            </div>
            <Card title="Channels" subtitle="Registrations, visits and actual spend in the selected view" actions={<ExportButton path={`/api/attribution/export.csv${v.q}`} />}>
              <Table caption="Channel performance" empty="No channel data in this view." rows={d.channels.map((c) => ({ ...c, id: c.channel }))} columns={[
                { key: 'channel', label: 'Channel' }, { key: 'visitors', label: 'Visits', num: true, render: (r) => fmtNum(r.visitors) }, { key: 'registrations', label: 'Registrations', num: true },
                { key: 'visitToRegRate', label: 'Visit→Reg', num: true, render: (r) => fmtPct(r.visitToRegRate) }, { key: 'spendINR', label: 'Actual spend', num: true, render: (r) => fmtINR(r.spendINR) },
                { key: 'cpr', label: 'Cost / reg', num: true, render: (r) => fmtINR(r.costPerRegistrationINR, true) }]} />
            </Card>
            {d.forecast.warnings.length > 0 && <Notice tone="warn" title="Forecast note:">{d.forecast.warnings[0]}</Notice>}
          </>
        );
      }}
    </Async>
  );
}
