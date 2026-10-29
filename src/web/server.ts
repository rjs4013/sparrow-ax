import Fastify from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { lastRunByKind, listContracts, type ContractRow, type RunKind, type RunRecord } from '../db/contracts.ts';
import { listDeliveries, type DeliveryRow } from '../db/deliveries.ts';
import { buildWorkbook, exportFileName } from '../export/excel.ts';
import { addDays, periodRange, shiftPeriod, todayKst, type PeriodView } from '../filters/dates.ts';

export interface ServerOptions {
  db?: DatabaseSync;
  // 업체 선택 목록(설정의 id · 표시 이름).
  companies?: { id: string; label: string }[];
  today?: () => string;
  // 엑셀의 계약 시트에 쓰는 물품분류번호(설정 값).
  categoryCode?: string;
}

const VIEWS: { view: PeriodView; label: string }[] = [
  { view: 'day', label: '일' },
  { view: 'week', label: '주' },
  { view: 'month', label: '월' },
];

// 계약명 · 업체명 등은 외부(나라장터) 데이터이므로 모두 이스케이프해서 출력한다.
const esc = (v: string | number): string =>
  String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// RFC 5987 filename*: encodeURIComponent가 인코딩하지 않는 ' ( ) * 도 퍼센트 인코딩한다.
const encodeRfc5987 = (s: string): string => encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const won = (n: number | null): string => (n === null ? '-' : n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','));

const CSS = `
:root{--bg:#f7f7f5;--fg:#1f2328;--muted:#6a7078;--card:#fff;--line:#e2e3e0;--accent:#1d5fd0;--ok:#15803d;--bad:#b42318;--warn:#b45309;--chip:#eef1f6}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#e6e8eb;--muted:#9aa1ab;--card:#1c1f25;--line:#2d313a;--accent:#7aa7ff;--ok:#4ade80;--bad:#f87171;--warn:#fbbf24;--chip:#262b34}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI","Malgun Gothic",sans-serif}
main{max-width:1200px;margin:0 auto;padding:20px 16px 48px}h1{font-size:20px;margin:0 0 12px}
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
@media (max-width:640px){main{padding:12px}}
`;

type Page = 'contracts' | 'deliveries';
const PATH: Record<Page, string> = { contracts: '/', deliveries: '/deliveries' };

function href(page: Page, view: PeriodView, date: string, company: string): string {
  const q = [`view=${view}`, `date=${date}`, ...(company === '' ? [] : [`company=${encodeURIComponent(company)}`])];
  return `${PATH[page]}?${q.join('&')}`;
}

// 저장된 UTC 시각을 한국 시간(UTC+9, 일광절약시간 없음)으로 보여 준다.
const kst = (iso: string): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : `${new Date(ms + 9 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')} 한국시간`;
};

const KIND_LABEL: Record<RunKind, string> = {
  backfill: '백필(체결일자)', daily: '매일 증분(등록일시)', verify: '교차 검증',
  dlvr_backfill: '납품요구 백필(접수일자)', dlvr_daily: '납품요구 매일(접수일자)',
};
const PAGE_KINDS: Record<Page, RunKind[]> = { contracts: ['daily', 'verify', 'backfill'], deliveries: ['dlvr_daily', 'dlvr_backfill'] };
const EMPTY_RUN: Record<Page, string> = {
  contracts: '수집 기록이 없습니다. <code>npm run collect</code>로 수집을 먼저 실행하세요.',
  deliveries: '납품요구 수집 기록이 없습니다. <code>npm run collect -- --mode dlvr-backfill</code>로 수집을 먼저 실행하세요.',
};

function runLine(run: RunRecord): string {
  const label = { success: '성공', failed: '실패', running: '진행 중(또는 중단됨)' }[run.status];
  const range = run.rangeFrom === run.rangeTo ? run.rangeFrom : `${run.rangeFrom} ~ ${run.rangeTo}`;
  const what = run.kind.startsWith('dlvr') ? `수신 ${run.fetched}행 · 9개사 납품요구 ${run.matched}행 저장` : `수신 ${run.fetched}건 · 9개사 계약 ${run.matched}건 저장`;
  const detail = `${what} · 호출 ${run.calls}회`;
  return `<div class="runline"><div class="row"><b>${esc(KIND_LABEL[run.kind])}</b><span class="status-${run.status}">${label}</span>
<span>${esc(range)}</span><span class="muted">${esc(kst(run.finishedAt ?? run.startedAt))}</span></div>
<div class="muted">${esc(detail)}${run.note === null ? '' : ` · ${esc(run.note)}`}</div>${run.error === null ? '' : `<div class="status-failed">${esc(run.error)}</div>`}</div>`;
}

function runBox(page: Page, runs: Partial<Record<RunKind, RunRecord>>): string {
  const lines = PAGE_KINDS[page].flatMap((k) => (runs[k] ? [runLine(runs[k])] : []));
  if (lines.length === 0) return `<div class="card muted">${EMPTY_RUN[page]}</div>`;
  return `<div class="card"><div class="muted">마지막 수집 상태</div>${lines.join('')}</div>`;
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
  range: { from: string; to: string }; runs: Partial<Record<RunKind, RunRecord>>;
  title: string; summary: string; body: string; note: string;
}

// 계약 · 납품요구 두 화면의 공통 뼈대: 화면 이동, 수집 상태, 기간 · 업체 선택.
function shell(s: Shell): string {
  const { page, view, date, company } = s;
  const pages = (['contracts', 'deliveries'] as Page[])
    .map((p) => `<a class="${p === page ? 'on' : ''}" href="${esc(href(p, view, date, company))}">${p === 'contracts' ? '계약' : '납품요구'}</a>`).join('');
  const tabs = VIEWS.map((v) => `<a class="${v.view === view ? 'on' : ''}" href="${esc(href(page, v.view, date, company))}">${v.label}</a>`).join('');
  const exportHref = `/export.xlsx?date=${date}${company === '' ? '' : `&company=${encodeURIComponent(company)}`}`;
  const options = [{ id: '', label: '전체 업체' }, ...s.companies]
    .map((c) => `<option value="${esc(c.id)}"${c.id === company ? ' selected' : ''}>${esc(c.label)}</option>`).join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>경쟁사 모니터링 · ${esc(s.title)}</title><style>${CSS}</style></head><body><main>
<h1>경쟁사 모니터링</h1>
<div class="pages row">${pages}</div>
${runBox(page, s.runs)}
<div class="card"><form method="get" action="${PATH[page]}" class="row"><input type="hidden" name="view" value="${view}"><input type="hidden" name="date" value="${esc(date)}">
<span class="tabs row">${tabs}</span>
<span class="nav row"><a href="${esc(href(page, view, shiftPeriod(view, date, -1), company))}">← 이전</a><a href="${esc(href(page, view, shiftPeriod(view, date, 1), company))}">다음 →</a></span>
<select name="company" aria-label="업체">${options}</select><button type="submit">조회</button>
<a class="dl" href="${esc(exportHref)}" title="고른 날짜가 속한 달 전체를 엑셀로 내려받습니다">엑셀 내보내기</a>
<span class="grow"></span><b>${esc(s.range.from)} ~ ${esc(s.range.to)}</b><span class="muted">${esc(s.summary)}</span></form></div>
<div class="card">${s.body}</div>
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

    for (const page of ['contracts', 'deliveries'] as Page[]) {
      app.get(PATH[page], async (req, reply) => {
        const cond = parseConditions(req.query as Record<string, string | undefined>);
        if (!cond) return reply.code(400).type('text/plain; charset=utf-8').send(BAD);
        const { view, date, company } = cond;
        const range = periodRange(view, date);
        const filter = { ...range, ...(company === '' ? {} : { companyId: company }) };
        const base = { page, view, date, company, companies, range, runs: lastRunByKind(db) };

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
