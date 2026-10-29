import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finishRun, lastRun, lastRunByKind, listContracts, startRun, upsertContracts } from '../db/contracts.ts';
import { migrate, openDb } from '../db/index.ts';
import { createMatcher, parseMonitoringConfig } from '../filters/contracts.ts';
import { runCollection, runDaily, runVerify } from './run.ts';

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

// 하루치 등록일시 조회: 날짜별로 준비된 행을 돌려주는 가짜 클라이언트.
const BASE = 'getCntrctInfoListThng';
const regDay = (n: string, over: Record<string, string> = {}) => ({ ...master, untyCntrctNo: n, ...over });
function dayClient(byDay: Record<string, object[] | Error>) {
  const calls: { path: string; day?: string }[] = [];
  return {
    calls,
    async get(path: string, params: Record<string, string | number> = {}) {
      const day = String(params['inqryBgnDt'] ?? '').slice(0, 8) || undefined;
      calls.push({ path, ...(day ? { day } : {}) });
      if (path.endsWith('Detail')) return page([detail]);
      const rows = byDay[day ?? ''];
      if (rows instanceof Error) throw rows;
      return page(rows ?? []);
    },
  };
}
const noSleep = async () => {};
const seedBackfill = (db: ReturnType<typeof setup>, startedAt: string) => {
  const id = startRun(db, '2026-01-01', '2026-10-28', startedAt, 'backfill');
  finishRun(db, id, { status: 'success', fetched: 1, matched: 1, calls: 5, error: null }, startedAt);
};

test('매일 증분: 백필이 시작된 한국 날짜부터 어제까지 하루씩 받고 하루마다 실행 기록을 남긴다', async () => {
  const db = setup();
  seedBackfill(db, '2026-10-29T01:29:47Z'); // 한국 시간 10-29
  const client = dayClient({
    '20261029': [regDay('R26TE00000010'), regDay('R26TE00000011', { cntrctCnclsDate: '' })],
    '20261030': [regDay('R26TE00000012')],
  });
  const result = await runDaily({ db, client, matcher, today: '2026-10-31', maxCalls: 20, sleep: noSleep, now: () => '2026-10-31T00:00:00Z' });
  assert.equal(result.status, 'success');
  assert.equal(result.days, 2);
  assert.deepEqual(client.calls.filter((c) => c.path === BASE).map((c) => c.day), ['20261029', '20261030']);
  assert.deepEqual(listContracts(db, { from: '2026-10-01', to: '2026-10-31' }).map((r) => r.untyNo).sort(), ['R26TE00000010', 'R26TE00000012']);
  const daily = lastRunByKind(db).daily!;
  assert.deepEqual([daily.rangeFrom, daily.rangeTo, daily.status], ['2026-10-30', '2026-10-30', 'success']);
});

test('매일 증분: 다음 실행은 마지막 성공한 날 다음 날부터 이어 가고, 받을 날이 없으면 호출하지 않는다', async () => {
  const db = setup();
  seedBackfill(db, '2026-10-29T01:29:47Z');
  await runDaily({ db, client: dayClient({}), matcher, today: '2026-10-31', maxCalls: 20, sleep: noSleep });
  const client = dayClient({});
  await runDaily({ db, client, matcher, today: '2026-11-02', maxCalls: 20, sleep: noSleep });
  assert.deepEqual(client.calls.map((c) => c.day), ['20261031', '20261101']);
  const none = dayClient({});
  const again = await runDaily({ db, client: none, matcher, today: '2026-11-02', maxCalls: 20, sleep: noSleep });
  assert.equal(again.days, 0);
  assert.equal(none.calls.length, 0);
});

test('매일 증분: 중간 날짜에서 실패하면 앞 날짜는 저장하고 멈추며, 다음 실행은 실패한 날부터 다시 한다', async () => {
  const db = setup();
  seedBackfill(db, '2026-10-29T01:29:47Z');
  const fail = dayClient({ '20261029': [regDay('R26TE00000010')], '20261030': new Error('연결 끊김'), '20261031': [regDay('R26TE00000012')] });
  const result = await runDaily({ db, client: fail, matcher, today: '2026-11-01', maxCalls: 30, sleep: noSleep });
  assert.equal(result.status, 'failed');
  assert.equal(result.days, 1);
  assert.match(result.error ?? '', /연결 끊김/);
  assert.deepEqual(listContracts(db, { from: '2026-10-01', to: '2026-10-31' }).map((r) => r.untyNo), ['R26TE00000010']);
  assert.equal(lastRunByKind(db).daily?.status, 'failed');
  const retry = dayClient({ '20261030': [regDay('R26TE00000011')], '20261031': [regDay('R26TE00000012')] });
  const second = await runDaily({ db, client: retry, matcher, today: '2026-11-01', maxCalls: 30, sleep: noSleep });
  assert.equal(second.status, 'success');
  assert.deepEqual(retry.calls.filter((c) => c.path === BASE).map((c) => c.day), ['20261030', '20261031']);
});

test('매일 증분: 시작점(백필 · 증분 성공 기록)이 없으면 백필을 먼저 하라며 멈춘다', async () => {
  const db = setup();
  const client = dayClient({});
  await assert.rejects(runDaily({ db, client, matcher, today: '2026-10-31', maxCalls: 20 }), /백필/);
  assert.equal(client.calls.length, 0);
});

test('매일 증분: 호출 상한은 여러 날 전체에 걸쳐 센다', async () => {
  const db = setup();
  seedBackfill(db, '2026-10-29T01:29:47Z');
  const client = dayClient({});
  const result = await runDaily({ db, client, matcher, today: '2026-11-03', maxCalls: 2, sleep: noSleep });
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /호출 상한/);
  assert.equal(client.calls.length, 2);
  assert.equal(result.days, 2);
});

test('교차 검증: 최근 N일을 체결일자 방식으로 다시 받아, 증분이 놓쳤던 계약 수를 메모에 남기고 저장한다', async () => {
  const db = setup();
  // 이미 증분으로 저장된 계약 1건
  upsertContracts(db, [{
    untyNo: 'R26TE00000010', companyId: 'a', companyName: '주식회사 에이', bizNo: '1234567890', contractName: '구매', signedDate: '2026-10-21',
    registeredAt: '2026-10-21 09:30:00', amount: 100, contractOrg: '조달청', demanderName: '각 수요기관', demanderPlaceholder: true,
    method: '단가계약', productIds: ['33333333'], productNames: ['제품'], verified: true, idConflict: false,
  }], '2026-10-22T00:00:00Z');
  const calls: Record<string, string | number>[] = [];
  const client = {
    get: async (path: string, params: Record<string, string | number> = {}) => {
      if (path.endsWith('Detail')) return page([detail]);
      calls.push(params);
      return page([regDay('R26TE00000010'), regDay('R26TE00000020', { cntrctCnclsDate: '2026-10-25' })]);
    },
  };
  const result = await runVerify({ db, client, matcher, today: '2026-10-30', days: 14, maxCalls: 20, sleep: noSleep, now: () => '2026-10-30T00:00:00Z' });
  assert.equal(result.status, 'success');
  assert.equal(result.newlyFound, 1);
  assert.equal(result.missed, null); // 증분 성공 기록이 없어 판정 불가
  assert.deepEqual([calls[0]?.['inqryBgnDate'], calls[0]?.['inqryEndDate']], ['20261016', '20261029']);
  const run = lastRunByKind(db).verify!;
  assert.deepEqual([run.rangeFrom, run.rangeTo, run.status], ['2026-10-16', '2026-10-29', 'success']);
  assert.match(run.note ?? '', /새로 찾은 계약 1건/);
  assert.equal(listContracts(db, { from: '2026-10-01', to: '2026-10-31' }).length, 2);
});

test('교차 검증: 새로 찾은 계약이 없으면 그렇게 기록한다 / 실패하면 아무것도 저장하지 않는다', async () => {
  const db = setup();
  const client = { get: async (path: string) => (path.endsWith('Detail') ? page([detail]) : page([])) };
  await runVerify({ db, client, matcher, today: '2026-10-30', days: 14, maxCalls: 20, sleep: noSleep });
  assert.match(lastRunByKind(db).verify?.note ?? '', /새로 찾은 계약 0건/);
  const bad = { get: async () => { throw new Error('연결 끊김'); } };
  const failed = await runVerify({ db, client: bad, matcher, today: '2026-10-30', days: 14, maxCalls: 20, sleep: noSleep });
  assert.equal(failed.status, 'failed');
  assert.equal(lastRunByKind(db).verify?.status, 'failed');
});

test('매일 증분: from을 주면 시작점 계산 없이 그 날부터 어제까지 받는다 (시작점 기록이 없어도 된다)', async () => {
  const db = setup();
  const client = dayClient({ '20261027': [regDay('R26TE00000030')] });
  const result = await runDaily({ db, client, matcher, today: '2026-10-29', from: '2026-10-27', maxCalls: 20, sleep: noSleep });
  assert.equal(result.status, 'success');
  assert.deepEqual(client.calls.filter((c) => c.path === BASE).map((c) => c.day), ['20261027', '20261028']);
  assert.equal(listContracts(db, { from: '2026-10-01', to: '2026-10-31' }).length, 1);
  const none = dayClient({});
  assert.equal((await runDaily({ db, client: none, matcher, today: '2026-10-29', from: '2026-10-29', maxCalls: 20 })).days, 0);
  assert.equal(none.calls.length, 0);
});

test('교차 검증: 등록일이 증분이 이미 처리한 구간 안인 것만 증분이 놓친 것으로 센다 (아직 받을 차례가 아닌 것은 세지 않는다)', async () => {
  const db = setup();
  const d = startRun(db, '2026-10-26', '2026-10-26', '2026-10-27T00:00:00Z', 'daily');
  finishRun(db, d, { status: 'success', fetched: 1, matched: 0, calls: 5, error: null }, '2026-10-27T00:01:00Z');
  const client = {
    get: async (path: string) =>
      path.endsWith('Detail')
        ? page([detail])
        : page([
            regDay('R26TE00000040', { cntrctCnclsDate: '2026-10-20', rgstDt: '2026-10-21 10:00:00' }), // 증분 구간 안(10-21 <= 10-26): 놓친 것
            regDay('R26TE00000041', { cntrctCnclsDate: '2026-10-27', rgstDt: '2026-10-28 09:00:00' }), // 아직 증분 차례 전: 놓친 것 아님
          ]),
  };
  const result = await runVerify({ db, client, matcher, today: '2026-10-30', days: 14, maxCalls: 20, sleep: noSleep });
  assert.equal(result.newlyFound, 2);
  assert.equal(result.missed, 1);
  assert.match(lastRunByKind(db).verify?.note ?? '', /새로 찾은 계약 2건 · 그중 증분이 놓친 것 1건/);
});

test('증분의 시작점은 가장 늦은 성공일이다: 과거 구간을 --from으로 재수집해도 시작점이 뒤로 가지 않는다', async () => {
  const db = setup();
  const a = startRun(db, '2026-10-30', '2026-10-30', '2026-10-31T00:00:00Z', 'daily');
  finishRun(db, a, { status: 'success', fetched: 1, matched: 0, calls: 5, error: null }, '2026-10-31T00:01:00Z');
  const b = startRun(db, '2026-10-20', '2026-10-20', '2026-11-01T00:00:00Z', 'daily'); // 나중에 id가 큰 과거 재수집
  finishRun(db, b, { status: 'success', fetched: 1, matched: 0, calls: 5, error: null }, '2026-11-01T00:01:00Z');
  const client = dayClient({});
  await runDaily({ db, client, matcher, today: '2026-11-02', maxCalls: 20, sleep: noSleep });
  assert.deepEqual(client.calls.map((c) => c.day), ['20261031', '20261101']);
});
