import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface Migration {
  id: string;
  sql: string;
}

// 테이블 스키마는 기능 지시서에서 정하고 여기에 추가한다. id는 정렬 가능한 문자열(예: '0001_init').
export const migrations: Migration[] = [
  {
    id: '0001_contracts',
    // 계약은 (통합계약번호, 업체 id)가 고유하다: 공동수급 계약은 9개사 중 둘 이상이 한 계약에 들어올 수 있다.
    // 제품 식별번호 · 이름은 JSON 배열 문자열, 불리언은 0/1이다.
    sql: `
      CREATE TABLE contracts (
        unty_no TEXT NOT NULL,
        company_id TEXT NOT NULL,
        company_name TEXT NOT NULL,
        biz_no TEXT NOT NULL,
        contract_name TEXT NOT NULL,
        signed_date TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        amount INTEGER,
        contract_org TEXT NOT NULL,
        demander_name TEXT NOT NULL,
        demander_placeholder INTEGER NOT NULL,
        method TEXT NOT NULL,
        product_ids TEXT NOT NULL,
        product_names TEXT NOT NULL,
        verified INTEGER NOT NULL,
        id_conflict INTEGER NOT NULL,
        collected_at TEXT NOT NULL,
        PRIMARY KEY (unty_no, company_id)
      );
      CREATE INDEX contracts_signed_date ON contracts (signed_date);
      CREATE TABLE collect_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        range_from TEXT NOT NULL,
        range_to TEXT NOT NULL,
        status TEXT NOT NULL,
        fetched INTEGER NOT NULL DEFAULT 0,
        matched INTEGER NOT NULL DEFAULT 0,
        calls INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
    `,
  },
  {
    id: '0002_run_kind',
    // 실행 종류: backfill(체결일자 백필), daily(등록일시 증분, 하루 1행), verify(체결일자 교차 검증). 기존 행은 백필이다.
    sql: `
      ALTER TABLE collect_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'backfill';
      ALTER TABLE collect_runs ADD COLUMN note TEXT;
    `,
  },
  {
    id: '0003_delivery_requests',
    // 나라장터쇼핑몰 납품요구 상세의 물품 행(우리 업체 것만). 변경 차수별 행을 모두 보관하고 조회가 가장 큰 차수만 고른다.
    // 계약정보서비스의 계약과는 번호 체계가 달라 연결하지 않는다(독립 원천, WO-20261028-11).
    sql: `
      CREATE TABLE delivery_requests (
        dlvr_req_no TEXT NOT NULL,
        chg_ord INTEGER NOT NULL,
        prdct_sno TEXT NOT NULL,
        company_id TEXT NOT NULL,
        company_name TEXT NOT NULL,
        biz_no TEXT NOT NULL,
        received_date TEXT NOT NULL,
        demander_code TEXT NOT NULL,
        demander_name TEXT NOT NULL,
        demander_kind TEXT NOT NULL,
        product_class_no TEXT NOT NULL,
        product_class_name TEXT NOT NULL,
        product_id TEXT NOT NULL,
        product_name TEXT NOT NULL,
        unit_price INTEGER,
        qty INTEGER,
        amount INTEGER,
        deadline TEXT NOT NULL,
        contract_no TEXT NOT NULL,
        contract_style TEXT NOT NULL,
        final_yn INTEGER NOT NULL,
        incdec_qty INTEGER,
        incdec_amt INTEGER,
        verified INTEGER NOT NULL,
        id_conflict INTEGER NOT NULL,
        collected_at TEXT NOT NULL,
        PRIMARY KEY (dlvr_req_no, chg_ord, prdct_sno, company_id)
      );
      CREATE INDEX delivery_requests_received_date ON delivery_requests (received_date);
    `,
  },
  {
    id: '0004_delivery_request_name',
    // 납품요구건명(요구사항의 "공사명"). 이미 저장된 행은 빈 값이고 납품요구 백필을 다시 돌리면 채워진다.
    sql: "ALTER TABLE delivery_requests ADD COLUMN dlvr_req_nm TEXT NOT NULL DEFAULT ''",
  },
  {
    id: '0005_bid_notices',
    // 개방표준서비스 입찰공고 중 공고명 키워드에 걸린 것. (공고번호, 차수)가 고유하고 정정 · 재공고는 차수가 다른 행이다.
    // 일시는 'YYYY-MM-DD HH:MM' 문자열(없으면 빈 문자열), 키워드는 JSON 배열 문자열이다. 담당자 정보는 저장하지 않는다.
    sql: `
      CREATE TABLE bid_notices (
        bid_ntce_no TEXT NOT NULL,
        bid_ntce_ord TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        work_kind TEXT NOT NULL,
        notice_date TEXT NOT NULL,
        notice_time TEXT NOT NULL,
        demander_name TEXT NOT NULL,
        demander_code TEXT NOT NULL,
        notice_org_name TEXT NOT NULL,
        notice_org_code TEXT NOT NULL,
        est_price INTEGER,
        budget_amt INTEGER,
        bid_begin TEXT NOT NULL,
        reg_close TEXT NOT NULL,
        bid_close TEXT NOT NULL,
        opening TEXT NOT NULL,
        url TEXT NOT NULL,
        contract_method TEXT NOT NULL,
        keywords TEXT NOT NULL,
        collected_at TEXT NOT NULL,
        PRIMARY KEY (bid_ntce_no, bid_ntce_ord)
      );
      CREATE INDEX bid_notices_notice_date ON bid_notices (notice_date);
    `,
  },
  {
    id: '0006_bid_awards',
    // 개방표준서비스 낙찰정보 중 공고명 키워드에 걸린 공고(투찰업체별 행을 공고 하나로 묶은 결과). (공고번호, 차수)가 고유하다.
    // 입찰공고(bid_notices)와의 연결은 저장하지 않고 조회할 때 같은 키로 이어 붙인다. 대표자 · 담당자 · 연락처 · 주소는 저장하지 않는다.
    sql: `
      CREATE TABLE bid_awards (
        bid_ntce_no TEXT NOT NULL,
        bid_ntce_ord TEXT NOT NULL,
        title TEXT NOT NULL,
        work_kind TEXT NOT NULL,
        demander_name TEXT NOT NULL,
        demander_code TEXT NOT NULL,
        est_price INTEGER,
        reserve_price INTEGER,
        base_amt INTEGER,
        opening TEXT NOT NULL,
        result TEXT NOT NULL,
        bidder_count INTEGER NOT NULL,
        winner_name TEXT NOT NULL,
        winner_amt INTEGER,
        winner_rate REAL,
        winner_date TEXT NOT NULL,
        keywords TEXT NOT NULL,
        collected_at TEXT NOT NULL,
        PRIMARY KEY (bid_ntce_no, bid_ntce_ord)
      );
      CREATE INDEX bid_awards_opening ON bid_awards (opening);
    `,
  },
];

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  return db;
}

// 적용되지 않은 마이그레이션만 id 순서로 각각 트랜잭션 안에서 실행한다. 적용한 id 목록을 반환한다.
export function migrate(db: DatabaseSync, list: Migration[] = migrations): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((r) => String(r['id'])),
  );
  const applied: string[] = [];
  // 로케일과 무관하게 결정적인 코드 단위 순서로 정렬한다.
  for (const m of [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (done.has(m.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
        m.id,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (err) {
      // 마이그레이션 SQL이 직접 COMMIT했다면 ROLLBACK이 실패할 수 있다. 원래 오류를 가리지 않는다.
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw new Error(`마이그레이션 ${m.id} 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
    applied.push(m.id);
  }
  return applied;
}
