import type { DeliveryRow } from '../db/deliveries.ts';
import type { Matcher } from '../filters/contracts.ts';
import { monthRanges, type IsoDate } from '../filters/dates.ts';
import { field, G2bResponseError } from '../g2b/response.ts';
import { fetchAll, PRODUCT_NAME, type FetchPage } from './contracts.ts';

// 나라장터쇼핑몰 납품요구 상세. 한 쪽 최대 999행, 접수일자 구간은 한 달까지 확인했다 (WO-20261028-11).
const OP = 'getDlvrReqDtlInfoList';
const ROWS = 999;

export interface DeliveryStats {
  fetched: number;
  companyMatched: number;
  categoryMismatch: number;
}

const compact = (d: IsoDate) => d.replaceAll('-', '');

function toNumber(text: string): number | null {
  const s = text.replaceAll(',', '').trim();
  const n = s === '' ? NaN : Number(s);
  return Number.isFinite(n) ? n : null;
}

const format = (message: string): never => {
  throw new G2bResponseError(`나라장터 응답 형식 오류: ${message}`);
};

// 접수일자 구간(달력 월 단위) + 품명 필터로 납품요구 물품 행을 받아 우리 업체 · 분류번호 것만 저장 행으로 바꾼다.
// 업체는 상호 정확 일치, 분류번호는 8자리 정확 일치, 식별번호는 표시만 한다(목록 밖이어도 저장).
export async function collectDeliveries(
  deps: { fetchPage: FetchPage; matcher: Matcher; log?: (message: string) => void },
  range: { from: IsoDate; to: IsoDate },
): Promise<{ rows: DeliveryRow[]; stats: DeliveryStats }> {
  const { matcher } = deps;
  const stats: DeliveryStats = { fetched: 0, companyMatched: 0, categoryMismatch: 0 };
  const rows: DeliveryRow[] = [];
  const seen = new Set<string>();

  for (const month of monthRanges(range.from, range.to)) {
    const items = await fetchAll(deps.fetchPage, OP, {
      inqryDiv: 1, inqryBgnDate: compact(month.from), inqryEndDate: compact(month.to), prdctClsfcNoNm: PRODUCT_NAME, numOfRows: ROWS,
    });
    deps.log?.(`${month.from} ~ ${month.to}: ${items.length}행 수신`);

    for (const it of items) {
      const dlvrReqNo = field(it, 'dlvrReqNo');
      const chgText = field(it, 'dlvrReqChgOrd');
      const prdctSno = field(it, 'prdctSno');
      const key = `${dlvrReqNo}|${chgText}|${prdctSno}|${field(it, 'corpNm')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      stats.fetched++;

      const companyId = matcher.matchCompany(field(it, 'corpNm'));
      if (companyId === undefined) continue;
      stats.companyMatched++;
      if (!matcher.isMonitoredCategory(field(it, 'prdctClsfcNo'))) {
        stats.categoryMismatch++;
        continue;
      }

      const receivedDate = field(it, 'dlvrReqRcptDate');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedDate)) format(`접수일자 형식이 다릅니다 (${dlvrReqNo})`);
      const chgOrd = chgText === '' ? 0 : Number(chgText);
      if (!Number.isInteger(chgOrd)) format(`변경 차수가 숫자가 아닙니다 (${dlvrReqNo})`);

      const productId = field(it, 'prdctIdntNo');
      const check = productId === '' ? { verified: false, idConflict: false } : matcher.checkProduct(companyId, productId);
      rows.push({
        dlvrReqNo,
        chgOrd,
        prdctSno,
        companyId,
        companyName: field(it, 'corpNm'),
        bizNo: field(it, 'cntrctCorpBizno'),
        receivedDate,
        demanderCode: field(it, 'dminsttCd'),
        demanderName: field(it, 'dminsttNm'),
        demanderKind: field(it, 'dmndInsttDivNm'),
        productClassNo: field(it, 'prdctClsfcNo'),
        productClassName: field(it, 'prdctClsfcNoNm'),
        productId,
        productName: field(it, 'prdctIdntNoNm'),
        unitPrice: toNumber(field(it, 'prdctUprc')),
        qty: toNumber(field(it, 'prdctQty')),
        amount: toNumber(field(it, 'prdctAmt')),
        deadline: field(it, 'dlvrTmlmtDate'),
        contractNo: field(it, 'cntrctNo'),
        contractStyle: field(it, 'cntrctCnclsStleNm'),
        finalYn: field(it, 'fnlDlvrReqYn') === 'Y',
        incdecQty: toNumber(field(it, 'incdecQty')),
        incdecAmt: toNumber(field(it, 'incdecAmt')),
        verified: check.verified,
        idConflict: check.idConflict,
      });
    }
  }
  return { rows, stats };
}
