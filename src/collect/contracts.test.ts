import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMatcher, parseMonitoringConfig } from '../filters/contracts.ts';
import { G2bResponseError } from '../g2b/response.ts';
import { collectContracts, createFetcher, PRODUCT_NAME } from './contracts.ts';

const CAT = '43233205';
const matcher = createMatcher(parseMonitoringConfig({
  categoryCodes: [CAT],
  companies: [
    { id: 'a', label: '에이', matchNames: ['주식회사 에이'], provisional: false, products: [{ id: '11111111', name: 'A1' }, { id: '33333333', name: 'A3' }] },
    { id: 'b', label: '비', matchNames: ['(주)비'], provisional: false, products: [{ id: '11111111', name: 'B1' }] },
  ],
}));

const corp = (name: string, seq = 1) => `[${seq}^법인사업자^단독^${name}^홍길동^대한민국^100^${name}^^1234567890]`;
const placeholder = '[1^ZZ99999^각 수요기관^중앙행정기관^^^]';
const master = (over: Record<string, string> = {}) => ({
  untyCntrctNo: 'R26TE00000001', cntrctNm: '보안 소프트웨어 구매', cntrctCnclsDate: '2026-10-21', rgstDt: '2026-10-21 09:30:00',
  thtmCntrctAmt: '1000000', cntrctInsttNm: '조달청', cntrctCnclsMthdNm: '제3자단가계약', corpList: corp('주식회사 에이'),
  dminsttList: placeholder, chgDt: '', ...over,
});
const detail = (id: string, cat = CAT) => ({ prdctClsfcNo: cat, prdctIdntNo: id, krnPrdctNm: `제품${id}`, prdctClsfcNoNm: '품명' });
const page = (items: object[], totalCount = items.length) => ({
  response: { header: { resultCode: '00', resultMsg: '정상' }, body: { items, numOfRows: 999, pageNo: 1, totalCount } },
});

type Call = { path: string; params: Record<string, string | number> };
// 오퍼레이션별로 준비된 응답을 차례로 돌려주는 가짜 클라이언트.
function fakeClient(responses: Record<string, unknown[]>) {
  const calls: Call[] = [];
  const queues = Object.fromEntries(Object.entries(responses).map(([k, v]) => [k, [...v]]));
  return {
    calls,
    async get(path: string, params: Record<string, string | number> = {}) {
      calls.push({ path, params });
      const next = queues[path]?.shift();
      if (next === undefined) throw new Error(`준비되지 않은 호출: ${path}`);
      if (next instanceof Error) throw next;
      return next;
    },
  };
}
const SRCH = 'getCntrctInfoListThngPPSSrch';
const DETAIL = 'getCntrctInfoListThngDetail';
const noSleep = async () => {};
const run = async (client: ReturnType<typeof fakeClient>, from = '2026-10-01', to = '2026-10-28', maxCalls = 50) => {
  const fetcher = createFetcher(client, { maxCalls, sleep: noSleep });
  const result = await collectContracts({ fetchPage: fetcher.fetchPage, matcher }, { from, to });
  return { ...result, calls: fetcher.calls() };
};

test('기간을 달력 월로 나눠 체결일자 검색을 호출하고 품명 필터를 건다', async () => {
  const client = fakeClient({ [SRCH]: [page([]), page([])] });
  await run(client, '2026-01-15', '2026-02-10');
  assert.deepEqual(client.calls.map((c) => c.params), [
    { inqryDiv: 1, inqryBgnDate: '20260115', inqryEndDate: '20260131', prdctClsfcNoNm: PRODUCT_NAME, numOfRows: 999, pageNo: 1 },
    { inqryDiv: 1, inqryBgnDate: '20260201', inqryEndDate: '20260210', prdctClsfcNoNm: PRODUCT_NAME, numOfRows: 999, pageNo: 1 },
  ]);
});

test('9개사가 든 계약만 세부 조회하고, 분류번호 · 식별번호를 판정해 저장 행을 만든다', async () => {
  const client = fakeClient({
    [SRCH]: [page([
      master(),
      master({ untyCntrctNo: 'R26TE00000002', corpList: corp('주식회사 다른회사') }),
    ])],
    [DETAIL]: [page([detail('33333333'), detail('99999999')])],
  });
  const { contracts, stats } = await run(client);
  assert.deepEqual(client.calls.filter((c) => c.path === DETAIL).map((c) => c.params), [{ inqryDiv: 2, untyCntrctNo: 'R26TE00000001', numOfRows: 100, pageNo: 1 }]);
  assert.deepEqual(contracts, [{
    untyNo: 'R26TE00000001', companyId: 'a', companyName: '주식회사 에이', bizNo: '1234567890', contractName: '보안 소프트웨어 구매',
    signedDate: '2026-10-21', registeredAt: '2026-10-21 09:30:00', amount: 1_000_000, contractOrg: '조달청', demanderName: '각 수요기관',
    demanderPlaceholder: true, method: '제3자단가계약', productIds: ['33333333', '99999999'], productNames: ['제품33333333', '제품99999999'],
    verified: true, idConflict: false,
  }]);
  assert.deepEqual(stats, { fetched: 2, blankSkipped: 0, companyMatched: 1, categoryMismatch: 0 });
});

test('실제 수요기관이 있으면 그 이름을 쓰고 자리표시자가 아니다', async () => {
  const client = fakeClient({
    [SRCH]: [page([master({ dminsttList: '[1^B552001^국방과학연구소^정부출자기관^연구지원부^홍^042-000-0000]', cntrctInsttNm: '국방과학연구소' })])],
    [DETAIL]: [page([detail('33333333')])],
  });
  const [c] = (await run(client)).contracts;
  assert.equal(c?.demanderName, '국방과학연구소');
  assert.equal(c?.demanderPlaceholder, false);
  assert.equal(c?.contractOrg, '국방과학연구소');
});

test('세부 조회의 분류번호가 보안 소프트웨어가 아니면 저장하지 않는다', async () => {
  const client = fakeClient({ [SRCH]: [page([master()])], [DETAIL]: [page([detail('33333333', '43211503')])] });
  const { contracts, stats } = await run(client);
  assert.deepEqual(contracts, []);
  assert.equal(stats.categoryMismatch, 1);
});

test('식별번호가 목록에 없는 신제품도 저장하되 확인 대상은 아니다', async () => {
  const client = fakeClient({ [SRCH]: [page([master()])], [DETAIL]: [page([detail('77777777')])] });
  const [c] = (await run(client)).contracts;
  assert.equal(c?.verified, false);
  assert.equal(c?.idConflict, false);
});

test('여러 업체의 목록에 걸친 식별번호는 대조 필요로 표시한다', async () => {
  const client = fakeClient({ [SRCH]: [page([master()])], [DETAIL]: [page([detail('11111111')])] });
  const [c] = (await run(client)).contracts;
  assert.equal(c?.verified, true);
  assert.equal(c?.idConflict, true);
});

test('공동수급으로 9개사가 둘이면 세부 조회는 한 번, 저장 행은 업체별로 둘', async () => {
  const client = fakeClient({
    [SRCH]: [page([master({ corpList: `${corp('주식회사 에이', 1)},${corp('(주)비', 2)}` })])],
    [DETAIL]: [page([detail('11111111')])],
  });
  const { contracts } = await run(client);
  assert.deepEqual(contracts.map((c) => c.companyId), ['a', 'b']);
  assert.equal(client.calls.filter((c) => c.path === DETAIL).length, 1);
});

test('체결일자가 빈 사전 등록 행은 버린다', async () => {
  const client = fakeClient({ [SRCH]: [page([master({ cntrctCnclsDate: '' })])] });
  const { contracts, stats } = await run(client);
  assert.deepEqual(contracts, []);
  assert.equal(stats.blankSkipped, 1);
  assert.equal(client.calls.filter((c) => c.path === DETAIL).length, 0);
});

test('금액이 비었거나 숫자가 아니면 null이다', async () => {
  const client = fakeClient({
    [SRCH]: [page([master({ thtmCntrctAmt: '' }), master({ untyCntrctNo: 'R26TE00000009', thtmCntrctAmt: 'abc' })])],
    [DETAIL]: [page([detail('33333333')]), page([detail('33333333')])],
  });
  assert.deepEqual((await run(client)).contracts.map((c) => c.amount), [null, null]);
});

test('한 페이지보다 많으면 다음 페이지를 이어서 받는다', async () => {
  const client = fakeClient({
    [SRCH]: [page([master({ corpList: corp('없는회사1') })], 2), page([master({ untyCntrctNo: 'R26TE00000003', corpList: corp('없는회사2') })], 2)],
  });
  const { stats } = await run(client);
  assert.equal(stats.fetched, 2);
  assert.deepEqual(client.calls.map((c) => c.params['pageNo']), [1, 2]);
});

test('같은 통합계약번호가 페이지 사이에 겹쳐 와도 한 번만 센다', async () => {
  const client = fakeClient({
    [SRCH]: [page([master()], 2), page([master()], 2)],
    [DETAIL]: [page([detail('33333333')])],
  });
  const { contracts } = await run(client);
  assert.equal(contracts.length, 1);
});

test('네트워크 오류는 재시도해서 성공하고, 시도마다 호출 수에 센다', async () => {
  const client = fakeClient({ [SRCH]: [new Error('boom'), page([])] });
  const { calls } = await run(client);
  assert.equal(calls, 2);
});

test('3번 모두 실패하면 오류를 던진다', async () => {
  const client = fakeClient({ [SRCH]: [new Error('boom1'), new Error('boom2'), new Error('boom3')] });
  await assert.rejects(run(client), /boom3/);
  assert.equal(client.calls.length, 3);
});

test('서비스가 알려 준 오류(결과코드)는 재시도하지 않는다', async () => {
  const wrapped = { 'nkoneps.com.response.ResponseError': { header: { resultCode: '07', resultMsg: '입력범위값 초과 에러' } } };
  const client = fakeClient({ [SRCH]: [wrapped, page([])] });
  await assert.rejects(run(client), (err: unknown) => err instanceof G2bResponseError && err.code === '07');
  assert.equal(client.calls.length, 1);
});

test('재시도 중에 호출 상한에 닿으면 직전 오류를 함께 알리고 기다리지 않는다', async () => {
  const client = fakeClient({ [SRCH]: [new Error('boom'), new Error('boom2'), page([])] });
  const sleeps: number[] = [];
  const fetcher = createFetcher(client, { maxCalls: 2, sleep: async (ms) => { sleeps.push(ms); } });
  await assert.rejects(
    fetcher.fetchPage(SRCH, {}),
    (err: Error) => /호출 상한\(2회\)/.test(err.message) && /직전 오류: boom2/.test(err.message),
  );
  assert.deepEqual(sleeps, [2000]);
  assert.equal(client.calls.length, 2);
});

test('호출 상한을 넘기면 더 호출하지 않고 멈춘다', async () => {
  const client = fakeClient({ [SRCH]: [page([]), page([]), page([])] });
  await assert.rejects(run(client, '2026-01-01', '2026-03-31', 2), /호출 상한/);
  assert.equal(client.calls.length, 2);
});
