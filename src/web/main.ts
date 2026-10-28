import { migrate, openDb } from '../db/index.ts';
import { buildServer } from './server.ts';

const db = openDb(process.env['DB_PATH'] ?? 'data/sparrow.db');
migrate(db);

const host = process.env['HOST'] ?? '127.0.0.1';
const port = Number(process.env['PORT'] ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`PORT가 올바르지 않습니다: ${process.env['PORT']}`);
}
// 로그인이 없는 서버이므로 루프백이 아닌 주소에 열 때는 사내망 한정 운영인지 확인하도록 경고한다.
if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
  console.warn(`경고: 인증 없는 웹 서버를 ${host}에 엽니다. 사내망에서만 접근 가능한지 확인하세요.`);
}
const address = await buildServer().listen({ host, port });
console.log(`sparrow-ax 웹 서버 시작: ${address}`);
