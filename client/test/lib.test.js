import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fmtDay, fmtINR, fmtPct, viewQuery } from '../src/lib/format.js';
import { parseAttribution } from '../src/lib/tracking.js';

describe('client formatting', () => {
  it('formats INR with Indian digit grouping', () => {
    assert.match(fmtINR(2000), /₹\s?2,000/);
    assert.match(fmtINR(123456), /₹\s?1,23,456/);
    assert.match(fmtINR(12.5, true), /12\.50/);
    assert.equal(fmtINR(null), '—');
  });
  it('formats percentages and days safely', () => {
    assert.equal(fmtPct(0.1234), '12.3%');
    assert.equal(fmtPct(null), '—');
    assert.equal(fmtDay('2026-10-29'), '29 Oct');
    assert.equal(fmtDay(null), '—');
  });
  it('builds filter queries only from non-default values', () => {
    assert.equal(viewQuery({ dataset: 'live', from: '', to: '', channel: 'all' }), '');
    assert.equal(viewQuery({ dataset: 'demo', from: '2026-10-25', to: '', channel: 'whatsapp' }), '?dataset=demo&from=2026-10-25&channel=whatsapp');
  });
});

describe('client attribution parsing', () => {
  it('captures UTM and referral parameters and drops empties', () => {
    assert.deepEqual(parseAttribution('?utm_source=whatsapp&utm_medium=social&utm_campaign=ai60&utm_content=cs_it-friendly&ref=AMB-ABC234&other=1'),
      { source: 'whatsapp', medium: 'social', campaign: 'ai60', content: 'cs_it-friendly', ref: 'AMB-ABC234' });
    assert.deepEqual(parseAttribution('?utm_source=&foo=bar'), {});
    assert.deepEqual(parseAttribution(''), {});
  });
  it('truncates over-long values', () => {
    assert.equal(parseAttribution(`?utm_source=${'a'.repeat(500)}`).source.length, 80);
  });
});
