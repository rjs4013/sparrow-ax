import type { DatabaseSync } from 'node:sqlite';
import { finishRun, startRun, upsertContracts } from '../db/contracts.ts';
import type { Matcher } from '../filters/contracts.ts';
import type { IsoDate } from '../filters/dates.ts';
import { collectContracts, createFetcher } from './contracts.ts';

export interface RunResult {
  status: 'success' | 'failed';
  fetched: number;
  matched: number;
  calls: number;
  error: string | null;
}

// 한 번의 수집을 실행 기록으로 감싼다. 수집이 끝까지 성공한 경우에만 계약을 저장하고(일부만 저장하지 않는다),
// 실패하면 사유를 기록에 남긴다. 사유 문구는 클라이언트가 이미 서비스키를 가린 것이다.
export async function runCollection(opts: {
  db: DatabaseSync;
  client: { get(path: string, params?: Record<string, string | number>): Promise<unknown> };
  matcher: Matcher;
  range: { from: IsoDate; to: IsoDate };
  maxCalls: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
  log?: (message: string) => void;
}): Promise<RunResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const runId = startRun(opts.db, opts.range.from, opts.range.to, now());
  const fetcher = createFetcher(opts.client, { maxCalls: opts.maxCalls, ...(opts.sleep ? { sleep: opts.sleep } : {}) });
  let result: RunResult;
  try {
    const { contracts, stats } = await collectContracts({ fetchPage: fetcher.fetchPage, matcher: opts.matcher, ...(opts.log ? { log: opts.log } : {}) }, opts.range);
    upsertContracts(opts.db, contracts, now());
    result = { status: 'success', fetched: stats.fetched, matched: contracts.length, calls: fetcher.calls(), error: null };
  } catch (err) {
    result = { status: 'failed', fetched: 0, matched: 0, calls: fetcher.calls(), error: err instanceof Error ? err.message : String(err) };
  }
  finishRun(opts.db, runId, result, now());
  return result;
}
