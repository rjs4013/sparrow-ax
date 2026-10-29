import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstNoticeDate, listBids, upsertBids, type BidRow } from './bids.ts';
import { migrate, openDb } from './index.ts';

const row = (over: Partial<BidRow> = {}): BidRow => ({
  bidNtceNo: 'R26BK01000001', bidNtceOrd: '000', title: '소스코드 보안약점 진단 용역', status: '일반공고', workKind: '용역',
  noticeDate: '2026-10-27', noticeTime: '09:30', demanderName: '한국정보보호진흥원', demanderCode: '1234567', noticeOrgName: '한국정보보호진흥원',
  noticeOrgCode: '1234567', estimatedPrice: 90_000_000, budgetAmount: 99_000_000, bidBegin: '2026-10-27 09:30', regClose: '2026-11-03 17:00',
  bidClose: '2026-11-05 10:00', opening: '2026-11-05 11:00', url: 'https://www.g2b.go.kr/pt/menu/selectSubFrame.do?bidno=R26BK01000001',
  contractMethod: '제한경쟁', keywords: ['소스코드', '보안약점'], ...over,
});
const fresh = () => {
  const db = openDb(':memory:');
  migrate(db);
  return db;
};
const q = { from: '2026-10-01', to: '2026-10-31' };

test('0005 마이그레이션이 bid_notices 테이블을 만든다', () => {
  const db = openDb(':memory:');
  assert.equal(migrate(db).length, 6);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r['name']);
  assert.ok(tables.includes('bid_notices'));
});

test('저장하고 그대로 읽는다 (빈 금액 · 빈 일시 · 키워드 배열)', () => {
  const db = fresh();
  upsertBids(db, [row(), row({ bidNtceNo: 'B', estimatedPrice: null, budgetAmount: null, regClose: '', opening: '', url: '', keywords: ['솔루션'] })], '2026-10-29T00:00:00Z');
  const all = listBids(db, q);
  assert.equal(all.length, 2);
  assert.deepEqual(all.find((r) => r.bidNtceNo === 'R26BK01000001'), row());
  const b = all.find((r) => r.bidNtceNo === 'B');
  assert.equal(b?.estimatedPrice, null);
  assert.equal(b?.regClose, '');
  assert.deepEqual(b?.keywords, ['솔루션']);
});

test('같은 (공고번호, 차수)는 갱신되고, 차수가 다르면 별개 행이다', () => {
  const db = fresh();
  upsertBids(db, [row()], '2026-10-29T00:00:00Z');
  upsertBids(db, [row({ status: '정정공고', title: '정정된 제목 소스코드' }), row({ bidNtceOrd: '001', status: '재입찰공고' })], '2026-10-30T00:00:00Z');
  const all = listBids(db, q);
  assert.equal(all.length, 2);
  assert.equal(all.find((r) => r.bidNtceOrd === '000')?.status, '정정공고');
  assert.equal(all.find((r) => r.bidNtceOrd === '001')?.status, '재입찰공고');
});

test('공고일자 기간(양끝 포함)으로 거르고 최근 공고 순으로 정렬한다', () => {
  const db = fresh();
  upsertBids(db, [
    row({ bidNtceNo: 'A', noticeDate: '2026-10-01', noticeTime: '09:00' }),
    row({ bidNtceNo: 'B', noticeDate: '2026-10-31', noticeTime: '09:00' }),
    row({ bidNtceNo: 'C', noticeDate: '2026-11-01' }),
    row({ bidNtceNo: 'D', noticeDate: '2026-09-30' }),
    row({ bidNtceNo: 'E', noticeDate: '2026-10-31', noticeTime: '17:00' }),
  ], '2026-10-29T00:00:00Z');
  assert.deepEqual(listBids(db, q).map((r) => r.bidNtceNo), ['E', 'B', 'A']);
  assert.deepEqual(listBids(db, { from: '2026-12-01', to: '2026-12-31' }), []);
});

test('저장 중 오류가 나면 일부만 저장되지 않는다', () => {
  const db = fresh();
  assert.throws(() => upsertBids(db, [row(), row({ bidNtceNo: 'BAD', noticeDate: null as unknown as string })], '2026-10-29T00:00:00Z'));
  assert.deepEqual(listBids(db, { from: '2026-01-01', to: '2026-12-31' }), []);
});

test('firstNoticeDate: 저장된 가장 이른 공고일자(없으면 null) — 대시보드가 "수집 전" 기간을 구별하는 데 쓴다', () => {
  const db = fresh();
  assert.equal(firstNoticeDate(db), null);
  upsertBids(db, [row({ bidNtceNo: 'A', noticeDate: '2026-10-22' }), row({ bidNtceNo: 'B', noticeDate: '2026-10-05' })], '2026-10-29T00:00:00Z');
  assert.equal(firstNoticeDate(db), '2026-10-05');
});
