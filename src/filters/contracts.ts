import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Product {
  id: string;
  name: string;
}

export interface Company {
  id: string;
  label: string;
  // 계약의 업체명과 정확히 일치해야 하는 등록 상호들 (앞뒤 공백만 무시).
  matchNames: string[];
  // true면 나라장터 등록 상호를 아직 확인하지 못한 잠정 표기다 (WO-20261028-04 결정 11).
  provisional: boolean;
  products: Product[];
}

export interface MonitoringConfig {
  categoryCodes: string[];
  companies: Company[];
}

// 나라장터 응답을 정규화한 계약 · 납품요구 한 건. 필드 매핑은 API 응답 확인 뒤에 만든다.
export interface ContractRecord {
  categoryCode: string;
  companyName: string;
  productId: string;
}

export type Classification =
  | { pass: false; rejected: 'category' | 'company' }
  | {
      pass: true;
      companyId: string;
      // 식별번호가 그 업체의 확인 대상 목록에 있으면 true. 목록에 없는 신제품도 저장은 된다.
      verified: boolean;
      // 같은 식별번호가 여러 업체 목록에 걸쳐 있어 원본 대조가 필요한 번호면 true.
      idConflict: boolean;
    };

export interface Matcher {
  classify(record: ContractRecord): Classification;
  // 여러 업체에 걸친 식별번호들 (정렬됨).
  conflictIds: string[];
}

const isString = (v: unknown): v is string => typeof v === 'string';

function fail(message: string): never {
  throw new Error(`모니터링 설정 오류: ${message}`);
}

export function parseMonitoringConfig(raw: unknown): MonitoringConfig {
  if (typeof raw !== 'object' || raw === null) fail('객체가 아닙니다');
  const { categoryCodes, companies } = raw as Record<string, unknown>;

  if (!Array.isArray(categoryCodes) || categoryCodes.length === 0) fail('categoryCodes가 비어 있습니다');
  for (const c of categoryCodes) if (!isString(c) || !/^\d{10}$/.test(c)) fail(`물품분류번호는 10자리 숫자여야 합니다: ${String(c)}`);

  if (!Array.isArray(companies) || companies.length === 0) fail('companies가 비어 있습니다');
  const ids = new Set<string>();
  const names = new Map<string, string>();
  const parsed: Company[] = companies.map((c: unknown, i) => {
    if (typeof c !== 'object' || c === null) fail(`companies[${i}]가 객체가 아닙니다`);
    const { id, label, matchNames, provisional, products } = c as Record<string, unknown>;
    if (!isString(id) || id === '') fail(`companies[${i}].id가 없습니다`);
    if (ids.has(id)) fail(`업체 id가 중복됩니다: ${id}`);
    ids.add(id);
    if (!isString(label) || label === '') fail(`${id}: label이 없습니다`);
    if (typeof provisional !== 'boolean') fail(`${id}: provisional은 true/false여야 합니다`);
    if (!Array.isArray(matchNames) || matchNames.length === 0) fail(`${id}: matchNames가 비어 있습니다`);
    const normalized = matchNames.map((n: unknown) => {
      if (!isString(n) || n.trim() === '') fail(`${id}: matchNames에 빈 값이 있습니다`);
      const name = n.trim();
      // 같은 상호가 두 업체에 있으면 어느 업체인지 판별할 수 없다.
      const other = names.get(name);
      if (other !== undefined) fail(`상호 "${name}"가 ${other}와 ${id}에 중복됩니다`);
      names.set(name, id);
      return name;
    });
    if (!Array.isArray(products)) fail(`${id}: products가 배열이 아닙니다`);
    const seen = new Set<string>();
    const prods: Product[] = products.map((p: unknown) => {
      if (typeof p !== 'object' || p === null) fail(`${id}: products에 객체가 아닌 값이 있습니다`);
      const { id: pid, name } = p as Record<string, unknown>;
      if (!isString(pid) || !/^\d{8}$/.test(pid)) fail(`${id}: 물품식별번호는 8자리 숫자여야 합니다: ${String(pid)}`);
      if (seen.has(pid)) fail(`${id}: 물품식별번호가 중복됩니다: ${pid}`);
      seen.add(pid);
      return { id: pid, name: isString(name) ? name : '' };
    });
    return { id, label, matchNames: normalized, provisional, products: prods };
  });

  return { categoryCodes: [...categoryCodes] as string[], companies: parsed };
}

export function loadMonitoringConfig(
  path: URL | string = new URL('../../config/contract-monitoring.json', import.meta.url),
): MonitoringConfig {
  try {
    return parseMonitoringConfig(JSON.parse(readFileSync(path, 'utf8')));
  } catch (err) {
    // JSON 문법 오류 · 형식 오류가 어느 파일의 문제인지 알 수 있게 경로를 붙인다.
    const where = path instanceof URL ? fileURLToPath(path) : path;
    throw new Error(`${where}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

// 1차 물품분류번호(정확 일치) → 2차 업체명(정확 일치) → 3차 물품식별번호 '확인 대상' 표시.
// 3차는 걸러내지 않는다: 분류번호와 업체명이 맞으면 목록에 없는 신제품도 통과한다 (WO-20261028-04 결정 5).
export function createMatcher(config: MonitoringConfig): Matcher {
  const categories = new Set(config.categoryCodes);
  const byName = new Map<string, Company>();
  for (const c of config.companies) for (const n of c.matchNames) byName.set(n, c);

  const owners = new Map<string, Set<string>>();
  for (const c of config.companies) {
    for (const p of c.products) owners.set(p.id, (owners.get(p.id) ?? new Set()).add(c.id));
  }
  const conflictIds = [...owners].filter(([, o]) => o.size > 1).map(([id]) => id).sort();
  const conflicts = new Set(conflictIds);

  return {
    conflictIds,
    classify(record) {
      if (!categories.has(record.categoryCode)) return { pass: false, rejected: 'category' };
      const company = byName.get(record.companyName.trim());
      if (!company) return { pass: false, rejected: 'company' };
      const verified = company.products.some((p) => p.id === record.productId);
      return { pass: true, companyId: company.id, verified, idConflict: verified && conflicts.has(record.productId) };
    },
  };
}
