import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finishRun, startRun, upsertContracts, type ContractRow } from '../db/contracts.ts';
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

test('수집 상태는 매일 증분 · 교차 검증 · 백필을 각각 보여 주고 교차 검증 메모도 보여 준다', async () => {
  const { db, get } = setup();
  const b = startRun(db, '2026-01-01', '2026-10-28', '2026-10-29T00:00:00Z', 'backfill');
  finishRun(db, b, { status: 'success', fetched: 423, matched: 11, calls: 21, error: null }, '2026-10-29T00:01:00Z');
  const d = startRun(db, '2026-10-29', '2026-10-29', '2026-10-30T00:00:00Z', 'daily');
  finishRun(db, d, { status: 'success', fetched: 4200, matched: 1, calls: 7, error: null }, '2026-10-30T00:02:00Z');
  const v = startRun(db, '2026-10-16', '2026-10-29', '2026-10-31T00:00:00Z', 'verify');
  finishRun(db, v, { status: 'success', fetched: 40, matched: 2, calls: 4, error: null, note: '교차 검증: 새로 찾은 계약 1건' }, '2026-10-31T00:01:00Z');
  const body = (await get('/')).body;
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
  assert.match((await get('/deliveries')).body, /납품요구 수집 기록이 없습니다/);
  const r = startRun(db, '2026-01-01', '2026-10-28', '2026-10-29T00:00:00Z', 'dlvr_backfill');
  finishRun(db, r, { status: 'success', fetched: 1288, matched: 13, calls: 2, error: null }, '2026-10-29T00:01:00Z');
  const status = (await get('/deliveries')).body;
  assert.match(status, /납품요구 백필/);
  assert.match(status, /납품요구 13행 저장/);
  for (const url of ['/deliveries?view=year', '/deliveries?date=abc', '/deliveries?company=nope']) assert.equal((await get(url)).statusCode, 400, url);
});

test('두 화면은 서로 이동하는 링크를 갖고, 각 화면은 자기 수집 상태만 보여 준다', async () => {
  const { db, get } = setupD();
  const b = startRun(db, '2026-01-01', '2026-10-28', '2026-10-29T00:00:00Z', 'backfill');
  finishRun(db, b, { status: 'success', fetched: 423, matched: 11, calls: 21, error: null }, '2026-10-29T00:01:00Z');
  const contracts = (await get('/?view=month&date=2026-06-15&company=sparrow')).body;
  assert.match(contracts, /href="\/deliveries\?view=month&amp;date=2026-06-15&amp;company=sparrow"/);
  assert.match(contracts, /백필\(체결일자\)/);
  const deliveries = (await get('/deliveries?view=month&date=2026-06-15')).body;
  assert.match(deliveries, /href="\/\?view=month&amp;date=2026-06-15"/);
  assert.doesNotMatch(deliveries, /백필\(체결일자\)/);
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
