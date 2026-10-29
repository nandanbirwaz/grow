import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiFailure, downloadCsv } from '../api.js';

/** Fetch hook with loading / error / refresh. `path` null = skip. */
export function useApi(path, { deps = [] } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: Boolean(path) });
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const my = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const { api } = await import('../api.js');
      const data = await api.get(path);
      if (my === seq.current) setState({ data, error: null, loading: false });
    } catch (e) {
      if (my === seq.current) setState({ data: null, error: e instanceof ApiFailure ? e.message : 'Network error', loading: false });
    }
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, reload: load };
}

export function Loading({ label = 'Loading…' }) {
  return <div className="state" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" />{label}</div>;
}
export function ErrorState({ message, onRetry }) {
  return <div className="state error" role="alert"><strong>Couldn’t load this.</strong> {message}{onRetry && <button className="btn small" onClick={onRetry}>Retry</button>}</div>;
}
export function Empty({ title, children }) {
  return <div className="state empty"><strong>{title}</strong><p>{children}</p></div>;
}
export function Async({ res, children, emptyIf, empty }) {
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorState message={res.error} onRetry={res.reload} />;
  if (!res.data) return null;
  if (emptyIf && emptyIf(res.data)) return empty;
  return children(res.data);
}

export const Card = ({ title, subtitle, actions, children, className = '' }) => (
  <section className={`card ${className}`}>
    {(title || actions) && <header className="card-h"><div><h3>{title}</h3>{subtitle && <p className="muted small">{subtitle}</p>}</div>{actions && <div className="row">{actions}</div>}</header>}
    {children}
  </section>
);

export const Stat = ({ label, value, hint, tone }) => (
  <div className={`stat ${tone || ''}`}><div className="stat-l">{label}</div><div className="stat-v">{value}</div>{hint && <div className="stat-h">{hint}</div>}</div>
);

const BADGES = { simulated: 'Simulated', recorded: 'Recorded', target: 'Target', estimate: 'Model estimate', actual: 'Actual', ai: 'AI-generated', fallback: 'Rule-based (not AI)' };
export const Badge = ({ kind, children }) => <span className={`badge b-${kind}`}>{children || BADGES[kind]}</span>;

export function Notice({ tone = 'info', title, children }) {
  return <div className={`notice n-${tone}`} role={tone === 'warn' || tone === 'error' ? 'alert' : 'note'}>{title && <strong>{title} </strong>}{children}</div>;
}

export function Table({ columns, rows, caption, empty = 'No rows.' }) {
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label={caption}>
      <table>
        {caption && <caption className="sr">{caption}</caption>}
        <thead><tr>{columns.map((c) => <th key={c.key} scope="col" className={c.num ? 'num' : ''}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={columns.length} className="muted">{empty}</td></tr>}
          {rows.map((r, i) => <tr key={r.id ?? i}>{columns.map((c) => <td key={c.key} className={c.num ? 'num' : ''}>{c.render ? c.render(r) : r[c.key] ?? '—'}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

export function ExportButton({ path, name = 'export.csv', label = 'Export CSV' }) {
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  return (
    <>
      <button className="btn small" disabled={busy} onClick={async () => { setBusy(true); setErr(null); try { await downloadCsv(path, name); } catch (e) { setErr(e.message); } finally { setBusy(false); } }}>
        {busy ? 'Exporting…' : label}
      </button>
      {err && <span className="err small" role="alert">{err}</span>}
    </>
  );
}

export function Field({ label, hint, children, id }) {
  return <label className="field" htmlFor={id}><span>{label}</span>{children}{hint && <small className="muted">{hint}</small>}</label>;
}

/** Collects a human reason before a consequential action. */
export function ReasonPrompt({ title, confirmLabel = 'Confirm', onConfirm, onCancel, required = true, children }) {
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const ok = !required || reason.trim().length >= 3;
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal">
        <h3>{title}</h3>{children}
        <Field label={`Reason${required ? ' (required, recorded in the audit log)' : ''}`} id="reason"><textarea id="reason" rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row end">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn primary" disabled={!ok || busy} onClick={async () => { setBusy(true); setErr(null); try { await onConfirm(reason.trim()); } catch (e) { setErr(e.message); setBusy(false); } }}>{busy ? 'Working…' : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
