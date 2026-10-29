import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadBidConfig, matchKeywords, parseBidConfig } from './bids.ts';

const keywords = ['공급망', 'SBOM', 'Dev', 'app', '솔루션', 'SW공급망'];

test('공고명에 키워드가 포함되면 걸린 키워드를 설정 순서대로 돌려준다', () => {
  assert.deepEqual(matchKeywords('2026년 소프트웨어 공급망 보안 솔루션 구축', keywords), ['공급망', '솔루션']);
  assert.deepEqual(matchKeywords('SW공급망 보안 강화', keywords), ['공급망', 'SW공급망']);
  assert.deepEqual(matchKeywords('일반 물품 구매', keywords), []);
  assert.deepEqual(matchKeywords('', keywords), []);
});

test('영문 키워드는 대소문자를 무시하고 단순 포함으로 판정한다 (사람 결정: 대소문자 무시 포함)', () => {
  assert.deepEqual(matchKeywords('sbom 도입', keywords), ['SBOM']);
  assert.deepEqual(matchKeywords('DEVSECOPS 체계', keywords), ['Dev']);
  // 단어 경계를 보지 않으므로 Developer · Apple · application도 걸린다(잡음은 알려진 한계).
  assert.deepEqual(matchKeywords('Developer 교육', keywords), ['Dev']);
  assert.deepEqual(matchKeywords('Apple제조업 지원', keywords), ['app']);
  assert.deepEqual(matchKeywords('application 운영', keywords), ['app']);
});

test('설정 검증: 비어 있거나 공백뿐이거나 대소문자만 다른 중복 키워드를 거부한다', () => {
  assert.deepEqual(parseBidConfig({ keywords: [' 공급망 ', 'SBOM'] }).keywords, ['공급망', 'SBOM']);
  assert.throws(() => parseBidConfig({ keywords: [] }), /keywords/);
  assert.throws(() => parseBidConfig({ keywords: ['  '] }), /빈 값/);
  assert.throws(() => parseBidConfig({ keywords: ['SBOM', 'sbom'] }), /중복/);
  assert.throws(() => parseBidConfig({ keywords: [1] }), /문자열/);
  assert.throws(() => parseBidConfig(null), /객체/);
});

test('실제 설정 파일: 요구사항 2.3의 키워드 15종 그대로', () => {
  assert.deepEqual(loadBidConfig().keywords, [
    '공급망', '취약점', '시큐어', '개발보안', '소스코드', '오픈소스', 'SBOM', 'Dev', '솔루션', 'app', '모의해킹', '보안약점', 'SW공급망', 'SW보안약점', '컨설팅',
  ]);
});

test('설정을 읽다 실패하면 오류 메시지에 파일 경로가 들어간다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sparrow-bid-'));
  try {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not json');
    assert.throws(() => loadBidConfig(bad), (err: Error) => err.message.includes(bad));
    assert.throws(() => loadBidConfig(join(dir, 'missing.json')), (err: Error) => err.message.includes('missing.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('한글 조합 방식(NFC · NFD)이 달라도 같은 키워드로 판정한다', () => {
  const nfd = '소스코드 점검'.normalize('NFD');
  assert.notEqual(nfd, '소스코드 점검');
  assert.deepEqual(matchKeywords(nfd, ['소스코드']), ['소스코드']);
});
