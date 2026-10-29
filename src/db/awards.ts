import type { DatabaseSync } from 'node:sqlite';

// 개방표준서비스 낙찰정보 중 공고명 키워드에 걸린 공고 한 건. 투찰업체별 행을 공고 하나로 묶은 결과이며
// 대표자 · 담당자 · 연락처 · 주소는 저장하지 않는다.
export interface AwardRow {
  bidNtceNo: string;
  bidNtceOrd: string;
  title: string;
  workKind: string;
  demanderName: string;
  demanderCode: string;
  estimatedPrice: number | null;
  reservePrice: number | null;
  // 기초금액(낙찰 응답에는 있고 입찰공고 응답에는 없다).
  baseAmount: number | null;
  // 개찰일시 'YYYY-MM-DD HH:MM'
  opening: string;
  // 개찰결과구분: 개찰완료 · 유찰 · 재입찰
  result: string;
  bidderCount: number;
  // 최종낙찰자(낙찰여부 Y인 행). 아직 정해지지 않았으면 빈 문자열 · null이다.
  winnerName: string;
  winnerAmount: number | null;
  winnerRate: number | null;
  winnerDate: string;
  keywords: string[];
}

// 입찰공고와의 연결은 저장하지 않고 조회할 때 (공고번호, 차수)로 이어 붙인다(공고가 나중에 수집돼도 자동으로 연결).
export interface AwardView extends AwardRow {
  linked: boolean;
  noticeUrl: string;
  noticeStatus: string;
}

// 같은 (공고번호, 차수)는 갱신한다. 이미 정해진 낙찰자는 낙찰자가 비어 있는 응답으로 지우지 않는다(낙찰자는 개찰 며칠 뒤에 채워진다).
export function upsertAwards(db: DatabaseSync, rows: AwardRow[], now: string): void {
  const stmt = db.prepare(`
    INSERT INTO bid_awards (bid_ntce_no, bid_ntce_ord, title, work_kind, demander_name, demander_code, est_price, reserve_price, base_amt, opening,
      result, bidder_count, winner_name, winner_amt, winner_rate, winner_date, keywords, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (bid_ntce_no, bid_ntce_ord) DO UPDATE SET
      title = excluded.title, work_kind = excluded.work_kind, demander_name = excluded.demander_name, demander_code = excluded.demander_code,
      est_price = excluded.est_price, reserve_price = excluded.reserve_price, base_amt = excluded.base_amt, opening = excluded.opening,
      result = excluded.result, bidder_count = excluded.bidder_count, keywords = excluded.keywords, collected_at = excluded.collected_at,
      winner_name = CASE WHEN excluded.winner_name <> '' THEN excluded.winner_name ELSE bid_awards.winner_name END,
      winner_amt = CASE WHEN excluded.winner_name <> '' THEN excluded.winner_amt ELSE bid_awards.winner_amt END,
      winner_rate = CASE WHEN excluded.winner_name <> '' THEN excluded.winner_rate ELSE bid_awards.winner_rate END,
      winner_date = CASE WHEN excluded.winner_name <> '' THEN excluded.winner_date ELSE bid_awards.winner_date END`);
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run(
        r.bidNtceNo, r.bidNtceOrd, r.title, r.workKind, r.demanderName, r.demanderCode, r.estimatedPrice, r.reservePrice, r.baseAmount, r.opening,
        r.result, r.bidderCount, r.winnerName, r.winnerAmount, r.winnerRate, r.winnerDate, JSON.stringify(r.keywords), now,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

// 개찰일자가 [from, to](양끝 포함)인 낙찰정보를 최근 개찰 순으로. 입찰공고가 저장돼 있으면 공고 링크 · 상태를 붙인다.
export function listAwards(db: DatabaseSync, q: { from: string; to: string }): AwardView[] {
  const rows = db
    .prepare(`
      SELECT a.*, b.url AS notice_url, b.status AS notice_status, (b.bid_ntce_no IS NOT NULL) AS linked
      FROM bid_awards a
      LEFT JOIN bid_notices b ON b.bid_ntce_no = a.bid_ntce_no AND b.bid_ntce_ord = a.bid_ntce_ord
      WHERE substr(a.opening, 1, 10) >= ? AND substr(a.opening, 1, 10) <= ?
      ORDER BY a.opening DESC, a.bid_ntce_no DESC, a.bid_ntce_ord DESC`)
    .all(q.from, q.to);
  return rows.map((r) => ({
    bidNtceNo: String(r['bid_ntce_no']),
    bidNtceOrd: String(r['bid_ntce_ord']),
    title: String(r['title']),
    workKind: String(r['work_kind']),
    demanderName: String(r['demander_name']),
    demanderCode: String(r['demander_code']),
    estimatedPrice: num(r['est_price']),
    reservePrice: num(r['reserve_price']),
    baseAmount: num(r['base_amt']),
    opening: String(r['opening']),
    result: String(r['result']),
    bidderCount: Number(r['bidder_count']),
    winnerName: String(r['winner_name']),
    winnerAmount: num(r['winner_amt']),
    winnerRate: num(r['winner_rate']),
    winnerDate: String(r['winner_date']),
    keywords: JSON.parse(String(r['keywords'])) as string[],
    linked: Number(r['linked']) === 1,
    noticeUrl: r['notice_url'] === null ? '' : String(r['notice_url']),
    noticeStatus: r['notice_status'] === null ? '' : String(r['notice_status']),
  }));
}
