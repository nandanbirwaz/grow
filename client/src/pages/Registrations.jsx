import { useState } from 'react';
import { useView } from '../view.js';
import { Async, Card, Empty, ExportButton, Notice, Table, useApi } from '../components/ui.jsx';
import { DailyChart } from '../components/charts.jsx';
import { fmtDateTime } from '../lib/format.js';

const PAGE = 25;
export default function Registrations() {
  const v = useView();
  const [offset, setOffset] = useState(0);
  const sep = v.q ? '&' : '?';
  const res = useApi(`/api/registrations${v.q}${sep}limit=${PAGE}&offset=${offset}`, { deps: [v.n] });
  return (
    <Async res={res} emptyIf={(d) => d.total === 0 && offset === 0} empty={<Empty title="No registrations in this view">Try clearing the filters, or load demo data.</Empty>}>
      {(d) => (
        <>
          <Notice>{d.note}</Notice>
          <Card title="Daily registrations" actions={<ExportButton path={`/api/registrations/export.csv${v.q}`} />}><DailyChart data={d.daily} /></Card>
          <Card title={`Registrations (${d.total})`} subtitle="Newest first. Contact details are masked.">
            <Table caption="Registrations" rows={d.items} columns={[
              { key: 'createdAt', label: 'Registered', render: (r) => fmtDateTime(r.createdAt) }, { key: 'contact', label: 'Contact' }, { key: 'college', label: 'College' },
              { key: 'channel', label: 'Channel' }, { key: 'campaign', label: 'Campaign' }, { key: 'content', label: 'Content' }, { key: 'variant', label: 'Variant' },
              { key: 'referralStatus', label: 'Referral', render: (r) => (r.referralCode ? `${r.referralCode} · ${r.referralStatus}` : '—') }]} />
            <div className="row end" style={{ marginTop: '.6rem' }}>
              <span className="muted small">{offset + 1}–{Math.min(offset + PAGE, d.total)} of {d.total}</span>
              <button className="btn small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
              <button className="btn small" disabled={offset + PAGE >= d.total} onClick={() => setOffset(offset + PAGE)}>Next</button>
            </div>
          </Card>
        </>
      )}
    </Async>
  );
}
