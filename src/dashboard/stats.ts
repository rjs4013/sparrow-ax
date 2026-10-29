import { addDays, periodRange, shiftPeriod, type IsoDate, type PeriodView } from '../filters/dates.ts';

// 입찰 · 낙찰 대시보드 집계(순수 함수). 입력은 저장된 입찰공고(공고일자) · 낙찰정보(개찰일자)를 날짜 · 수요처 · 키워드만 남긴 모양이다.
export interface Range {
  from: IsoDate;
  to: IsoDate;
}

export interface Bucket extends Range {
  label: string;
}

const inRange = (date: string, r: Range): boolean => date >= r.from && date <= r.to;

export function countIn(items: { date: string }[], range: Range): number {
  return items.filter((i) => inRange(i.date, range)).length;
}

// 고른 날짜 기준 일 · 주(월~일) · 월 건수.
export function periodTrio(items: { date: string }[], date: IsoDate): { day: number; week: number; month: number } {
  return {
    day: countIn(items, periodRange('day', date)),
    week: countIn(items, periodRange('week', date)),
    month: countIn(items, periodRange('month', date)),
  };
}

const NO_DEMANDER = '(수요처 없음)';

// 수요기관별 입찰공고 · 낙찰 건수. 합계 많은 순(같으면 이름순)으로 상위 limit곳과 나머지 합계.
export function byDemander(
  bids: { demander: string }[],
  awards: { demander: string }[],
  limit: number,
): { rows: { name: string; bids: number; awards: number }[]; others: { orgs: number; bids: number; awards: number } } {
  const map = new Map<string, { name: string; bids: number; awards: number }>();
  const entry = (name: string) => {
    const key = name === '' ? NO_DEMANDER : name;
    let e = map.get(key);
    if (!e) map.set(key, (e = { name: key, bids: 0, awards: 0 }));
    return e;
  };
  for (const b of bids) entry(b.demander).bids++;
  for (const a of awards) entry(a.demander).awards++;
  const sorted = [...map.values()].sort((x, y) => y.bids + y.awards - (x.bids + x.awards) || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  const rest = sorted.slice(limit);
  return {
    rows: sorted.slice(0, limit),
    others: { orgs: rest.length, bids: rest.reduce((s, r) => s + r.bids, 0), awards: rest.reduce((s, r) => s + r.awards, 0) },
  };
}

// 키워드별 건수(설정 키워드 순서). 한 공고에 키워드가 여럿이면 각각 한 번씩 센다. 설정에 없는 키워드는 무시한다(추세는 필터 키워드만, 사람 결정).
export function keywordCounts(items: { keywords: string[] }[], keywords: string[]): { keyword: string; count: number }[] {
  return keywords.map((keyword) => ({ keyword, count: items.filter((i) => i.keywords.includes(keyword)).length }));
}

// 고른 날짜까지 n개 기간(오래된 것부터). 일 = 하루, 주 = 월~일, 월 = 달력 월.
export function trendBuckets(view: PeriodView, date: IsoDate, n: number): Bucket[] {
  const buckets: Bucket[] = [];
  let cursor = date;
  for (let i = 0; i < n; i++) {
    const r = periodRange(view, cursor);
    const label = view === 'month' ? r.from.slice(0, 7) : view === 'week' ? `${r.from.slice(5)}~` : r.from.slice(5);
    buckets.unshift({ label, from: r.from, to: r.to });
    cursor = view === 'day' ? addDays(cursor, -1) : shiftPeriod(view, cursor, -1);
  }
  return buckets;
}

// 기간별 키워드 건수와 합계. 합계 많은 순(같으면 설정 순서)이고 기간 전체에서 한 번도 없는 키워드는 뺀다.
export function keywordTrend(
  items: { date: string; keywords: string[] }[],
  keywords: string[],
  buckets: Bucket[],
): { keyword: string; counts: number[]; total: number }[] {
  return keywords
    .map((keyword, order) => {
      const counts = buckets.map((b) => items.filter((i) => inRange(i.date, b) && i.keywords.includes(keyword)).length);
      return { keyword, counts, total: counts.reduce((a, c) => a + c, 0), order };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total || a.order - b.order)
    .map(({ keyword, counts, total }) => ({ keyword, counts, total }));
}
