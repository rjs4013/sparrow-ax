import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finishRun, lastRunByKind, startRun } from '../db/contracts.ts';
import { listDeliveries } from '../db/deliveries.ts';
import { migrate, openDb } from '../db/index.ts';
import { createMatcher, parseMonitoringConfig } from '../filters/contracts.ts';
import { G2bResponseError } from '../g2b/response.ts';
import { createFetcher, PRODUCT_NAME } from './contracts.ts';
import { collectDeliveries } from './deliveries.ts';
import { runDeliveryBackfill, runDeliveryDaily, runDeliveryVerify } from './run.ts';

const matcher = createMatcher(parseMonitoringConfig({
  categoryCodes: ['43233205'],
  companies: [
    { id: 'a', label: '에이', matchNames: ['주식회사 에이'], provisional: false, products: [{ id: '11111111', name: 'A1' }, { id: '33333333', name: 'A3' }] },
    { id: 'b', label: '비', matchNames: ['(주)비'], provisional: false, products: [{ id: '11111111', name: 'B1' }] },
  ],
}));

const OP = 'getDlvrReqDtlInfoList';
const item = (over: Record<string, string> = {}) => ({
  dlvrReqNo: 'R26TB00000001', dlvrReqNm: '정보보안 솔루션 구매', dlvrReqChgOrd: '0', dlvrReqRcptDate: '2026-06-08', prdctSno: '1', prdctClsfcNo: '43233205',
  prdctClsfcNoNm: '트랜잭션보안및바이러스보호소프트웨어', prdctIdntNo: '33333333', prdctIdntNoNm: '웹방화벽', prdctUprc: '45500000',
  prdctQty: '1', prdctAmt: '45500000', dlvrTmlmtDate: '2026-07-08', cntrctNo: '002461624', cntrctCnclsStleNm: '제3자단가계약',
  dminsttCd: '1790364', dminsttNm: '고위공직자범죄수사처', dmndInsttDivNm: '중앙행정기관', corpNm: '주식회사 에이', cntrctCorpBizno: '1234567890',
  fnlDlvrReqYn: 'Y', incdecQty: '1', incdecAmt: '45500000', ...over,
});
const page = (items: object[], totalCount = items.length) => ({
  response: { header: { resultCode: '00', resultMsg: '정상' }, body: { items, numOfRows: 999, pageNo: 1, totalCount } },
});
type Call = { path: string; params: Record<string, string | number> };
function fakeClient(responses: unknown[]) {
  const calls: Call[] = [];
  const queue = [...responses];
  return {
    calls,
    async get(path: string, params: Record<string, string | number> = {}) {
      calls.push({ path, params });
      const next = queue.shift();
      if (next === undefined) throw new Error('준비되지 않은 호출');
      if (next instanceof Error) throw next;
      return next;
    },
  };
}
const noSleep = async () => {};
const collect = async (client: ReturnType<typeof fakeClient>, from = '2026-06-01', to = '2026-06-30') => {
  const fetcher = createFetcher(client, { maxCalls: 20, sleep: noSleep });
  return collectDeliveries({ fetchPage: fetcher.fetchPage, matcher }, { from, to });
};

test('기간을 달력 월로 나눠 납품요구 상세를 호출하고 품명 필터를 건다', async () => {
  const client = fakeClient([page([]), page([])]);
  await collect(client, '2026-01-15', '2026-02-10');
  assert.deepEqual(client.calls.map((c) => [c.path, c.params]), [
    [OP, { inqryDiv: 1, inqryBgnDate: '20260115', inqryEndDate: '20260131', prdctClsfcNoNm: PRODUCT_NAME, numOfRows: 999, pageNo: 1 }],
    [OP, { inqryDiv: 1, inqryBgnDate: '20260201', inqryEndDate: '20260210', prdctClsfcNoNm: PRODUCT_NAME, numOfRows: 999, pageNo: 1 }],
  ]);
});

test('우리 업체(상호 정확 일치) 행만 저장 행으로 바꾼다', async () => {
  const client = fakeClient([page([item(), item({ prdctSno: '2', corpNm: '주식회사 다른회사' })])]);
  const { rows, stats } = await collect(client);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    dlvrReqNo: 'R26TB00000001', requestName: '정보보안 솔루션 구매', chgOrd: 0, prdctSno: '1', companyId: 'a', companyName: '주식회사 에이', bizNo: '1234567890',
    receivedDate: '2026-06-08', demanderCode: '1790364', demanderName: '고위공직자범죄수사처', demanderKind: '중앙행정기관',
    productClassNo: '43233205', productClassName: '트랜잭션보안및바이러스보호소프트웨어', productId: '33333333', productName: '웹방화벽',
    unitPrice: 45_500_000, qty: 1, amount: 45_500_000, deadline: '2026-07-08', contractNo: '002461624', contractStyle: '제3자단가계약',
    finalYn: true, incdecQty: 1, incdecAmt: 45_500_000, verified: true, idConflict: false,
  });
  assert.deepEqual(stats, { fetched: 2, companyMatched: 1, categoryMismatch: 0 });
});

test('분류번호가 보안 소프트웨어가 아니면 건너뛰고 건수에 센다', async () => {
  const client = fakeClient([page([item({ prdctClsfcNo: '43211503' })])]);
  const { rows, stats } = await collect(client);
  assert.deepEqual(rows, []);
  assert.equal(stats.categoryMismatch, 1);
});

test('식별번호: 목록 밖은 verified=false, 여러 업체에 걸친 번호는 대조 필요, 비어 있으면 둘 다 false', async () => {
  const client = fakeClient([page([
    item({ prdctSno: '1', prdctIdntNo: '77777777' }),
    item({ prdctSno: '2', prdctIdntNo: '11111111' }),
    item({ prdctSno: '3', prdctIdntNo: '' }),
  ])]);
  const { rows } = await collect(client);
  assert.deepEqual(rows.map((r) => [r.prdctSno, r.verified, r.idConflict]), [['1', false, false], ['2', true, true], ['3', false, false]]);
});

test('변경 차수 · 빈 금액 · 쉼표가 든 숫자를 읽는다', async () => {
  const client = fakeClient([page([item({ dlvrReqChgOrd: '02', prdctAmt: '', prdctQty: '1,200', fnlDlvrReqYn: 'N', incdecQty: '', incdecAmt: 'abc' })])]);
  const [r] = (await collect(client)).rows;
  assert.equal(r?.chgOrd, 2);
  assert.equal(r?.amount, null);
  assert.equal(r?.qty, 1200);
  assert.equal(r?.finalYn, false);
  assert.equal(r?.incdecQty, null);
  assert.equal(r?.incdecAmt, null);
});

test('접수일자 형식이 다르거나 변경 차수가 숫자가 아니면 조용히 넘기지 않고 실패한다', async () => {
  await assert.rejects(collect(fakeClient([page([item({ dlvrReqRcptDate: '20260608' })])])), (e: unknown) => e instanceof G2bResponseError);
  await assert.rejects(collect(fakeClient([page([item({ dlvrReqChgOrd: 'x' })])])), (e: unknown) => e instanceof G2bResponseError);
});

test('여러 쪽을 이어서 받고, 쪽 사이에 겹친 행은 한 번만 센다', async () => {
  const client = fakeClient([page([item()], 2), page([item(), item({ prdctSno: '2' })], 3)]);
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

test('백필: 끝까지 성공하면 저장하고 dlvr_backfill 실행 기록을 남긴다', async () => {
  const db = setup();
  const client = fakeClient([page([item()])]);
  const r = await runDeliveryBackfill({ db, client, matcher, range: { from: '2026-06-01', to: '2026-06-30' }, maxCalls: 10, sleep: noSleep, now: () => '2026-10-29T00:00:00Z' });
  assert.equal(r.status, 'success');
  assert.equal(listDeliveries(db, { from: '2026-06-01', to: '2026-06-30' }).length, 1);
  const run = lastRunByKind(db).dlvr_backfill!;
  assert.deepEqual([run.status, run.fetched, run.matched, run.calls, run.rangeFrom, run.rangeTo], ['success', 1, 1, 1, '2026-06-01', '2026-06-30']);
});

test('백필: 실패하면 아무것도 저장하지 않고 사유를 기록한다', async () => {
  const db = setup();
  const client = fakeClient([page([item()]), new Error('연결 끊김'), new Error('연결 끊김'), new Error('연결 끊김')]);
  const r = await runDeliveryBackfill({ db, client, matcher, range: { from: '2026-06-01', to: '2026-07-31' }, maxCalls: 10, sleep: noSleep });
  assert.equal(r.status, 'failed');
  assert.deepEqual(listDeliveries(db, { from: '2026-01-01', to: '2026-12-31' }), []);
  assert.match(lastRunByKind(db).dlvr_backfill?.error ?? '', /연결 끊김/);
});

const seed = (db: ReturnType<typeof setup>, kind: 'dlvr_backfill' | 'dlvr_daily', from: string, to: string) => {
  const id = startRun(db, from, to, '2026-10-29T00:00:00Z', kind);
  finishRun(db, id, { status: 'success', fetched: 1, matched: 1, calls: 1, error: null }, '2026-10-29T00:01:00Z');
};

test('매일: 마지막 성공일 다음 날부터 어제까지에 최근 3일을 더해 한 번에 받고, 실행 기록의 끝 날짜가 다음 시작점이 된다', async () => {
  const db = setup();
  seed(db, 'dlvr_backfill', '2026-01-01', '2026-10-20');
  const client = fakeClient([page([item({ dlvrReqRcptDate: '2026-10-22' })])]);
  const r = await runDeliveryDaily({ db, client, matcher, today: '2026-10-25', maxCalls: 10, sleep: noSleep });
  assert.equal(r.status, 'success');
  // 마지막 성공일 10-20 → 받을 날 10-21~10-24, 최근 3일을 더해 10-18부터
  assert.deepEqual([client.calls[0]?.params['inqryBgnDate'], client.calls[0]?.params['inqryEndDate']], ['20261018', '20261024']);
  assert.deepEqual([lastRunByKind(db).dlvr_daily?.rangeFrom, lastRunByKind(db).dlvr_daily?.rangeTo], ['2026-10-18', '2026-10-24']);
  const next = fakeClient([page([])]);
  await runDeliveryDaily({ db, client: next, matcher, today: '2026-10-27', maxCalls: 10, sleep: noSleep });
  assert.deepEqual([next.calls[0]?.params['inqryBgnDate'], next.calls[0]?.params['inqryEndDate']], ['20261022', '20261026']);
});

const verify = (db: ReturnType<typeof setup>, client: ReturnType<typeof fakeClient>, days = 14) =>
  runDeliveryVerify({ db, client, matcher, today: '2026-10-30', days, maxCalls: 10, sleep: noSleep, now: () => '2026-10-30T00:00:00Z' });

test('교차 검증: 최근 N일을 다시 받아 저장하고, 새 행 중 다음 매일 수집의 되돌아보기 앞에 있는 것만 놓친 것으로 센다', async () => {
  const db = setup();
  await runDeliveryBackfill({ db, client: fakeClient([page([item({ dlvrReqNo: 'R1', dlvrReqRcptDate: '2026-10-20' })])]), matcher, range: { from: '2026-10-01', to: '2026-10-24' }, maxCalls: 10, sleep: noSleep });
  seed(db, 'dlvr_daily', '2026-10-22', '2026-10-25');
  const client = fakeClient([page([
    item({ dlvrReqNo: 'R1', dlvrReqRcptDate: '2026-10-20' }),
    item({ dlvrReqNo: 'R2', dlvrReqRcptDate: '2026-10-22' }),
    item({ dlvrReqNo: 'R3', dlvrReqRcptDate: '2026-10-23' }),
    item({ dlvrReqNo: 'R4', dlvrReqRcptDate: '2026-10-28' }),
  ])]);
  const r = await verify(db, client);
  assert.equal(r.status, 'success');
  // 기본 14일: 10-16 ~ 어제(10-29), 한 달 안이라 한 번 호출
  assert.deepEqual(client.calls.map((c) => [c.params['inqryBgnDate'], c.params['inqryEndDate']]), [['20261016', '20261029']]);
  // 매일 수집의 마지막 성공일 10-25 → 다음 매일 수집은 10-23부터 받는다. 10-22(R2)는 그보다 앞서 놓친 것, 10-23(R3) · 10-28(R4)은 어차피 받는다.
  assert.deepEqual([r.fetched, r.matched, r.newlyFound, r.missed], [4, 4, 3, 1]);
  assert.equal(listDeliveries(db, { from: '2026-10-01', to: '2026-10-31' }).length, 4);
  const run = lastRunByKind(db).dlvr_verify!;
  assert.deepEqual([run.status, run.rangeFrom, run.rangeTo, run.fetched, run.matched], ['success', '2026-10-16', '2026-10-29', 4, 4]);
  assert.match(run.note ?? '', /새로 찾은 납품요구 3행/);
  assert.match(run.note ?? '', /놓친 것 1행/);
});

test('교차 검증: 변경 차수가 새로 나타난 행도 새 행이고, 모두 이미 있으면 0행이다', async () => {
  const db = setup();
  await runDeliveryBackfill({ db, client: fakeClient([page([item({ dlvrReqNo: 'R1' })])]), matcher, range: { from: '2026-06-01', to: '2026-06-30' }, maxCalls: 10, sleep: noSleep });
  const same = await verify(db, fakeClient([page([item({ dlvrReqNo: 'R1' })])]), 29);
  assert.deepEqual([same.newlyFound, same.missed], [0, null]);
  const changed = await verify(db, fakeClient([page([item({ dlvrReqNo: 'R1' }), item({ dlvrReqNo: 'R1', dlvrReqChgOrd: '1' })])]), 29);
  assert.equal(changed.newlyFound, 1);
});

test('교차 검증: 매일 수집 기록이 없으면 놓침 여부를 판정하지 않고 그렇게 적는다', async () => {
  const db = setup();
  seed(db, 'dlvr_backfill', '2026-01-01', '2026-10-24');
  const r = await verify(db, fakeClient([page([item({ dlvrReqRcptDate: '2026-10-21' })])]));
  assert.deepEqual([r.newlyFound, r.missed], [1, null]);
  assert.match(lastRunByKind(db).dlvr_verify?.note ?? '', /판정 불가/);
});

test('교차 검증: 매일 수집의 시작점(dlvr_daily 기록)을 바꾸지 않는다', async () => {
  const db = setup();
  seed(db, 'dlvr_daily', '2026-10-01', '2026-10-20');
  await verify(db, fakeClient([page([])]));
  assert.deepEqual([lastRunByKind(db).dlvr_daily?.rangeFrom, lastRunByKind(db).dlvr_daily?.rangeTo], ['2026-10-01', '2026-10-20']);
  const next = fakeClient([page([])]);
  await runDeliveryDaily({ db, client: next, matcher, today: '2026-10-25', maxCalls: 10, sleep: noSleep });
  assert.equal(next.calls[0]?.params['inqryBgnDate'], '20261018');
});

test('교차 검증: 실패하면 아무것도 저장하지 않고 사유를 기록한다', async () => {
  const db = setup();
  const client = fakeClient([new Error('연결 끊김'), new Error('연결 끊김'), new Error('연결 끊김')]);
  const r = await verify(db, client);
  assert.equal(r.status, 'failed');
  assert.deepEqual(listDeliveries(db, { from: '2026-01-01', to: '2026-12-31' }), []);
  assert.match(lastRunByKind(db).dlvr_verify?.error ?? '', /연결 끊김/);
});

test('매일: 받을 날이 없으면 호출하지 않고, 시작점이 없으면 백필을 먼저 하라며 멈춘다', async () => {
  const db = setup();
  await assert.rejects(runDeliveryDaily({ db, client: fakeClient([]), matcher, today: '2026-10-25', maxCalls: 10 }), /납품요구 백필/);
  seed(db, 'dlvr_backfill', '2026-01-01', '2026-10-24');
  const none = fakeClient([]);
  const r = await runDeliveryDaily({ db, client: none, matcher, today: '2026-10-25', maxCalls: 10 });
  assert.equal(r.status, 'success');
  assert.equal(none.calls.length, 0);
});
