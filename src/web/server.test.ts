import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finishRun, startRun, upsertContracts, type ContractRow } from '../db/contracts.ts';
import { upsertAwards, type AwardRow } from '../db/awards.ts';
import { upsertBids, type BidRow } from '../db/bids.ts';
import { upsertDeliveries, type DeliveryRow } from '../db/deliveries.ts';
import ExcelJS from 'exceljs';
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
  assert.match((await get('/admin')).body, /수집 기록이 없습니다/);
  const ok = startRun(db, '2026-01-01', '2026-10-28', '2026-10-29T00:00:00Z');
  finishRun(db, ok, { status: 'success', fetched: 420, matched: 11, calls: 21, error: null }, '2026-10-29T00:01:00Z');
  const success = (await get('/admin')).body;
  assert.match(success, /성공/);
  assert.match(success, /2026-01-01 ~ 2026-10-28/);
  assert.match(success, /호출 21회/);
  assert.match(success, /2026-10-29 09:01 한국시간/);
  const bad = startRun(db, '2026-10-01', '2026-10-28', '2026-10-30T00:00:00Z');
  finishRun(db, bad, { status: 'failed', fetched: 0, matched: 0, calls: 3, error: '나라장터 API 호출 실패: <b>x</b>' }, '2026-10-30T00:00:05Z');
  const failed = (await get('/admin')).body;
  assert.match(failed, /실패/);
  assert.match(failed, /나라장터 API 호출 실패: &lt;b&gt;x&lt;\/b&gt;/);
  // 수집 상태는 관리 화면에만 보인다(사람 요구, 2026-10-29).
  for (const url of ['/', '/deliveries', '/bids']) assert.doesNotMatch((await get(url)).body, /마지막 수집 상태|한국시간|npm run collect/, url);
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

test('수집 상태는 매일 증분 · 교차 검증 · 백필을 각각 보여 주고 교차 검증 메모도 보여 준다', async () => {
  const { db, get } = setup();
  const b = startRun(db, '2026-01-01', '2026-10-28', '2026-10-29T00:00:00Z', 'backfill');
  finishRun(db, b, { status: 'success', fetched: 423, matched: 11, calls: 21, error: null }, '2026-10-29T00:01:00Z');
  const d = startRun(db, '2026-10-29', '2026-10-29', '2026-10-30T00:00:00Z', 'daily');
  finishRun(db, d, { status: 'success', fetched: 4200, matched: 1, calls: 7, error: null }, '2026-10-30T00:02:00Z');
  const v = startRun(db, '2026-10-16', '2026-10-29', '2026-10-31T00:00:00Z', 'verify');
  finishRun(db, v, { status: 'success', fetched: 40, matched: 2, calls: 4, error: null, note: '교차 검증: 새로 찾은 계약 1건' }, '2026-10-31T00:01:00Z');
  const body = (await get('/admin')).body;
  assert.match(body, /매일 증분\(등록일시\)/);
  assert.match(body, /교차 검증/);
  assert.match(body, /백필\(체결일자\)/);
  assert.match(body, /새로 찾은 계약 1건/);
  assert.match(body, /호출 7회/);
  assert.ok(body.indexOf('매일 증분') < body.indexOf('교차 검증') && body.indexOf('교차 검증') < body.indexOf('백필'));
});

// ---- 납품요구 화면 ----
const dRow = (over: Partial<DeliveryRow> = {}): DeliveryRow => ({
  dlvrReqNo: 'R26TB01997234', requestName: '정보보안 솔루션 구매', chgOrd: 0, prdctSno: '1', companyId: 'nilesoft', companyName: '(주)나일소프트', bizNo: '1234567890',
  receivedDate: '2026-06-08', demanderCode: '1790364', demanderName: '고위공직자범죄수사처', demanderKind: '중앙행정기관',
  productClassNo: '43233205', productClassName: '트랜잭션보안및바이러스보호소프트웨어', productId: '24590125', productName: '웹방화벽',
  unitPrice: 45_500_000, qty: 2, amount: 91_000_000, deadline: '2026-07-08', contractNo: '002461624', contractStyle: '제3자단가계약',
  finalYn: true, incdecQty: 2, incdecAmt: 91_000_000, verified: false, idConflict: false, ...over,
});

function setupD(rows: DeliveryRow[] = []) {
  const db = openDb(':memory:');
  migrate(db);
  upsertDeliveries(db, rows, '2026-10-29T00:00:00Z');
  const app = buildServer({ db, companies, today: () => '2026-06-15' });
  return { db, app, get: (url: string) => app.inject({ method: 'GET', url }) };
}

test('납품요구 화면: 접수일자 기준으로 수요기관 · 물품 · 수량 · 금액을 보여 준다', async () => {
  const { get } = setupD([dRow(), dRow({ dlvrReqNo: 'OLD', receivedDate: '2026-05-31', demanderName: '지난달 기관' })]);
  const res = await get('/deliveries');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /text\/html/);
  assert.match(res.body, /고위공직자범죄수사처/);
  assert.match(res.body, /\(주\)나일소프트/);
  assert.match(res.body, /24590125/);
  assert.match(res.body, /웹방화벽/);
  assert.match(res.body, /91,000,000/);
  assert.match(res.body, /45,500,000/);
  assert.match(res.body, /2026-06-01 ~ 2026-06-30/);
  assert.doesNotMatch(res.body, /지난달 기관/);
});

test('납품요구 화면: 일 · 주 · 업체로 거르고 건수 · 수요기관 수 · 금액 합계를 보여 준다', async () => {
  const { get } = setupD([
    dRow({ dlvrReqNo: 'A', receivedDate: '2026-06-15', amount: 100, demanderCode: '111', demanderName: '가 기관' }),
    dRow({ dlvrReqNo: 'A', prdctSno: '2', receivedDate: '2026-06-15', amount: 50, demanderCode: '111', demanderName: '가 기관' }),
    dRow({ dlvrReqNo: 'B', receivedDate: '2026-06-10', amount: 10, companyId: 'sparrow', companyName: '주식회사 스패로우', demanderCode: '222', demanderName: '나 기관' }),
  ]);
  const month = (await get('/deliveries?view=month&date=2026-06-15')).body;
  assert.match(month, /3행 · 납품요구 2건 · 수요기관 2곳 · 합계 160원/);
  const day = (await get('/deliveries?view=day&date=2026-06-15')).body;
  assert.match(day, /2행 · 납품요구 1건 · 수요기관 1곳 · 합계 150원/);
  const company = (await get('/deliveries?view=month&date=2026-06-15&company=sparrow')).body;
  assert.match(company, /1행/);
  assert.doesNotMatch(company, /가 기관/);
});

test('납품요구 화면: 확인 대상 · 목록 밖 · 대조 필요 · 최종 아님 · 변경 차수 표시', async () => {
  const { get } = setupD([
    dRow({ dlvrReqNo: 'V', verified: true }),
    dRow({ dlvrReqNo: 'X', verified: true, idConflict: true }),
    dRow({ dlvrReqNo: 'N', verified: false }),
    dRow({ dlvrReqNo: 'F', finalYn: false, chgOrd: 2 }),
    dRow({ dlvrReqNo: 'C', chgOrd: 1, qty: 0, amount: 0, incdecQty: -2, incdecAmt: -91_000_000 }),
    dRow({ dlvrReqNo: 'E', productId: '', productName: '' }),
  ]);
  const body = (await get('/deliveries')).body;
  assert.match(body, /확인 대상/);
  assert.match(body, /대조 필요/);
  assert.match(body, /목록 밖/);
  assert.match(body, /최종 아님/);
  assert.match(body, /변경 2차/);
  assert.match(body, /취소\(수량 0\)/);
  assert.match(body, /제품 정보 없음/);
});

test('납품요구 화면: 데이터의 HTML은 이스케이프되고, 빈 상태 · 수집 상태 · 잘못된 조건 처리', async () => {
  const xss = setupD([dRow({ demanderName: '<script>alert(1)</script>', productName: '<img src=x onerror=alert(2)>' })]);
  const body = (await xss.get('/deliveries')).body;
  assert.doesNotMatch(body, /<script>alert\(1\)/);
  assert.doesNotMatch(body, /<img src=x/);
  assert.match(body, /&lt;script&gt;/);

  const { db, get } = setupD();
  assert.match((await get('/deliveries')).body, /해당 기간에 수집된 납품요구가 없습니다/);
  assert.match((await get('/admin')).body, /납품요구 수집 기록이 없습니다/);
  const r = startRun(db, '2026-01-01', '2026-10-28', '2026-10-29T00:00:00Z', 'dlvr_backfill');
  finishRun(db, r, { status: 'success', fetched: 1288, matched: 13, calls: 2, error: null }, '2026-10-29T00:01:00Z');
  const status = (await get('/admin')).body;
  assert.match(status, /납품요구 백필/);
  assert.match(status, /납품요구 13행 저장/);
  for (const url of ['/deliveries?view=year', '/deliveries?date=abc', '/deliveries?company=nope']) assert.equal((await get(url)).statusCode, 400, url);
});

test('계약 · 납품요구 화면은 서로 이동하는 링크를 갖고 수집 상태는 보여 주지 않는다 (수집 상태는 관리 화면에만)', async () => {
  const { db, get } = setupD();
  const b = startRun(db, '2026-01-01', '2026-10-28', '2026-10-29T00:00:00Z', 'backfill');
  finishRun(db, b, { status: 'success', fetched: 423, matched: 11, calls: 21, error: null }, '2026-10-29T00:01:00Z');
  const contracts = (await get('/?view=month&date=2026-06-15&company=sparrow')).body;
  assert.match(contracts, /href="\/deliveries\?view=month&amp;date=2026-06-15&amp;company=sparrow"/);
  assert.doesNotMatch(contracts, /백필\(체결일자\)/);
  const deliveries = (await get('/deliveries?view=month&date=2026-06-15')).body;
  assert.match(deliveries, /href="\/\?view=month&amp;date=2026-06-15"/);
  assert.doesNotMatch(deliveries, /백필\(체결일자\)/);
  assert.match((await get('/admin')).body, /백필\(체결일자\)/);
});

// ---- 엑셀 내보내기 ----
function setupX() {
  const db = openDb(':memory:');
  migrate(db);
  upsertContracts(db, [
    row({ untyNo: 'C1', signedDate: '2026-06-24', contractName: '6월 계약' }),
    row({ untyNo: 'C2', signedDate: '2026-07-01', contractName: '7월 계약' }),
    row({ untyNo: 'C3', signedDate: '2026-06-02', contractName: '6월 나일 계약', companyId: 'nilesoft', companyName: '(주)나일소프트' }),
  ], '2026-10-29T00:00:00Z');
  upsertDeliveries(db, [
    dRow({ dlvrReqNo: 'D1', receivedDate: '2026-06-08', demanderName: '6월 기관' }),
    dRow({ dlvrReqNo: 'D2', receivedDate: '2026-05-31', demanderName: '5월 기관' }),
    dRow({ dlvrReqNo: 'D3', receivedDate: '2026-06-09', companyId: 'sparrow', companyName: '주식회사 스패로우', demanderName: '스패로우 기관' }),
  ], '2026-10-29T00:00:00Z');
  const app = buildServer({ db, companies, today: () => '2026-06-15', categoryCode: '43233205' });
  return { get: (url: string) => app.inject({ method: 'GET', url }) };
}

async function load(res: { rawPayload: Buffer }): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
  return wb;
}

test('엑셀: 고른 날짜가 속한 달 전체를 두 시트로 내려받는다 (일/주 보기여도 그 달 전체)', async () => {
  const { get } = setupX();
  const res = await get('/export.xlsx?view=day&date=2026-06-15');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(res.headers['content-disposition'] as string, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
  assert.match(res.headers['content-disposition'] as string, new RegExp(encodeURIComponent('경쟁사_실적_2026-06.xlsx')));
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['cache-control'], 'no-store');
  const wb = await load(res);
  const names = (ws: ExcelJS.Worksheet) => ws.getColumn(3).values.slice(2);
  assert.deepEqual(names(wb.getWorksheet('납품요구')!).sort(), ['6월 기관', '스패로우 기관']);
  assert.equal(wb.getWorksheet('계약')!.rowCount, 3); // 머리글 + 6월 계약 2건
});

test('엑셀: 업체를 고르면 그 업체만, 파일명에 업체 이름이 붙는다', async () => {
  const { get } = setupX();
  const res = await get('/export.xlsx?date=2026-06-15&company=sparrow');
  assert.match(res.headers['content-disposition'] as string, new RegExp(encodeURIComponent('경쟁사_실적_2026-06_스패로우.xlsx')));
  const wb = await load(res);
  assert.deepEqual(wb.getWorksheet('납품요구')!.getColumn(3).values.slice(2), ['스패로우 기관']);
  assert.deepEqual(wb.getWorksheet('계약')!.getColumn(4).values.slice(2), ['6월 계약']);
});

test('엑셀: 잘못된 조건은 400, db가 없으면 경로가 없다', async () => {
  const { get } = setupX();
  for (const url of ['/export.xlsx?date=abc', '/export.xlsx?date=2026-02-30', '/export.xlsx?company=nope', '/export.xlsx?view=year']) {
    assert.equal((await get(url)).statusCode, 400, url);
  }
  assert.equal((await buildServer().inject({ method: 'GET', url: '/export.xlsx' })).statusCode, 404);
});

test('두 화면에 엑셀 내보내기 링크가 있고 화면 조건(날짜 · 업체)을 그대로 싣는다', async () => {
  const { get } = setupX();
  const contracts = (await get('/?view=week&date=2026-06-15&company=sparrow')).body;
  const deliveries = (await get('/deliveries?view=day&date=2026-06-15&company=sparrow')).body;
  for (const body of [contracts, deliveries]) {
    assert.match(body, /href="\/export\.xlsx\?date=2026-06-15&amp;company=sparrow"[^>]*>엑셀 내보내기/);
  }
});

test('엑셀: 업체 이름의 따옴표 · 괄호 · 개행이 있어도 헤더가 깨지지 않는다 (RFC 5987 인코딩)', async () => {
  const db = openDb(':memory:');
  migrate(db);
  const app = buildServer({ db, companies: [{ id: 'x', label: "a'b(c)*\r\nd" }], today: () => '2026-06-15', categoryCode: '43233205' });
  const res = await app.inject({ method: 'GET', url: '/export.xlsx?date=2026-06-15&company=x' });
  const header = res.headers['content-disposition'] as string;
  assert.equal(res.statusCode, 200);
  assert.ok(!/[\r\n]/.test(header));
  const star = header.split("filename*=UTF-8''")[1]!;
  assert.ok(!/['()*]/.test(star), star);
  assert.equal(decodeURIComponent(star), "경쟁사_실적_2026-06_a'b(c)___d.xlsx");
});

// ---- 입찰공고 화면 ----
const bRow = (over: Partial<BidRow> = {}): BidRow => ({
  bidNtceNo: 'R26BK01000001', bidNtceOrd: '000', title: '소스코드 보안약점 진단 용역', status: '일반공고', workKind: '용역',
  noticeDate: '2026-10-27', noticeTime: '09:30', demanderName: '한국정보보호진흥원', demanderCode: '1234567', noticeOrgName: '한국정보보호진흥원',
  noticeOrgCode: '1234567', estimatedPrice: 90_000_000, budgetAmount: 99_000_000, bidBegin: '2026-10-27 09:30', regClose: '2026-11-03 17:00',
  bidClose: '2026-11-05 10:00', opening: '2026-11-05 11:00', url: 'https://www.g2b.go.kr/x?bidno=R26BK01000001', contractMethod: '제한경쟁',
  keywords: ['소스코드', '보안약점'], ...over,
});

function setupB(rows: BidRow[] = []) {
  const db = openDb(':memory:');
  migrate(db);
  upsertBids(db, rows, '2026-10-29T00:00:00Z');
  const app = buildServer({ db, companies, today: () => '2026-10-29', keywords: ['소스코드', '보안약점', '솔루션'] });
  return { db, app, get: (url: string) => app.inject({ method: 'GET', url }) };
}

test('입찰공고 화면: 공고명 · 수요처 · 추정가격 · 입찰일 · 등록마감 · 투찰마감 · 개찰 · 공고 링크를 보여 준다', async () => {
  const { get } = setupB([bRow(), bRow({ bidNtceNo: 'OLD', noticeDate: '2026-09-30', title: '지난달 공고' })]);
  const res = await get('/bids');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /text\/html/);
  const body = res.body;
  assert.match(body, /소스코드 보안약점 진단 용역/);
  assert.match(body, /한국정보보호진흥원/);
  assert.match(body, /90,000,000/);
  assert.match(body, /배정예산 99,000,000/);
  assert.match(body, /2026-10-27 09:30/);
  assert.match(body, /2026-11-03 17:00/);
  assert.match(body, /2026-11-05 10:00/);
  assert.match(body, /href="https:\/\/www\.g2b\.go\.kr\/x\?bidno=R26BK01000001" target="_blank" rel="noopener noreferrer">공고 보기/);
  assert.match(body, /2026-10-01 ~ 2026-10-31/);
  assert.doesNotMatch(body, /지난달 공고/);
});

test('입찰공고 화면: 수요기관 · 키워드 · 일/주 기간으로 거르고 요약을 보여 준다', async () => {
  const { get } = setupB([
    bRow({ bidNtceNo: 'A', noticeDate: '2026-10-29', demanderName: '가 기관', title: '가 공고', keywords: ['솔루션'] }),
    bRow({ bidNtceNo: 'B', noticeDate: '2026-10-27', demanderName: '나 기관', title: '나 공고', keywords: ['소스코드'] }),
    bRow({ bidNtceNo: 'C', noticeDate: '2026-10-05', demanderName: '가 기관', title: '다 공고', keywords: ['소스코드'] }),
  ]);
  const month = (await get('/bids?view=month&date=2026-10-29')).body;
  assert.match(month, /3건 · 수요기관 2곳/);
  const day = (await get('/bids?view=day&date=2026-10-29')).body;
  assert.match(day, /가 공고/);
  assert.doesNotMatch(day, /나 공고/);
  const week = (await get('/bids?view=week&date=2026-10-29')).body;
  assert.match(week, /가 공고/);
  assert.match(week, /나 공고/);
  assert.doesNotMatch(week, /다 공고/);
  const org = (await get('/bids?date=2026-10-29&demander=' + encodeURIComponent('가 기관'))).body;
  assert.match(org, /가 공고/);
  assert.match(org, /다 공고/);
  assert.doesNotMatch(org, /나 공고/);
  const kw = (await get('/bids?date=2026-10-29&keyword=' + encodeURIComponent('솔루션'))).body;
  assert.match(kw, /가 공고/);
  assert.doesNotMatch(kw, /나 공고/);
  // 수요기관 선택지는 그 기간에 나온 기관, 키워드 선택지는 설정의 키워드다.
  assert.match(month, /<option value="나 기관">/);
  assert.match(month, /<option value="솔루션">/);
});

test('입찰공고 화면: 상태 · 업무구분 · 키워드 표시, 링크는 http(s)만 링크로 만든다', async () => {
  const { get } = setupB([
    bRow({ bidNtceNo: 'S', status: '정정공고', bidNtceOrd: '001' }),
    bRow({ bidNtceNo: 'T', status: '취소공고' }),
    bRow({ bidNtceNo: 'J', url: 'javascript:alert(1)' }),
    bRow({ bidNtceNo: 'N', url: '', estimatedPrice: null, budgetAmount: null, regClose: '' }),
  ]);
  const body = (await get('/bids')).body;
  assert.match(body, /정정공고/);
  assert.match(body, /취소공고/);
  assert.match(body, /차수 001/);
  assert.match(body, /용역/);
  assert.match(body, /소스코드/);
  assert.doesNotMatch(body, /href="javascript:/);
  assert.doesNotMatch(body, /javascript:alert/);
});

test('입찰공고 화면: 데이터의 HTML은 이스케이프되고, 빈 상태 · 수집 상태 · 잘못된 조건 처리', async () => {
  const xss = setupB([bRow({ title: '<script>alert(1)</script>', demanderName: '<img src=x onerror=alert(2)>' })]);
  const body = (await xss.get('/bids')).body;
  assert.doesNotMatch(body, /<script>alert\(1\)/);
  assert.doesNotMatch(body, /<img src=x/);
  assert.match(body, /&lt;script&gt;/);

  const { db, get } = setupB();
  assert.match((await get('/bids')).body, /해당 기간에 수집된 입찰공고가 없습니다/);
  assert.match((await get('/admin')).body, /입찰공고 수집 기록이 없습니다/);
  const r = startRun(db, '2026-10-28', '2026-10-28', '2026-10-29T00:00:00Z', 'bid_daily');
  finishRun(db, r, { status: 'success', fetched: 1906, matched: 7, calls: 4, error: null }, '2026-10-29T00:01:00Z');
  const status = (await get('/admin')).body;
  assert.match(status, /입찰공고 매일/);
  assert.match(status, /수신 1906건 · 키워드 적중 7건 저장/);
  for (const url of ['/bids?view=year', '/bids?date=abc', '/bids?keyword=nope', '/bids?demander=' + 'x'.repeat(201)]) assert.equal((await get(url)).statusCode, 400, url);
});

test('세 화면은 서로 이동하는 링크를 갖고, 입찰공고 화면에는 엑셀 링크가 없다', async () => {
  const { get } = setupB();
  for (const url of ['/', '/deliveries', '/bids']) {
    const body = (await get(url)).body;
    assert.match(body, /href="\/bids\?view=month&amp;date=2026-10-29"[^>]*>입찰공고/);
    assert.match(body, /href="\/\?view=month&amp;date=2026-10-29"[^>]*>계약/);
    assert.match(body, /href="\/admin"[^>]*>관리/);
  }
  assert.doesNotMatch((await get('/bids')).body, /export\.xlsx/);
});

test('입찰공고 화면: 고른 수요기관이 그 기간에 없어도 선택 상자에 남는다 (기간 이동 후 조건이 조용히 바뀌지 않게)', async () => {
  const { get } = setupB([bRow({ demanderName: '가 기관' })]);
  const body = (await get('/bids?date=2026-12-01&demander=' + encodeURIComponent('가 기관'))).body;
  assert.match(body, /<option value="가 기관" selected>/);
  assert.match(body, /0건/);
});

// ---- 관리 화면 ----
test('관리 화면: 계약 · 납품요구 · 입찰공고 · 낙찰정보 수집 상태를 묶음별로 보여 주고, 접근 제한 없이 링크로 들어간다', async () => {
  const { db, get } = setupB();
  const res = await get('/admin');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /text\/html/);
  for (const title of ['계약(경쟁사) 수집', '납품요구 수집', '입찰공고 수집', '낙찰정보 수집']) assert.match(res.body, new RegExp(title.replace(/[()]/g, '\\$&')), title);
  assert.equal((res.body.match(/수집 기록이 없습니다/g) ?? []).length, 4);
  const a = startRun(db, '2026-10-28', '2026-10-28', '2026-10-29T00:00:00Z', 'award_daily');
  finishRun(db, a, { status: 'success', fetched: 45484, matched: 5, calls: 46, error: null, note: '쪽 이동 확인: 2번 받음, 고유 45484행' }, '2026-10-29T00:03:00Z');
  const after = (await get('/admin')).body;
  assert.match(after, /낙찰정보 매일/);
  assert.match(after, /수신 45484행 · 키워드 적중 공고 5건 저장/);
  assert.match(after, /쪽 이동 확인/);
  assert.equal((after.match(/수집 기록이 없습니다/g) ?? []).length, 3);
  assert.match(after, /href="\/"[^>]*>계약/);
});

// ---- 낙찰정보 (입찰공고 화면의 두 번째 목록) ----
const aRow = (over: Partial<AwardRow> = {}): AwardRow => ({
  bidNtceNo: 'R26BK01000001', bidNtceOrd: '000', title: '소스코드 보안약점 진단 용역', workKind: '용역', demanderName: '한국정보보호진흥원', demanderCode: '1234567',
  estimatedPrice: 90_000_000, reservePrice: 88_000_000, baseAmount: 89_000_000, opening: '2026-10-27 11:00', result: '개찰완료', bidderCount: 3,
  winnerName: '주식회사 낙찰', winnerAmount: 80_000_000, winnerRate: 89.9, winnerDate: '2026-10-28', keywords: ['소스코드'], ...over,
});

test('입찰공고 화면: 낙찰정보 목록에 공고명 · 수요처 · 기초금액 · 낙찰처 · 낙찰금액 · 공고 링크를 보여 준다', async () => {
  const { db, get } = setupB([bRow()]);
  upsertAwards(db, [aRow(), aRow({ bidNtceNo: 'OLD', opening: '2026-09-30 11:00', title: '지난달 낙찰' })], '2026-10-29T00:00:00Z');
  const body = (await get('/bids')).body;
  assert.match(body, /<h2>낙찰정보<\/h2>/);
  assert.match(body, /주식회사 낙찰/);
  assert.match(body, /89,000,000/);
  assert.match(body, /80,000,000/);
  assert.match(body, /낙찰률 89\.9%/);
  assert.match(body, /2026-10-27 11:00/);
  assert.match(body, /href="https:\/\/www\.g2b\.go\.kr\/x\?bidno=R26BK01000001"/);
  assert.doesNotMatch(body, /지난달 낙찰/);
});

test('입찰공고 화면: 낙찰자 미확정 · 유찰 · 공고 없는 단독 낙찰을 구분해서 보여 준다', async () => {
  const { db, get } = setupB([bRow()]);
  upsertAwards(db, [
    aRow({ bidNtceNo: 'P', winnerName: '', winnerAmount: null, winnerRate: null, winnerDate: '' }),
    aRow({ bidNtceNo: 'F', result: '유찰', winnerName: '', winnerAmount: null, winnerRate: null, winnerDate: '' }),
    aRow({ bidNtceNo: 'ALONE' }),
  ], '2026-10-29T00:00:00Z');
  const body = (await get('/bids')).body;
  assert.match(body, /낙찰자 미확정/);
  assert.match(body, /유찰/);
  assert.match(body, /공고 미수집\(단독\)/);
});

test('입찰공고 화면: 수요기관 · 키워드 조건이 낙찰정보에도 적용되고 요약에 낙찰 건수가 들어간다', async () => {
  const { db, get } = setupB([bRow({ demanderName: '가 기관' })]);
  upsertAwards(db, [
    aRow({ bidNtceNo: 'A', title: '가 낙찰', demanderName: '가 기관', keywords: ['솔루션'] }),
    aRow({ bidNtceNo: 'B', title: '나 낙찰', demanderName: '나 기관', keywords: ['소스코드'] }),
  ], '2026-10-29T00:00:00Z');
  const all = (await get('/bids')).body;
  assert.match(all, /1건 · 수요기관 1곳 · 낙찰 2건/);
  const org = (await get('/bids?demander=' + encodeURIComponent('가 기관'))).body;
  assert.match(org, /가 낙찰/);
  assert.doesNotMatch(org, /나 낙찰/);
  const kw = (await get('/bids?keyword=' + encodeURIComponent('소스코드'))).body;
  assert.match(kw, /나 낙찰/);
  assert.doesNotMatch(kw, /가 낙찰/);
  assert.match(all, /<option value="나 기관">/);
});

test('입찰공고 화면: 낙찰정보의 HTML도 이스케이프되고, 낙찰 목록이 비면 빈 상태 문구를 보여 준다', async () => {
  const { db, get } = setupB([bRow()]);
  assert.match((await get('/bids')).body, /해당 기간에 수집된 낙찰정보가 없습니다/);
  upsertAwards(db, [aRow({ title: '<script>alert(1)</script>', winnerName: '<img src=x onerror=alert(2)>' })], '2026-10-29T00:00:00Z');
  const body = (await get('/bids')).body;
  assert.doesNotMatch(body, /<script>alert\(1\)/);
  assert.doesNotMatch(body, /<img src=x/);
});

// ---- 입찰 · 낙찰 대시보드 ----
function setupDash() {
  const { db, get } = setupB([
    bRow({ bidNtceNo: 'A', noticeDate: '2026-10-29', demanderName: '가 기관', keywords: ['솔루션'] }),
    bRow({ bidNtceNo: 'B', noticeDate: '2026-10-29', demanderName: '가 기관', keywords: ['솔루션', '소스코드'] }),
    bRow({ bidNtceNo: 'C', noticeDate: '2026-10-27', demanderName: '나 기관', keywords: ['소스코드'] }),
    bRow({ bidNtceNo: 'D', noticeDate: '2026-10-05', demanderName: '나 기관', keywords: ['보안약점'] }),
    bRow({ bidNtceNo: 'E', noticeDate: '2026-09-30', demanderName: '다 기관', keywords: ['솔루션'] }),
  ]);
  upsertAwards(db, [
    aRow({ bidNtceNo: 'X', opening: '2026-10-29 11:00', demanderName: '가 기관', keywords: ['솔루션'] }),
    aRow({ bidNtceNo: 'Y', opening: '2026-10-05 11:00', demanderName: '나 기관', keywords: ['소스코드'] }),
  ], '2026-10-29T00:00:00Z');
  return { get };
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('대시보드: 신규 입찰공고 · 낙찰 건수를 고른 날짜 기준 일 · 주 · 월로 보여 준다', async () => {
  const { get } = setupDash();
  const body = (await get('/bids?view=day&date=2026-10-29')).body;
  // 입찰공고: 일 2(A,B) · 주 3(A,B,C) · 월 4(+D)
  assert.match(body, /<h2>신규 입찰공고 건수<\/h2><div class="kpi"><div class="kpi-cell on"><div class="kpi-n">2<\/div>[^]*?<div class="kpi-n">3<\/div>[^]*?<div class="kpi-n">4<\/div>/);
  // 낙찰: 일 1(X) · 주 1 · 월 2(+Y)
  assert.match(body, /<h2>신규 낙찰 건수<\/h2><div class="kpi"><div class="kpi-cell on"><div class="kpi-n">1<\/div>[^]*?<div class="kpi-n">1<\/div>[^]*?<div class="kpi-n">2<\/div>/);
  // 보기 단위에 맞는 칸이 강조된다
  const month = (await get('/bids?view=month&date=2026-10-29')).body;
  assert.match(month, /<div class="kpi-cell on"><div class="kpi-n">4<\/div><div class="muted">월<\/div>/);
});

test('대시보드: 수요기관별 현황(선택 기간의 입찰공고 · 낙찰 건수, 많은 순)', async () => {
  const { get } = setupDash();
  const body = (await get('/bids?view=month&date=2026-10-29')).body;
  const part = body.slice(body.indexOf('수요기관별 현황'), body.indexOf('공고 키워드별 발생 건수'));
  const t = text(part);
  // 10월: 가 기관(입찰 2 · 낙찰 1) 3건, 나 기관(입찰 2: C, D · 낙찰 1) 3건 — 같으면 이름순
  assert.match(t, /가 기관 2 1/);
  assert.match(t, /나 기관 2 1/);
  assert.ok(part.indexOf('가 기관') < part.indexOf('나 기관'));
  assert.doesNotMatch(t, /다 기관/);
});

test('대시보드: 키워드별 발생 건수와 추세 표 (필터 키워드만)', async () => {
  const { get } = setupDash();
  const body = (await get('/bids?view=month&date=2026-10-29')).body;
  const counts = text(body.slice(body.indexOf('공고 키워드별 발생 건수'), body.indexOf('공고 키워드별 사업 추세')));
  // 10월 입찰공고: 솔루션 2(A,B) · 소스코드 2(B,C) · 보안약점 1(D) / 낙찰: 솔루션 1 · 소스코드 1
  assert.match(counts, /솔루션 2 1/);
  assert.match(counts, /소스코드 2 1/);
  assert.match(counts, /보안약점 1 0/);
  // 추세(월 6개): 마지막 두 칸은 9월, 10월. 솔루션: 9월 1(E) → 10월 2
  const trend = body.slice(body.indexOf('공고 키워드별 사업 추세'));
  assert.match(trend, /<th class="num">2026-09<\/th><th class="num">2026-10<div class="muted">진행 중<\/div><\/th><th class="num">합계<\/th>/);
  // 마지막 칸(10월)은 진행 중이라 완결된 두 기간(8월 · 9월)을 비교하는데 8월은 수집 전이라 비교하지 않는다.
  assert.match(text(trend), /솔루션 [^]*? 1 2 3 -/);
  assert.match(trend, /진행 중/);
  assert.match(trend, /style="background:color-mix\(in srgb, var\(--accent\) /);
  assert.doesNotMatch(trend, /AI|개인정보/);
});

test('대시보드: 수요기관 · 키워드 조건이 대시보드 전체에 적용된다', async () => {
  const { get } = setupDash();
  const org = (await get('/bids?view=month&date=2026-10-29&demander=' + encodeURIComponent('가 기관'))).body;
  assert.match(org, /<h2>신규 입찰공고 건수<\/h2><div class="kpi"><div class="kpi-cell"><div class="kpi-n">2<\/div>/);
  assert.doesNotMatch(text(org.slice(org.indexOf('수요기관별 현황'), org.indexOf('공고 키워드별 발생 건수'))), /나 기관 /);
  const kw = (await get('/bids?view=month&date=2026-10-29&keyword=' + encodeURIComponent('보안약점'))).body;
  assert.match(kw, /<h2>신규 입찰공고 건수<\/h2><div class="kpi">[^]*?<div class="kpi-n">1<\/div><div class="muted">월/);
  const trend = text(kw.slice(kw.indexOf('공고 키워드별 사업 추세')));
  assert.match(trend, /보안약점/);
  assert.doesNotMatch(trend, /솔루션/);
});

test('대시보드: 일 보기는 14일, 주 보기는 8주 추세, 데이터가 없으면 안내 문구', async () => {
  const { get } = setupDash();
  const day = (await get('/bids?view=day&date=2026-10-29')).body;
  assert.equal((day.slice(day.indexOf('공고 키워드별 사업 추세')).match(/<th class="num">\d\d-\d\d(?:<div class="muted">진행 중<\/div>)?<\/th>/g) ?? []).length, 14);
  const week = (await get('/bids?view=week&date=2026-10-29')).body;
  assert.equal((week.slice(week.indexOf('공고 키워드별 사업 추세')).match(/<th class="num">\d\d-\d\d~(?:<div class="muted">진행 중<\/div>)?<\/th>/g) ?? []).length, 8);
  const empty = setupB();
  const body = (await empty.get('/bids')).body;
  assert.match(body, /선택 기간에 해당하는 입찰공고 · 낙찰정보가 없습니다/);
  assert.match(body, /추세를 그릴 수 없습니다/);
});

test('대시보드: 수요기관 이름 등은 이스케이프된다', async () => {
  const { get } = setupB([bRow({ demanderName: '<script>alert(1)</script>', keywords: ['솔루션'] })]);
  const body = (await get('/bids')).body;
  assert.doesNotMatch(body, /<script>alert\(1\)/);
});

test('대시보드: 수집이 시작되기 전 기간이 추세 표에 있으면 "수집 전" 안내를 보여 준다', async () => {
  const { get } = setupDash();
  // 월 보기는 6개월(2026-05~10)을 보고 첫 수집일은 2026-09-30 → 안내가 나온다
  const month = (await get('/bids?view=month&date=2026-10-29')).body;
  assert.match(month, /입찰공고 수집은 2026-09-30부터 쌓였습니다/);
  assert.match(month, /수집 전/);
  // 일 보기는 14일(10-16~10-29)이 모두 수집 이후 → 안내 없음
  const day = (await get('/bids?view=day&date=2026-10-29')).body;
  assert.doesNotMatch(day, /입찰공고 수집은/);
});

test('대시보드: 직전 대비는 완결된 마지막 두 기간을 비교하고, 진행 중인 마지막 칸은 표시한다', async () => {
  const { get } = setupB([
    bRow({ bidNtceNo: 'A', noticeDate: '2026-10-26', keywords: ['솔루션'] }),
    bRow({ bidNtceNo: 'B', noticeDate: '2026-10-27', keywords: ['솔루션'] }),
    bRow({ bidNtceNo: 'C', noticeDate: '2026-10-27', keywords: ['솔루션'] }),
  ]);
  // 오늘 2026-10-29: 일 보기 마지막 칸(10-29)은 진행 중 → 10-28(0)과 10-27(2) 비교 = ▼ 2
  const open = (await get('/bids?view=day&date=2026-10-29')).body;
  assert.match(open, /진행 중/);
  assert.match(text(open.slice(open.indexOf('공고 키워드별 사업 추세'))), /솔루션 [^]*? ▼ 2/);
  // 10-27로 고르면 마지막 칸이 완결(10-27 = 2건, 10-26 = 1건) → ▲ 1
  const done = (await get('/bids?view=day&date=2026-10-27')).body;
  assert.doesNotMatch(done, /<span class="muted">진행 중<\/span>/);
  assert.match(text(done.slice(done.indexOf('공고 키워드별 사업 추세'))), /솔루션 [^]*? ▲ 1/);
  assert.match(done, /진행 중인 기간은 제외/);
});

test('대시보드: 키워드를 고르면 키워드별 건수와 추세도 그 키워드 한 줄로 제한된다 (다른 키워드가 든 공고여도)', async () => {
  const { get } = setupDash();
  const body = (await get('/bids?view=month&date=2026-10-29&keyword=' + encodeURIComponent('솔루션'))).body;
  // 공고 B는 솔루션 · 소스코드 둘 다 가졌지만 소스코드 줄은 나오지 않는다
  const counts = text(body.slice(body.indexOf('공고 키워드별 발생 건수'), body.indexOf('공고 키워드별 사업 추세')));
  assert.match(counts, /솔루션 2 1/);
  assert.doesNotMatch(counts, /소스코드/);
  const trendCard = body.slice(body.indexOf('공고 키워드별 사업 추세'), body.indexOf('건수는 (공고번호, 차수) 행 기준'));
  assert.match(text(trendCard), /솔루션/);
  assert.doesNotMatch(text(trendCard), /소스코드/);
});

test('대시보드: 건수 기준(차수 행) · 키워드 중복 계산 안내와 낙찰정보 수집 시작일 안내', async () => {
  const { get } = setupDash();
  const body = (await get('/bids?view=month&date=2026-10-29')).body;
  assert.match(body, /건수는 \(공고번호, 차수\) 행 기준/);
  assert.match(body, /여러 키워드에 걸리면 각각 세므로/);
  assert.match(body, /낙찰정보 수집은 2026-10-05부터/);
  const none = (await setupB().get('/bids')).body;
  assert.match(none, /낙찰정보 수집 기록이 없습니다/);
});
