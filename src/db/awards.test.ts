import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstAwardDate, listAwards, upsertAwards, type AwardRow } from './awards.ts';
import { upsertBids, type BidRow } from './bids.ts';
import { migrate, openDb } from './index.ts';

const award = (over: Partial<AwardRow> = {}): AwardRow => ({
  bidNtceNo: 'R26BK01000001', bidNtceOrd: '000', title: '소스코드 보안약점 진단 용역', workKind: '용역', demanderName: '한국정보보호진흥원', demanderCode: '1234567',
  estimatedPrice: 90_000_000, reservePrice: 88_000_000, baseAmount: 89_000_000, opening: '2026-10-27 11:00', result: '개찰완료', bidderCount: 3,
  winnerName: '주식회사 낙찰', winnerAmount: 80_000_000, winnerRate: 89.9, winnerDate: '2026-10-28', keywords: ['소스코드', '보안약점'], ...over,
});
const bid = (over: Partial<BidRow> = {}): BidRow => ({
  bidNtceNo: 'R26BK01000001', bidNtceOrd: '000', title: '소스코드 보안약점 진단 용역', status: '일반공고', workKind: '용역', noticeDate: '2026-10-20', noticeTime: '09:00',
  demanderName: '한국정보보호진흥원', demanderCode: '1234567', noticeOrgName: '한국정보보호진흥원', noticeOrgCode: '1234567', estimatedPrice: 90_000_000, budgetAmount: null,
  bidBegin: '', regClose: '', bidClose: '', opening: '2026-10-27 11:00', url: 'https://www.g2b.go.kr/x?bidno=R26BK01000001', contractMethod: '제한경쟁', keywords: ['소스코드'], ...over,
});
const fresh = () => {
  const db = openDb(':memory:');
  migrate(db);
  return db;
};
const q = { from: '2026-10-01', to: '2026-10-31' };

test('0006 마이그레이션이 bid_awards 테이블을 만든다', () => {
  const db = openDb(':memory:');
  assert.equal(migrate(db).length, 6);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r['name']);
  assert.ok(tables.includes('bid_awards'));
});

test('저장하고 그대로 읽는다. 입찰공고가 없으면 단독(공고 링크 없음)이다', () => {
  const db = fresh();
  upsertAwards(db, [award(), award({ bidNtceNo: 'B', winnerName: '', winnerAmount: null, winnerRate: null, winnerDate: '', baseAmount: null, result: '유찰' })], '2026-10-29T00:00:00Z');
  const all = listAwards(db, q);
  assert.equal(all.length, 2);
  const a = all.find((r) => r.bidNtceNo === 'R26BK01000001')!;
  assert.deepEqual({ ...a, noticeUrl: undefined, noticeStatus: undefined, linked: undefined }, { ...award(), noticeUrl: undefined, noticeStatus: undefined, linked: undefined });
  assert.equal(a.linked, false);
  assert.equal(a.noticeUrl, '');
  const b = all.find((r) => r.bidNtceNo === 'B')!;
  assert.equal(b.winnerName, '');
  assert.equal(b.winnerAmount, null);
  assert.equal(b.baseAmount, null);
});

test('저장된 입찰공고와 (공고번호, 차수)가 같으면 연결되어 공고 링크 · 상태가 붙는다 (나중에 공고가 수집돼도 자동 연결)', () => {
  const db = fresh();
  upsertAwards(db, [award(), award({ bidNtceNo: 'X' })], '2026-10-29T00:00:00Z');
  assert.equal(listAwards(db, q).filter((r) => r.linked).length, 0);
  upsertBids(db, [bid({ status: '정정공고' }), bid({ bidNtceNo: 'R26BK01000001', bidNtceOrd: '001' })], '2026-10-29T00:00:00Z');
  const linked = listAwards(db, q).filter((r) => r.linked);
  assert.deepEqual(linked.map((r) => [r.bidNtceNo, r.noticeUrl, r.noticeStatus]), [['R26BK01000001', 'https://www.g2b.go.kr/x?bidno=R26BK01000001', '정정공고']]);
});

test('재수집하면 갱신되지만, 이미 정해진 낙찰자는 낙찰자 없는 응답으로 지워지지 않는다', () => {
  const db = fresh();
  upsertAwards(db, [award()], '2026-10-29T00:00:00Z');
  upsertAwards(db, [award({ winnerName: '', winnerAmount: null, winnerRate: null, winnerDate: '', bidderCount: 5, result: '개찰완료' })], '2026-10-30T00:00:00Z');
  const [r] = listAwards(db, q);
  assert.equal(r?.winnerName, '주식회사 낙찰');
  assert.equal(r?.winnerAmount, 80_000_000);
  assert.equal(r?.bidderCount, 5);
  // 새 낙찰자가 오면 바뀐다.
  upsertAwards(db, [award({ winnerName: '다른 업체', winnerAmount: 70_000_000 })], '2026-10-31T00:00:00Z');
  assert.equal(listAwards(db, q)[0]?.winnerName, '다른 업체');
  assert.equal(listAwards(db, q).length, 1);
});

test('개찰일자 기간(양끝 포함)으로 거르고 최근 개찰 순으로 정렬한다', () => {
  const db = fresh();
  upsertAwards(db, [
    award({ bidNtceNo: 'A', opening: '2026-10-01 09:00' }), award({ bidNtceNo: 'B', opening: '2026-10-31 09:00' }), award({ bidNtceNo: 'C', opening: '2026-11-01 09:00' }),
    award({ bidNtceNo: 'D', opening: '2026-09-30 09:00' }), award({ bidNtceNo: 'E', opening: '2026-10-31 17:00' }),
  ], '2026-10-29T00:00:00Z');
  assert.deepEqual(listAwards(db, q).map((r) => r.bidNtceNo), ['E', 'B', 'A']);
});

test('저장 중 오류가 나면 일부만 저장되지 않는다', () => {
  const db = fresh();
  assert.throws(() => upsertAwards(db, [award(), award({ bidNtceNo: 'BAD', opening: null as unknown as string })], '2026-10-29T00:00:00Z'));
  assert.deepEqual(listAwards(db, { from: '2026-01-01', to: '2026-12-31' }), []);
});

test('firstAwardDate: 저장된 가장 이른 개찰일자(없으면 null)', () => {
  const db = fresh();
  assert.equal(firstAwardDate(db), null);
  upsertAwards(db, [award({ bidNtceNo: 'A', opening: '2026-10-27 11:00' }), award({ bidNtceNo: 'B', opening: '2026-10-05 09:00' })], '2026-10-29T00:00:00Z');
  assert.equal(firstAwardDate(db), '2026-10-05');
});
