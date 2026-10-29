// 계약정보서비스 응답을 읽는다. 구조는 WO-20261028-07의 실측을 따른다.
// 오류는 HTTP 200으로도 오고(`nkoneps.com.response.ResponseError` 래퍼), 항목 키의 대소문자가 명세와 다르다.

// code: 서비스가 알려 준 resultCode. null이면 응답 모양 자체가 예상과 다르다.
export class G2bResponseError extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = 'G2bResponseError';
    this.code = code;
  }
}

// 키는 소문자로 바꿔 보관한다. 읽을 때는 `field`를 쓴다.
export type Row = Readonly<Record<string, string>>;

export interface Page {
  items: Row[];
  totalCount: number;
  pageNo: number;
  numOfRows: number;
}

const bad = (message: string): never => {
  throw new G2bResponseError(`나라장터 응답 형식 오류: ${message}`);
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function lookup(obj: Record<string, unknown>, name: string): unknown {
  const lower = name.toLowerCase();
  const keys = Object.keys(obj).filter((k) => k.toLowerCase() === lower);
  if (keys.length > 1) bad(`대소문자만 다른 키가 겹칩니다: ${name}`);
  return keys[0] === undefined ? undefined : obj[keys[0]];
}

function readInt(obj: Record<string, unknown>, name: string): number {
  const v = lookup(obj, name);
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n)) return bad(`${name}가 정수가 아닙니다`);
  return n;
}

function toRow(raw: unknown): Row {
  if (!isObject(raw)) return bad('항목이 객체가 아닙니다');
  const row: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = k.toLowerCase();
    if (Object.hasOwn(row, key)) bad(`항목에 대소문자만 다른 키가 겹칩니다: ${k}`);
    if (v === null) row[key] = '';
    else if (typeof v === 'string') row[key] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') row[key] = String(v);
    else bad(`항목 값이 문자열이 아닙니다: ${k}`);
  }
  return row;
}

export function parsePage(raw: unknown): Page {
  if (!isObject(raw)) return bad('최상위가 객체가 아닙니다');

  // 오류 래퍼: {"nkoneps.com.response.ResponseError": {"header": {...}}}
  const wrapperKey = Object.keys(raw).find((k) => k.toLowerCase().endsWith('responseerror'));
  const response = wrapperKey === undefined ? lookup(raw, 'response') : raw[wrapperKey];
  if (!isObject(response)) return bad('response가 없습니다');

  const header = lookup(response, 'header');
  if (!isObject(header)) return bad('header가 없습니다');
  const resultCode = lookup(header, 'resultCode');
  if (typeof resultCode !== 'string') return bad('resultCode가 없습니다');
  if (wrapperKey !== undefined || resultCode !== '00') {
    const msg = lookup(header, 'resultMsg');
    throw new G2bResponseError(`나라장터 API 오류 ${resultCode}: ${typeof msg === 'string' ? msg : ''}`, resultCode);
  }

  const body = lookup(response, 'body');
  if (!isObject(body)) return bad('body가 없습니다');
  const items = lookup(body, 'items');
  // 결과가 없으면 items 키 자체가 오지 않는다. 그 밖의 모양(빈 문자열, 객체 하나)은 받아들이지 않는다.
  if (items !== undefined && !Array.isArray(items)) return bad('items가 배열이 아닙니다');

  return {
    items: (items ?? []).map(toRow),
    totalCount: readInt(body, 'totalCount'),
    pageNo: readInt(body, 'pageNo'),
    numOfRows: readInt(body, 'numOfRows'),
  };
}

export function field(row: Row, name: string): string {
  const key = name.toLowerCase();
  return Object.hasOwn(row, key) ? row[key]! : '';
}

export interface Corp {
  name: string;
  bizNo: string;
  kind: string;
  jointKind: string;
  share: string;
}

export interface Demander {
  code: string;
  name: string;
  jurisdiction: string;
}

// `[a^b^c],[d^e^f]` 형태를 칸 배열들로 푼다. 칸 수가 다르거나 괄호 밖에 다른 글자가 있으면 실패한다.
function splitEntries(text: string, columns: number, label: string): string[][] {
  // 상호에 대괄호가 들어 있을 수 있어(실측: "회사 [지점]"), 항목의 끝은 "뒤에 문자열 끝 또는 `,[순번^`이 오는 `]`"로 정한다.
  const entry = /\[(\d+\^.*?)\](?=\s*(?:,\s*\[\d+\^|$))/gs;
  const entries = [...text.matchAll(entry)];
  const rest = text.replace(entry, '').replace(/[,\s]/g, '');
  if (rest !== '') bad(`${label}에 괄호 밖 글자가 있습니다`);
  return entries.map((m) => {
    const cells = (m[1] ?? '').split('^');
    if (cells.length !== columns) bad(`${label} 항목의 칸이 ${columns}개가 아닙니다 (${cells.length}개)`);
    return cells.map((c) => c.trim());
  });
}

// 순번^업체구분^공동도급방식구분^업체명^대표자명^국적명^지분율^채권자명^담당자성명^사업자등록번호
// 대표자 · 담당자 이름은 쓰지 않으므로 버린다.
export function parseCorpList(text: string): Corp[] {
  return splitEntries(text, 10, 'corpList').map((c) => ({
    kind: c[1]!, jointKind: c[2]!, name: c[3]!, share: c[6]!, bizNo: c[9]!,
  }));
}

// 순번^수요기관코드^수요기관명^소관구분^담당부서명^담당자성명^담당자전화번호
// 담당자 · 전화번호는 개인 연락처라 버린다.
export function parseDemanderList(text: string): Demander[] {
  return splitEntries(text, 7, 'dminsttList').map((c) => ({ code: c[1]!, name: c[2]!, jurisdiction: c[3]! }));
}

const PLACEHOLDER_CODE = 'ZZ99999';
const PLACEHOLDER_NAME = '각 수요기관';

// 조달청 계약은 실제 구매처 대신 "각 수요기관"(ZZ99999)이 들어온다.
export function isPlaceholderDemander(d: Demander): boolean {
  return d.code === PLACEHOLDER_CODE || d.name === PLACEHOLDER_NAME;
}
