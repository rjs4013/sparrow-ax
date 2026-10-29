import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listContracts, lastRun } from '../db/contracts.ts';
import { migrate, openDb } from '../db/index.ts';
import { createMatcher, parseMonitoringConfig } from '../filters/contracts.ts';
import { runCollection } from './run.ts';

const matcher = createMatcher(parseMonitoringConfig({
  categoryCodes: ['43233205'],
  companies: [{ id: 'a', label: '에이', matchNames: ['주식회사 에이'], provisional: false, products: [{ id: '33333333', name: 'A3' }] }],
}));
const page = (items: object[]) => ({ response: { header: { resultCode: '00', resultMsg: '정상' }, body: { items, numOfRows: 999, pageNo: 1, totalCount: items.length } } });
const master = {
  untyCntrctNo: 'R26TE00000001', cntrctNm: '구매', cntrctCnclsDate: '2026-10-21', rgstDt: '2026-10-21 09:30:00', thtmCntrctAmt: '100',
  cntrctInsttNm: '조달청', cntrctCnclsMthdNm: '단가계약', chgDt: '',
  corpList: '[1^법인사업자^단독^주식회사 에이^홍^대한민국^100^주식회사 에이^^1234567890]', dminsttList: '[1^ZZ99999^각 수요기관^중앙행정기관^^^]',
};
const detail = { prdctClsfcNo: '43233205', prdctIdntNo: '33333333', krnPrdctNm: '제품' };
const setup = () => {
  const db = openDb(':memory:');
  migrate(db);
  return db;
};

test('성공하면 계약을 저장하고 실행 기록에 건수와 호출 수를 남긴다', async () => {
  const db = setup();
  const client = { get: async (path: string) => (path.endsWith('Detail') ? page([detail]) : page([master])) };
  const result = await runCollection({ db, client, matcher, range: { from: '2026-10-01', to: '2026-10-28' }, maxCalls: 10, now: () => '2026-10-29T00:00:00Z' });
  assert.equal(result.status, 'success');
  assert.equal(listContracts(db, { from: '2026-10-01', to: '2026-10-31' }).length, 1);
  assert.deepEqual(
    (({ status, fetched, matched, calls, error, rangeFrom, rangeTo }) => ({ status, fetched, matched, calls, error, rangeFrom, rangeTo }))(lastRun(db)!),
    { status: 'success', fetched: 1, matched: 1, calls: 2, error: null, rangeFrom: '2026-10-01', rangeTo: '2026-10-28' },
  );
});

test('수집이 실패하면 아무것도 저장하지 않고 실패와 사유를 기록한다', async () => {
  const db = setup();
  let n = 0;
  const client = {
    get: async (path: string) => {
      n++;
      if (path.endsWith('Detail')) throw new Error('연결 끊김');
      return page([master]);
    },
  };
  const result = await runCollection({
    db, client, matcher, range: { from: '2026-10-01', to: '2026-10-28' }, maxCalls: 10, sleep: async () => {}, now: () => '2026-10-29T00:00:00Z',
  });
  assert.equal(result.status, 'failed');
  assert.deepEqual(listContracts(db, { from: '2026-01-01', to: '2026-12-31' }), []);
  const run = lastRun(db)!;
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /연결 끊김/);
  assert.equal(run.calls, n);
});
