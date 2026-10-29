import type { AwardRow } from '../db/awards.ts';
import { matchKeywords } from '../filters/bids.ts';
import type { IsoDate } from '../filters/dates.ts';
import { field, G2bResponseError } from '../g2b/response.ts';
import type { FetchPage } from './contracts.ts';
import { toNumber } from './format.ts';

// 개방표준서비스 낙찰정보. 개찰일시 구간은 하루 제한, 업무구분코드 필수, 쪽 크기 999까지 되고(1000 이상은 10으로 처리됨),
// 투찰업체별로 행이 온다(실측 2026-10-27: 용역 10,867행 · 물품 34,617행). WO-20261028-15.
const OP = 'getDataSetOpnStdScsbidInfo';
const ROWS = 999;
const MAX_PAGES = 200;
// 사람 결정: 업무구분은 물품(1) · 용역(5)만 받는다.
const DIVISIONS = [1, 5] as const;
export interface AwardStats {
  // 받은 원본 행 수(업무구분 합계). 낙찰 행은 한 공고 안의 품목별 행이 섞여 있어 키로 중복을 가릴 수 없다(실측: 같은 공고 · 업체 · 순위 · 금액
  // 키의 행들이 낙찰금액 · 낙찰업체가 서로 다르다). 그래서 입찰공고처럼 고유 건수로 쪽 이동을 감지하지 못하고 원본 행 수를 그대로 센다.
  fetched: number;
  // 키워드에 걸린 공고 수.
  matched: number;
  // 업무구분별 받은 행 수가 서비스의 전체 건수와 다를 때의 설명(쪽 이동 · 누락 가능성). 같으면 비어 있다.
  notes: string[];
}

const compact = (d: IsoDate) => d.replaceAll('-', '');
const stamp = (date: string, time: string): string => (date === '' ? '' : `${date} ${time}`.trim());

interface Group {
  base: Omit<AwardRow, 'bidderCount' | 'winnerName' | 'winnerAmount' | 'winnerRate' | 'winnerDate'>;
  bidders: Set<string>;
  winner: { name: string; amount: number | null; rate: number | null; date: string } | null;
}

// 개찰일 하루의 낙찰정보(물품 · 용역)를 받아 공고명 키워드에 걸린 공고만 남기고, 투찰업체 행들을 공고 하나로 묶는다.
// 하루가 수만 행이라 쪽마다 바로 걸러 메모리를 아낀다. 대표자 · 담당자 · 연락처 · 주소 필드는 읽지 않는다.
export async function collectAwardDay(
  deps: { fetchPage: FetchPage; keywords: string[]; log?: (message: string) => void },
  day: IsoDate,
): Promise<{ rows: AwardRow[]; stats: AwardStats }> {
  const groups = new Map<string, Group>();
  const stats: AwardStats = { fetched: 0, matched: 0, notes: [] };

  for (const div of DIVISIONS) {
    const params = { bsnsDivCd: div, opengBgnDt: `${compact(day)}0000`, opengEndDt: `${compact(day)}2359`, numOfRows: ROWS };
    let raw = 0;
    let total = 0;
    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
      const page = await deps.fetchPage(OP, { ...params, pageNo });
      total = page.totalCount;
      raw += page.items.length;
      for (const it of page.items) {
        const title = field(it, 'bidNtceNm');
        const keywords = matchKeywords(title, deps.keywords);
        if (keywords.length === 0) continue;
        const no = field(it, 'bidNtceNo');
        const ord = field(it, 'bidNtceOrd');
        // 번호 · 차수가 비면 (공고번호, 차수)가 충돌해 서로 덮어쓰므로 조용히 저장하지 않는다.
        if (no === '' || ord === '') throw new G2bResponseError('나라장터 응답 형식 오류: 낙찰정보의 입찰공고 번호 또는 차수가 비어 있습니다');
        const openingDate = field(it, 'opengDate');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(openingDate)) throw new G2bResponseError(`나라장터 응답 형식 오류: 개찰일자 형식이 다릅니다 (${no})`);

        const key = `${no}|${ord}`;
        let group = groups.get(key);
        if (!group) {
          group = {
            base: {
              bidNtceNo: no, bidNtceOrd: ord, title, workKind: field(it, 'bsnsDivNm'),
              demanderName: field(it, 'dmndInsttNm') || field(it, 'ntceInsttNm'), demanderCode: field(it, 'dmndInsttCd') || field(it, 'ntceInsttCd'),
              estimatedPrice: toNumber(field(it, 'presmptPrce')), reservePrice: toNumber(field(it, 'rsrvtnPrce')), baseAmount: toNumber(field(it, 'bssAmt')),
              opening: stamp(openingDate, field(it, 'opengTm')), result: field(it, 'opengRsltDivNm'), keywords,
            },
            bidders: new Set(),
            winner: null,
          };
          groups.set(key, group);
        }
        // 투찰업체 수는 사업자번호(없으면 업체명)가 다른 업체 수로 센다. 둘 다 비면 세지 않는다.
        const bidder = field(it, 'bidprcCorpBizrno') || field(it, 'bidprcCorpNm');
        if (bidder !== '') group.bidders.add(bidder);
        // 낙찰자는 낙찰여부 Y인 행에 최종낙찰 필드가 채워진다(없으면 그 행의 투찰값). 처음 만난 낙찰자 행을 쓴다.
        if (field(it, 'sucsfYn') === 'Y' && group.winner === null) {
          group.winner = {
            name: field(it, 'fnlSucsfCorpNm') || field(it, 'bidprcCorpNm'),
            amount: toNumber(field(it, 'fnlSucsfAmt')) ?? toNumber(field(it, 'bidprcAmt')),
            rate: toNumber(field(it, 'fnlSucsfRt')) ?? toNumber(field(it, 'bidprcRt')),
            date: field(it, 'fnlSucsfDate'),
          };
        }
      }
      if (page.items.length === 0 || raw >= page.totalCount) break;
    }
    deps.log?.(`${day} 업무구분 ${div}: ${raw}행 수신 (전체 ${total}행)`);
    // 행을 키로 중복 제거할 수 없어 원본 행 수와 서비스의 전체 건수 비교가 쪽 이동 · 누락을 알아챌 유일한 신호다.
    if (raw !== total) stats.notes.push(`업무구분 ${div}: 전체 ${total}행 중 ${raw}행 수신`);
    stats.fetched += raw;
  }

  const rows: AwardRow[] = [...groups.values()].map((g) => ({
    ...g.base,
    bidderCount: g.bidders.size,
    winnerName: g.winner?.name ?? '',
    winnerAmount: g.winner?.amount ?? null,
    winnerRate: g.winner?.rate ?? null,
    winnerDate: g.winner?.date ?? '',
  }));
  stats.matched = rows.length;
  return { rows, stats };
}
