import type { DatabaseSync } from 'node:sqlite';
import { existingKeys, finishRun, lastSuccessRun, startRun, upsertContracts, type RunKind } from '../db/contracts.ts';
import { upsertBids } from '../db/bids.ts';
import { upsertDeliveries } from '../db/deliveries.ts';
import type { Matcher } from '../filters/contracts.ts';
import { addDays, collectionRange, todayKst, type IsoDate } from '../filters/dates.ts';
import { collectContracts, collectDay, createFetcher } from './contracts.ts';
import { collectBidDay } from './bids.ts';
import { collectDeliveries } from './deliveries.ts';

export interface RunResult {
  status: 'success' | 'failed';
  fetched: number;
  matched: number;
  calls: number;
  error: string | null;
}

interface RunOptions {
  db: DatabaseSync;
  client: { get(path: string, params?: Record<string, string | number>): Promise<unknown> };
  matcher: Matcher;
  maxCalls: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
  log?: (message: string) => void;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function makeFetcher(opts: RunOptions) {
  return createFetcher(opts.client, { maxCalls: opts.maxCalls, ...(opts.sleep ? { sleep: opts.sleep } : {}) });
}

// 백필: 한 번의 수집(체결일자 방식)을 실행 기록으로 감싼다. 수집이 끝까지 성공한 경우에만 계약을 저장하고(일부만 저장하지 않는다),
// 실패하면 사유를 기록에 남긴다. 사유 문구는 클라이언트가 이미 서비스키를 가린 것이다.
export async function runCollection(opts: RunOptions & { range: { from: IsoDate; to: IsoDate } }): Promise<RunResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const runId = startRun(opts.db, opts.range.from, opts.range.to, now(), 'backfill');
  const fetcher = makeFetcher(opts);
  let result: RunResult;
  try {
    const { contracts, stats } = await collectContracts({ fetchPage: fetcher.fetchPage, matcher: opts.matcher, ...(opts.log ? { log: opts.log } : {}) }, opts.range);
    upsertContracts(opts.db, contracts, now());
    result = { status: 'success', fetched: stats.fetched, matched: contracts.length, calls: fetcher.calls(), error: null };
  } catch (err) {
    result = { status: 'failed', fetched: 0, matched: 0, calls: fetcher.calls(), error: message(err) };
  }
  finishRun(opts.db, runId, result, now());
  return result;
}

export interface DailyResult extends RunResult {
  // 끝까지 받아 저장한 날 수.
  days: number;
}

// 매일 증분(등록일시 방식): 마지막 성공한 날 다음 날부터 어제까지를 하루씩 받는다. 하루가 끝날 때마다 그 날의 결과를 저장하고
// 그 날의 실행 기록(daily)을 남긴다. 중간에 실패하면 거기서 멈추고, 다음 실행이 실패한 날부터 이어 간다.
// 시작점: daily 성공 기록의 마지막 날. 없으면 가장 최근 백필이 시작된 한국 날짜(백필 이후 등록분을 빠짐없이 받고 겹침은 upsert로 안전).
// from을 주면 시작점 계산 대신 그 날부터 받는다(과거 구간 재수집, 동작 확인용).
export async function runDaily(opts: RunOptions & { today: IsoDate; from?: IsoDate }): Promise<DailyResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const yesterday = addDays(opts.today, -1);
  const lastDaily = opts.from === undefined ? lastSuccessRun(opts.db, 'daily') : null;
  let lastSuccess: IsoDate;
  if (opts.from !== undefined) {
    lastSuccess = addDays(opts.from, -1);
  } else if (lastDaily) {
    lastSuccess = lastDaily.rangeTo;
  } else {
    const backfill = lastSuccessRun(opts.db, 'backfill');
    if (!backfill) throw new Error('증분 수집의 시작점이 없습니다. 먼저 백필(npm run collect)을 성공시키세요');
    lastSuccess = addDays(todayKst(new Date(backfill.startedAt)), -1);
  }
  const range = opts.from !== undefined ? (opts.from > yesterday ? null : { from: opts.from, to: yesterday }) : collectionRange(lastSuccess, opts.today);
  const total: DailyResult = { status: 'success', fetched: 0, matched: 0, calls: 0, error: null, days: 0 };
  if (range === null) return total;

  const fetcher = makeFetcher(opts);
  const deps = { fetchPage: fetcher.fetchPage, matcher: opts.matcher, ...(opts.log ? { log: opts.log } : {}) };
  for (let day = range.from; day <= range.to; day = addDays(day, 1)) {
    const runId = startRun(opts.db, day, day, now(), 'daily');
    const before = fetcher.calls();
    try {
      const { contracts, stats } = await collectDay(deps, day);
      upsertContracts(opts.db, contracts, now());
      finishRun(opts.db, runId, { status: 'success', fetched: stats.fetched, matched: contracts.length, calls: fetcher.calls() - before, error: null }, now());
      total.days++;
      total.fetched += stats.fetched;
      total.matched += contracts.length;
    } catch (err) {
      finishRun(opts.db, runId, { status: 'failed', fetched: 0, matched: 0, calls: fetcher.calls() - before, error: message(err) }, now());
      total.status = 'failed';
      total.error = message(err);
      break;
    }
  }
  total.calls = fetcher.calls();
  return total;
}

export interface VerifyResult extends RunResult {
  // 이미 저장된 것에 없던 9개사 계약 수.
  newlyFound: number;
  // 그중 등록일이 증분이 이미 처리한 구간 안이라 증분이 놓친 것으로 볼 수 있는 수. 증분 성공 기록이 없으면 판정할 수 없어 null.
  missed: number | null;
}

// 교차 검증(체결일자 방식): 최근 days일을 다시 받아 저장하고, DB에 없던 계약이 몇 건인지 실행 기록 메모에 남긴다.
// 없던 계약이라도 등록일이 증분이 아직 처리하지 않은 날(어제 이후, 또는 밀린 구간)이면 놓친 것이 아니라 아직 받을 차례가 아닌 것이므로,
// "증분이 놓친 것"은 등록일이 증분의 마지막 성공일 이하인 것만 센다.
export async function runVerify(opts: RunOptions & { today: IsoDate; days: number }): Promise<VerifyResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const range = { from: addDays(opts.today, -opts.days), to: addDays(opts.today, -1) };
  const runId = startRun(opts.db, range.from, range.to, now(), 'verify');
  const fetcher = makeFetcher(opts);
  let result: VerifyResult;
  let note: string | null = null;
  try {
    const { contracts, stats } = await collectContracts({ fetchPage: fetcher.fetchPage, matcher: opts.matcher, ...(opts.log ? { log: opts.log } : {}) }, range);
    const known = existingKeys(opts.db, contracts);
    const fresh = contracts.filter((c) => !known.has(`${c.untyNo}|${c.companyId}`));
    const newlyFound = fresh.length;
    const covered = lastSuccessRun(opts.db, 'daily')?.rangeTo ?? null;
    const missed = covered === null ? null : fresh.filter((c) => c.registeredAt.slice(0, 10) <= covered).length;
    upsertContracts(opts.db, contracts, now());
    result = { status: 'success', fetched: stats.fetched, matched: contracts.length, calls: fetcher.calls(), error: null, newlyFound, missed };
    note = `교차 검증: 새로 찾은 계약 ${newlyFound}건` + (missed === null ? ' (증분 기록이 없어 놓침 여부는 판정 불가)' : ` · 그중 증분이 놓친 것 ${missed}건`);
  } catch (err) {
    result = { status: 'failed', fetched: 0, matched: 0, calls: fetcher.calls(), error: message(err), newlyFound: 0, missed: null };
  }
  finishRun(opts.db, runId, { ...result, note }, now());
  return result;
}

// 납품요구(쇼핑몰) 한 구간의 수집을 실행 기록으로 감싼다. 끝까지 성공했을 때만 저장한다.
async function runDeliveries(opts: RunOptions & { range: { from: IsoDate; to: IsoDate }; kind: RunKind }): Promise<RunResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const runId = startRun(opts.db, opts.range.from, opts.range.to, now(), opts.kind);
  const fetcher = makeFetcher(opts);
  let result: RunResult;
  try {
    const { rows, stats } = await collectDeliveries({ fetchPage: fetcher.fetchPage, matcher: opts.matcher, ...(opts.log ? { log: opts.log } : {}) }, opts.range);
    upsertDeliveries(opts.db, rows, now());
    result = { status: 'success', fetched: stats.fetched, matched: rows.length, calls: fetcher.calls(), error: null };
  } catch (err) {
    result = { status: 'failed', fetched: 0, matched: 0, calls: fetcher.calls(), error: message(err) };
  }
  finishRun(opts.db, runId, result, now());
  return result;
}

export function runDeliveryBackfill(opts: RunOptions & { range: { from: IsoDate; to: IsoDate } }): Promise<RunResult> {
  return runDeliveries({ ...opts, kind: 'dlvr_backfill' });
}

// 접수일자의 등록 지연을 모르므로, 마지막 성공일 다음 날부터 어제까지에 최근 LOOKBACK_DAYS일을 더해 다시 받는다(upsert라 안전).
const LOOKBACK_DAYS = 3;

// 납품요구 매일 수집: 시작점은 dlvr_daily 성공 기록의 마지막 날, 없으면 dlvr_backfill 성공 기록의 마지막 날이다.
export async function runDeliveryDaily(opts: RunOptions & { today: IsoDate }): Promise<RunResult> {
  const last = lastSuccessRun(opts.db, 'dlvr_daily') ?? lastSuccessRun(opts.db, 'dlvr_backfill');
  if (!last) throw new Error('납품요구 수집의 시작점이 없습니다. 먼저 납품요구 백필(--mode dlvr-backfill)을 성공시키세요');
  const range = collectionRange(last.rangeTo, opts.today);
  if (range === null) return { status: 'success', fetched: 0, matched: 0, calls: 0, error: null };
  return runDeliveries({ ...opts, range: { from: addDays(range.from, -LOOKBACK_DAYS), to: range.to }, kind: 'dlvr_daily' });
}

// 입찰공고 매일 수집(개방표준, 입찰공고일시 하루 단위): 마지막 성공한 날 다음 날부터 어제까지를 하루씩 받고 하루마다 저장 · 기록한다.
// 시작점: bid_daily 성공 기록의 마지막 날 + 1, 없으면 어제 하루(요구사항: "전일자 신규"). from을 주면 그 날부터 다시 받는다.
export async function runBidDaily(opts: {
  db: DatabaseSync;
  client: { get(path: string, params?: Record<string, string | number>): Promise<unknown> };
  keywords: string[];
  maxCalls: number;
  today: IsoDate;
  from?: IsoDate;
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
  log?: (message: string) => void;
}): Promise<DailyResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const yesterday = addDays(opts.today, -1);
  const last = lastSuccessRun(opts.db, 'bid_daily');
  const start = opts.from ?? (last ? addDays(last.rangeTo, 1) : yesterday);
  const total: DailyResult = { status: 'success', fetched: 0, matched: 0, calls: 0, error: null, days: 0 };
  if (start > yesterday) return total;

  const fetcher = createFetcher(opts.client, { maxCalls: opts.maxCalls, ...(opts.sleep ? { sleep: opts.sleep } : {}) });
  const deps = { fetchPage: fetcher.fetchPage, keywords: opts.keywords, ...(opts.log ? { log: opts.log } : {}) };
  for (let day = start; day <= yesterday; day = addDays(day, 1)) {
    const runId = startRun(opts.db, day, day, now(), 'bid_daily');
    const before = fetcher.calls();
    try {
      const { rows, stats } = await collectBidDay(deps, day);
      upsertBids(opts.db, rows, now());
      // 쪽 이동으로 같은 날을 다시 받았거나 전체 건수를 못 채웠다면 기록에 남긴다.
      const note = stats.passes > 1 || stats.shortfall > 0
        ? `쪽 이동 확인: ${stats.passes}번 받음, 고유 ${stats.fetched}건${stats.shortfall > 0 ? ` (전체 건수에 ${stats.shortfall}건 부족)` : ''}`
        : null;
      finishRun(opts.db, runId, { status: 'success', fetched: stats.fetched, matched: rows.length, calls: fetcher.calls() - before, error: null, note }, now());
      total.days++;
      total.fetched += stats.fetched;
      total.matched += rows.length;
    } catch (err) {
      finishRun(opts.db, runId, { status: 'failed', fetched: 0, matched: 0, calls: fetcher.calls() - before, error: message(err) }, now());
      total.status = 'failed';
      total.error = message(err);
      break;
    }
  }
  total.calls = fetcher.calls();
  return total;
}
