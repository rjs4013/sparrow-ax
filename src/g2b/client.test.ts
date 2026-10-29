import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createG2bClient, loadG2bConfig } from './client.ts';

const KEY = 'SECRET%2Bkey';
const config = { baseUrl: 'https://example.test/api', serviceKey: KEY };

test('서비스별 변수를 읽고, 서비스키나 요청주소가 없으면 변수 이름을 알려 준다', () => {
  assert.throws(() => loadG2bConfig({ G2B_CONTRACT_BASE_URL: 'https://x' }, 'CONTRACT'), /G2B_CONTRACT_SERVICE_KEY/);
  assert.throws(() => loadG2bConfig({ G2B_CONTRACT_SERVICE_KEY: 'k' }, 'CONTRACT'), /G2B_CONTRACT_BASE_URL/);
  assert.deepEqual(loadG2bConfig({ G2B_CONTRACT_SERVICE_KEY: ' k ', G2B_CONTRACT_BASE_URL: ' https://x ' }, 'CONTRACT'), {
    baseUrl: 'https://x',
    serviceKey: 'k',
  });
  // 다른 서비스의 변수는 읽지 않는다.
  const env = { G2B_CONTRACT_SERVICE_KEY: 'c', G2B_CONTRACT_BASE_URL: 'https://c', G2B_OPENSTD_SERVICE_KEY: 'o', G2B_OPENSTD_BASE_URL: 'https://o' };
  assert.equal(loadG2bConfig(env, 'OPENSTD').serviceKey, 'o');
  assert.equal(loadG2bConfig(env, 'CONTRACT').baseUrl, 'https://c');
  assert.throws(() => loadG2bConfig({ G2B_CONTRACT_SERVICE_KEY: 'k', G2B_CONTRACT_BASE_URL: 'https://x' }, 'OPENSTD'), /G2B_OPENSTD_SERVICE_KEY/);
});

test('요청주소가 https가 아니거나 주소 형식이 아니면 거부한다 (서비스키가 쿼리스트링으로 가므로)', () => {
  for (const url of ['http://apis.data.go.kr/x', 'ftp://x', 'apis.data.go.kr/x', '//x', 'not a url']) {
    assert.throws(() => loadG2bConfig({ G2B_CONTRACT_SERVICE_KEY: 'k', G2B_CONTRACT_BASE_URL: url }, 'CONTRACT'), /https/, url);
    assert.throws(() => createG2bClient({ baseUrl: url, serviceKey: 'k' }), /https/, url);
  }
});

test('경로가 절대 주소여도 요청주소의 출처를 벗어나지 않는다 (https 강제 우회 방지)', () => {
  const client = createG2bClient(config);
  for (const path of ['http://evil.test/x', 'https://evil.test/x']) {
    assert.throws(() => client.buildUrl(path), /출처/, path);
  }
});

test('오류 메시지에 서비스키 값이 들어가지 않는다 (주소 오류)', () => {
  const secret = 'SECRETVALUE';
  assert.throws(() => loadG2bConfig({ G2B_CONTRACT_SERVICE_KEY: secret, G2B_CONTRACT_BASE_URL: 'http://x' }, 'CONTRACT'), (err: Error) => !err.message.includes(secret));
});

test('기본 호출은 리다이렉트를 따르지 않고 제한 시간을 둔다', async () => {
  const original = globalThis.fetch;
  let seen: RequestInit | undefined;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seen = init;
    return { ok: true, status: 200, json: async () => ({ ok: 1 }) };
  }) as unknown as typeof fetch;
  try {
    assert.deepEqual(await createG2bClient(config).get('/getList'), { ok: 1 });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen?.redirect, 'error');
  assert.ok(seen?.signal instanceof AbortSignal);
});

test('URL에 경로, 파라미터, 서비스키, json 타입이 붙는다', () => {
  const url = new URL(createG2bClient(config).buildUrl('/getList', { pageNo: 1, inqryBgnDt: '202610280000' }));
  assert.equal(url.origin + url.pathname, 'https://example.test/api/getList');
  assert.equal(url.searchParams.get('pageNo'), '1');
  assert.equal(url.searchParams.get('inqryBgnDt'), '202610280000');
  assert.equal(url.searchParams.get('serviceKey'), KEY);
  assert.equal(url.searchParams.get('type'), 'json');
});

test('응답 오류 메시지에 서비스키가 노출되지 않는다', async () => {
  const client = createG2bClient(config, async () => ({ ok: false, status: 500, json: async () => ({}) }));
  await assert.rejects(client.get('/getList'), (err: Error) => {
    assert.match(err.message, /500/);
    assert.ok(!err.message.includes(KEY), '서비스키 노출');
    assert.ok(!err.message.includes(encodeURIComponent(KEY)), '인코딩된 서비스키 노출');
    return true;
  });
});

test('네트워크 오류 메시지에 서비스키가 노출되지 않는다', async () => {
  for (const form of [KEY, encodeURIComponent(KEY)]) {
    const client = createG2bClient(config, async () => {
      throw new Error(`connect failed ${form}`);
    });
    await assert.rejects(client.get('/getList'), (err: Error) => {
      assert.ok(!err.message.includes(form), `서비스키 노출: ${form}`);
      assert.match(err.message, /connect failed \*\*\*/);
      return true;
    });
  }
});

test('원문 · encodeURIComponent · URLSearchParams 형태가 서로 다른 키도 모두 마스킹한다', async () => {
  const key = 'a b!~';
  const forms = [key, encodeURIComponent(key), new URLSearchParams({ k: key }).toString().slice(2)];
  assert.equal(new Set(forms).size, 3, '세 형태가 서로 달라야 이 테스트가 의미가 있다');
  for (const form of forms) {
    const client = createG2bClient({ ...config, serviceKey: key }, async () => {
      throw new Error(`x ${form} y`);
    });
    await assert.rejects(client.get('/getList'), (err: Error) => {
      assert.ok(!err.message.includes(form), `서비스키 노출: ${form}`);
      return true;
    });
  }
});

test('JSON 파싱 오류에도 서비스키가 노출되지 않는다', async () => {
  const client = createG2bClient(config, async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError(`bad json near ${KEY}`);
    },
  }));
  await assert.rejects(client.get('/getList'), (err: Error) => {
    assert.match(err.message, /JSON/);
    assert.ok(!err.message.includes(KEY));
    return true;
  });
});

test('빈 서비스키로는 클라이언트를 만들 수 없다', () => {
  assert.throws(() => createG2bClient({ baseUrl: 'https://x', serviceKey: '' }), /비어/);
});

test('성공하면 JSON 본문을 반환한다', async () => {
  const client = createG2bClient(config, async () => ({ ok: true, status: 200, json: async () => ({ a: 1 }) }));
  assert.deepEqual(await client.get('/getList'), { a: 1 });
});
