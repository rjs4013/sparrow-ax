import Fastify from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { lastRun, listContracts, type ContractRow, type RunRecord } from '../db/contracts.ts';
import { addDays, periodRange, shiftPeriod, todayKst, type PeriodView } from '../filters/dates.ts';

export interface ServerOptions {
  db?: DatabaseSync;
  // 업체 선택 목록(설정의 id · 표시 이름).
  companies?: { id: string; label: string }[];
  today?: () => string;
}

const VIEWS: { view: PeriodView; label: string }[] = [
  { view: 'day', label: '일' },
  { view: 'week', label: '주' },
  { view: 'month', label: '월' },
];

// 계약명 · 업체명 등은 외부(나라장터) 데이터이므로 모두 이스케이프해서 출력한다.
const esc = (v: string | number): string =>
  String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const won = (n: number | null): string => (n === null ? '-' : n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','));

const CSS = `
:root{--bg:#f7f7f5;--fg:#1f2328;--muted:#6a7078;--card:#fff;--line:#e2e3e0;--accent:#1d5fd0;--ok:#15803d;--bad:#b42318;--warn:#b45309;--chip:#eef1f6}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#e6e8eb;--muted:#9aa1ab;--card:#1c1f25;--line:#2d313a;--accent:#7aa7ff;--ok:#4ade80;--bad:#f87171;--warn:#fbbf24;--chip:#262b34}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI","Malgun Gothic",sans-serif}
main{max-width:1200px;margin:0 auto;padding:20px 16px 48px}h1{font-size:20px;margin:0 0 12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:12px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.grow{flex:1}.muted{color:var(--muted)}
.tabs a,.nav a{padding:4px 12px;border:1px solid var(--line);border-radius:6px;color:var(--fg);text-decoration:none;background:var(--card)}
.tabs a.on{background:var(--accent);color:#fff;border-color:var(--accent)}
select,button{font:inherit;padding:4px 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}
.status-success{color:var(--ok);font-weight:600}.status-failed{color:var(--bad);font-weight:600}.status-running{color:var(--warn);font-weight:600}
.tablewrap{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:900px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:600;white-space:nowrap}
td.num{text-align:right;white-space:nowrap}.chip{display:inline-block;padding:1px 8px;border-radius:999px;background:var(--chip);font-size:12px;margin:0 4px 2px 0;white-space:nowrap}
.chip.ok{color:var(--ok)}.chip.warn{color:var(--warn)}.empty{padding:28px;text-align:center}
@media (max-width:640px){main{padding:12px}}
`;

function href(view: PeriodView, date: string, company: string): string {
  const q = [`view=${view}`, `date=${date}`, ...(company === '' ? [] : [`company=${encodeURIComponent(company)}`])];
  return `/?${q.join('&')}`;
}

// 저장된 UTC 시각을 한국 시간(UTC+9, 일광절약시간 없음)으로 보여 준다.
const kst = (iso: string): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : `${new Date(ms + 9 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')} 한국시간`;
};

function runBox(run: RunRecord | null): string {
  if (run === null) return '<div class="card muted">수집 기록이 없습니다. <code>npm run collect</code>로 수집을 먼저 실행하세요.</div>';
  const label = { success: '성공', failed: '실패', running: '진행 중(또는 중단됨)' }[run.status];
  const detail = `수신 ${run.fetched}건 · 9개사 계약 ${run.matched}건 저장 · 호출 ${run.calls}회`;
  return `<div class="card"><div class="row"><b>마지막 수집</b><span class="status-${run.status}">${label}</span>
<span>${esc(run.rangeFrom)} ~ ${esc(run.rangeTo)}</span><span class="muted">${esc(kst(run.finishedAt ?? run.startedAt))}</span></div>
<div class="muted">${esc(detail)}</div>${run.error === null ? '' : `<div class="status-failed">${esc(run.error)}</div>`}</div>`;
}

function productCell(r: ContractRow): string {
  const chips = [
    // 식별번호가 비어 있으면 목록 안팎을 판정할 수 없다.
    r.productIds.length === 0
      ? '<span class="chip warn">제품 정보 없음</span>'
      : r.verified ? '<span class="chip ok">확인 대상</span>' : '<span class="chip warn">목록 밖</span>',
    ...(r.idConflict ? ['<span class="chip warn">대조 필요</span>'] : []),
  ].join('');
  const items = r.productIds.map((id, i) => `${esc(id)}${r.productNames[i] ? ` ${esc(r.productNames[i] as string)}` : ''}`);
  // 제품이 수십 개인 계약이 있어 앞 2개만 보이고 나머지는 접는다 (스크립트 없이 details로).
  const shown = items.slice(0, 2).join('<br>');
  const rest = items.length > 2 ? `<details><summary>외 ${items.length - 2}개</summary>${items.slice(2).join('<br>')}</details>` : '';
  return `${chips}<div class="muted">${shown}${rest}</div>`;
}

function demanderCell(r: ContractRow): string {
  return r.demanderPlaceholder
    ? '<span class="chip warn">수요기관 미공개</span><div class="muted">조달청 계약</div>'
    : esc(r.demanderName);
}

function page(opts: {
  view: PeriodView; date: string; company: string; companies: { id: string; label: string }[];
  range: { from: string; to: string }; rows: ContractRow[]; run: RunRecord | null;
}): string {
  const { view, date, company, range, rows } = opts;
  // 공동수급 계약은 업체별 행에 같은 금액이 들어 있으므로 계약(통합계약번호) 단위로 한 번만 더한다.
  const total = [...new Map(rows.map((r) => [r.untyNo, r.amount ?? 0])).values()].reduce((a, b) => a + b, 0);
  const tabs = VIEWS.map((v) => `<a class="${v.view === view ? 'on' : ''}" href="${esc(href(v.view, date, company))}">${v.label}</a>`).join('');
  const options = [{ id: '', label: '전체 업체' }, ...opts.companies]
    .map((c) => `<option value="${esc(c.id)}"${c.id === company ? ' selected' : ''}>${esc(c.label)}</option>`).join('');
  const body = rows.length === 0
    ? '<div class="empty muted">해당 기간에 수집된 계약이 없습니다.</div>'
    : `<div class="tablewrap"><table><thead><tr><th>체결일자</th><th>업체</th><th>계약명</th><th class="num">금액(원)</th><th>계약기관</th><th>수요기관</th><th>제품</th><th>계약방법</th></tr></thead><tbody>${rows
        .map((r) => `<tr><td>${esc(r.signedDate)}</td><td>${esc(r.companyName)}</td><td>${esc(r.contractName)}<div class="muted">${esc(r.untyNo)}</div></td><td class="num">${won(r.amount)}</td><td>${esc(r.contractOrg)}</td><td>${demanderCell(r)}</td><td>${productCell(r)}</td><td>${esc(r.method)}</td></tr>`)
        .join('')}</tbody></table></div>`;

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>경쟁사 계약 모니터링</title><style>${CSS}</style></head><body><main>
<h1>경쟁사 계약 모니터링</h1>
${runBox(opts.run)}
<div class="card"><form method="get" action="/" class="row"><input type="hidden" name="view" value="${view}"><input type="hidden" name="date" value="${esc(date)}">
<span class="tabs row">${tabs}</span>
<span class="nav row"><a href="${esc(href(view, shiftPeriod(view, date, -1), company))}">← 이전</a><a href="${esc(href(view, shiftPeriod(view, date, 1), company))}">다음 →</a></span>
<select name="company" aria-label="업체">${options}</select><button type="submit">조회</button>
<span class="grow"></span><b>${esc(range.from)} ~ ${esc(range.to)}</b><span class="muted">${rows.length}건 · 합계 ${won(total)}원</span></form></div>
<div class="card">${body}</div>
<p class="muted">체결일자 기준입니다. 금액은 금차계약금액이며, 조달청 계약은 API가 실제 수요기관을 알려 주지 않습니다.</p>
</main></body></html>`;
}

export function buildServer(opts: ServerOptions = {}) {
  const app = Fastify({ logger: false });
  app.get('/health', async () => ({ status: 'ok' }));

  const { db } = opts;
  if (db) {
    const companies = opts.companies ?? [];
    const today = opts.today ?? todayKst;
    app.get('/', async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      const view = (q['view'] ?? 'month') as PeriodView;
      const date = q['date'] ?? today();
      const company = q['company'] ?? '';
      try {
        if (!VIEWS.some((v) => v.view === view)) throw new Error('view');
        addDays(date, 0);
        if (company !== '' && !companies.some((c) => c.id === company)) throw new Error('company');
      } catch {
        return reply.code(400).type('text/plain; charset=utf-8').send('잘못된 조회 조건입니다 (view: day|week|month, date: YYYY-MM-DD, company: 목록의 id)');
      }
      const range = periodRange(view, date);
      const rows = listContracts(db, { ...range, ...(company === '' ? {} : { companyId: company }) });
      return reply
        .type('text/html; charset=utf-8')
        .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
        .header('x-content-type-options', 'nosniff')
        .send(page({ view, date, company, companies, range, rows, run: lastRun(db) }));
    });
  }
  return app;
}
