import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finishRun, lastRunByKind, startRun } from '../db/contracts.ts';
import { listBids } from '../db/bids.ts';
import { migrate, openDb } from '../db/index.ts';
import { G2bResponseError } from '../g2b/response.ts';
import { collectBidDay } from './bids.ts';
import { createFetcher } from './contracts.ts';
import { runBidDaily } from './run.ts';

const OP = 'getDataSetOpnStdBidPblancInfo';
const keywords = ['소스코드', '솔루션', 'app'];
const titled = (no: string, extra: Record<string, string> = {}) => item({ bidNtceNo: no, ...extra });
const item = (over: Record<string, string> = {}) => ({
  bidNtceNo: 'R26BK01000001', bidNtceOrd: '000', bidNtceNm: '소스코드 보안약점 진단 용역', bidNtceSttusNm: '일반공고', bsnsDivNm: '용역',
  bidNtceDate: '2026-10-27', bidNtceBgn: '09:30', ntceInsttNm: '공고기관', ntceInsttCd: '111', ntceInsttOfclNm: '홍길동', ntceInsttOfclTel: '02-000-0000',
  ntceInsttOfclEmailAdrs: 'a@b.c', dmndInsttNm: '수요기관', dmndInsttCd: '222', dmndInsttOfclNm: '김철수', dmndInsttOfclTel: '031-000-0000',
  bidPrtcptQlfctRgstClseDate: '2026-11-03', bidPrtcptQlfctRgstClseTm: '17:00', bidBeginDate: '2026-10-27', bidBeginTm: '09:30',
  bidClseDate: '2026-11-05', bidClseTm: '10:00', opengDate: '2026-11-05', opengTm: '11:00', asignBdgtAmt: '99000000', presmptPrce: '90000000',
  cntrctCnclsMthdNm: '제한경쟁', bidNtceUrl: 'https://www.g2b.go.kr/x?bidno=R26BK01000001', ...over,
});
const page = (items: object[], totalCount = items.length) => ({
  response: { header: { resultCode: '00', resultMsg: '정상' }, body: { items, numOfRows: 500, pageNo: 1, totalCount } },
});
type Call = { path: string; params: Record<string, string | number> };
function fakeClient(byDay: Record<string, unknown[] | Error>) {
  const calls: Call[] = [];
  const queues = Object.fromEntries(Object.entries(byDay).map(([k, v]) => [k, v instanceof Error ? v : [...v]]));
  return {
    calls,
    async get(path: string, params: Record<string, string | number> = {}) {
      calls.push({ path, params });
      const day = String(params['bidNtceBgnDt']).slice(0, 8);
      const q = queues[day];
      if (q instanceof Error) throw q;
      return q?.shift() ?? page([]);
    },
  };
}
const noSleep = async () => {};
const collect = async (client: ReturnType<typeof fakeClient>, day = '2026-10-27') => {
  const fetcher = createFetcher(client, { maxCalls: 20, sleep: noSleep });
  return collectBidDay({ fetchPage: fetcher.fetchPage, keywords }, day);
};

test('입찰공고일시 하루 구간으로 호출하고 쪽당 500건을 요청한다', async () => {
  const client = fakeClient({ '20261027': [page([])] });
  await collect(client);
  assert.deepEqual(client.calls.map((c) => [c.path, c.params]), [[OP, { bidNtceBgnDt: '202610270000', bidNtceEndDt: '202610272359', numOfRows: 500, pageNo: 1 }]]);
});

test('키워드에 걸린 공고만 저장 행으로 바꾸고 걸린 키워드를 담는다', async () => {
  const client = fakeClient({ '20261027': [page([item(), item({ bidNtceNo: 'X', bidNtceNm: '일반 물품 구매' }), item({ bidNtceNo: 'Y', bidNtceNm: 'AI 솔루션 개발 app' })])] });
  const { rows, stats } = await collect(client);
  assert.deepEqual(rows.map((r) => [r.bidNtceNo, r.keywords]), [['R26BK01000001', ['소스코드']], ['Y', ['솔루션', 'app']]]);
  assert.deepEqual(stats, { fetched: 3, matched: 2, passes: 1, shortfall: 0 });
});

test('필드를 요구사항 항목으로 옮기고 담당자 정보는 가져오지 않는다', async () => {
  const { rows } = await collect(fakeClient({ '20261027': [page([item()])] }));
  assert.deepEqual(rows[0], {
    bidNtceNo: 'R26BK01000001', bidNtceOrd: '000', title: '소스코드 보안약점 진단 용역', status: '일반공고', workKind: '용역',
    noticeDate: '2026-10-27', noticeTime: '09:30', demanderName: '수요기관', demanderCode: '222', noticeOrgName: '공고기관', noticeOrgCode: '111',
    estimatedPrice: 90_000_000, budgetAmount: 99_000_000, bidBegin: '2026-10-27 09:30', regClose: '2026-11-03 17:00', bidClose: '2026-11-05 10:00',
    opening: '2026-11-05 11:00', url: 'https://www.g2b.go.kr/x?bidno=R26BK01000001', contractMethod: '제한경쟁', keywords: ['소스코드'],
  });
  const text = JSON.stringify(rows);
  for (const secret of ['홍길동', '김철수', '02-000-0000', '031-000-0000', 'a@b.c']) assert.ok(!text.includes(secret), secret);
});

test('수요기관이 비어 있으면 공고기관을 수요처로 쓰고, 빈 금액 · 빈 일시는 null · 빈 문자열이다', async () => {
  const { rows } = await collect(fakeClient({
    '20261027': [page([item({ dmndInsttNm: '', dmndInsttCd: '', presmptPrce: '', asignBdgtAmt: '', bidPrtcptQlfctRgstClseDate: '', bidPrtcptQlfctRgstClseTm: '' })])],
  }));
  assert.equal(rows[0]?.demanderName, '공고기관');
  assert.equal(rows[0]?.demanderCode, '111');
  assert.equal(rows[0]?.estimatedPrice, null);
  assert.equal(rows[0]?.budgetAmount, null);
  assert.equal(rows[0]?.regClose, '');
});

test('공고일자 형식이 다르면 조용히 넘기지 않고 실패한다', async () => {
  await assert.rejects(collect(fakeClient({ '20261027': [page([item({ bidNtceDate: '20261027' })])] })), (e: unknown) => e instanceof G2bResponseError);
  await assert.rejects(collect(fakeClient({ '20261027': [page([item({ bidNtceDate: '' })])] })), (e: unknown) => e instanceof G2bResponseError);
});

test('여러 쪽을 이어서 받고, (공고번호 + 차수)가 겹치면 한 번만 센다', async () => {
  const client = fakeClient({ '20261027': [page([item()], 2), page([item(), item({ bidNtceOrd: '001' })], 2)] });
  const { rows, stats } = await collect(client);
  assert.equal(rows.length, 2);
  assert.equal(stats.fetched, 2);
  assert.deepEqual(client.calls.map((c) => c.params['pageNo']), [1, 2]);
});

const setup = () => {
  const db = openDb(':memory:');
  migrate(db);
  return db;
};
const seed = (db: ReturnType<typeof setup>, day: string) => {
  const id = startRun(db, day, day, '2026-10-29T00:00:00Z', 'bid_daily');
  finishRun(db, id, { status: 'success', fetched: 1, matched: 1, calls: 1, error: null }, '2026-10-29T00:01:00Z');
};
test('입찰 매일: 기록이 없으면 전일자만 받고, 하루마다 실행 기록을 남긴다', async () => {
  const db = setup();
  const client = fakeClient({ '20261028': [page([item({ bidNtceDate: '2026-10-28' })])] });
  const r = await runBidDaily({ db, client, keywords, today: '2026-10-29', maxCalls: 20, sleep: noSleep, now: () => '2026-10-29T00:00:00Z' });
  assert.equal(r.status, 'success');
  assert.equal(r.days, 1);
  assert.deepEqual(client.calls.map((c) => c.params['bidNtceBgnDt']), ['202610280000']);
  assert.equal(listBids(db, { from: '2026-10-01', to: '2026-10-31' }).length, 1);
  const last = lastRunByKind(db).bid_daily!;
  assert.deepEqual([last.rangeFrom, last.rangeTo, last.status, last.fetched, last.matched], ['2026-10-28', '2026-10-28', 'success', 1, 1]);
});

test('입찰 매일: 마지막 성공일 다음 날부터 어제까지 이어 받고, 받을 날이 없으면 호출하지 않는다', async () => {
  const db = setup();
  seed(db, '2026-10-26');
  const client = fakeClient({});
  const r = await runBidDaily({ db, client, keywords, today: '2026-10-29', maxCalls: 20, sleep: noSleep });
  assert.equal(r.days, 2);
  assert.deepEqual(client.calls.map((c) => c.params['bidNtceBgnDt']), ['202610270000', '202610280000']);
  const none = fakeClient({});
  assert.equal((await runBidDaily({ db, client: none, keywords, today: '2026-10-29', maxCalls: 20 })).days, 0);
  assert.equal(none.calls.length, 0);
});

test('입찰 매일: from을 주면 그 날부터 어제까지(과거 구간 재수집)', async () => {
  const db = setup();
  seed(db, '2026-10-28');
  const client = fakeClient({});
  const r = await runBidDaily({ db, client, keywords, today: '2026-10-29', from: '2026-10-26', maxCalls: 20, sleep: noSleep });
  assert.equal(r.days, 3);
  assert.deepEqual(client.calls.map((c) => c.params['bidNtceBgnDt']), ['202610260000', '202610270000', '202610280000']);
});

test('입찰 매일: 중간 날짜에서 실패하면 앞 날짜는 저장하고 멈추며 다음 실행은 실패한 날부터 한다', async () => {
  const db = setup();
  seed(db, '2026-10-25');
  const bad = fakeClient({ '20261026': [page([item({ bidNtceNo: 'A', bidNtceDate: '2026-10-26' })])], '20261027': new Error('연결 끊김') });
  const r = await runBidDaily({ db, client: bad, keywords, today: '2026-10-29', maxCalls: 30, sleep: noSleep });
  assert.equal(r.status, 'failed');
  assert.equal(r.days, 1);
  assert.match(r.error ?? '', /연결 끊김/);
  assert.deepEqual(listBids(db, { from: '2026-10-01', to: '2026-10-31' }).map((b) => b.bidNtceNo), ['A']);
  assert.equal(lastRunByKind(db).bid_daily?.status, 'failed');
  const retry = fakeClient({});
  await runBidDaily({ db, client: retry, keywords, today: '2026-10-29', maxCalls: 30, sleep: noSleep });
  assert.deepEqual(retry.calls.map((c) => c.params['bidNtceBgnDt']), ['202610270000', '202610280000']);
});

test('입찰 매일: 호출 상한은 여러 날 전체에 걸쳐 센다', async () => {
  const db = setup();
  seed(db, '2026-10-20');
  const client = fakeClient({});
  const r = await runBidDaily({ db, client, keywords, today: '2026-10-29', maxCalls: 2, sleep: noSleep });
  assert.equal(r.status, 'failed');
  assert.match(r.error ?? '', /호출 상한/);
  assert.equal(client.calls.length, 2);
});


test('쪽 이동으로 중복이 생겨 고유 건수가 전체 건수보다 적으면 같은 날을 다시 받아 합친다', async () => {
  // 1차: 전체 3건인데 쪽 사이에 B가 겹쳐 와서 C가 빠짐. 2차: 정상.
  const client = fakeClient({
    '20261027': [
      page([titled('A'), titled('B')], 3), page([titled('B')], 3),
      page([titled('A'), titled('B')], 3), page([titled('C')], 3),
    ],
  });
  const { rows, stats } = await collect(client);
  assert.deepEqual(rows.map((r) => r.bidNtceNo).sort(), ['A', 'B', 'C']);
  assert.deepEqual(stats, { fetched: 3, matched: 3, passes: 2, shortfall: 0 });
  assert.equal(client.calls.length, 4);
});

test('다시 받아도 부족하면 최대 3번까지만 받고 부족 건수를 알린다', async () => {
  const pass = () => [page([titled('A')], 3), page([], 3)];
  const client = fakeClient({ '20261027': [...pass(), ...pass(), ...pass(), ...pass()] });
  const { stats } = await collect(client);
  assert.equal(stats.passes, 3);
  assert.equal(stats.shortfall, 2);
  assert.equal(client.calls.length, 6);
});

test('입찰공고 번호나 차수가 빈 항목은 키 충돌을 막으려고 실패로 처리한다', async () => {
  await assert.rejects(collect(fakeClient({ '20261027': [page([item({ bidNtceNo: '' })])] })), (e: unknown) => e instanceof G2bResponseError);
  await assert.rejects(collect(fakeClient({ '20261027': [page([item({ bidNtceOrd: '' })])] })), (e: unknown) => e instanceof G2bResponseError);
});

test('입찰 매일: 다시 받은 날은 실행 기록 메모에 남긴다', async () => {
  const db = setup();
  const d = { bidNtceDate: '2026-10-28' };
  const client = fakeClient({
    '20261028': [page([titled('A', d), titled('B', d)], 3), page([titled('B', d)], 3), page([titled('A', d), titled('C', d)], 3)],
  });
  await runBidDaily({ db, client, keywords, today: '2026-10-29', maxCalls: 20, sleep: noSleep });
  assert.match(lastRunByKind(db).bid_daily?.note ?? '', /2번 받음/);
  assert.equal(listBids(db, { from: '2026-10-01', to: '2026-10-31' }).length, 3);
  const quiet = setup();
  await runBidDaily({ db: quiet, client: fakeClient({ '20261028': [page([item({ bidNtceDate: '2026-10-28' })])] }), keywords, today: '2026-10-29', maxCalls: 20, sleep: noSleep });
  assert.equal(lastRunByKind(quiet).bid_daily?.note, null);
});
