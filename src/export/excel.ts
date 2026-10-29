import ExcelJS from 'exceljs';
import type { ContractRow } from '../db/contracts.ts';
import type { DeliveryRow } from '../db/deliveries.ts';

export interface ExportInput {
  // 'YYYY-MM'
  month: string;
  // 업체를 골랐다면 그 표시 이름(파일명에 붙는다).
  companyLabel: string | null;
  // 계약 행에는 분류번호가 저장돼 있지 않아 설정의 분류번호를 쓴다(수집이 그 분류번호로만 거른다).
  categoryCode: string;
  deliveries: DeliveryRow[];
  contracts: ContractRow[];
}

// 요구사항 7.4의 7개 항목 + 제조사(업체). 두 시트가 같은 열 구성을 쓴다.
const COLUMNS: { header: string; width: number }[] = [
  { header: '납품요구일자(계약일자)', width: 22 },
  { header: '제조사', width: 20 },
  { header: '수요기관명', width: 26 },
  { header: '공사명', width: 40 },
  { header: '물품분류번호', width: 14 },
  { header: '물품식별명', width: 44 },
  { header: '물품식별번호', width: 16 },
  { header: '금액', width: 18 },
];

const PLACEHOLDER_DEMANDER = '수요기관 미공개(조달청 계약)';

// 날짜는 날짜 셀로 넣는다(정렬 · 필터가 되도록). UTC 자정으로 만들어 표시 날짜가 어긋나지 않게 한다.
const toDate = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

function addSheet(wb: ExcelJS.Workbook, name: string, rows: (string | number | Date | null)[][], wrapColumns: number[] = []): void {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ header: c.header, width: c.width }));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(r);
  ws.getColumn(1).numFmt = 'yyyy-mm-dd';
  ws.getColumn(8).numFmt = '#,##0';
  for (const c of wrapColumns) ws.getColumn(c).alignment = { wrapText: true, vertical: 'top' };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
}

// 선택한 달의 납품요구(물품 하나가 한 행)와 계약(계약 하나가 한 행, 제품은 줄바꿈으로 나열)을 두 시트로 만든다.
// 외부 데이터는 모두 문자열 셀로 들어가 수식으로 해석되지 않는다.
export async function buildWorkbook(input: ExportInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'sparrow-ax';

  addSheet(wb, '납품요구', input.deliveries.map((d) => [
    toDate(d.receivedDate), d.companyName, d.demanderName, d.requestName, d.productClassNo, d.productName, d.productId, d.amount,
  ]));
  addSheet(
    wb,
    '계약',
    input.contracts.map((c) => [
      toDate(c.signedDate), c.companyName, c.demanderPlaceholder ? PLACEHOLDER_DEMANDER : c.demanderName, c.contractName, input.categoryCode,
      c.productNames.join('\n'), c.productIds.join('\n'), c.amount,
    ]),
    [6, 7],
  );
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// 파일명: 경쟁사_실적_YYYY-MM.xlsx (업체를 고르면 _업체 표시 이름). 파일명에 쓸 수 없는 문자 · 제어문자는 _로 바꾼다.
export function exportFileName(month: string, companyLabel: string | null): string {
  const label = companyLabel === null ? '' : `_${companyLabel.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')}`;
  return `경쟁사_실적_${month}${label}.xlsx`;
}
