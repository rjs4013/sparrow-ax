import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listDeliveries, upsertDeliveries, type DeliveryRow } from './deliveries.ts';
import { migrate, openDb } from './index.ts';

const row = (over: Partial<DeliveryRow> = {}): DeliveryRow => ({
  dlvrReqNo: 'R26TB01997234', chgOrd: 0, prdctSno: '1', companyId: 'nilesoft', companyName: '(주)나일소프트', bizNo: '1234567890',
  receivedDate: '2026-06-08', demanderCode: '1790364', demanderName: '고위공직자범죄수사처', demanderKind: '중앙행정기관',
  productClassNo: '43233205', productClassName: '트랜잭션보안및바이러스보호소프트웨어', productId: '24590125', productName: '웹방화벽',
  unitPrice: 45_500_000, qty: 1, amount: 45_500_000, deadline: '2026-07-08', contractNo: '002461624', contractStyle: '제3자단가계약',
  finalYn: true, incdecQty: 1, incdecAmt: 45_500_000, verified: false, idConflict: false, ...over,
});
const fresh = () => {
  const db = openDb(':memory:');
  migrate(db);
  return db;
};
const q = { from: '2026-06-01', to: '2026-06-30' };

test('0003 마이그레이션이 delivery_requests 테이블을 만든다', () => {
  const db = openDb(':memory:');
  assert.equal(migrate(db).length, 3);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r['name']);
  assert.ok(tables.includes('delivery_requests'));
});

test('저장하고 그대로 읽는다 (빈 값 · 불리언 포함)', () => {
  const db = fresh();
  upsertDeliveries(db, [row(), row({ prdctSno: '2', unitPrice: null, qty: null, amount: null, incdecQty: null, incdecAmt: null, finalYn: false, verified: true, idConflict: true })], '2026-10-29T00:00:00Z');
  const all = listDeliveries(db, q);
  assert.equal(all.length, 2);
  assert.deepEqual(all.find((r) => r.prdctSno === '1'), row());
  const second = all.find((r) => r.prdctSno === '2');
  assert.equal(second?.amount, null);
  assert.equal(second?.finalYn, false);
  assert.equal(second?.idConflict, true);
});

test('같은 키를 다시 저장하면 갱신되고 중복 행이 생기지 않는다', () => {
  const db = fresh();
  upsertDeliveries(db, [row()], '2026-10-29T00:00:00Z');
  upsertDeliveries(db, [row({ amount: 1, productName: '변경됨' })], '2026-10-30T00:00:00Z');
  const all = listDeliveries(db, q);
  assert.equal(all.length, 1);
  assert.equal(all[0]?.amount, 1);
  assert.equal(all[0]?.productName, '변경됨');
});

test('변경 차수가 여럿이면 저장은 모두 하고, 조회는 가장 큰 차수만 보여 준다', () => {
  const db = fresh();
  upsertDeliveries(db, [
    row({ chgOrd: 0, amount: 100 }),
    row({ chgOrd: 2, amount: 300 }),
    row({ chgOrd: 1, amount: 200 }),
    row({ prdctSno: '2', chgOrd: 0, amount: 50 }),
  ], '2026-10-29T00:00:00Z');
  const all = listDeliveries(db, q);
  assert.deepEqual(all.map((r) => [r.prdctSno, r.chgOrd, r.amount]).sort(), [['1', 2, 300], ['2', 0, 50]]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM delivery_requests').get()?.['n'], 4);
});

test('같은 납품요구에 업체가 둘이면 행이 둘이다 (공동수급)', () => {
  const db = fresh();
  upsertDeliveries(db, [row(), row({ companyId: 'ssr', companyName: '(주)에스에스알' })], '2026-10-29T00:00:00Z');
  assert.equal(listDeliveries(db, q).length, 2);
});

test('접수일자 기간(양끝 포함) · 업체로 거르고 최근 접수일자 순으로 정렬한다', () => {
  const db = fresh();
  upsertDeliveries(db, [
    row({ dlvrReqNo: 'A', receivedDate: '2026-06-01' }),
    row({ dlvrReqNo: 'B', receivedDate: '2026-06-30', companyId: 'ssr' }),
    row({ dlvrReqNo: 'C', receivedDate: '2026-07-01' }),
    row({ dlvrReqNo: 'D', receivedDate: '2026-05-31' }),
  ], '2026-10-29T00:00:00Z');
  assert.deepEqual(listDeliveries(db, q).map((r) => r.dlvrReqNo), ['B', 'A']);
  assert.deepEqual(listDeliveries(db, { ...q, companyId: 'nilesoft' }).map((r) => r.dlvrReqNo), ['A']);
  assert.deepEqual(listDeliveries(db, { from: '2026-12-01', to: '2026-12-31' }), []);
});

test('저장 중 오류가 나면 일부만 저장되지 않는다', () => {
  const db = fresh();
  assert.throws(() => upsertDeliveries(db, [row(), row({ dlvrReqNo: 'BAD', receivedDate: null as unknown as string })], '2026-10-29T00:00:00Z'));
  assert.deepEqual(listDeliveries(db, { from: '2026-01-01', to: '2026-12-31' }), []);
});

test('변경본의 접수일자가 다른 달이어도 납품요구는 최초 접수일자의 기간에 남고, 값은 최신 차수의 것이다', () => {
  const db = fresh();
  upsertDeliveries(db, [
    row({ dlvrReqNo: 'C', chgOrd: 0, receivedDate: '2026-05-31', qty: 18, amount: 29_700_000, finalYn: false }),
    row({ dlvrReqNo: 'C', chgOrd: 1, receivedDate: '2026-06-02', qty: 0, amount: 0, incdecQty: -18, incdecAmt: -29_700_000, finalYn: true }),
  ], '2026-10-29T00:00:00Z');
  const may = listDeliveries(db, { from: '2026-05-01', to: '2026-05-31' });
  assert.equal(may.length, 1);
  assert.deepEqual([may[0]?.receivedDate, may[0]?.chgOrd, may[0]?.qty, may[0]?.amount], ['2026-05-31', 1, 0, 0]);
  assert.deepEqual(listDeliveries(db, { from: '2026-06-01', to: '2026-06-30' }), []);
});
