const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = new Intl.NumberFormat('en-IN');

export const fmtINR = (n, decimals = false) => (n === null || n === undefined ? '—' : (decimals ? inr2 : inr).format(n));
export const fmtNum = (n) => (n === null || n === undefined ? '—' : num.format(n));
export const fmtPct = (r, d = 1) => (r === null || r === undefined ? '—' : `${(r * 100).toFixed(d)}%`);
export const fmtDay = (day) => {
  if (!day) return '—';
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
};
export const fmtDateTime = (iso) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

/** Build a query string from the dashboard view state. Only non-default values are included. */
export function viewQuery({ dataset, from, to, channel }) {
  const p = new URLSearchParams();
  if (dataset && dataset !== 'live') p.set('dataset', dataset);
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  if (channel && channel !== 'all') p.set('channel', channel);
  const s = p.toString();
  return s ? `?${s}` : '';
}
