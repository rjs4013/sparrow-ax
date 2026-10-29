import type { ContractRow } from '../db/contracts.ts';
import { monthRanges, type IsoDate } from '../filters/dates.ts';
import type { Matcher } from '../filters/contracts.ts';
import { field, G2bResponseError, isPlaceholderDemander, parseCorpList, parseDemanderList, parsePage, type Corp, type Page, type Row } from '../g2b/response.ts';

// 서버 품명 필터(부분 일치). 이 품명이 아닌 계약은 놓친다 (WO-20261028-07의 "품명 의존" 위험).
export const PRODUCT_NAME = '트랜잭션보안및바이러스보호소프트웨어';

const SEARCH = 'getCntrctInfoListThngPPSSrch';
const BASE = 'getCntrctInfoListThng';
const DETAIL = 'getCntrctInfoListThngDetail';
// 실측한 페이지 크기 상한: 체결일자 검색 999, 세부 조회 100.
const SEARCH_ROWS = 999;
const DETAIL_ROWS = 100;
const MAX_PAGES = 100;

type Params = Record<string, string | number>;
export type FetchPage = (op: string, params: Params) => Promise<Page>;

// 호출 수를 세고 상한을 지키며, 네트워크 · HTTP 오류는 최대 attempts번 시도한다.
// 서비스가 결과코드로 알려 준 오류는 되풀이해도 같으므로 재시도하지 않는다.
export function createFetcher(
  client: { get(path: string, params?: Params): Promise<unknown> },
  opts: { maxCalls: number; attempts?: number; sleep?: (ms: number) => Promise<void> },
) {
  const attempts = opts.attempts ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let calls = 0;
  const fetchPage: FetchPage = async (op, params) => {
    let last: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (calls >= opts.maxCalls) {
        // 재시도 중에 상한에 닿으면 원인이 된 직전 오류를 함께 남긴다.
        const cause = last instanceof Error ? ` (직전 오류: ${last.message})` : '';
        throw new Error(`호출 상한(${opts.maxCalls}회)에 도달해 중단합니다${cause}`);
      }
      calls++;
      try {
        return parsePage(await client.get(op, params));
      } catch (err) {
        if (err instanceof G2bResponseError) throw err;
        last = err;
        // 다음 시도가 상한에 막힐 것이 확실하면 기다리지 않는다.
        if (attempt < attempts && calls < opts.maxCalls) await sleep(2000 * attempt);
      }
    }
    throw last;
  };
  return { fetchPage, calls: () => calls };
}

async function fetchAll(fetchPage: FetchPage, op: string, params: Params): Promise<Row[]> {
  const rows: Row[] = [];
  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
    const page = await fetchPage(op, { ...params, pageNo });
    rows.push(...page.items);
    if (page.items.length === 0 || rows.length >= page.totalCount) return rows;
  }
  throw new Error(`${op}: 페이지가 ${MAX_PAGES}개를 넘어 중단합니다`);
}

export interface CollectStats {
  fetched: number;
  blankSkipped: number;
  companyMatched: number;
  categoryMismatch: number;
}

const compact = (d: IsoDate) => d.replaceAll('-', '');

function toAmount(text: string): number | null {
  const s = text.replaceAll(',', '').trim();
  const n = s === '' ? NaN : Number(s);
  return Number.isFinite(n) ? n : null;
}

interface Deps {
  fetchPage: FetchPage;
  matcher: Matcher;
  log?: (message: string) => void;
}

// 받은 행들을 9개사 판정(기본 조회의 corpList) → 세부 조회로 분류번호 · 식별번호 판정해 저장 행으로 바꾼다.
// 같은 통합계약번호는 한 번만 센다(쪽 사이에 겹쳐 올 수 있다).
function createProcessor(deps: Deps) {
  const { fetchPage, matcher } = deps;
  const stats: CollectStats = { fetched: 0, blankSkipped: 0, companyMatched: 0, categoryMismatch: 0 };
  const contracts: ContractRow[] = [];
  const seen = new Set<string>();

  async function process(rows: Row[]): Promise<void> {
    for (const row of rows) {
      const untyNo = field(row, 'untyCntrctNo');
      if (seen.has(untyNo)) continue;
      seen.add(untyNo);
      stats.fetched++;

      // 체결일자가 빈 행은 확정 전 사전 등록 레코드다 (WO-20261028-07 5차).
      const signedDate = field(row, 'cntrctCnclsDate');
      if (signedDate === '') {
        stats.blankSkipped++;
        continue;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(signedDate)) throw new G2bResponseError(`나라장터 응답 형식 오류: 체결일자 형식이 다릅니다 (${untyNo})`);

      const byCompany = new Map<string, Corp>();
      for (const corp of parseCorpList(field(row, 'corpList'))) {
        const id = matcher.matchCompany(corp.name);
        if (id !== undefined && !byCompany.has(id)) byCompany.set(id, corp);
      }
      if (byCompany.size === 0) continue;
      stats.companyMatched++;

      const items = (await fetchAll(fetchPage, DETAIL, { inqryDiv: 2, untyCntrctNo: untyNo, numOfRows: DETAIL_ROWS }))
        .filter((item) => matcher.isMonitoredCategory(field(item, 'prdctClsfcNo')));
      if (items.length === 0) {
        stats.categoryMismatch++;
        continue;
      }
      const productIds = items.map((item) => field(item, 'prdctIdntNo')).filter((id) => id !== '');
      const productNames = items.map((item) => field(item, 'krnPrdctNm')).filter((name) => name !== '');

      const demanders = parseDemanderList(field(row, 'dminsttList'));
      const real = demanders.find((d) => !isPlaceholderDemander(d));

      for (const [companyId, corp] of byCompany) {
        const checks = productIds.map((id) => matcher.checkProduct(companyId, id));
        contracts.push({
          untyNo,
          companyId,
          companyName: corp.name,
          bizNo: corp.bizNo,
          contractName: field(row, 'cntrctNm'),
          signedDate,
          registeredAt: field(row, 'rgstDt'),
          amount: toAmount(field(row, 'thtmCntrctAmt')),
          contractOrg: field(row, 'cntrctInsttNm'),
          demanderName: real?.name ?? demanders[0]?.name ?? '',
          demanderPlaceholder: demanders.length > 0 && real === undefined,
          method: field(row, 'cntrctCnclsMthdNm'),
          productIds,
          productNames,
          verified: checks.some((c) => c.verified),
          idConflict: checks.some((c) => c.idConflict),
        });
      }
    }
  }
  return { process, contracts, stats };
}

// 체결일자 검색(달력 월 단위, 서버 품명 필터) — 백필과 교차 검증에 쓴다.
export async function collectContracts(deps: Deps, range: { from: IsoDate; to: IsoDate }): Promise<{ contracts: ContractRow[]; stats: CollectStats }> {
  const processor = createProcessor(deps);
  for (const month of monthRanges(range.from, range.to)) {
    const rows = await fetchAll(deps.fetchPage, SEARCH, {
      inqryDiv: 1, inqryBgnDate: compact(month.from), inqryEndDate: compact(month.to), prdctClsfcNoNm: PRODUCT_NAME, numOfRows: SEARCH_ROWS,
    });
    deps.log?.(`${month.from} ~ ${month.to}: ${rows.length}건 수신`);
    await processor.process(rows);
  }
  return { contracts: processor.contracts, stats: processor.stats };
}

// 등록일시 하루치(00:00~23:59) 기본 조회 — 매일 증분에 쓴다. 서버 품명 필터가 없어 하루 약 4,200건(5쪽 안팎)을 받고,
// 그중 체결일자가 빈 사전 등록 행은 버린다. 늦게 등록되는 계약도 등록되는 날 받게 된다.
export async function collectDay(deps: Deps, day: IsoDate): Promise<{ contracts: ContractRow[]; stats: CollectStats }> {
  const processor = createProcessor(deps);
  const rows = await fetchAll(deps.fetchPage, BASE, {
    inqryDiv: 1, inqryBgnDt: `${compact(day)}0000`, inqryEndDt: `${compact(day)}2359`, numOfRows: SEARCH_ROWS,
  });
  deps.log?.(`${day}: ${rows.length}건 수신`);
  await processor.process(rows);
  return { contracts: processor.contracts, stats: processor.stats };
}
