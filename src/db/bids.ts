import type { DatabaseSync } from 'node:sqlite';

// 개방표준서비스 입찰공고 한 건. 담당자 이름 · 전화 · 이메일은 저장하지 않는다.
export interface BidRow {
  bidNtceNo: string;
  // 입찰공고차수("000" 형식 문자열). 정정 · 재공고는 차수가 다른 행이다.
  bidNtceOrd: string;
  title: string;
  // 일반공고 · 정정공고 · 취소공고 · 재입찰공고
  status: string;
  workKind: string;
  noticeDate: string;
  noticeTime: string;
  demanderName: string;
  demanderCode: string;
  noticeOrgName: string;
  noticeOrgCode: string;
  // 추정가격(요구사항의 "기초금액"을 이 값으로 대신한다: 입찰공고 응답에는 기초금액이 없다).
  estimatedPrice: number | null;
  budgetAmount: number | null;
  // 'YYYY-MM-DD HH:MM'. 값이 없으면 빈 문자열.
  bidBegin: string;
  regClose: string;
  bidClose: string;
  opening: string;
  url: string;
  contractMethod: string;
  // 공고명에서 걸린 키워드(설정 순서).
  keywords: string[];
}

export function upsertBids(db: DatabaseSync, rows: BidRow[], now: string): void {
  const stmt = db.prepare(`
    INSERT INTO bid_notices (bid_ntce_no, bid_ntce_ord, title, status, work_kind, notice_date, notice_time, demander_name, demander_code,
      notice_org_name, notice_org_code, est_price, budget_amt, bid_begin, reg_close, bid_close, opening, url, contract_method, keywords, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (bid_ntce_no, bid_ntce_ord) DO UPDATE SET
      title = excluded.title, status = excluded.status, work_kind = excluded.work_kind, notice_date = excluded.notice_date,
      notice_time = excluded.notice_time, demander_name = excluded.demander_name, demander_code = excluded.demander_code,
      notice_org_name = excluded.notice_org_name, notice_org_code = excluded.notice_org_code, est_price = excluded.est_price,
      budget_amt = excluded.budget_amt, bid_begin = excluded.bid_begin, reg_close = excluded.reg_close, bid_close = excluded.bid_close,
      opening = excluded.opening, url = excluded.url, contract_method = excluded.contract_method, keywords = excluded.keywords,
      collected_at = excluded.collected_at`);
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run(
        r.bidNtceNo, r.bidNtceOrd, r.title, r.status, r.workKind, r.noticeDate, r.noticeTime, r.demanderName, r.demanderCode,
        r.noticeOrgName, r.noticeOrgCode, r.estimatedPrice, r.budgetAmount, r.bidBegin, r.regClose, r.bidClose, r.opening, r.url,
        r.contractMethod, JSON.stringify(r.keywords), now,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

// 공고일자가 [from, to](양끝 포함)인 입찰공고를 최근 공고 순으로.
export function listBids(db: DatabaseSync, q: { from: string; to: string }): BidRow[] {
  const rows = db
    .prepare('SELECT * FROM bid_notices WHERE notice_date >= ? AND notice_date <= ? ORDER BY notice_date DESC, notice_time DESC, bid_ntce_no DESC, bid_ntce_ord DESC')
    .all(q.from, q.to);
  return rows.map((r) => ({
    bidNtceNo: String(r['bid_ntce_no']),
    bidNtceOrd: String(r['bid_ntce_ord']),
    title: String(r['title']),
    status: String(r['status']),
    workKind: String(r['work_kind']),
    noticeDate: String(r['notice_date']),
    noticeTime: String(r['notice_time']),
    demanderName: String(r['demander_name']),
    demanderCode: String(r['demander_code']),
    noticeOrgName: String(r['notice_org_name']),
    noticeOrgCode: String(r['notice_org_code']),
    estimatedPrice: num(r['est_price']),
    budgetAmount: num(r['budget_amt']),
    bidBegin: String(r['bid_begin']),
    regClose: String(r['reg_close']),
    bidClose: String(r['bid_close']),
    opening: String(r['opening']),
    url: String(r['url']),
    contractMethod: String(r['contract_method']),
    keywords: JSON.parse(String(r['keywords'])) as string[],
  }));
}
