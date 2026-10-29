import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface BidConfig {
  // 공고명 필터 키워드 (요구사항 2.3).
  keywords: string[];
}

function fail(message: string): never {
  throw new Error(`입찰공고 설정 오류: ${message}`);
}

export function parseBidConfig(raw: unknown): BidConfig {
  if (typeof raw !== 'object' || raw === null) fail('객체가 아닙니다');
  const { keywords } = raw as Record<string, unknown>;
  if (!Array.isArray(keywords) || keywords.length === 0) fail('keywords가 비어 있습니다');
  const seen = new Set<string>();
  const normalized = (keywords as unknown[]).map((k) => {
    if (typeof k !== 'string') return fail('키워드는 문자열이어야 합니다');
    const word = k.trim();
    if (word === '') return fail('keywords에 빈 값이 있습니다');
    // 판정이 대소문자를 무시하므로 대소문자만 다른 키워드는 중복이다.
    if (seen.has(word.toLowerCase())) return fail(`키워드가 중복됩니다: ${word}`);
    seen.add(word.toLowerCase());
    return word;
  });
  return { keywords: normalized };
}

export function loadBidConfig(path: URL | string = new URL('../../config/bid-monitoring.json', import.meta.url)): BidConfig {
  try {
    return parseBidConfig(JSON.parse(readFileSync(path, 'utf8')));
  } catch (err) {
    const where = path instanceof URL ? fileURLToPath(path) : path;
    throw new Error(`${where}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

// 공고명에 포함된 키워드를 설정 순서대로 돌려준다. 대소문자를 무시한 단순 포함 판정이다(사람 결정, 2026-10-29).
// 단어 경계를 보지 않아 "Developer" · "Apple" · "application"도 걸리는 잡음이 있다(실측: 평일 하루 약 1,600~2,100건 중 7~17건 적중).
// 한글 조합 방식(NFC · NFD)이 달라도 같게 보도록 정규화해서 비교한다.
const fold = (s: string): string => s.normalize('NFC').toLowerCase();

export function matchKeywords(title: string, keywords: string[]): string[] {
  const lower = fold(title);
  return keywords.filter((k) => lower.includes(fold(k)));
}
