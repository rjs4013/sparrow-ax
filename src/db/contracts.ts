import type { DatabaseSync } from 'node:sqlite';

export interface ContractRow {
  untyNo: string;
  companyId: string;
  companyName: string;
  bizNo: string;
  contractName: string;
  signedDate: string;
  registeredAt: string;
  amount: number | null;
  contractOrg: string;
  demanderName: string;
  // true면 수요기관이 실제 구매처가 아닌 "각 수요기관" 자리표시자다(조달청 계약).
  demanderPlaceholder: boolean;
  method: string;
  productIds: string[];
  productNames: string[];
  verified: boolean;
  idConflict: boolean;
}

// 같은 (통합계약번호, 업체 id)는 갱신한다. 전체가 한 트랜잭션이라 중간에 실패하면 하나도 저장되지 않는다.
export function upsertContracts(db: DatabaseSync, rows: ContractRow[], now: string): void {
  const stmt = db.prepare(`
    INSERT INTO contracts (unty_no, company_id, company_name, biz_no, contract_name, signed_date, registered_at, amount,
      contract_org, demander_name, demander_placeholder, method, product_ids, product_names, verified, id_conflict, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (unty_no, company_id) DO UPDATE SET
      company_name = excluded.company_name, biz_no = excluded.biz_no, contract_name = excluded.contract_name,
      signed_date = excluded.signed_date, registered_at = excluded.registered_at, amount = excluded.amount,
      contract_org = excluded.contract_org, demander_name = excluded.demander_name,
      demander_placeholder = excluded.demander_placeholder, method = excluded.method, product_ids = excluded.product_ids,
      product_names = excluded.product_names, verified = excluded.verified, id_conflict = excluded.id_conflict,
      collected_at = excluded.collected_at`);
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run(
        r.untyNo, r.companyId, r.companyName, r.bizNo, r.contractName, r.signedDate, r.registeredAt, r.amount,
        r.contractOrg, r.demanderName, r.demanderPlaceholder ? 1 : 0, r.method, JSON.stringify(r.productIds),
        JSON.stringify(r.productNames), r.verified ? 1 : 0, r.idConflict ? 1 : 0, now,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// 체결일자가 [from, to](양끝 포함)인 계약을 최근 체결일자 순으로.
export function listContracts(db: DatabaseSync, q: { from: string; to: string; companyId?: string }): ContractRow[] {
  const where = q.companyId === undefined ? '' : 'AND company_id = ?';
  const args = q.companyId === undefined ? [q.from, q.to] : [q.from, q.to, q.companyId];
  const rows = db
    .prepare(`SELECT * FROM contracts WHERE signed_date >= ? AND signed_date <= ? ${where} ORDER BY signed_date DESC, unty_no, company_id`)
    .all(...args);
  return rows.map((r) => ({
    untyNo: String(r['unty_no']),
    companyId: String(r['company_id']),
    companyName: String(r['company_name']),
    bizNo: String(r['biz_no']),
    contractName: String(r['contract_name']),
    signedDate: String(r['signed_date']),
    registeredAt: String(r['registered_at']),
    amount: r['amount'] === null ? null : Number(r['amount']),
    contractOrg: String(r['contract_org']),
    demanderName: String(r['demander_name']),
    demanderPlaceholder: r['demander_placeholder'] === 1,
    method: String(r['method']),
    productIds: JSON.parse(String(r['product_ids'])) as string[],
    productNames: JSON.parse(String(r['product_names'])) as string[],
    verified: r['verified'] === 1,
    idConflict: r['id_conflict'] === 1,
  }));
}

export type RunKind = 'backfill' | 'daily' | 'verify';

export interface RunRecord {
  id: number;
  kind: RunKind;
  startedAt: string;
  finishedAt: string | null;
  rangeFrom: string;
  rangeTo: string;
  status: 'running' | 'success' | 'failed';
  fetched: number;
  matched: number;
  calls: number;
  error: string | null;
  // 실행이 남기는 참고 문구(예: 교차 검증이 새로 찾은 계약 수).
  note: string | null;
}

export function startRun(db: DatabaseSync, rangeFrom: string, rangeTo: string, now: string, kind: RunKind = 'backfill'): number {
  const res = db
    .prepare("INSERT INTO collect_runs (started_at, range_from, range_to, status, kind) VALUES (?, ?, ?, 'running', ?)")
    .run(now, rangeFrom, rangeTo, kind);
  return Number(res.lastInsertRowid);
}

export function finishRun(
  db: DatabaseSync,
  id: number,
  result: { status: 'success' | 'failed'; fetched: number; matched: number; calls: number; error: string | null; note?: string | null },
  now: string,
): void {
  db.prepare('UPDATE collect_runs SET finished_at = ?, status = ?, fetched = ?, matched = ?, calls = ?, error = ?, note = ? WHERE id = ?').run(
    now, result.status, result.fetched, result.matched, result.calls, result.error, result.note ?? null, id,
  );
}

function toRun(r: Record<string, unknown>): RunRecord {
  return {
    id: Number(r['id']),
    kind: String(r['kind']) as RunKind,
    startedAt: String(r['started_at']),
    finishedAt: r['finished_at'] === null ? null : String(r['finished_at']),
    rangeFrom: String(r['range_from']),
    rangeTo: String(r['range_to']),
    status: String(r['status']) as RunRecord['status'],
    fetched: Number(r['fetched']),
    matched: Number(r['matched']),
    calls: Number(r['calls']),
    error: r['error'] === null ? null : String(r['error']),
    note: r['note'] === null ? null : String(r['note']),
  };
}

export function lastRun(db: DatabaseSync): RunRecord | null {
  const r = db.prepare('SELECT * FROM collect_runs ORDER BY id DESC LIMIT 1').get();
  return r ? toRun(r) : null;
}

// 종류별로 가장 최근 실행(성공 여부와 무관)을 돌려준다. 한 번도 실행하지 않은 종류는 빠진다.
export function lastRunByKind(db: DatabaseSync): Partial<Record<RunKind, RunRecord>> {
  const out: Partial<Record<RunKind, RunRecord>> = {};
  for (const r of db.prepare('SELECT * FROM collect_runs WHERE id IN (SELECT MAX(id) FROM collect_runs GROUP BY kind)').all()) {
    const run = toRun(r);
    out[run.kind] = run;
  }
  return out;
}

export function lastSuccessRun(db: DatabaseSync, kind: RunKind): RunRecord | null {
  const r = db.prepare("SELECT * FROM collect_runs WHERE kind = ? AND status = 'success' ORDER BY range_to DESC, id DESC LIMIT 1").get(kind);
  return r ? toRun(r) : null;
}

// 이미 저장된 (통합계약번호, 업체 id) 키를 `통합계약번호|업체 id` 형태로 돌려준다.
export function existingKeys(db: DatabaseSync, keys: { untyNo: string; companyId: string }[]): Set<string> {
  const stmt = db.prepare('SELECT 1 AS found FROM contracts WHERE unty_no = ? AND company_id = ?');
  const found = new Set<string>();
  for (const k of keys) if (stmt.get(k.untyNo, k.companyId)) found.add(`${k.untyNo}|${k.companyId}`);
  return found;
}
