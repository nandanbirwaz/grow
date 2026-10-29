import { useView } from '../view.js';
import { Async, Badge, Card, ExportButton, Notice, Stat, Table, useApi } from '../components/ui.jsx';
import { ForecastChart, Legend } from '../components/charts.jsx';
import { fmtNum, fmtPct } from '../lib/format.js';

export default function Forecasts() {
  const v = useView();
  const res = useApi(`/api/forecast${v.qDataset}`, { deps: [v.n] });
  return (
    <Async res={res}>
      {(f) => (
        <>
          <Notice>{f.filtersNote}</Notice>
          <Notice tone="info" title="What this is:">A transparent run-rate projection — <strong>not</strong> a trained or validated machine-learning model.</Notice>
          {f.warnings.map((w) => <Notice key={w} tone="warn">{w}</Notice>)}
          <div className="grid g4" style={{ margin: '1rem 0' }}>
            <Stat label={<>Registered <Badge kind="actual" /></>} value={fmtNum(f.totals.registrations)} hint={`day ${f.campaign.elapsedDays} of ${f.campaign.durationDays}`} />
            <Stat label={<>Target <Badge kind="target" /></>} value={fmtNum(f.campaign.target)} hint={`${fmtPct(f.totals.attainment)} attained`} />
            <Stat label="Needed per day" value={f.totals.requiredPerDay === null ? '—' : f.totals.requiredPerDay.toFixed(1)} hint={`${fmtNum(f.totals.gap)} to go in ${f.campaign.remainingDays} day(s)`} />
            <Stat label="Current average / day" value={f.stats.meanDaily.toFixed(1)} hint={`last 3 days: ${f.stats.recent3DayMean ?? '—'}`} />
          </div>
          <Card title="Cumulative registrations and scenarios">
            <ForecastChart forecast={f} />
            <Legend items={[{ label: 'Actual', color: 'var(--c1)' }, { label: 'Base projection', color: 'var(--c2)' }, { label: 'Conservative / optimistic', color: 'var(--c2-soft)', dash: '4 4' }, { label: 'Target', color: 'var(--c3)', dash: '6 3' }]} />
          </Card>
          {f.scenarios ? (
            <Card title={<>Scenarios <Badge kind="estimate" /></>} subtitle="Projected final registrations at campaign end" actions={<ExportButton path={`/api/forecast/export.csv${v.qDataset}`} />}>
              <Table caption="Scenarios" rows={Object.entries(f.scenarios).map(([k, s]) => ({ id: k, ...s }))} columns={[
                { key: 'label', label: 'Scenario' }, { key: 'dailyRate', label: 'Daily rate', num: true }, { key: 'projectedTotal', label: 'Projected total', num: true, render: (s) => fmtNum(s.projectedTotal) },
                { key: 'attainment', label: 'Of target', num: true, render: (s) => fmtPct(s.attainment) }, { key: 'onTrack', label: 'Reaches target?', render: (s) => (s.onTrack ? 'Yes' : `No — short by ${fmtNum(s.shortfall)}`) }]} />
              <p className="muted small">Uncertainty: the conservative/optimistic rates are the base rate ∓ 1.28 standard errors (≈80% interval under independence). Real uncertainty is larger — daily counts are correlated and campaigns change.</p>
            </Card>
          ) : <Card title="Scenarios"><p className="muted">Hidden until enough data exists — showing a projection from too few days would be misleading.</p></Card>}
          {f.channelProjection.length > 0 && (
            <Card title="Channel baseline projection" subtitle="Each channel's own run-rate extended to campaign end; channels overlap neither in totals nor causes.">
              <Table caption="Channel projection" rows={f.channelProjection.map((c) => ({ ...c, id: c.channel }))} columns={[{ key: 'channel', label: 'Channel' }, { key: 'registrationsSoFar', label: 'So far', num: true }, { key: 'baselineProjection', label: 'Baseline projection', num: true }]} />
            </Card>
          )}
          <div className="grid g2">
            <Card title="Formulas">{f.formulas.map((x) => <div className="formula" key={x}>{x}</div>)}</Card>
            <Card title="Assumptions"><ul>{f.assumptions.map((x) => <li key={x}>{x}</li>)}</ul></Card>
          </div>
        </>
      )}
    </Async>
  );
}
