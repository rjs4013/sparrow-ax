import assert from 'node:assert/strict';
import { test } from 'node:test';
import { field, G2bResponseError, isPlaceholderDemander, parseCorpList, parseDemanderList, parsePage } from './response.ts';

// 실제 응답(WO-20261028-07)의 구조를 본뜬 합성 입력이다. 값은 지어낸 것이다.
const ok = (body: object) => ({ response: { header: { resultCode: '00', resultMsg: '정상' }, body } });
const item = {
  untyCntrctNo: 'R26TE00000001',
  dcsnCntrctNo: 'R26TA00000000001',
  cntrctNm: '보안 소프트웨어 구매',
  cntrctCnclsDate: '2026-10-21',
  thtmCntrctAmt: '1000000',
  rgstDt: '2026-10-21 09:30:00',
  chgDt: '',
  corpList: '[1^법인사업자^단독^주식회사 스패로우^홍길동^대한민국^100^주식회사 스패로우^^1234567890]',
  dminsttList: '[1^ZZ99999^각 수요기관^중앙행정기관^^^]',
};

test('정상 응답: 항목과 건수를 읽고, 키는 대소문자를 무시한다', () => {
  const page = parsePage(ok({ items: [item, { ...item, untyCntrctNo: 'R26TE00000002' }], numOfRows: 999, pageNo: 1, totalCount: 2 }));
  assert.equal(page.totalCount, 2);
  assert.equal(page.pageNo, 1);
  assert.equal(page.numOfRows, 999);
  assert.equal(page.items.length, 2);
  assert.equal(field(page.items[0]!, 'untyCntrctNo'), 'R26TE00000001');
  assert.equal(field(page.items[0]!, 'UNTYCNTRCTNO'), 'R26TE00000001');
  assert.equal(field(page.items[0]!, 'chgDt'), '');
  assert.equal(field(page.items[0]!, 'noSuchField'), '');
});

test('명세와 대소문자가 다른 키(pubPrcrmntLrgClsfcNm)도 같은 필드로 읽는다', () => {
  const page = parsePage(ok({ items: [{ ...item, PUBPRCRMNTLRGCLSFCNM: '물품' }], numOfRows: 10, pageNo: 1, totalCount: 1 }));
  assert.equal(field(page.items[0]!, 'pubPrcrmntLrgClsfcNm'), '물품');
});

test('Object.prototype과 이름이 같은 키도 일반 필드로 다룬다', () => {
  const page = parsePage(ok({ items: [{ constructor: 'x', toString: 'y' }], numOfRows: 1, pageNo: 1, totalCount: 1 }));
  assert.equal(field(page.items[0]!, 'constructor'), 'x');
  assert.equal(field({}, 'constructor'), '');
});

test('결과가 없으면 items 키 없이 totalCount 0으로 오고, 빈 배열로 읽는다', () => {
  const page = parsePage(ok({ numOfRows: 100, pageNo: 1, totalCount: 0 }));
  assert.deepEqual(page.items, []);
  assert.equal(page.totalCount, 0);
});

test('HTTP 200으로 오는 오류 래퍼는 빈 결과가 아니라 실패다', () => {
  const wrapped = { 'nkoneps.com.response.ResponseError': { header: { resultCode: '07', resultMsg: '입력범위값 초과 에러' } } };
  assert.throws(() => parsePage(wrapped), (err: unknown) => {
    assert.ok(err instanceof G2bResponseError);
    assert.equal(err.code, '07');
    assert.match(err.message, /07/);
    assert.match(err.message, /입력범위값 초과 에러/);
    return true;
  });
});

test('정상 래퍼여도 resultCode가 00이 아니면 실패다', () => {
  const bad = { response: { header: { resultCode: '30', resultMsg: '등록되지 않은 서비스키' }, body: {} } };
  assert.throws(() => parsePage(bad), (err: unknown) => err instanceof G2bResponseError && err.code === '30');
});

test('예상하지 못한 모양은 조용히 받아들이지 않는다', () => {
  for (const raw of [null, 'text', [], {}, { response: {} }, { response: { header: {} } }]) {
    assert.throws(() => parsePage(raw), (err: unknown) => err instanceof G2bResponseError && err.code === null, JSON.stringify(raw));
  }
  // items가 배열이 아니거나, 건수가 숫자가 아니거나, 항목에 중첩 값이 있는 경우
  for (const body of [
    { items: '', numOfRows: 1, pageNo: 1, totalCount: 0 },
    { items: { item, extra: 1 }, numOfRows: 1, pageNo: 1, totalCount: 1 },
    { items: { item: 'text' }, numOfRows: 1, pageNo: 1, totalCount: 1 },
    { items: [item], numOfRows: 1, pageNo: 1, totalCount: 'many' },
    { items: [{ a: { b: 1 } }], numOfRows: 1, pageNo: 1, totalCount: 1 },
    { items: [{ a: '1', A: '2' }], numOfRows: 1, pageNo: 1, totalCount: 1 },
  ]) {
    assert.throws(() => parsePage(ok(body)), (err: unknown) => err instanceof G2bResponseError && err.code === null, JSON.stringify(body).slice(0, 40));
  }
});

test('숫자로 온 건수 필드는 문자열이어도 읽는다', () => {
  const page = parsePage(ok({ items: [], numOfRows: '100', pageNo: '1', totalCount: '0' }));
  assert.deepEqual([page.numOfRows, page.pageNo, page.totalCount], [100, 1, 0]);
});

test('corpList: 업체명 · 사업자등록번호 · 구분을 읽고 대표자 · 담당자는 버린다', () => {
  assert.deepEqual(parseCorpList(item.corpList), [
    { name: '주식회사 스패로우', bizNo: '1234567890', kind: '법인사업자', jointKind: '단독', share: '100' },
  ]);
});

test('corpList: 여러 건, 괄호 · 슬래시 · 전각 괄호 · 한자가 든 상호, 빈 문자열', () => {
  const text = '[1^법인사업자^주계약자^(주)에이/비^김^대한민국^60^(주)에이/비^^1111111111],[2^법인사업자^공동수급^株式會社 錦湖（서울）^이^대한민국^40^x^^2222222222]';
  assert.deepEqual(parseCorpList(text).map((c) => [c.name, c.bizNo, c.jointKind, c.share]), [
    ['(주)에이/비', '1111111111', '주계약자', '60'],
    ['株式會社 錦湖（서울）', '2222222222', '공동수급', '40'],
  ]);
  assert.deepEqual(parseCorpList(''), []);
});

test('corpList: 상호 안에 대괄호가 있어도 항목 경계를 잃지 않는다 (실측: "회사 [지점]")', () => {
  const text = '[1^법인사업자^단독^주식회사 에이 [서울지점]^김^대한민국^100^주식회사 에이 [서울지점]^^1111111111],[2^법인사업자^공동수급^비^이^대한민국^0^x^^2222222222]';
  assert.deepEqual(parseCorpList(text).map((c) => [c.name, c.bizNo]), [
    ['주식회사 에이 [서울지점]', '1111111111'],
    ['비', '2222222222'],
  ]);
});

test('corpList: 형식이 어긋나면 조용히 넘기지 않고 실패한다', () => {
  for (const bad of ['[1^a^b]', '1^법인^단독^이름^대표^국^100^채^^123', '[1^a^b^c^d^e^f^g^h^i^j]', '[1^법인사업자^단독^이름^대^국^100^채^^123] 끼어든 글자']) {
    assert.throws(() => parseCorpList(bad), (err: unknown) => err instanceof G2bResponseError, bad);
  }
});

test('dminsttList: 수요기관 코드 · 이름 · 소관구분을 읽고, 담당자 · 전화는 버린다', () => {
  assert.deepEqual(parseDemanderList('[1^B552001^국방과학연구소^정부출자기관^연구지원부^홍길동^042-000-0000]'), [
    { code: 'B552001', name: '국방과학연구소', jurisdiction: '정부출자기관' },
  ]);
  assert.deepEqual(parseDemanderList(''), []);
  assert.throws(() => parseDemanderList('[1^ZZ99999^각 수요기관]'), (err: unknown) => err instanceof G2bResponseError);
});

test('"각 수요기관"(ZZ99999)은 실제 구매처가 아닌 자리표시자로 판정한다', () => {
  const [placeholder] = parseDemanderList(item.dminsttList);
  assert.equal(isPlaceholderDemander(placeholder!), true);
  assert.equal(isPlaceholderDemander({ code: 'B552001', name: '국방과학연구소', jurisdiction: '정부출자기관' }), false);
  // 코드가 바뀌어도 이름이 같으면 자리표시자다(둘 중 하나만 맞아도 실제 구매처로 취급하지 않는다).
  assert.equal(isPlaceholderDemander({ code: 'X', name: '각 수요기관', jurisdiction: '' }), true);
  assert.equal(isPlaceholderDemander({ code: 'ZZ99999', name: '', jurisdiction: '' }), true);
});

test('items가 {item: …}로 한 번 싸여 와도(쇼핑몰 서비스 형식) 배열 또는 객체 하나를 읽는다', () => {
  const many = parsePage(ok({ items: { item: [item, { ...item, untyCntrctNo: 'R26TE00000002' }] }, numOfRows: 10, pageNo: 1, totalCount: 2 }));
  assert.equal(many.items.length, 2);
  const one = parsePage(ok({ items: { item }, numOfRows: 10, pageNo: 1, totalCount: 1 }));
  assert.equal(one.items.length, 1);
  assert.equal(field(one.items[0]!, 'untyCntrctNo'), 'R26TE00000001');
  assert.deepEqual(parsePage(ok({ items: { item: [] }, numOfRows: 10, pageNo: 1, totalCount: 0 })).items, []);
});
