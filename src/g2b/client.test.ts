import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createG2bClient, loadG2bConfig } from './client.ts';

const KEY = 'SECRET%2Bkey';
const config = { baseUrl: 'https://example.test/api', serviceKey: KEY };

test('서비스키나 기본 URL이 없으면 명확한 오류를 낸다', () => {
  assert.throws(() => loadG2bConfig({ G2B_BASE_URL: 'https://x' }), /G2B_SERVICE_KEY/);
  assert.throws(() => loadG2bConfig({ G2B_SERVICE_KEY: 'k' }), /G2B_BASE_URL/);
  assert.deepEqual(loadG2bConfig({ G2B_SERVICE_KEY: ' k ', G2B_BASE_URL: ' https://x ' }), {
    baseUrl: 'https://x',
    serviceKey: 'k',
  });
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
