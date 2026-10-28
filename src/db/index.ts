import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface Migration {
  id: string;
  sql: string;
}

// 테이블 스키마는 기능 지시서에서 정하고 여기에 추가한다. id는 정렬 가능한 문자열(예: '0001_init').
export const migrations: Migration[] = [];

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  return db;
}

// 적용되지 않은 마이그레이션만 id 순서로 각각 트랜잭션 안에서 실행한다. 적용한 id 목록을 반환한다.
export function migrate(db: DatabaseSync, list: Migration[] = migrations): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((r) => String(r['id'])),
  );
  const applied: string[] = [];
  // 로케일과 무관하게 결정적인 코드 단위 순서로 정렬한다.
  for (const m of [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (done.has(m.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
        m.id,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (err) {
      // 마이그레이션 SQL이 직접 COMMIT했다면 ROLLBACK이 실패할 수 있다. 원래 오류를 가리지 않는다.
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw new Error(`마이그레이션 ${m.id} 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
    applied.push(m.id);
  }
  return applied;
}
