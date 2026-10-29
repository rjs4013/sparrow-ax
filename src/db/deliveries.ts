import type { DatabaseSync } from 'node:sqlite';

// 나라장터쇼핑몰 납품요구 상세의 물품 행 하나 (우리 업체 것만 저장한다).
export interface DeliveryRow {
  dlvrReqNo: string;
  // 납품요구건명(요구사항의 "공사명").
  requestName: string;
  // 변경 차수. 변경본은 행이 따로 오므로 모두 저장하고 조회는 가장 큰 차수만 보여 준다.
  chgOrd: number;
  prdctSno: string;
  companyId: string;
  companyName: string;
  bizNo: string;
  receivedDate: string;
  demanderCode: string;
  demanderName: string;
  demanderKind: string;
  productClassNo: string;
  productClassName: string;
  productId: string;
  productName: string;
  unitPrice: number | null;
  qty: number | null;
  amount: number | null;
  deadline: string;
  contractNo: string;
  contractStyle: string;
  finalYn: boolean;
  incdecQty: number | null;
  incdecAmt: number | null;
  verified: boolean;
  idConflict: boolean;
}

// 같은 키(납품요구번호, 변경차수, 물품순번, 업체 id)는 갱신한다. 전체가 한 트랜잭션이다.
export function upsertDeliveries(db: DatabaseSync, rows: DeliveryRow[], now: string): void {
  const stmt = db.prepare(`
    INSERT INTO delivery_requests (dlvr_req_no, dlvr_req_nm, chg_ord, prdct_sno, company_id, company_name, biz_no, received_date, demander_code,
      demander_name, demander_kind, product_class_no, product_class_name, product_id, product_name, unit_price, qty, amount, deadline,
      contract_no, contract_style, final_yn, incdec_qty, incdec_amt, verified, id_conflict, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (dlvr_req_no, chg_ord, prdct_sno, company_id) DO UPDATE SET
      dlvr_req_nm = excluded.dlvr_req_nm, company_name = excluded.company_name, biz_no = excluded.biz_no, received_date = excluded.received_date,
      demander_code = excluded.demander_code, demander_name = excluded.demander_name, demander_kind = excluded.demander_kind,
      product_class_no = excluded.product_class_no, product_class_name = excluded.product_class_name, product_id = excluded.product_id,
      product_name = excluded.product_name, unit_price = excluded.unit_price, qty = excluded.qty, amount = excluded.amount,
      deadline = excluded.deadline, contract_no = excluded.contract_no, contract_style = excluded.contract_style,
      final_yn = excluded.final_yn, incdec_qty = excluded.incdec_qty, incdec_amt = excluded.incdec_amt, verified = excluded.verified,
      id_conflict = excluded.id_conflict, collected_at = excluded.collected_at`);
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run(
        r.dlvrReqNo, r.requestName, r.chgOrd, r.prdctSno, r.companyId, r.companyName, r.bizNo, r.receivedDate, r.demanderCode, r.demanderName,
        r.demanderKind, r.productClassNo, r.productClassName, r.productId, r.productName, r.unitPrice, r.qty, r.amount, r.deadline,
        r.contractNo, r.contractStyle, r.finalYn ? 1 : 0, r.incdecQty, r.incdecAmt, r.verified ? 1 : 0, r.idConflict ? 1 : 0, now,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

// 납품요구 물품 행을 최근 접수일자 순으로. (납품요구번호, 물품순번, 업체)마다 한 행만 돌려주며,
// **기간은 최초 접수일자(가장 작은 변경 차수들 중 가장 이른 접수일자)로 판정하고 값(수량 · 금액 · 변경 차수)은 가장 큰 변경 차수의 것**이다.
// 변경본의 접수일자가 다른 달이어도 납품요구는 처음 접수된 기간에 남고, 취소 · 감액은 그 기간의 현재 값에 반영된다.
// 돌려주는 receivedDate는 최초 접수일자다.
export function listDeliveries(db: DatabaseSync, q: { from: string; to: string; companyId?: string }): DeliveryRow[] {
  const where = q.companyId === undefined ? '' : 'AND company_id = ?';
  const args = q.companyId === undefined ? [q.from, q.to] : [q.from, q.to, q.companyId];
  const rows = db
    .prepare(`
      WITH latest AS (
        SELECT d.*, (SELECT MIN(x.received_date) FROM delivery_requests x
                     WHERE x.dlvr_req_no = d.dlvr_req_no AND x.prdct_sno = d.prdct_sno AND x.company_id = d.company_id) AS first_received
        FROM delivery_requests d
        WHERE d.chg_ord = (SELECT MAX(x.chg_ord) FROM delivery_requests x
                           WHERE x.dlvr_req_no = d.dlvr_req_no AND x.prdct_sno = d.prdct_sno AND x.company_id = d.company_id)
      )
      SELECT * FROM latest
      WHERE first_received >= ? AND first_received <= ? ${where}
      ORDER BY first_received DESC, dlvr_req_no, prdct_sno, company_id`)
    .all(...args);
  return rows.map((r) => ({
    dlvrReqNo: String(r['dlvr_req_no']),
    requestName: String(r['dlvr_req_nm']),
    chgOrd: Number(r['chg_ord']),
    prdctSno: String(r['prdct_sno']),
    companyId: String(r['company_id']),
    companyName: String(r['company_name']),
    bizNo: String(r['biz_no']),
    receivedDate: String(r['first_received']),
    demanderCode: String(r['demander_code']),
    demanderName: String(r['demander_name']),
    demanderKind: String(r['demander_kind']),
    productClassNo: String(r['product_class_no']),
    productClassName: String(r['product_class_name']),
    productId: String(r['product_id']),
    productName: String(r['product_name']),
    unitPrice: num(r['unit_price']),
    qty: num(r['qty']),
    amount: num(r['amount']),
    deadline: String(r['deadline']),
    contractNo: String(r['contract_no']),
    contractStyle: String(r['contract_style']),
    finalYn: r['final_yn'] === 1,
    incdecQty: num(r['incdec_qty']),
    incdecAmt: num(r['incdec_amt']),
    verified: r['verified'] === 1,
    idConflict: r['id_conflict'] === 1,
  }));
}
