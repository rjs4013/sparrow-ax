import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { migrate, openDb } from './index.ts';

const list = [
  { id: '0002_add', sql: 'ALTER TABLE t ADD COLUMN b TEXT' },
  { id: '0001_init', sql: 'CREATE TABLE t (a TEXT)' },
];

test('빈 DB에서 id 순서대로 적용하고, 다시 실행하면 아무것도 적용하지 않는다', () => {
  const db = openDb(':memory:');
  assert.deepEqual(migrate(db, list), ['0001_init', '0002_add']);
  assert.deepEqual(migrate(db, list), []);
  db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run('x', 'y');
});

test('없는 디렉터리의 빈 파일 DB를 만들어 초기화하고, 다시 열어도 재적용하지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sparrow-db-'));
  try {
    const path = join(dir, 'nested', 'x.db');
    const first = openDb(path);
    assert.deepEqual(migrate(first, list), ['0001_init', '0002_add']);
    first.close();
    const second = openDb(path);
    assert.deepEqual(migrate(second, list), []);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('id 정렬은 로케일과 무관한 코드 단위 순서다', () => {
  const db = openDb(':memory:');
  const mixed = [
    { id: '0001_b', sql: 'CREATE TABLE b (a TEXT)' },
    { id: '0001_B', sql: 'CREATE TABLE B2 (a TEXT)' },
  ];
  assert.deepEqual(migrate(db, mixed), ['0001_B', '0001_b']);
});

test('실패한 마이그레이션은 롤백되고 기록되지 않는다', () => {
  const db = openDb(':memory:');
  const bad = [{ id: '0001_bad', sql: 'CREATE TABLE ok (a TEXT); CREATE TABLE ok (a TEXT)' }];
  assert.throws(() => migrate(db, bad), /0001_bad/);
  const rows = db.prepare('SELECT id FROM schema_migrations').all();
  assert.equal(rows.length, 0);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok'").all();
  assert.equal(tables.length, 0);
});
