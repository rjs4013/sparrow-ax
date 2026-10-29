import { byDemander, keywordCounts, keywordTrend, periodTrio, trendBuckets, type Range } from '../dashboard/stats.ts';
import { addDays, periodRange, type PeriodView } from '../filters/dates.ts';
import { esc } from './html.ts';

// 대시보드에 필요한 최소한의 모양: 입찰공고(공고일자) · 낙찰정보(개찰일자)를 날짜 · 수요처 · 키워드만 남긴 것.
export interface DashItem {
  date: string;
  demander: string;
  keywords: string[];
}

// 기간 수: 일 보기 14일 · 주 보기 8주 · 월 보기 6개월.
export const TREND_COUNT: Record<PeriodView, number> = { day: 14, week: 8, month: 6 };
const VIEW_LABEL: Record<PeriodView, string> = { day: '일', week: '주', month: '월' };
const TOP_DEMANDERS = 10;

// 건수 막대 · 히트맵의 색 농도는 CSS 변수와 인라인 스타일(CSP style-src 'unsafe-inline')로 그린다. 자바스크립트는 쓰지 않는다.
const pct = (value: number, max: number): number => (max <= 0 ? 0 : Math.round((value / max) * 100));

function tile(title: string, trio: { day: number; week: number; month: number }, active: PeriodView, note = ''): string {
  const cell = (v: PeriodView) => `<div class="kpi-cell${v === active ? ' on' : ''}"><div class="kpi-n">${trio[v]}</div><div class="muted">${VIEW_LABEL[v]}</div></div>`;
  return `<div class="card"><h2>${esc(title)}</h2><div class="kpi">${cell('day')}${cell('week')}${cell('month')}</div>${note}</div>`;
}

function demanderTable(bids: DashItem[], awards: DashItem[]): string {
  const { rows, others } = byDemander(bids, awards, TOP_DEMANDERS);
  if (rows.length === 0) return '<div class="muted">선택 기간에 해당하는 입찰공고 · 낙찰정보가 없습니다.</div>';
  const max = Math.max(...rows.map((r) => r.bids + r.awards));
  const body = rows
    .map((r) => `<tr><td>${esc(r.name)}<div class="bar" style="width:${pct(r.bids + r.awards, max)}%"></div></td><td class="num">${r.bids}</td><td class="num">${r.awards}</td></tr>`)
    .join('');
  const rest = others.orgs === 0 ? '' : `<tr><td class="muted">나머지 ${others.orgs}곳</td><td class="num">${others.bids}</td><td class="num">${others.awards}</td></tr>`;
  return `<table class="compact"><thead><tr><th>수요기관</th><th class="num">입찰공고</th><th class="num">낙찰</th></tr></thead><tbody>${body}${rest}</tbody></table>`;
}

function keywordTable(bids: DashItem[], awards: DashItem[], keywords: string[]): string {
  const b = keywordCounts(bids, keywords);
  const a = keywordCounts(awards, keywords);
  const rows = keywords
    .map((keyword, i) => ({ keyword, bids: b[i]?.count ?? 0, awards: a[i]?.count ?? 0 }))
    .filter((r) => r.bids + r.awards > 0)
    .sort((x, y) => y.bids + y.awards - (x.bids + x.awards));
  if (rows.length === 0) return '<div class="muted">선택 기간에 키워드에 걸린 공고가 없습니다.</div>';
  const max = Math.max(...rows.map((r) => r.bids + r.awards));
  return `<table class="compact"><thead><tr><th>공고 키워드</th><th class="num">입찰공고</th><th class="num">낙찰</th></tr></thead><tbody>${rows
    .map((r) => `<tr><td>${esc(r.keyword)}<div class="bar" style="width:${pct(r.bids + r.awards, max)}%"></div></td><td class="num">${r.bids}</td><td class="num">${r.awards}</td></tr>`)
    .join('')}</tbody></table>`;
}

function trendTable(bids: DashItem[], keywords: string[], view: PeriodView, date: string, dataFrom: string | null, today: string): string {
  const buckets = trendBuckets(view, date, TREND_COUNT[view]);
  const rows = keywordTrend(bids, keywords, buckets);
  if (rows.length === 0) return '<div class="muted">이 기간에는 키워드에 걸린 입찰공고가 없어 추세를 그릴 수 없습니다. 수집이 쌓이면 채워집니다.</div>';
  const max = Math.max(...rows.flatMap((r) => r.counts));
  // 수집은 전일자까지라 마지막 기간이 아직 끝나지 않았다면(끝 날짜가 어제보다 뒤) 진행 중이다. 직전 대비는 진행 중인 기간을 빼고 완결된 마지막 두 기간을 비교하고,
  // 비교할 직전 기간이 수집 시작 전이면 비교하지 않는다.
  const open = (buckets[buckets.length - 1]?.to ?? '') > addDays(today, -1);
  const lastIdx = buckets.length - (open ? 2 : 1);
  const prevIdx = lastIdx - 1;
  const comparable = prevIdx >= 0 && dataFrom !== null && (buckets[prevIdx]?.from ?? '') >= dataFrom;
  const head = buckets.map((x, i) => `<th class="num">${esc(x.label)}${open && i === buckets.length - 1 ? '<div class="muted">진행 중</div>' : ''}</th>`).join('');
  const body = rows
    .map((r) => {
      const diff = comparable ? (r.counts[lastIdx] ?? 0) - (r.counts[prevIdx] ?? 0) : 0;
      const change = !comparable ? '<span class="muted">-</span>' : diff > 0 ? `<span class="up">▲ ${diff}</span>` : diff < 0 ? `<span class="down">▼ ${-diff}</span>` : '<span class="muted">-</span>';
      const cells = r.counts
        .map((c) => `<td class="num heat" style="background:color-mix(in srgb, var(--accent) ${pct(c, max) * 0.6}%, transparent)">${c === 0 ? '<span class="muted">0</span>' : c}</td>`)
        .join('');
      return `<tr><td>${esc(r.keyword)}</td>${cells}<td class="num"><b>${r.total}</b></td><td class="num">${change}</td></tr>`;
    })
    .join('');
  // 첫 수집일보다 이른 기간의 0은 "없음"이 아니라 "수집 전"이므로 알린다(첫 기간이 일부만 수집됐다면 직전 대비도 믿기 어렵다).
  const pre = dataFrom !== null && (buckets[0]?.from ?? dataFrom) < dataFrom
    ? `<p class="muted">입찰공고 수집은 ${esc(dataFrom)}부터 쌓였습니다. 그 이전 기간의 0은 "없음"이 아니라 "수집 전"입니다.</p>`
    : '';
  return `${pre}<div class="tablewrap"><table class="compact"><thead><tr><th>공고 키워드</th>${head}<th class="num">합계</th><th class="num">직전 대비</th></tr></thead><tbody>${body}</tbody></table></div>
<p class="muted">직전 대비는 완결된 마지막 두 기간을 비교합니다(진행 중인 기간은 제외, 수집 전 기간과는 비교하지 않음).</p>`;
}

// 입찰 · 낙찰 대시보드 영역(요구사항 5.5 · 6.1). 건수 · 수요기관별 · 키워드별은 고른 기간(range) 기준이고, 일/주/월 건수와 추세는 고른 날짜 기준이다.
// bids / awards는 수요기관 · 키워드 조건을 이미 적용한 것이며 추세 기간 전체를 덮는 범위여야 한다.
export function dashboardHtml(input: {
  view: PeriodView; date: string; range: Range; bids: DashItem[]; awards: DashItem[]; keywords: string[];
  // 저장된 가장 이른 입찰공고 · 낙찰정보 일자("수집 전" 안내용). 없으면 null.
  dataFrom: string | null;
  awardFrom: string | null;
  // 오늘(수집은 전일자까지라 오늘 기간은 진행 중).
  today: string;
}): string {
  const { view, date, range, bids, awards, keywords, dataFrom, awardFrom, today } = input;
  const within = (items: DashItem[]) => items.filter((i) => i.date >= range.from && i.date <= range.to);
  const bidsNow = within(bids);
  const awardsNow = within(awards);
  // 낙찰정보는 수집이 짧아 0이 "없음"인지 "수집 전"인지 구별되지 않으므로 수집 시작일을 알린다.
  const awardNote = awardFrom === null
    ? '<p class="muted">낙찰정보 수집 기록이 없습니다.</p>'
    : periodRange('month', date).from < awardFrom
      ? `<p class="muted">낙찰정보 수집은 ${esc(awardFrom)}부터 쌓였습니다. 그 이전의 0은 "수집 전"입니다.</p>`
      : '';
  return `<div class="grid">${tile('신규 입찰공고 건수', periodTrio(bids, date), view)}${tile('신규 낙찰 건수', periodTrio(awards, date), view, awardNote)}</div>
<div class="grid">
<div class="card"><h2>수요기관별 현황 <span class="muted">(${esc(range.from)} ~ ${esc(range.to)})</span></h2>${demanderTable(bidsNow, awardsNow)}</div>
<div class="card"><h2>공고 키워드별 발생 건수 <span class="muted">(${esc(range.from)} ~ ${esc(range.to)})</span></h2>${keywordTable(bidsNow, awardsNow, keywords)}</div>
</div>
<div class="card"><h2>공고 키워드별 사업 추세 <span class="muted">(입찰공고, 최근 ${TREND_COUNT[view]}${VIEW_LABEL[view] === '월' ? '개월' : VIEW_LABEL[view] === '주' ? '주' : '일'})</span></h2>${trendTable(bids, keywords, view, date, dataFrom, today)}</div>
<p class="muted">건수는 (공고번호, 차수) 행 기준입니다(정정 · 재입찰 공고는 차수가 다른 행으로 따로 셉니다). 한 공고가 여러 키워드에 걸리면 각각 세므로 키워드별 건수의 합이 공고 수보다 클 수 있습니다.</p>`;
}
