import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMatcher, loadMonitoringConfig, parseMonitoringConfig, type ContractRecord } from './contracts.ts';

const CAT = '43233205';
const base = {
  categoryCodes: [CAT],
  companies: [
    {
      id: 'a', label: '에이', matchNames: ['주식회사 에이'], provisional: false,
      products: [{ id: '11111111', name: 'A1' }, { id: '33333333', name: 'A3' }],
    },
    {
      id: 'b', label: '비', matchNames: ['비', '비코리아'], provisional: true,
      products: [{ id: '11111111', name: 'B1' }, { id: '22222222', name: 'B2' }],
    },
  ],
};
const matcher = createMatcher(parseMonitoringConfig(base));
const rec = (over: Partial<ContractRecord> = {}): ContractRecord => ({
  categoryCode: CAT, companyName: '주식회사 에이', productId: '33333333', ...over,
});

test('분류번호가 보안소프트웨어가 아니면, 업체명이 맞아도 제외한다 (1차)', () => {
  assert.deepEqual(matcher.classify(rec({ categoryCode: '43233206' })), { pass: false, rejected: 'category' });
  // 이전에 쓰던 10자리 표기는 API의 8자리와 일치하지 않으므로 통과시키지 않는다.
  assert.deepEqual(matcher.classify(rec({ categoryCode: '4323320501' })), { pass: false, rejected: 'category' });
  assert.deepEqual(matcher.classify(rec({ categoryCode: '4323320' })), { pass: false, rejected: 'category' });
  assert.deepEqual(matcher.classify(rec({ categoryCode: '' })), { pass: false, rejected: 'category' });
});

test('업체명은 정확 일치만 통과한다: 비슷한 이름 · 포함 관계는 제외 (2차)', () => {
  for (const name of ['주식회사에이', '(주)에이', '에이', '주식회사 에이코리아', '주식회사 에이 Korea', '']) {
    assert.deepEqual(matcher.classify(rec({ companyName: name })), { pass: false, rejected: 'company' }, name);
  }
});

test('업체명 앞뒤 공백은 무시하고, 별칭 상호도 같은 업체로 본다', () => {
  assert.deepEqual(matcher.classify(rec({ companyName: ' 주식회사 에이 ' })), {
    pass: true, companyId: 'a', verified: true, idConflict: false,
  });
  assert.equal(matcher.classify(rec({ companyName: '비코리아', productId: '22222222' })).pass, true);
});

test('식별번호가 목록에 있으면 확인 대상, 없으면 신제품도 저장 대상이다 (3차)', () => {
  assert.deepEqual(matcher.classify(rec({ productId: '33333333' })), { pass: true, companyId: 'a', verified: true, idConflict: false });
  assert.deepEqual(matcher.classify(rec({ productId: '99999999' })), { pass: true, companyId: 'a', verified: false, idConflict: false });
});

test('다른 업체 목록에만 있는 식별번호는 이 업체의 확인 대상이 아니다', () => {
  assert.deepEqual(matcher.classify(rec({ productId: '22222222' })), { pass: true, companyId: 'a', verified: false, idConflict: false });
});

test('여러 업체에 걸친 식별번호는 업체명으로 판별하고 대조 필요로 표시한다', () => {
  assert.deepEqual(matcher.conflictIds, ['11111111']);
  assert.deepEqual(matcher.classify(rec({ productId: '11111111' })), { pass: true, companyId: 'a', verified: true, idConflict: true });
  assert.deepEqual(matcher.classify(rec({ companyName: '비', productId: '11111111' })), { pass: true, companyId: 'b', verified: true, idConflict: true });
});

test('설정 검증: 분류번호 · 식별번호 자릿수, 중복, 빈 값을 거부한다', () => {
  const withCompany = (over: object) => ({ ...base, companies: [{ ...base.companies[0], ...over }] });
  assert.throws(() => parseMonitoringConfig({ ...base, categoryCodes: ['1234567'] }), /8자리/);
  assert.throws(() => parseMonitoringConfig({ ...base, categoryCodes: ['4323320501'] }), /8자리/);
  assert.throws(() => parseMonitoringConfig({ ...base, categoryCodes: [] }), /categoryCodes/);
  assert.throws(() => parseMonitoringConfig(withCompany({ products: [{ id: '1234567', name: 'x' }] })), /8자리/);
  assert.throws(() => parseMonitoringConfig(withCompany({ products: [{ id: '11111111' }, { id: '11111111' }] })), /중복/);
  assert.throws(() => parseMonitoringConfig(withCompany({ matchNames: [] })), /matchNames/);
  assert.throws(() => parseMonitoringConfig(withCompany({ matchNames: ['  '] })), /빈 값/);
  assert.throws(() => parseMonitoringConfig(withCompany({ provisional: 'yes' })), /provisional/);
  assert.throws(() => parseMonitoringConfig({ ...base, companies: [base.companies[0], base.companies[0]] }), /중복/);
  assert.throws(() => parseMonitoringConfig({ ...base, companies: [base.companies[0], { ...base.companies[1], matchNames: ['주식회사 에이'] }] }), /중복/);
  assert.throws(() => parseMonitoringConfig(null), /객체/);
});

test('실제 설정 파일: 9개사, 식별번호 58개, 분류번호 43233205, 제외 업체 없음, 충돌 번호 4개', () => {
  const config = loadMonitoringConfig();
  assert.deepEqual(config.categoryCodes, ['43233205']);
  assert.deepEqual(config.companies.map((c) => c.label).sort(), ['나일소프트', '래브라도랩스', '레드펜소프트', '스패로우', '에스에스알', '정보라인', '코드마인드', '코드원', '하로스']);
  assert.equal(config.companies.reduce((n, c) => n + c.products.length, 0), 58);

  const names = config.companies.flatMap((c) => c.matchNames);
  for (const excluded of ['이븐스타', '싸이버텍', '파수닷컴']) assert.ok(!names.includes(excluded), excluded);
  assert.ok(names.includes('트리니티소프트'), '트리니티소프트는 에스에스알 별칭으로 포함');

  const sparrow = config.companies.find((c) => c.id === 'sparrow');
  assert.deepEqual(sparrow?.matchNames, ['주식회사 스패로우']);
  assert.equal(sparrow?.provisional, false);
  assert.equal(sparrow?.products.length, 24);

  const real = createMatcher(config);
  assert.deepEqual(real.conflictIds, ['22300118', '22300119', '22849502', '22849503']);
  assert.deepEqual(real.classify({ categoryCode: CAT, companyName: '주식회사 스패로우', productId: '26181128' }), {
    pass: true, companyId: 'sparrow', verified: true, idConflict: false,
  });
  assert.deepEqual(real.classify({ categoryCode: CAT, companyName: '(주)나일소프트', productId: '22849502' }), {
    pass: true, companyId: 'nilesoft', verified: true, idConflict: true,
  });
  assert.equal(real.classify({ categoryCode: CAT, companyName: '싸이버텍', productId: '22835795' }).pass, false);
});

test('전각 공백 · NBSP · 개행은 무시하지만 대소문자와 내부 공백 차이는 거부한다', () => {
  for (const name of ['\u3000주식회사 에이\u3000', '\u00a0주식회사 에이\u00a0', '주식회사 에이\n']) {
    assert.equal(matcher.classify(rec({ companyName: name })).pass, true, JSON.stringify(name));
  }
  for (const name of ['주식회사  에이', '주식회사\u00a0에이']) {
    assert.deepEqual(matcher.classify(rec({ companyName: name })), { pass: false, rejected: 'company' }, JSON.stringify(name));
  }
});

test('분류번호와 업체명이 모두 틀리면 1차(category) 사유가 우선한다', () => {
  assert.deepEqual(matcher.classify(rec({ categoryCode: '0000000000', companyName: '없는회사' })), { pass: false, rejected: 'category' });
});

test('실제 설정: 업체별 식별번호 수 · 잠정 여부 · 별칭 분류', () => {
  const config = loadMonitoringConfig();
  const counts = Object.fromEntries(config.companies.map((c) => [c.id, c.products.length]));
  assert.deepEqual(counts, {
    sparrow: 24, ssr: 9, infoline: 10, codemind: 5, haros: 1, nilesoft: 6, redpen: 0, codeone: 2, labradorlabs: 1,
  });
  // 실제 응답으로 등록 상호를 확인한 업체만 provisional=false다. 에스에스알은 별칭(트리니티소프트)이, 레드펜소프트는 등록 상호가 미확인이다.
  const confirmed = ['sparrow', 'nilesoft', 'codemind', 'labradorlabs', 'infoline', 'codeone', 'haros'];
  for (const c of config.companies) assert.equal(c.provisional, !confirmed.includes(c.id), c.id);

  const real = createMatcher(config);
  const hit = (companyName: string, productId: string) => real.classify({ categoryCode: CAT, companyName, productId });
  assert.deepEqual(hit('트리니티소프트', '25613507'), { pass: true, companyId: 'ssr', verified: true, idConflict: false });
  assert.deepEqual(hit('(주)에스에스알', '22849502'), { pass: true, companyId: 'ssr', verified: true, idConflict: true });
  assert.deepEqual(hit('(주)정보라인', '22849502'), { pass: true, companyId: 'infoline', verified: true, idConflict: true });
  // 납품요구 실응답(2026)에서 확인한 등록 상호. 정확 일치라 "(주)"가 없는 이름은 통과하지 못한다.
  assert.equal(hit('(주)코드원', '12345678').pass, true);
  assert.equal(hit('(주)하로스', '12345678').pass, true);
  for (const name of ['정보라인', '코드원', '하로스']) assert.deepEqual(hit(name, '22849502'), { pass: false, rejected: 'company' }, name);
  // 레드펜소프트는 받은 식별번호가 없어 업체명만 통과하고 확인 대상 표시는 없다.
  assert.deepEqual(hit('레드펜소프트', '12345678'), { pass: true, companyId: 'redpen', verified: false, idConflict: false });
  // 제외된 업체
  for (const name of ['이븐스타', '파수닷컴']) assert.deepEqual(hit(name, '24121890'), { pass: false, rejected: 'company' }, name);
});

test('설정을 읽다 실패하면 오류 메시지에 파일 경로가 들어간다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sparrow-cfg-'));
  try {
    const badJson = join(dir, 'bad.json');
    writeFileSync(badJson, '{ not json');
    assert.throws(() => loadMonitoringConfig(badJson), (err: Error) => err.message.includes(badJson));

    const badShape = join(dir, 'shape.json');
    writeFileSync(badShape, JSON.stringify({ categoryCodes: ['123'], companies: [] }));
    assert.throws(() => loadMonitoringConfig(badShape), (err: Error) => err.message.includes(badShape) && err.message.includes('8자리'));

    assert.throws(() => loadMonitoringConfig(join(dir, 'missing.json')), (err: Error) => err.message.includes('missing.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('업체 판정과 분류번호 판정을 따로 호출할 수 있다 (업체는 기본 조회, 분류번호는 세부 조회에 있다)', () => {
  assert.equal(matcher.matchCompany(' 주식회사 에이 '), 'a');
  assert.equal(matcher.matchCompany('비코리아'), 'b');
  assert.equal(matcher.matchCompany('주식회사 에이코리아'), undefined);
  assert.equal(matcher.isMonitoredCategory(CAT), true);
  assert.equal(matcher.isMonitoredCategory('4323320501'), false);
  assert.deepEqual(matcher.checkProduct('a', '33333333'), { verified: true, idConflict: false });
  assert.deepEqual(matcher.checkProduct('a', '11111111'), { verified: true, idConflict: true });
  assert.deepEqual(matcher.checkProduct('a', '22222222'), { verified: false, idConflict: false });
  assert.throws(() => matcher.checkProduct('없는업체', '33333333'), /업체/);
});

test('실제 설정: 응답에서 확인한 등록 상호로 정확 일치한다', () => {
  const real = createMatcher(loadMonitoringConfig());
  const expected: Record<string, string> = {
    '주식회사 스패로우': 'sparrow', '(주)나일소프트': 'nilesoft', '코드마인드 주식회사': 'codemind',
    '주식회사 래브라도랩스': 'labradorlabs', '(주)에스에스알': 'ssr', '트리니티소프트': 'ssr',
  };
  for (const [name, id] of Object.entries(expected)) assert.equal(real.matchCompany(name), id, name);
  // 예전에 쓰던 짧은 잠정 표기는 실제 상호와 일치하지 않으므로 더 이상 통과시키지 않는다.
  for (const short of ['나일소프트', '코드마인드', '래브라도랩스', '에스에스알']) assert.equal(real.matchCompany(short), undefined, short);
});
