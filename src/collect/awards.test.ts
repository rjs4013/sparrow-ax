import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listAwards } from '../db/awards.ts';
import { finishRun, lastRunByKind, startRun } from '../db/contracts.ts';
import { migrate, openDb } from '../db/index.ts';
import { G2bResponseError } from '../g2b/response.ts';
import { collectAwardDay } from './awards.ts';
import { createFetcher } from './contracts.ts';
import { runAwardDaily } from './run.ts';

const OP = 'getDataSetOpnStdScsbidInfo';
const keywords = ['솔루션', '컨설팅'];
// 투찰업체 한 행. 낙찰자 행은 sucsfYn=Y이고 최종낙찰 필드가 채워진다.
const row = (over: Record<string, string> = {}) => ({
  bidNtceNo: 'R26BK01000001', bidNtceOrd: '000', bidNtceNm: 'AI 솔루션 구축 용역', bsnsDivNm: '용역', ntceInsttNm: '공고기관', ntceInsttCd: '111',
  dmndInsttNm: '수요기관', dmndInsttCd: '222', presmptPrce: '90000000', rsrvtnPrce: '88000000', bssAmt: '89000000', opengDate: '2026-10-27', opengTm: '11:00',
  opengRsltDivNm: '개찰완료', opengRank: '1', bidprcCorpBizrno: '1112233334', bidprcCorpNm: '주식회사 가', bidprcCorpCeoNm: '홍길동', bidprcAmt: '80000000', bidprcRt: '89.9',
  sucsfYn: 'N', fnlSucsfAmt: '', fnlSucsfRt: '', fnlSucsfDate: '', fnlSucsfCorpNm: '', fnlSucsfCorpCeoNm: '', fnlSucsfCorpOfclNm: '', fnlSucsfCorpAdrs: '', fnlSucsfCorpContactTel: '', ...over,
});
const winner = (over: Record<string, string> = {}) => row({
  sucsfYn: 'Y', fnlSucsfAmt: '80000000', fnlSucsfRt: '89.9', fnlSucsfDate: '2026-10-28', fnlSucsfCorpNm: '주식회사 낙찰', fnlSucsfCorpCeoNm: '김대표', fnlSucsfCorpOfclNm: '이담당',
  fnlSucsfCorpAdrs: '서울시 어딘가', fnlSucsfCorpContactTel: '02-111-2222', bidprcCorpBizrno: '9998877776', bidprcCorpNm: '주식회사 낙찰', ...over,
});
const page = (items: object[], totalCount = items.length) => ({
  response: { header: { resultCode: '00', resultMsg: '정상' }, body: { items, numOfRows: 999, pageNo: 1, totalCount } },
});
type Call = { path: string; params: Record<string, string | number> };
// 업무구분(1 물품, 5 용역) × 날짜별로 준비된 쪽을 차례로 돌려주는 가짜 클라이언트. 준비된 것이 없으면 빈 결과.
function fakeClient(queues: Record<string, unknown[] | Error>) {
  const calls: Call[] = [];
  const q = Object.fromEntries(Object.entries(queues).map(([k, v]) => [k, v instanceof Error ? v : [...v]]));
  return {
    calls,
    async get(path: string, params: Record<string, string | number> = {}) {
      calls.push({ path, params });
      const key = `${String(params['opengBgnDt']).slice(0, 8)}:${params['bsnsDivCd']}`;
      const entry = q[key];
      if (entry instanceof Error) throw entry;
      return entry?.shift() ?? page([]);
    },
  };
}
const noSleep = async () => {};
const collect = async (client: ReturnType<typeof fakeClient>, day = '2026-10-27') => {
  const fetcher = createFetcher(client, { maxCalls: 50, sleep: noSleep });
  return collectAwardDay({ fetchPage: fetcher.fetchPage, keywords }, day);
};

test('개찰일시 하루 구간을 업무구분 물품(1) · 용역(5)별로 쪽 크기 999로 받는다', async () => {
  const client = fakeClient({});
  await collect(client);
  assert.deepEqual(client.calls.map((c) => [c.path, c.params]), [
    [OP, { bsnsDivCd: 1, opengBgnDt: '202610270000', opengEndDt: '202610272359', numOfRows: 999, pageNo: 1 }],
    [OP, { bsnsDivCd: 5, opengBgnDt: '202610270000', opengEndDt: '202610272359', numOfRows: 999, pageNo: 1 }],
  ]);
});

test('투찰업체별 행을 공고 하나로 묶고, 낙찰자 행에서 낙찰처 · 금액 · 일자를 뽑는다', async () => {
  const client = fakeClient({ '20261027:5': [page([row(), winner(), row({ bidprcCorpBizrno: '5556667778', bidprcCorpNm: '주식회사 나', opengRank: '3' })])] });
  const { rows, stats } = await collect(client);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    bidNtceNo: 'R26BK01000001', bidNtceOrd: '000', title: 'AI 솔루션 구축 용역', workKind: '용역', demanderName: '수요기관', demanderCode: '222',
    estimatedPrice: 90_000_000, reservePrice: 88_000_000, baseAmount: 89_000_000, opening: '2026-10-27 11:00', result: '개찰완료', bidderCount: 3,
    winnerName: '주식회사 낙찰', winnerAmount: 80_000_000, winnerRate: 89.9, winnerDate: '2026-10-28', keywords: ['솔루션'],
  });
  assert.deepEqual(stats, { fetched: 3, matched: 1, notes: [] });
});

test('낙찰자가 아직 없으면 낙찰처가 비고, 유찰도 그대로 저장한다', async () => {
  const client = fakeClient({ '20261027:5': [page([row({ bidNtceNo: 'P' }), row({ bidNtceNo: 'F', opengRsltDivNm: '유찰', bssAmt: '' })])] });
  const { rows } = await collect(client);
  const p = rows.find((r) => r.bidNtceNo === 'P')!;
  const f = rows.find((r) => r.bidNtceNo === 'F')!;
  assert.equal(p.winnerName, '');
  assert.equal(p.winnerAmount, null);
  assert.equal(f.result, '유찰');
  assert.equal(f.baseAmount, null);
});

test('공고명이 키워드에 걸린 공고만 남기고(대소문자 무시), 업무구분이 다른 두 호출의 결과를 합친다', async () => {
  const client = fakeClient({
    '20261027:1': [page([row({ bidNtceNo: 'G', bsnsDivNm: '물품', bidNtceNm: '컨설팅 SW 구매' }), row({ bidNtceNo: 'X', bidNtceNm: '일반 물품 구매' })])],
    '20261027:5': [page([row({ bidNtceNo: 'Y', bidNtceNm: '소규모 컨설팅 용역' }), row({ bidNtceNo: 'Z', bidNtceNm: '청소 용역' })])],
  });
  const { rows, stats } = await collect(client);
  assert.deepEqual(rows.map((r) => r.bidNtceNo).sort(), ['G', 'Y']);
  assert.equal(stats.fetched, 4);
  assert.equal(stats.matched, 2);
});

test('대표자 · 담당자 · 연락처 · 주소는 읽지도 저장하지도 않는다', async () => {
  const { rows } = await collect(fakeClient({ '20261027:5': [page([row(), winner()])] }));
  const text = JSON.stringify(rows);
  for (const secret of ['홍길동', '김대표', '이담당', '서울시 어딘가', '02-111-2222', '1112233334']) assert.ok(!text.includes(secret), secret);
});

test('여러 쪽을 이어서 받고, 투찰업체 수는 사업자번호가 다른 업체 수로 센다', async () => {
  const a = row({ bidprcCorpBizrno: 'A1', opengRank: '1' });
  const b = row({ bidprcCorpBizrno: 'B1', opengRank: '2' });
  const client = fakeClient({ '20261027:5': [page([a], 2), page([b], 2)] });
  const { rows, stats } = await collect(client);
  assert.equal(rows[0]?.bidderCount, 2);
  assert.equal(stats.fetched, 2);
  assert.deepEqual(client.calls.filter((c) => c.params['bsnsDivCd'] === 5).map((c) => c.params['pageNo']), [1, 2]);
});

test('같은 공고 · 업체 · 순위 · 금액이어도 내용이 다른 행(품목별 낙찰)은 버리지 않는다 — 키로 중복을 가리지 않는다', async () => {
  // 실측: 같은 키의 행들이 낙찰금액 · 낙찰업체가 서로 다르다(한 공고 안의 품목별 행). 원본 행 수를 그대로 센다.
  const lot1 = winner({ fnlSucsfAmt: '1000', fnlSucsfCorpNm: '업체 갑' });
  const lot2 = winner({ fnlSucsfAmt: '2000', fnlSucsfCorpNm: '업체 을' });
  const { rows, stats } = await collect(fakeClient({ '20261027:5': [page([lot1, lot2])] }));
  assert.equal(stats.fetched, 2);
  // 낙찰자는 처음 만난 낙찰자 행 하나를 쓴다(여러 품목의 낙찰자가 다른 공고는 드물다).
  assert.equal(rows[0]?.winnerName, '업체 갑');
  assert.equal(rows[0]?.winnerAmount, 1000);
});

test('개찰일자 · 공고번호가 비어 있는 적중 공고는 조용히 넘기지 않고 실패한다', async () => {
  await assert.rejects(collect(fakeClient({ '20261027:5': [page([row({ opengDate: '' })])] })), (e: unknown) => e instanceof G2bResponseError);
  await assert.rejects(collect(fakeClient({ '20261027:5': [page([row({ bidNtceNo: '' })])] })), (e: unknown) => e instanceof G2bResponseError);
});

const setup = () => {
  const db = openDb(':memory:');
  migrate(db);
  return db;
};
const seed = (db: ReturnType<typeof setup>, day: string) => {
  const id = startRun(db, day, day, '2026-10-29T00:00:00Z', 'award_daily');
  finishRun(db, id, { status: 'success', fetched: 1, matched: 1, calls: 2, error: null }, '2026-10-29T00:01:00Z');
};

test('낙찰 매일: 기록이 없으면 어제(개찰일) 하루만 받고 저장하며 실행 기록을 남긴다', async () => {
  const db = setup();
  const client = fakeClient({ '20261028:5': [page([winner({ opengDate: '2026-10-28' })])] });
  const r = await runAwardDaily({ db, client, keywords, today: '2026-10-29', maxCalls: 20, sleep: noSleep, now: () => '2026-10-29T00:00:00Z' });
  assert.equal(r.status, 'success');
  assert.equal(r.days, 1);
  assert.deepEqual([...new Set(client.calls.map((c) => String(c.params['opengBgnDt'])))], ['202610280000']);
  assert.equal(listAwards(db, { from: '2026-10-01', to: '2026-10-31' }).length, 1);
  const last = lastRunByKind(db).award_daily!;
  assert.deepEqual([last.rangeFrom, last.status, last.fetched, last.matched, last.calls], ['2026-10-28', 'success', 1, 1, 2]);
});

test('낙찰 매일: 마지막 성공일 다음 날부터 이어 받고, 받을 날이 없으면 호출하지 않는다', async () => {
  const db = setup();
  seed(db, '2026-10-26');
  const client = fakeClient({});
  const r = await runAwardDaily({ db, client, keywords, today: '2026-10-29', maxCalls: 20, sleep: noSleep });
  assert.equal(r.days, 2);
  assert.deepEqual([...new Set(client.calls.map((c) => String(c.params['opengBgnDt']).slice(0, 8)))], ['20261027', '20261028']);
  const none = fakeClient({});
  assert.equal((await runAwardDaily({ db, client: none, keywords, today: '2026-10-29', maxCalls: 20 })).days, 0);
  assert.equal(none.calls.length, 0);
});

test('낙찰 매일: 중간 날짜에서 실패하면 앞 날짜는 저장하고 멈춘다', async () => {
  const db = setup();
  seed(db, '2026-10-25');
  const client = fakeClient({ '20261026:5': [page([winner({ bidNtceNo: 'A', opengDate: '2026-10-26' })])], '20261027:5': new Error('연결 끊김') });
  const r = await runAwardDaily({ db, client, keywords, today: '2026-10-29', maxCalls: 30, sleep: noSleep });
  assert.equal(r.status, 'failed');
  assert.equal(r.days, 1);
  assert.match(r.error ?? '', /연결 끊김/);
  assert.deepEqual(listAwards(db, { from: '2026-10-01', to: '2026-10-31' }).map((a) => a.bidNtceNo), ['A']);
});

test('낙찰 매일: 호출 상한은 여러 날에 걸쳐 센다 (넘기면 그날은 저장하지 않고 실패로 기록)', async () => {
  const capped = setup();
  seed(capped, '2026-10-20');
  const r = await runAwardDaily({ db: capped, client: fakeClient({}), keywords, today: '2026-10-29', maxCalls: 3, sleep: noSleep });
  assert.equal(r.status, 'failed');
  assert.match(r.error ?? '', /호출 상한/);
  assert.equal(lastRunByKind(capped).award_daily?.status, 'failed');
  assert.deepEqual(listAwards(capped, { from: '2026-10-01', to: '2026-10-31' }), []);
});

test('투찰업체 수: 사업자번호가 비면 업체명으로 세고, 둘 다 비면 세지 않는다', async () => {
  const noBiz = (name: string, rank: string) => row({ bidprcCorpBizrno: '', bidprcCorpNm: name, opengRank: rank });
  const { rows } = await collect(fakeClient({ '20261027:5': [page([noBiz('가', '1'), noBiz('나', '2'), noBiz('가', '3'), row({ bidprcCorpBizrno: '', bidprcCorpNm: '' })])] }));
  assert.equal(rows[0]?.bidderCount, 2);
});

test('받은 행 수가 서비스의 전체 건수와 다르면(쪽 이동 · 누락 가능성) 업무구분별로 알린다', async () => {
  // 전체 5행이라는데 3행만 오고 빈 쪽으로 끝남
  const { stats } = await collect(fakeClient({ '20261027:5': [page([row(), row({ opengRank: '2' }), row({ opengRank: '3' })], 5), page([], 5)] }));
  assert.equal(stats.notes.length, 1);
  assert.match(stats.notes[0] ?? '', /업무구분 5.*전체 5행 중 3행 수신/);
  // 정확히 맞으면 알릴 것이 없다
  const ok = await collect(fakeClient({ '20261027:5': [page([row(), row({ opengRank: '2' })], 2)] }));
  assert.deepEqual(ok.stats.notes, []);
});

test('낙찰 매일: 쪽 수 부족은 실행 기록 메모에 남는다', async () => {
  const db = setup();
  const client = fakeClient({ '20261028:5': [page([winner({ opengDate: '2026-10-28' })], 4), page([], 4)] });
  await runAwardDaily({ db, client, keywords, today: '2026-10-29', maxCalls: 20, sleep: noSleep });
  assert.match(lastRunByKind(db).award_daily?.note ?? '', /쪽 수 확인.*업무구분 5/);
  assert.equal(listAwards(db, { from: '2026-10-01', to: '2026-10-31' }).length, 1);
});
