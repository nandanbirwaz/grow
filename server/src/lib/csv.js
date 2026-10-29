/**
 * CSV serialisation with spreadsheet-formula-injection protection:
 * any cell starting with = + - @ TAB or CR is prefixed with an apostrophe (numbers are left alone).
 */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'number' ? String(value) : String(value);
  if (typeof value !== 'number' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** columns: [{key, label}] ; rows: array of objects */
export function toCsv(rows, columns) {
  const header = columns.map((c) => csvCell(c.label)).join(',');
  const lines = rows.map((r) => columns.map((c) => csvCell(r[c.key])).join(','));
  return `${[header, ...lines].join('\r\n')}\r\n`;
}
