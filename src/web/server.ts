import Fastify from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { trendBuckets } from '../dashboard/stats.ts';
import { firstAwardDate, listAwards, type AwardView } from '../db/awards.ts';
import { firstNoticeDate, listBids, type BidRow } from '../db/bids.ts';
import { lastRunByKind, listContracts, type ContractRow, type RunKind, type RunRecord } from '../db/contracts.ts';
import { listDeliveries, type DeliveryRow } from '../db/deliveries.ts';
import { buildWorkbook, exportFileName } from '../export/excel.ts';
import { addDays, periodRange, shiftPeriod, todayKst, type PeriodView } from '../filters/dates.ts';
import { dashboardHtml, TREND_COUNT, type DashItem } from './dashboard.ts';
import { esc, won } from './html.ts';

export interface ServerOptions {
  db?: DatabaseSync;
  // 업체 선택 목록(설정의 id · 표시 이름).
  companies?: { id: string; label: string }[];
  today?: () => string;
  // 엑셀의 계약 시트에 쓰는 물품분류번호(설정 값).
  categoryCode?: string;
  // 입찰공고 화면의 키워드 선택지(설정의 필터 키워드).
  keywords?: string[];
}

const VIEWS: { view: PeriodView; label: string }[] = [
  { view: 'day', label: '일' },
  { view: 'week', label: '주' },
  { view: 'month', label: '월' },
];

// RFC 5987 filename*: encodeURIComponent가 인코딩하지 않는 ' ( ) * 도 퍼센트 인코딩한다.
const encodeRfc5987 = (s: string): string => encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const CSS = `
:root{--bg:#f7f7f5;--fg:#1f2328;--muted:#6a7078;--card:#fff;--line:#e2e3e0;--accent:#1d5fd0;--ok:#15803d;--bad:#b42318;--warn:#b45309;--chip:#eef1f6}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#e6e8eb;--muted:#9aa1ab;--card:#1c1f25;--line:#2d313a;--accent:#7aa7ff;--ok:#4ade80;--bad:#f87171;--warn:#fbbf24;--chip:#262b34}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI","Malgun Gothic",sans-serif}
main{max-width:1200px;margin:0 auto;padding:20px 16px 48px}h1{font-size:20px;margin:0 0 12px}h2{font-size:15px;margin:0 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:12px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.grow{flex:1}.muted{color:var(--muted)}
.tabs a,.nav a,.pages a,.dl{padding:4px 12px;border:1px solid var(--line);border-radius:6px;color:var(--fg);text-decoration:none;background:var(--card)}
.tabs a.on,.pages a.on{background:var(--accent);color:#fff;border-color:var(--accent)}.pages{margin-bottom:12px}
select,button{font:inherit;padding:4px 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}
.status-success{color:var(--ok);font-weight:600}.status-failed{color:var(--bad);font-weight:600}.status-running{color:var(--warn);font-weight:600}.runline{padding:6px 0;border-top:1px solid var(--line)}.runline:first-of-type{border-top:0}
.tablewrap{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:900px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:600;white-space:nowrap}
td.num{text-align:right;white-space:nowrap}.chip{display:inline-block;padding:1px 8px;border-radius:999px;background:var(--chip);font-size:12px;margin:0 4px 2px 0;white-space:nowrap}
.chip.ok{color:var(--ok)}.chip.warn{color:var(--warn)}.empty{padding:28px;text-align:center}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}.grid>.card{margin-bottom:0}.grid+.grid,.grid+.card{margin-top:12px}
.kpi{display:flex;gap:8px}.kpi-cell{flex:1;text-align:center;padding:8px 4px;border:1px solid var(--line);border-radius:8px}.kpi-cell.on{background:var(--chip);border-color:var(--accent)}.kpi-n{font-size:24px;font-weight:700;line-height:1.2}
table.compact{min-width:0}.bar{height:6px;border-radius:3px;background:var(--accent);opacity:.55;margin-top:3px}td.heat{min-width:48px}.up{color:var(--ok);font-weight:600}.down{color:var(--bad);font-weight:600}
@media (max-width:640px){main{padding:12px}}
`;

type Page = 'contracts' | 'deliveries' | 'bids';
const PATH: Record<Page, string> = { contracts: '/', deliveries: '/deliveries', bids: '/bids' };
const PAGE_LABEL: Record<Page, string> = { contracts: '계약', deliveries: '납품요구', bids: '입찰공고' };

// extra: 화면별 추가 조회 조건(입찰공고의 수요기관 · 키워드). 빈 값은 싣지 않는다.
function href(page: Page, view: PeriodView, date: string, company: string, extra: Record<string, string> = {}): string {
  const q = [
    `view=${view}`, `date=${date}`, ...(company === '' ? [] : [`company=${encodeURIComponent(company)}`]),
    ...Object.entries(extra).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`),
  ];
  return `${PATH[page]}?${q.join('&')}`;
}

// 저장된 UTC 시각을 한국 시간(UTC+9, 일광절약시간 없음)으로 보여 준다.
const kst = (iso: string): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : `${new Date(ms + 9 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')} 한국시간`;
};

const KIND_LABEL: Record<RunKind, string> = {
  backfill: '백필(체결일자)', daily: '매일 증분(등록일시)', verify: '교차 검증',
  dlvr_backfill: '납품요구 백필(접수일자)', dlvr_daily: '납품요구 매일(접수일자)', bid_daily: '입찰공고 매일(공고일시)', award_daily: '낙찰정보 매일(개찰일시)',
};
// 관리 화면의 수집 상태 묶음.
const RUN_GROUPS: { title: string; kinds: RunKind[]; empty: string }[] = [
  { title: '계약(경쟁사) 수집', kinds: ['daily', 'verify', 'backfill'], empty: '수집 기록이 없습니다. <code>npm run collect</code>로 수집을 먼저 실행하세요.' },
  { title: '납품요구 수집', kinds: ['dlvr_daily', 'dlvr_backfill'], empty: '납품요구 수집 기록이 없습니다. <code>npm run collect -- --mode dlvr-backfill</code>로 수집을 먼저 실행하세요.' },
  { title: '입찰공고 수집', kinds: ['bid_daily'], empty: '입찰공고 수집 기록이 없습니다. <code>npm run collect -- --mode bid-daily</code>로 수집을 먼저 실행하세요.' },
  { title: '낙찰정보 수집', kinds: ['award_daily'], empty: '낙찰정보 수집 기록이 없습니다. <code>npm run collect -- --mode award-daily</code>로 수집을 먼저 실행하세요.' },
];

function runLine(run: RunRecord): string {
  const label = { success: '성공', failed: '실패', running: '진행 중(또는 중단됨)' }[run.status];
  const range = run.rangeFrom === run.rangeTo ? run.rangeFrom : `${run.rangeFrom} ~ ${run.rangeTo}`;
  const what = run.kind === 'award_daily'
    ? `수신 ${run.fetched}행 · 키워드 적중 공고 ${run.matched}건 저장`
    : run.kind.startsWith('bid')
    ? `수신 ${run.fetched}건 · 키워드 적중 ${run.matched}건 저장`
    : run.kind.startsWith('dlvr') ? `수신 ${run.fetched}행 · 9개사 납품요구 ${run.matched}행 저장` : `수신 ${run.fetched}건 · 9개사 계약 ${run.matched}건 저장`;
  const detail = `${what} · 호출 ${run.calls}회`;
  return `<div class="runline"><div class="row"><b>${esc(KIND_LABEL[run.kind])}</b><span class="status-${run.status}">${label}</span>
<span>${esc(range)}</span><span class="muted">${esc(kst(run.finishedAt ?? run.startedAt))}</span></div>
<div class="muted">${esc(detail)}${run.note === null ? '' : ` · ${esc(run.note)}`}</div>${run.error === null ? '' : `<div class="status-failed">${esc(run.error)}</div>`}</div>`;
}

// 관리 화면: 수집 종류별 마지막 실행 상태. 접근 제한 없이 화면 위쪽 "관리" 탭으로 들어간다.
function adminPage(runs: Partial<Record<RunKind, RunRecord>>): string {
  const groups = RUN_GROUPS.map((g) => {
    const lines = g.kinds.flatMap((k) => (runs[k] ? [runLine(runs[k])] : []));
    return `<div class="card"><h2>${esc(g.title)}</h2>${lines.length === 0 ? `<div class="muted">${g.empty}</div>` : lines.join('')}</div>`;
  }).join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>경쟁사 모니터링 · 관리</title><style>${CSS}</style></head><body><main>
<h1>경쟁사 모니터링</h1>
<div class="pages row">${pagesBar(null, (p) => PATH[p])}</div>
<p class="muted">마지막 수집 상태입니다. 수집은 명령(<code>npm run collect -- --mode …</code>)으로 실행하고, 결과가 여기에 기록됩니다.</p>
${groups}
</main></body></html>`;
}

// 화면 이동 탭(계약 · 납품요구 · 입찰공고 · 관리). active가 null이면 관리 화면이다.
function pagesBar(active: Page | null, linkFor: (p: Page) => string): string {
  const links = (['contracts', 'deliveries', 'bids'] as Page[])
    .map((p) => `<a class="${p === active ? 'on' : ''}" href="${esc(linkFor(p))}">${PAGE_LABEL[p]}</a>`).join('');
  return `${links}<a class="${active === null ? 'on' : ''}" href="/admin">관리</a>`;
}

function idChips(hasId: boolean, verified: boolean, idConflict: boolean): string {
  return [
    // 식별번호가 비어 있으면 목록 안팎을 판정할 수 없다.
    !hasId ? '<span class="chip warn">제품 정보 없음</span>' : verified ? '<span class="chip ok">확인 대상</span>' : '<span class="chip warn">목록 밖</span>',
    ...(idConflict ? ['<span class="chip warn">대조 필요</span>'] : []),
  ].join('');
}

function productCell(r: ContractRow): string {
  const items = r.productIds.map((id, i) => `${esc(id)}${r.productNames[i] ? ` ${esc(r.productNames[i] as string)}` : ''}`);
  // 제품이 수십 개인 계약이 있어 앞 2개만 보이고 나머지는 접는다 (스크립트 없이 details로).
  const shown = items.slice(0, 2).join('<br>');
  const rest = items.length > 2 ? `<details><summary>외 ${items.length - 2}개</summary>${items.slice(2).join('<br>')}</details>` : '';
  return `${idChips(r.productIds.length > 0, r.verified, r.idConflict)}<div class="muted">${shown}${rest}</div>`;
}

function demanderCell(r: ContractRow): string {
  return r.demanderPlaceholder
    ? '<span class="chip warn">수요기관 미공개</span><div class="muted">조달청 계약</div>'
    : esc(r.demanderName);
}

interface Shell {
  page: Page; view: PeriodView; date: string; company: string; companies: { id: string; label: string }[];
  range: { from: string; to: string };
  title: string; summary: string; body: string; note: string;
  // 본문 카드 아래에 이어 붙이는 카드(입찰공고 화면의 낙찰정보 목록), 위에 놓는 영역(입찰 · 낙찰 대시보드).
  after?: string;
  before?: string;
  // 입찰공고 화면처럼 업체 선택 대신 쓰는 조회 조건(선택 상자 HTML)과 그 값(이동 링크에 싣는다). 있으면 업체 선택 · 엑셀 링크는 없다.
  controls?: string; extra?: Record<string, string>;
}

// 계약 · 납품요구 · 입찰공고 세 화면의 공통 뼈대: 화면 이동 탭, 기간 선택, 조회 조건(수집 상태는 관리 화면에만 있다).
function shell(s: Shell): string {
  const { page, view, date, company } = s;
  const extra = s.extra ?? {};
  const pages = pagesBar(page, (p) => href(p, view, date, company));
  const tabs = VIEWS.map((v) => `<a class="${v.view === view ? 'on' : ''}" href="${esc(href(page, v.view, date, company, extra))}">${v.label}</a>`).join('');
  const exportHref = `/export.xlsx?date=${date}${company === '' ? '' : `&company=${encodeURIComponent(company)}`}`;
  const options = [{ id: '', label: '전체 업체' }, ...s.companies]
    .map((c) => `<option value="${esc(c.id)}"${c.id === company ? ' selected' : ''}>${esc(c.label)}</option>`).join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>경쟁사 모니터링 · ${esc(s.title)}</title><style>${CSS}</style></head><body><main>
<h1>경쟁사 모니터링</h1>
<div class="pages row">${pages}</div>
<div class="card"><form method="get" action="${PATH[page]}" class="row"><input type="hidden" name="view" value="${view}"><input type="hidden" name="date" value="${esc(date)}">
<span class="tabs row">${tabs}</span>
<span class="nav row"><a href="${esc(href(page, view, shiftPeriod(view, date, -1), company, extra))}">← 이전</a><a href="${esc(href(page, view, shiftPeriod(view, date, 1), company, extra))}">다음 →</a></span>
${s.controls ?? `<select name="company" aria-label="업체">${options}</select>`}<button type="submit">조회</button>
${s.controls ? '' : `<a class="dl" href="${esc(exportHref)}" title="고른 날짜가 속한 달 전체를 엑셀로 내려받습니다">엑셀 내보내기</a>`}
<span class="grow"></span><b>${esc(s.range.from)} ~ ${esc(s.range.to)}</b><span class="muted">${esc(s.summary)}</span></form></div>
${s.before ?? ''}
<div class="card">${s.body}</div>
${s.after ?? ''}
<p class="muted">${s.note}</p>
</main></body></html>`;
}

function contractsBody(rows: ContractRow[]): string {
  if (rows.length === 0) return '<div class="empty muted">해당 기간에 수집된 계약이 없습니다.</div>';
  return `<div class="tablewrap"><table><thead><tr><th>체결일자</th><th>업체</th><th>계약명</th><th class="num">금액(원)</th><th>계약기관</th><th>수요기관</th><th>제품</th><th>계약방법</th></tr></thead><tbody>${rows
    .map((r) => `<tr><td>${esc(r.signedDate)}</td><td>${esc(r.companyName)}</td><td>${esc(r.contractName)}<div class="muted">${esc(r.untyNo)}</div></td><td class="num">${won(r.amount)}</td><td>${esc(r.contractOrg)}</td><td>${demanderCell(r)}</td><td>${productCell(r)}</td><td>${esc(r.method)}</td></tr>`)
    .join('')}</tbody></table></div>`;
}

function deliveriesBody(rows: DeliveryRow[]): string {
  if (rows.length === 0) return '<div class="empty muted">해당 기간에 수집된 납품요구가 없습니다.</div>';
  return `<div class="tablewrap"><table><thead><tr><th>접수일자</th><th>업체</th><th>수요기관</th><th>제품</th><th class="num">수량</th><th class="num">단가(원)</th><th class="num">금액(원)</th><th>납품기한</th><th>계약방식 · 납품요구</th></tr></thead><tbody>${rows
    .map((r) => {
      // 변경 차수에서 수량이 0이 되면 취소다(실측: 변경 1차에서 수량 0 · 금액 0 · 증감 음수).
      const flags = `${r.finalYn ? '' : '<span class="chip warn">최종 아님</span>'}${r.chgOrd > 0 ? `<span class="chip">변경 ${r.chgOrd}차</span>` : ''}${r.chgOrd > 0 && r.qty === 0 ? '<span class="chip warn">취소(수량 0)</span>' : ''}`;
      const product = `${idChips(r.productId !== '', r.verified, r.idConflict)}<div class="muted">${esc(r.productId)}${r.productName ? ` ${esc(r.productName)}` : ''}</div>`;
      return `<tr><td>${esc(r.receivedDate)}</td><td>${esc(r.companyName)}</td><td>${esc(r.demanderName)}<div class="muted">${esc(r.demanderKind)}${r.demanderCode ? ` · ${esc(r.demanderCode)}` : ''}</div></td><td>${product}</td><td class="num">${r.qty === null ? '-' : won(r.qty)}</td><td class="num">${won(r.unitPrice)}</td><td class="num">${won(r.amount)}</td><td>${esc(r.deadline)}</td><td>${esc(r.contractStyle)}<div class="muted">${esc(r.dlvrReqNo)}</div>${flags}</td></tr>`;
    })
    .join('')}</tbody></table></div>`;
}

// 외부 링크는 http(s)만 링크로 만든다(javascript: 같은 값 방어).
const safeLink = (url: string): string =>
  /^https?:\/\//i.test(url) ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">공고 보기</a>` : '<span class="muted">-</span>';

function bidsBody(rows: BidRow[]): string {
  if (rows.length === 0) return '<div class="empty muted">해당 기간에 수집된 입찰공고가 없습니다.</div>';
  return `<div class="tablewrap"><table><thead><tr><th>공고명</th><th>수요처</th><th class="num">추정가격(원)</th><th>입찰일</th><th>등록마감</th><th>투찰마감</th><th>개찰</th><th>공고 링크</th></tr></thead><tbody>${rows
    .map((r) => {
      const status = r.status === '' || r.status === '일반공고' ? '' : `<span class="chip warn">${esc(r.status)}</span>`;
      const kind = r.workKind === '' ? '' : `<span class="chip">${esc(r.workKind)}</span>`;
      const kws = r.keywords.map((k) => `<span class="chip ok">${esc(k)}</span>`).join('');
      const budget = r.budgetAmount === null ? '' : `<div class="muted">배정예산 ${won(r.budgetAmount)}</div>`;
      return `<tr><td>${esc(r.title)}<div class="muted">${esc(r.bidNtceNo)} · 차수 ${esc(r.bidNtceOrd)}</div>${status}${kind}${kws}</td><td>${esc(r.demanderName)}</td><td class="num">${won(r.estimatedPrice)}${budget}</td><td>${esc(r.bidBegin || '-')}</td><td>${esc(r.regClose || '-')}</td><td>${esc(r.bidClose || '-')}</td><td>${esc(r.opening || '-')}</td><td>${safeLink(r.url)}</td></tr>`;
    })
    .join('')}</tbody></table></div>`;
}

function awardsBody(rows: AwardView[]): string {
  if (rows.length === 0) return '<div class="empty muted">해당 기간에 수집된 낙찰정보가 없습니다.</div>';
  return `<div class="tablewrap"><table><thead><tr><th>공고명</th><th>수요처</th><th class="num">기초금액(원)</th><th>낙찰처</th><th class="num">낙찰금액(원)</th><th>개찰</th><th>공고 링크</th></tr></thead><tbody>${rows
    .map((r) => {
      const result = r.result === '' || r.result === '개찰완료' ? '' : `<span class="chip warn">${esc(r.result)}</span>`;
      const notice = r.linked ? (r.noticeStatus === '' || r.noticeStatus === '일반공고' ? '' : `<span class="chip warn">${esc(r.noticeStatus)}</span>`) : '<span class="chip">공고 미수집(단독)</span>';
      const kws = r.keywords.map((k) => `<span class="chip ok">${esc(k)}</span>`).join('');
      const winner = r.winnerName !== ''
        ? esc(r.winnerName)
        : r.result === '개찰완료' || r.result === '' ? '<span class="muted">낙찰자 미확정</span>' : '<span class="muted">-</span>';
      const rate = r.winnerRate === null ? '' : `<div class="muted">낙찰률 ${esc(r.winnerRate)}%</div>`;
      const estimate = r.estimatedPrice === null ? '' : `<div class="muted">추정가격 ${won(r.estimatedPrice)}</div>`;
      return `<tr><td>${esc(r.title)}<div class="muted">${esc(r.bidNtceNo)} · 차수 ${esc(r.bidNtceOrd)} · 투찰 ${r.bidderCount}곳</div>${result}${notice}<span class="chip">${esc(r.workKind)}</span>${kws}</td><td>${esc(r.demanderName)}</td><td class="num">${won(r.baseAmount)}${estimate}</td><td>${winner}</td><td class="num">${won(r.winnerAmount)}${rate}</td><td>${esc(r.opening || '-')}</td><td>${r.linked ? safeLink(r.noticeUrl) : '<span class="muted">-</span>'}</td></tr>`;
    })
    .join('')}</tbody></table></div>`;
}

export function buildServer(opts: ServerOptions = {}) {
  const app = Fastify({ logger: false });
  app.get('/health', async () => ({ status: 'ok' }));

  const { db } = opts;
  if (db) {
    const companies = opts.companies ?? [];
    const today = opts.today ?? todayKst;
    const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

    const BAD = '잘못된 조회 조건입니다 (view: day|week|month, date: YYYY-MM-DD, company: 목록의 id)';
    // 화면 · 엑셀이 같이 쓰는 조회 조건 검증. 잘못되면 null.
    const parseConditions = (q: Record<string, string | undefined>): { view: PeriodView; date: string; company: string } | null => {
      const view = (q['view'] ?? 'month') as PeriodView;
      const date = q['date'] ?? today();
      const company = q['company'] ?? '';
      try {
        if (!VIEWS.some((v) => v.view === view)) throw new Error('view');
        addDays(date, 0);
        if (company !== '' && !companies.some((c) => c.id === company)) throw new Error('company');
      } catch {
        return null;
      }
      return { view, date, company };
    };

    // 엑셀 내보내기: 고른 날짜가 속한 달 전체(일/주 보기여도) + 업체 선택을 반영한다.
    app.get('/export.xlsx', async (req, reply) => {
      const cond = parseConditions(req.query as Record<string, string | undefined>);
      if (!cond) return reply.code(400).type('text/plain; charset=utf-8').send(BAD);
      const range = periodRange('month', cond.date);
      const month = range.from.slice(0, 7);
      const filter = { ...range, ...(cond.company === '' ? {} : { companyId: cond.company }) };
      const label = cond.company === '' ? null : (companies.find((c) => c.id === cond.company)?.label ?? cond.company);
      const file = await buildWorkbook({
        month, companyLabel: label, categoryCode: opts.categoryCode ?? '', deliveries: listDeliveries(db, filter), contracts: listContracts(db, filter),
      });
      return reply
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('content-disposition', `attachment; filename="export_${month}.xlsx"; filename*=UTF-8''${encodeRfc5987(exportFileName(month, label))}`)
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .send(file);
    });

    // 관리 화면: 수집 종류별 마지막 실행 상태(접근 제한 없음).
    app.get('/admin', async (_req, reply) =>
      reply
        .type('text/html; charset=utf-8')
        .header('content-security-policy', CSP)
        .header('x-content-type-options', 'nosniff')
        .send(adminPage(lastRunByKind(db))));

    // 입찰공고 화면: 공고일자 기간(일 · 주 · 월) · 수요기관 · 공고 키워드 조건(낙찰정보도 같은 조건으로 거른다).
    const keywords = opts.keywords ?? [];
    app.get('/bids', async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      const cond = parseConditions({ ...(q['view'] === undefined ? {} : { view: q['view'] }), ...(q['date'] === undefined ? {} : { date: q['date'] }) });
      const demander = q['demander'] ?? '';
      const keyword = q['keyword'] ?? '';
      if (!cond || demander.length > 200 || (keyword !== '' && !keywords.includes(keyword))) {
        return reply.code(400).type('text/plain; charset=utf-8').send('잘못된 조회 조건입니다 (view: day|week|month, date: YYYY-MM-DD, demander: 200자 이하, keyword: 설정의 키워드)');
      }
      const { view, date } = cond;
      const range = periodRange(view, date);
      const inRange = listBids(db, range);
      const awardsInRange = listAwards(db, range);
      const matches = (d: string, k: string[]) => (demander === '' || d === demander) && (keyword === '' || k.includes(keyword));
      const rows = inRange.filter((r) => matches(r.demanderName, r.keywords));
      const awards = awardsInRange.filter((a) => matches(a.demanderName, a.keywords));

      // 대시보드: 일/주/월 건수와 추세 기간 전체를 덮는 범위의 입찰공고 · 낙찰정보에 같은 수요기관 · 키워드 조건을 적용해 집계한다.
      const month = periodRange('month', date);
      const week = periodRange('week', date);
      const trendFrom = trendBuckets(view, date, TREND_COUNT[view])[0]?.from ?? range.from;
      const wide = {
        from: [trendFrom, month.from, week.from, range.from].sort()[0] as string,
        to: [month.to, week.to, range.to].sort().reverse()[0] as string,
      };
      const dashBids: DashItem[] = listBids(db, wide).filter((r) => matches(r.demanderName, r.keywords))
        .map((r) => ({ date: r.noticeDate, demander: r.demanderName, keywords: r.keywords }));
      const dashAwards: DashItem[] = listAwards(db, wide).filter((a) => matches(a.demanderName, a.keywords))
        .map((a) => ({ date: a.opening.slice(0, 10), demander: a.demanderName, keywords: a.keywords }));
      // 키워드를 고르면 키워드별 건수 · 추세도 그 키워드 한 줄로 제한한다(다른 키워드가 함께 든 공고여도).
      const dashboard = dashboardHtml({
        view, date, range, bids: dashBids, awards: dashAwards, keywords: keyword === '' ? keywords : [keyword],
        dataFrom: firstNoticeDate(db), awardFrom: firstAwardDate(db), today: today(),
      });
      // 고른 수요기관이 이 기간에 없어도 선택 상자에 남겨, 기간을 옮겨도 조건이 조용히 바뀌지 않게 한다.
      const demanders = [...new Set([...inRange.map((r) => r.demanderName), ...awardsInRange.map((a) => a.demanderName), ...(demander === '' ? [] : [demander])])].sort();
      const opt = (value: string, label: string, selected: string) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
      const controls =
        `<select name="demander" aria-label="수요기관">${[opt('', '전체 수요기관', demander), ...demanders.map((d) => opt(d, d, demander))].join('')}</select>` +
        `<select name="keyword" aria-label="공고 키워드">${[opt('', '전체 키워드', keyword), ...keywords.map((k) => opt(k, k, keyword))].join('')}</select>`;
      const html = shell({
        page: 'bids', view, date, company: '', companies: [], range, title: '입찰공고',
        summary: `${rows.length}건 · 수요기관 ${new Set(rows.map((r) => r.demanderName)).size}곳 · 낙찰 ${awards.length}건`,
        before: dashboard, body: `<h2>입찰공고</h2>${bidsBody(rows)}`, after: `<div class="card"><h2>낙찰정보</h2>${awardsBody(awards)}</div>`, controls, extra: { demander, keyword },
        note: '입찰공고는 공고일자, 낙찰정보는 개찰일자 기준이며 공고명에 필터 키워드(대소문자 무시 포함)가 있는 것만 저장합니다. 입찰공고의 금액은 추정가격입니다(요구사항의 "기초금액"은 입찰공고 응답에는 없고 낙찰정보에는 있습니다). 정정 · 재입찰 공고는 차수가 다른 행이고, 낙찰자는 개찰 며칠 뒤에 확정되어 그 전에는 "낙찰자 미확정"으로 보입니다(다시 받으면 갱신). 한 공고에 낙찰자가 여럿(품목별)이면 처음 만난 낙찰자만 보입니다.',
      });
      return reply
        .type('text/html; charset=utf-8')
        .header('content-security-policy', CSP)
        .header('x-content-type-options', 'nosniff')
        .send(html);
    });

    for (const page of ['contracts', 'deliveries'] as Page[]) {
      app.get(PATH[page], async (req, reply) => {
        const cond = parseConditions(req.query as Record<string, string | undefined>);
        if (!cond) return reply.code(400).type('text/plain; charset=utf-8').send(BAD);
        const { view, date, company } = cond;
        const range = periodRange(view, date);
        const filter = { ...range, ...(company === '' ? {} : { companyId: company }) };
        const base = { page, view, date, company, companies, range };

        let html: string;
        if (page === 'contracts') {
          const rows = listContracts(db, filter);
          // 공동수급 계약은 업체별 행에 같은 금액이 들어 있으므로 계약(통합계약번호) 단위로 한 번만 더한다.
          const total = [...new Map(rows.map((r) => [r.untyNo, r.amount ?? 0])).values()].reduce((a, b) => a + b, 0);
          html = shell({
            ...base, title: '계약', summary: `${rows.length}건 · 합계 ${won(total)}원`, body: contractsBody(rows),
            note: '체결일자 기준입니다. 금액은 금차계약금액이며, 조달청 계약은 API가 실제 수요기관을 알려 주지 않습니다. 실제 수요기관 · 금액은 "납품요구" 화면에서 봅니다.',
          });
        } else {
          const rows = listDeliveries(db, filter);
          const total = rows.reduce((sum, r) => sum + (r.amount ?? 0), 0);
          const requests = new Set(rows.map((r) => r.dlvrReqNo)).size;
          const demanders = new Set(rows.map((r) => r.demanderCode || r.demanderName)).size;
          html = shell({
            ...base, title: '납품요구', summary: `${rows.length}행 · 납품요구 ${requests}건 · 수요기관 ${demanders}곳 · 합계 ${won(total)}원`, body: deliveriesBody(rows),
            note: '납품요구 접수일자 기준이며 한 행이 물품 하나입니다. 변경 차수가 있는 납품요구는 최초 접수일자 기간에 최신 차수의 수량 · 금액으로 보여 줍니다(취소는 수량 0). 나라장터쇼핑몰의 납품요구 정보이며 계약 화면의 계약과는 번호로 연결되지 않습니다.',
          });
        }
        return reply
          .type('text/html; charset=utf-8')
          .header('content-security-policy', CSP)
          .header('x-content-type-options', 'nosniff')
          .send(html);
      });
    }
  }
  return app;
}
