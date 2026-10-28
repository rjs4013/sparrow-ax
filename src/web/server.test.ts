import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildServer } from './server.ts';

test('/health는 200과 ok를 반환한다', async () => {
  const app = buildServer();
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
  await app.close();
});
