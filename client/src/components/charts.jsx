import { fmtDay, fmtNum } from '../lib/format.js';

const C = { bar: 'var(--c1)', line: 'var(--c1)', ref: 'var(--c3)', band: 'var(--c1-soft)', axis: 'var(--muted)' };
const nice = (max) => { if (max <= 5) return 5; const p = 10 ** Math.floor(Math.log10(max)); return Math.ceil(max / p) * p; };

/** Daily columns with optional target line. Fully data-driven; includes an accessible table fallback via title/desc. */
export function DailyChart({ data, target, label = 'Registrations per day' }) {
  if (!data.length) return <p className="muted">No days in range.</p>;
  const W = 640; const H = 220; const m = { t: 12, r: 12, b: 28, l: 38 };
  const max = nice(Math.max(1, ...data.map((d) => d.count), target || 0));
  const bw = (W - m.l - m.r) / data.length;
  const y = (v) => H - m.b - (v / max) * (H - m.t - m.b);
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  const step = Math.ceil(data.length / 8);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="chart">
      <title>{label}</title><desc>{data.map((d) => `${d.day}: ${d.count}`).join('; ')}</desc>
      {ticks.map((t) => <g key={t}><line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" /><text x={m.l - 6} y={y(t) + 4} textAnchor="end" fill={C.axis} fontSize="11">{fmtNum(t)}</text></g>)}
      {data.map((d, i) => (
        <g key={d.day}>
          <rect x={m.l + i * bw + bw * 0.15} y={y(d.count)} width={bw * 0.7} height={Math.max(0, H - m.b - y(d.count))} fill={C.bar} rx="2"><title>{`${fmtDay(d.day)}: ${d.count}`}</title></rect>
          {i % step === 0 && <text x={m.l + i * bw + bw / 2} y={H - 8} textAnchor="middle" fill={C.axis} fontSize="11">{fmtDay(d.day)}</text>}
        </g>
      ))}
    </svg>
  );
}

/** Cumulative actual + scenario lines to the end of the campaign. */
export function ForecastChart({ forecast }) {
  const { dailySeries, scenarios, campaign } = forecast;
  const total = campaign.durationDays;
  const W = 640; const H = 240; const m = { t: 12, r: 16, b: 28, l: 44 };
  let acc = 0; const actual = dailySeries.map((d, i) => { acc += d.count; return { i: i + 1, v: acc }; });
  const done = actual.length ? actual[actual.length - 1] : { i: 0, v: 0 };
  const lines = scenarios ? Object.entries(scenarios).map(([k, s]) => ({ k, label: s.label, pts: [{ i: done.i, v: done.v }, { i: total, v: s.projectedTotal }] })) : [];
  const max = nice(Math.max(campaign.target, done.v, ...lines.map((l) => l.pts[1].v)) * 1.05);
  const x = (i) => m.l + (i / total) * (W - m.l - m.r);
  const y = (v) => H - m.b - (v / max) * (H - m.t - m.b);
  const path = (pts) => pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i)},${y(p.v)}`).join(' ');
  const dash = { conservative: '4 4', base: '', optimistic: '1 4' };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Cumulative registrations with target and projected scenarios" className="chart">
      <title>Cumulative registrations vs target</title>
      <desc>{`Target ${campaign.target}. Registered so far ${done.v}. ${lines.map((l) => `${l.label} projects ${l.pts[1].v}`).join('; ')}`}</desc>
      {[0, 0.5, 1].map((f) => <g key={f}><line x1={m.l} x2={W - m.r} y1={y(max * f)} y2={y(max * f)} stroke="var(--grid)" /><text x={m.l - 6} y={y(max * f) + 4} textAnchor="end" fill={C.axis} fontSize="11">{fmtNum(Math.round(max * f))}</text></g>)}
      <line x1={m.l} x2={W - m.r} y1={y(campaign.target)} y2={y(campaign.target)} stroke={C.ref} strokeWidth="1.5" strokeDasharray="6 3" />
      <text x={W - m.r} y={y(campaign.target) - 4} textAnchor="end" fill={C.ref} fontSize="11">Target {campaign.target}</text>
      {actual.length > 0 && <path d={path([{ i: 0, v: 0 }, ...actual])} fill="none" stroke={C.line} strokeWidth="2.5" />}
      {lines.map((l) => <path key={l.k} d={path(l.pts)} fill="none" stroke={l.k === 'base' ? 'var(--c2)' : 'var(--c2-soft)'} strokeWidth={l.k === 'base' ? 2.5 : 2} strokeDasharray={dash[l.k]} />)}
      {Array.from({ length: total + 1 }, (_, i) => <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fill={C.axis} fontSize="11">{i === 0 ? '' : `D${i}`}</text>)}
    </svg>
  );
}

export function Legend({ items }) {
  return <ul className="legend">{items.map((i) => <li key={i.label}><svg width="22" height="10" aria-hidden="true"><line x1="0" x2="22" y1="5" y2="5" stroke={i.color} strokeWidth="3" strokeDasharray={i.dash || ''} /></svg>{i.label}</li>)}</ul>;
}

/** Horizontal funnel bars (relative to the first stage). */
export function FunnelChart({ stages }) {
  const top = Math.max(1, stages[0]?.count || 0, ...stages.map((s) => s.count));
  return (
    <ol className="funnel" aria-label="Conversion funnel">
      {stages.map((s) => (
        <li key={s.type}>
          <div className="funnel-row"><span>{s.label}</span><strong>{fmtNum(s.count)}</strong></div>
          <div className="bar-bg" aria-hidden="true"><div className="bar" style={{ width: `${Math.min(100, (s.count / top) * 100)}%` }} /></div>
          {s.stepRate !== null && <small className="muted">{(s.stepRate * 100).toFixed(1)}% of previous stage · {fmtNum(s.dropOff)} fewer</small>}
        </li>
      ))}
    </ol>
  );
}

export function HBars({ rows, valueKey, labelKey, format = fmtNum }) {
  const max = Math.max(1, ...rows.map((r) => r[valueKey] || 0));
  return (
    <ul className="hbars">
      {rows.map((r) => (
        <li key={r[labelKey]}><span className="hb-l">{r[labelKey]}</span><div className="bar-bg" aria-hidden="true"><div className="bar" style={{ width: `${((r[valueKey] || 0) / max) * 100}%` }} /></div><span className="hb-v">{format(r[valueKey])}</span></li>
      ))}
    </ul>
  );
}

/** Conversion rate with 95% CI whiskers for variants. */
export function CiChart({ variants }) {
  const hi = Math.max(0.05, ...variants.map((v) => v.ci95?.high || v.conversionRate || 0)) * 1.1;
  const W = 520; const rowH = 38; const l = 90; const r = 20;
  const x = (v) => l + (v / hi) * (W - l - r);
  return (
    <svg viewBox={`0 0 ${W} ${variants.length * rowH + 28}`} role="img" aria-label="Conversion rate by variant with 95% confidence intervals" className="chart">
      <title>Conversion rate with 95% confidence interval</title>
      <desc>{variants.map((v) => `${v.variant}: ${((v.conversionRate || 0) * 100).toFixed(1)}%`).join('; ')}</desc>
      {variants.map((v, i) => {
        const cy = i * rowH + 20;
        return (
          <g key={v.variant}>
            <text x={l - 8} y={cy + 4} textAnchor="end" fontSize="12" fill="var(--text)">{v.variant}</text>
            {v.ci95 && <line x1={x(v.ci95.low)} x2={x(v.ci95.high)} y1={cy} y2={cy} stroke="var(--c2)" strokeWidth="3" strokeLinecap="round" />}
            {v.conversionRate !== null && <circle cx={x(v.conversionRate)} cy={cy} r="5" fill="var(--c1)" />}
          </g>
        );
      })}
      <text x={l} y={variants.length * rowH + 22} fontSize="11" fill={C.axis}>0%</text>
      <text x={W - r} y={variants.length * rowH + 22} fontSize="11" textAnchor="end" fill={C.axis}>{(hi * 100).toFixed(0)}%</text>
    </svg>
  );
}
