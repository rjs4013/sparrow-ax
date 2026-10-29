import type { BidRow } from '../db/bids.ts';
import { matchKeywords } from '../filters/bids.ts';
import type { IsoDate } from '../filters/dates.ts';
import { field, G2bResponseError, type Row } from '../g2b/response.ts';
import { fetchAllPages, type FetchPage } from './contracts.ts';
import { toNumber } from './format.ts';

// 개방표준서비스 입찰공고. 쪽당 최대 500건, 입찰공고일시 구간은 1개월 제한(하루 단위로 받는다), 서버 제목 필터는 없다(WO-20261028-07 · 14).
const OP = 'getDataSetOpnStdBidPblancInfo';
const ROWS = 500;

export interface BidStats {
  // 고유((공고번호, 차수)) 공고 수.
  fetched: number;
  matched: number;
  // 같은 날을 받은 횟수(1이면 한 번에 끝남).
  passes: number;
  // 서비스가 알려 준 전체 건수에 못 미친 고유 건수(다시 받아도 채우지 못한 것).
  shortfall: number;
}

// 쪽 이동으로 중복이 생겨 고유 건수가 전체 건수보다 적으면(실측: 10-28에 한 번 원본 2,144건 중 고유 2,111건, 같은 날을 세 번 다시 받았을 때는 재현되지 않음)
// 같은 날을 이 횟수까지 받아 합친다.
const MAX_PASSES = 3;

const compact = (d: IsoDate) => d.replaceAll('-', '');

// 날짜(YYYY-MM-DD)와 시각(HH:MM)을 'YYYY-MM-DD HH:MM'로 합친다. 날짜가 없으면 빈 문자열.
const stamp = (date: string, time: string): string => (date === '' ? '' : `${date} ${time}`.trim());

// 하루치(입찰공고일시 00:00~23:59) 입찰공고를 모두 받아 공고명 키워드에 걸린 것만 저장 행으로 바꾼다.
// 담당자 이름 · 전화 · 이메일 필드는 읽지 않는다.
export async function collectBidDay(
  deps: { fetchPage: FetchPage; keywords: string[]; log?: (message: string) => void },
  day: IsoDate,
): Promise<{ rows: BidRow[]; stats: BidStats }> {
  const params = { bidNtceBgnDt: `${compact(day)}0000`, bidNtceEndDt: `${compact(day)}2359`, numOfRows: ROWS };
  const unique = new Map<string, Row>();
  let total = 0;
  let passes = 0;
  while (passes < MAX_PASSES) {
    passes++;
    const { rows: pageRows, totalCount } = await fetchAllPages(deps.fetchPage, OP, params);
    total = totalCount;
    for (const it of pageRows) {
      const key = `${field(it, 'bidNtceNo')}|${field(it, 'bidNtceOrd')}`;
      if (!unique.has(key)) unique.set(key, it);
    }
    deps.log?.(`${day}: ${pageRows.length}건 수신 (${passes}번째, 고유 누계 ${unique.size} / 전체 ${totalCount})`);
    if (unique.size >= totalCount) break;
  }

  const stats: BidStats = { fetched: unique.size, matched: 0, passes, shortfall: Math.max(0, total - unique.size) };
  const rows: BidRow[] = [];
  for (const it of unique.values()) {
    const no = field(it, 'bidNtceNo');
    const ord = field(it, 'bidNtceOrd');

    const title = field(it, 'bidNtceNm');
    const keywords = matchKeywords(title, deps.keywords);
    if (keywords.length === 0) continue;

    // 번호 · 차수가 비면 (공고번호, 차수) 키가 충돌해 서로 덮어쓰므로 조용히 저장하지 않는다.
    if (no === '' || ord === '') throw new G2bResponseError('나라장터 응답 형식 오류: 입찰공고 번호 또는 차수가 비어 있습니다');
    const noticeDate = field(it, 'bidNtceDate');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(noticeDate)) throw new G2bResponseError(`나라장터 응답 형식 오류: 공고일자 형식이 다릅니다 (${no})`);

    stats.matched++;
    rows.push({
      bidNtceNo: no,
      bidNtceOrd: ord,
      title,
      status: field(it, 'bidNtceSttusNm'),
      workKind: field(it, 'bsnsDivNm'),
      noticeDate,
      noticeTime: field(it, 'bidNtceBgn'),
      demanderName: field(it, 'dmndInsttNm') || field(it, 'ntceInsttNm'),
      demanderCode: field(it, 'dmndInsttCd') || field(it, 'ntceInsttCd'),
      noticeOrgName: field(it, 'ntceInsttNm'),
      noticeOrgCode: field(it, 'ntceInsttCd'),
      estimatedPrice: toNumber(field(it, 'presmptPrce')),
      budgetAmount: toNumber(field(it, 'asignBdgtAmt')),
      bidBegin: stamp(field(it, 'bidBeginDate'), field(it, 'bidBeginTm')),
      regClose: stamp(field(it, 'bidPrtcptQlfctRgstClseDate'), field(it, 'bidPrtcptQlfctRgstClseTm')),
      bidClose: stamp(field(it, 'bidClseDate'), field(it, 'bidClseTm')),
      opening: stamp(field(it, 'opengDate'), field(it, 'opengTm')),
      url: field(it, 'bidNtceUrl'),
      contractMethod: field(it, 'cntrctCnclsMthdNm'),
      keywords,
    });
  }
  return { rows, stats };
}
