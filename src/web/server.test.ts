import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finishRun, startRun, upsertContracts, type ContractRow } from '../db/contracts.ts';
import { migrate, openDb } from '../db/index.ts';
import { buildServer } from './server.ts';

test('/health는 200과 ok를 반환한다', async () => {
  const app = buildServer();
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
  await app.close();
});

const row = (over: Partial<ContractRow> = {}): ContractRow => ({
  untyNo: 'R26TE00000001', companyId: 'sparrow', companyName: '주식회사 스패로우', bizNo: '1234567890',
  contractName: '보안 소프트웨어 구매', signedDate: '2026-10-21', registeredAt: '2026-10-21 09:30:00', amount: 1_234_567,
  contractOrg: '조달청', demanderName: '각 수요기관', demanderPlaceholder: true, method: '제3자단가계약',
  productIds: ['26181128'], productNames: ['플랫폼 Standard'], verified: true, idConflict: false, ...over,
});
const companies = [{ id: 'sparrow', label: '스패로우' }, { id: 'nilesoft', label: '나일소프트' }];

function setup(rows: ContractRow[] = []) {
  const db = openDb(':memory:');
  migrate(db);
  upsertContracts(db, rows, '2026-10-29T00:00:00Z');
  const app = buildServer({ db, companies, today: () => '2026-10-29' });
  return { db, app, get: (url: string) => app.inject({ method: 'GET', url }) };
}

test('db가 없으면 화면 경로는 없다', async () => {
  const res = await buildServer().inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 404);
});

test('기본 화면은 이번 달 계약을 HTML 표로 보여 준다', async () => {
  const { get } = setup([row(), row({ untyNo: 'OLD', signedDate: '2026-09-30', contractName: '지난달 계약' })]);
  const res = await get('/');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /text\/html/);
  assert.match(res.body, /보안 소프트웨어 구매/);
  assert.match(res.body, /스패로우/);
  assert.match(res.body, /1,234,567/);
  assert.match(res.body, /2026-10-01 ~ 2026-10-31/);
  assert.doesNotMatch(res.body, /지난달 계약/);
});

test('일 · 주 · 월 단위와 업체로 거른다', async () => {
  const { get } = setup([
    row({ untyNo: 'A', signedDate: '2026-10-29', contractName: '목요일 계약' }),
    row({ untyNo: 'B', signedDate: '2026-10-26', contractName: '월요일 계약', companyId: 'nilesoft', companyName: '(주)나일소프트' }),
    row({ untyNo: 'C', signedDate: '2026-10-05', contractName: '초순 계약' }),
  ]);
  const day = (await get('/?view=day&date=2026-10-29')).body;
  assert.match(day, /목요일 계약/);
  assert.doesNotMatch(day, /월요일 계약/);
  const week = (await get('/?view=week&date=2026-10-29')).body;
  assert.match(week, /목요일 계약/);
  assert.match(week, /월요일 계약/);
  assert.doesNotMatch(week, /초순 계약/);
  const onlyNile = (await get('/?view=month&date=2026-10-29&company=nilesoft')).body;
  assert.match(onlyNile, /월요일 계약/);
  assert.doesNotMatch(onlyNile, /목요일 계약/);
});

test('조달청 계약은 수요기관 미공개로, 기관 직접 계약은 기관 이름으로 보여 준다', async () => {
  const { get } = setup([
    row({ untyNo: 'P' }),
    row({ untyNo: 'D', demanderName: '국방과학연구소', demanderPlaceholder: false, contractOrg: '국방과학연구소' }),
  ]);
  const body = (await get('/')).body;
  assert.match(body, /수요기관 미공개/);
  assert.match(body, /국방과학연구소/);
});

test('확인 대상 · 식별번호 대조 필요 · 목록 밖 제품을 구분해 표시한다', async () => {
  const { get } = setup([
    row({ untyNo: 'V', verified: true, idConflict: false }),
    row({ untyNo: 'X', verified: true, idConflict: true }),
    row({ untyNo: 'N', verified: false, productIds: ['77777777'] }),
  ]);
  const body = (await get('/')).body;
  assert.match(body, /확인 대상/);
  assert.match(body, /대조 필요/);
  assert.match(body, /목록 밖/);
});

test('제품이 많으면 앞 2개만 보이고 나머지는 접어 둔다', async () => {
  const ids = ['10000001', '10000002', '10000003', '10000004'];
  const { get } = setup([row({ productIds: ids, productNames: ids.map((id) => `제품${id}`) })]);
  const body = (await get('/')).body;
  assert.match(body, /외 2개/);
  assert.match(body, /<details><summary>외 2개<\/summary>10000003 제품10000003<br>10000004 제품10000004<\/details>/);
  const few = setup([row({ productIds: ['10000001'], productNames: ['제품'] })]);
  assert.doesNotMatch((await few.get('/')).body, /<details>/);
});

test('데이터에 들어 있는 HTML은 이스케이프되어 실행되지 않는다', async () => {
  const { get } = setup([row({ contractName: '<script>alert(1)</script>', productNames: ['<img src=x onerror=alert(2)>'] })]);
  const res = await get('/');
  assert.doesNotMatch(res.body, /<script>alert\(1\)/);
  assert.doesNotMatch(res.body, /<img src=x/);
  assert.match(res.body, /&lt;script&gt;/);
  assert.match(res.headers['content-security-policy'] as string, /default-src 'none'/);
});

test('공동수급 계약의 금액은 합계에 한 번만 더하고, 제품 식별번호가 없으면 목록 밖이라 하지 않는다', async () => {
  const { get } = setup([
    row({ untyNo: 'J', companyId: 'sparrow', amount: 1000 }),
    row({ untyNo: 'J', companyId: 'nilesoft', companyName: '(주)나일소프트', amount: 1000 }),
    row({ untyNo: 'E', amount: 500, productIds: [], productNames: [], verified: false }),
  ]);
  const body = (await get('/')).body;
  assert.match(body, /3건 · 합계 1,500원/);
  assert.match(body, /제품 정보 없음/);
  assert.doesNotMatch(body, /목록 밖/);
});

test('결과가 없으면 빈 상태 문구를 보여 준다', async () => {
  const { get } = setup();
  assert.match((await get('/')).body, /해당 기간에 수집된 계약이 없습니다/);
});

test('수집 실행 상태: 기록 없음 / 성공 / 실패 사유', async () => {
  const { db, get } = setup();
  assert.match((await get('/')).body, /수집 기록이 없습니다/);
  const ok = startRun(db, '2026-01-01', '2026-10-28', '2026-10-29T00:00:00Z');
  finishRun(db, ok, { status: 'success', fetched: 420, matched: 11, calls: 21, error: null }, '2026-10-29T00:01:00Z');
  const success = (await get('/')).body;
  assert.match(success, /성공/);
  assert.match(success, /2026-01-01 ~ 2026-10-28/);
  assert.match(success, /호출 21회/);
  assert.match(success, /2026-10-29 09:01 한국시간/);
  const bad = startRun(db, '2026-10-01', '2026-10-28', '2026-10-30T00:00:00Z');
  finishRun(db, bad, { status: 'failed', fetched: 0, matched: 0, calls: 3, error: '나라장터 API 호출 실패: <b>x</b>' }, '2026-10-30T00:00:05Z');
  const failed = (await get('/')).body;
  assert.match(failed, /실패/);
  assert.match(failed, /나라장터 API 호출 실패: &lt;b&gt;x&lt;\/b&gt;/);
});

test('이전 · 다음 링크와 단위 전환 링크를 만든다', async () => {
  const { get } = setup();
  const body = (await get('/?view=month&date=2026-10-29&company=sparrow')).body;
  assert.match(body, /href="\/\?view=month&amp;date=2026-09-01&amp;company=sparrow"/);
  assert.match(body, /href="\/\?view=month&amp;date=2026-11-01&amp;company=sparrow"/);
  assert.match(body, /href="\/\?view=week&amp;date=2026-10-29&amp;company=sparrow"/);
});

test('잘못된 단위 · 날짜 · 업체는 400이다', async () => {
  const { get } = setup();
  for (const url of ['/?view=year', '/?date=2026-02-30', '/?date=abc', '/?company=nope']) {
    assert.equal((await get(url)).statusCode, 400, url);
  }
});
