import assert from 'node:assert/strict';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import type { ContractRow } from '../db/contracts.ts';
import type { DeliveryRow } from '../db/deliveries.ts';
import { buildWorkbook, exportFileName } from './excel.ts';

const delivery = (over: Partial<DeliveryRow> = {}): DeliveryRow => ({
  dlvrReqNo: 'R26TB01997234', requestName: '정보보안 솔루션 구매', chgOrd: 0, prdctSno: '1', companyId: 'nilesoft', companyName: '(주)나일소프트',
  bizNo: '1234567890', receivedDate: '2026-06-08', demanderCode: '1790364', demanderName: '고위공직자범죄수사처', demanderKind: '중앙행정기관',
  productClassNo: '43233205', productClassName: '트랜잭션보안및바이러스보호소프트웨어', productId: '24590125', productName: '웹방화벽',
  unitPrice: 45_500_000, qty: 2, amount: 91_000_000, deadline: '2026-07-08', contractNo: '002461624', contractStyle: '제3자단가계약',
  finalYn: true, incdecQty: 2, incdecAmt: 91_000_000, verified: false, idConflict: false, ...over,
});
const contract = (over: Partial<ContractRow> = {}): ContractRow => ({
  untyNo: 'R26TE00000001', companyId: 'sparrow', companyName: '주식회사 스패로우', bizNo: '1234567890', contractName: '상용SW 제3자단가계약',
  signedDate: '2026-06-24', registeredAt: '2026-06-24 09:00:00', amount: 30_580_000_000, contractOrg: '조달청', demanderName: '각 수요기관',
  demanderPlaceholder: true, method: '수의계약', productIds: ['26181128', '26181129'], productNames: ['플랫폼 Standard', '플랫폼 Ultimate'],
  verified: true, idConflict: false, ...over,
});
const input = { month: '2026-06', companyLabel: null, categoryCode: '43233205', deliveries: [delivery()], contracts: [contract()] };

async function read(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}
const headers = (ws: ExcelJS.Worksheet) => (ws.getRow(1).values as unknown[]).slice(1);

test('두 시트(납품요구 · 계약)와 요구사항 7개 항목 + 제조사 열이 있다', async () => {
  const wb = await read(await buildWorkbook(input));
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['납품요구', '계약']);
  const expected = ['납품요구일자(계약일자)', '제조사', '수요기관명', '공사명', '물품분류번호', '물품식별명', '물품식별번호', '금액'];
  assert.deepEqual(headers(wb.getWorksheet('납품요구')!), expected);
  assert.deepEqual(headers(wb.getWorksheet('계약')!), expected);
});

test('납품요구 시트: 물품 하나가 한 행이고 접수일자는 날짜 셀, 금액은 숫자 셀이다', async () => {
  const ws = (await read(await buildWorkbook(input))).getWorksheet('납품요구')!;
  const row = ws.getRow(2);
  const date = row.getCell(1).value;
  assert.ok(date instanceof Date);
  assert.equal((date as Date).toISOString().slice(0, 10), '2026-06-08');
  assert.equal(row.getCell(2).value, '(주)나일소프트');
  assert.equal(row.getCell(3).value, '고위공직자범죄수사처');
  assert.equal(row.getCell(4).value, '정보보안 솔루션 구매');
  assert.equal(row.getCell(5).value, '43233205');
  assert.equal(row.getCell(6).value, '웹방화벽');
  assert.equal(row.getCell(7).value, '24590125');
  assert.equal(row.getCell(8).value, 91_000_000);
  assert.equal(typeof row.getCell(8).value, 'number');
  assert.equal(ws.rowCount, 2);
});

test('계약 시트: 계약 하나가 한 행, 제품은 줄바꿈으로 나열, 조달청 계약은 수요기관 미공개, 분류번호는 설정 값', async () => {
  const ws = (await read(await buildWorkbook(input))).getWorksheet('계약')!;
  const row = ws.getRow(2);
  assert.equal((row.getCell(1).value as Date).toISOString().slice(0, 10), '2026-06-24');
  assert.equal(row.getCell(2).value, '주식회사 스패로우');
  assert.equal(row.getCell(3).value, '수요기관 미공개(조달청 계약)');
  assert.equal(row.getCell(4).value, '상용SW 제3자단가계약');
  assert.equal(row.getCell(5).value, '43233205');
  assert.equal(row.getCell(6).value, '플랫폼 Standard\n플랫폼 Ultimate');
  assert.equal(row.getCell(7).value, '26181128\n26181129');
  assert.equal(row.getCell(8).value, 30_580_000_000);
});

test('기관과 직접 맺은 계약은 수요기관 이름을 쓰고, 금액이 없으면 빈 셀이다', async () => {
  const ws = (await read(await buildWorkbook({
    ...input,
    contracts: [contract({ demanderName: '국방과학연구소', demanderPlaceholder: false, amount: null })],
    deliveries: [delivery({ amount: null })],
  }))).getWorksheet('계약')!;
  assert.equal(ws.getRow(2).getCell(3).value, '국방과학연구소');
  assert.equal(ws.getRow(2).getCell(8).value, null);
});

test('데이터가 없어도 두 시트에 머리글 행은 있다', async () => {
  const wb = await read(await buildWorkbook({ ...input, deliveries: [], contracts: [] }));
  assert.equal(wb.getWorksheet('납품요구')!.rowCount, 1);
  assert.equal(wb.getWorksheet('계약')!.rowCount, 1);
});

test('주어진 순서를 그대로 쓰고, 수식처럼 보이는 외부 값도 문자열로 저장한다', async () => {
  const wb = await read(await buildWorkbook({
    ...input,
    deliveries: [delivery({ demanderName: '=1+1', requestName: '+SUM(A1)' }), delivery({ dlvrReqNo: 'B', demanderName: '두번째' })],
  }));
  const ws = wb.getWorksheet('납품요구')!;
  assert.equal(ws.getRow(2).getCell(3).value, '=1+1');
  assert.equal(ws.getRow(2).getCell(4).value, '+SUM(A1)');
  assert.equal(typeof ws.getRow(2).getCell(3).value, 'string');
  assert.equal(ws.getRow(3).getCell(3).value, '두번째');
});

test('파일명: 월, 업체를 고르면 업체 이름이 붙고 파일명에 쓸 수 없는 문자는 바꾼다', () => {
  assert.equal(exportFileName('2026-06', null), '경쟁사_실적_2026-06.xlsx');
  assert.equal(exportFileName('2026-06', '스패로우'), '경쟁사_실적_2026-06_스패로우.xlsx');
  assert.equal(exportFileName('2026-06', 'a/b\\c:d*e?f"g<h>i|j'), '경쟁사_실적_2026-06_a_b_c_d_e_f_g_h_i_j.xlsx');
  // 개행 등 제어문자도 바꾼다.
  assert.equal(exportFileName('2026-06', 'a\r\nb\tc'), '경쟁사_실적_2026-06_a__b_c.xlsx');
});
