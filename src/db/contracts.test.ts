import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrate, openDb } from './index.ts';
import { existingKeys, finishRun, lastRun, lastRunByKind, lastSuccessRun, listContracts, startRun, upsertContracts, type ContractRow } from './contracts.ts';

const row = (over: Partial<ContractRow> = {}): ContractRow => ({
  untyNo: 'R26TE00000001', companyId: 'sparrow', companyName: '주식회사 스패로우', bizNo: '1234567890',
  contractName: '보안 소프트웨어 구매', signedDate: '2026-10-21', registeredAt: '2026-10-21 09:30:00', amount: 1_000_000,
  contractOrg: '조달청', demanderName: '각 수요기관', demanderPlaceholder: true, method: '제3자단가계약',
  productIds: ['26181128'], productNames: ['플랫폼 Standard'], verified: true, idConflict: false, ...over,
});

const fresh = () => {
  const db = openDb(':memory:');
  migrate(db);
  return db;
};

test('마이그레이션이 계약 · 수집 실행 테이블을 만들고 두 번 돌려도 안전하다', () => {
  const db = openDb(':memory:');
  assert.equal(migrate(db).length, 6);
  assert.deepEqual(migrate(db), []);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r['name']);
  assert.ok(tables.includes('contracts') && tables.includes('collect_runs'));
});

test('저장하고 그대로 읽는다 (배열 · 불리언 · 빈 금액 포함)', () => {
  const db = fresh();
  upsertContracts(db, [row(), row({ untyNo: 'R26TE00000002', amount: null, productIds: [], productNames: [], verified: false, demanderPlaceholder: false })], '2026-10-29T00:00:00Z');
  const all = listContracts(db, { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(all.length, 2);
  assert.deepEqual(all.find((r) => r.untyNo === 'R26TE00000001'), row());
  const second = all.find((r) => r.untyNo === 'R26TE00000002');
  assert.equal(second?.amount, null);
  assert.deepEqual(second?.productIds, []);
  assert.equal(second?.verified, false);
});

test('같은 계약 · 업체를 다시 저장하면 갱신되고 중복 행이 생기지 않는다', () => {
  const db = fresh();
  upsertContracts(db, [row()], '2026-10-29T00:00:00Z');
  upsertContracts(db, [row({ amount: 2_000_000, contractName: '변경됨' })], '2026-10-30T00:00:00Z');
  const all = listContracts(db, { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(all.length, 1);
  assert.equal(all[0]?.amount, 2_000_000);
  assert.equal(all[0]?.contractName, '변경됨');
});

test('같은 계약에 업체가 둘이면(공동수급) 행이 둘이다', () => {
  const db = fresh();
  upsertContracts(db, [row(), row({ companyId: 'ssr', companyName: '(주)에스에스알' })], '2026-10-29T00:00:00Z');
  assert.equal(listContracts(db, { from: '2026-10-01', to: '2026-10-31' }).length, 2);
});

test('기간 · 업체로 거르고 체결일자 내림차순으로 정렬한다 (양끝 포함)', () => {
  const db = fresh();
  upsertContracts(db, [
    row({ untyNo: 'A', signedDate: '2026-10-01' }),
    row({ untyNo: 'B', signedDate: '2026-10-31', companyId: 'ssr' }),
    row({ untyNo: 'C', signedDate: '2026-11-01' }),
    row({ untyNo: 'D', signedDate: '2026-09-30' }),
  ], '2026-10-29T00:00:00Z');
  assert.deepEqual(listContracts(db, { from: '2026-10-01', to: '2026-10-31' }).map((r) => r.untyNo), ['B', 'A']);
  assert.deepEqual(listContracts(db, { from: '2026-10-01', to: '2026-10-31', companyId: 'sparrow' }).map((r) => r.untyNo), ['A']);
  assert.deepEqual(listContracts(db, { from: '2026-12-01', to: '2026-12-31' }), []);
});

test('저장 중 오류가 나면 일부만 저장되지 않는다 (한 트랜잭션)', () => {
  const db = fresh();
  const bad = row({ untyNo: 'BAD', signedDate: null as unknown as string });
  assert.throws(() => upsertContracts(db, [row(), bad], '2026-10-29T00:00:00Z'));
  assert.deepEqual(listContracts(db, { from: '2026-01-01', to: '2026-12-31' }), []);
});

test('수집 실행 기록: 시작 → 성공 / 실패 메시지, 가장 최근 것을 읽는다', () => {
  const db = fresh();
  assert.equal(lastRun(db), null);
  const id1 = startRun(db, '2026-01-01', '2026-10-28', '2026-10-29T00:00:00Z');
  finishRun(db, id1, { status: 'success', fetched: 420, matched: 11, calls: 21, error: null }, '2026-10-29T00:01:00Z');
  const id2 = startRun(db, '2026-10-01', '2026-10-28', '2026-10-30T00:00:00Z');
  assert.equal(lastRun(db)?.status, 'running');
  finishRun(db, id2, { status: 'failed', fetched: 10, matched: 0, calls: 3, error: '나라장터 API 호출 실패: boom' }, '2026-10-30T00:00:10Z');
  assert.deepEqual(lastRun(db), {
    id: id2, startedAt: '2026-10-30T00:00:00Z', finishedAt: '2026-10-30T00:00:10Z', rangeFrom: '2026-10-01', rangeTo: '2026-10-28',
    status: 'failed', fetched: 10, matched: 0, calls: 3, error: '나라장터 API 호출 실패: boom', kind: 'backfill', note: null,
  });
});

test('실행 종류(backfill · daily · verify)와 메모를 기록하고, 종류별 최근 기록 · 마지막 성공 기록을 읽는다', () => {
  const db = fresh();
  assert.deepEqual(lastRunByKind(db), {});
  assert.equal(lastSuccessRun(db, 'daily'), null);
  const ok = { status: 'success' as const, fetched: 1, matched: 1, calls: 5, error: null };
  const d1 = startRun(db, '2026-10-28', '2026-10-28', '2026-10-29T00:00:00Z', 'daily');
  finishRun(db, d1, ok, '2026-10-29T00:01:00Z');
  const d2 = startRun(db, '2026-10-29', '2026-10-29', '2026-10-30T00:00:00Z', 'daily');
  finishRun(db, d2, { ...ok, status: 'failed', error: 'boom' }, '2026-10-30T00:00:30Z');
  const v = startRun(db, '2026-10-16', '2026-10-29', '2026-10-30T01:00:00Z', 'verify');
  finishRun(db, v, { ...ok, note: '교차 검증: 새로 찾은 계약 2건' }, '2026-10-30T01:01:00Z');
  const byKind = lastRunByKind(db);
  assert.equal(byKind.daily?.id, d2);
  assert.equal(byKind.daily?.status, 'failed');
  assert.equal(byKind.verify?.note, '교차 검증: 새로 찾은 계약 2건');
  assert.equal(byKind.backfill, undefined);
  assert.equal(lastSuccessRun(db, 'daily')?.rangeTo, '2026-10-28');
  assert.equal(lastRun(db)?.kind, 'verify');
});

test('existingKeys는 이미 저장된 (통합계약번호, 업체 id)만 돌려준다', () => {
  const db = fresh();
  upsertContracts(db, [row({ untyNo: 'A', companyId: 'sparrow' }), row({ untyNo: 'A', companyId: 'ssr' })], '2026-10-29T00:00:00Z');
  const keys = existingKeys(db, [
    { untyNo: 'A', companyId: 'sparrow' }, { untyNo: 'A', companyId: 'nilesoft' }, { untyNo: 'B', companyId: 'sparrow' },
  ]);
  assert.deepEqual([...keys], ['A|sparrow']);
});
