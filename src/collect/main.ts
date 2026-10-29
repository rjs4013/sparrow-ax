// 경쟁사 계약 수집(체결일자 방식 백필) 명령. 실행: npm run collect -- --from 2026-01-01 --to 2026-10-28
// 같은 기간을 다시 돌려도 안전하다(통합계약번호 + 업체 id로 갱신). 호출 횟수는 --max-calls로 제한한다.
import { parseArgs } from 'node:util';
import { openDb, migrate } from '../db/index.ts';
import { createMatcher, loadMonitoringConfig } from '../filters/contracts.ts';
import { addDays, collectionRange, todayKst } from '../filters/dates.ts';
import { createG2bClient, loadG2bConfig } from '../g2b/client.ts';
import { runCollection } from './run.ts';

const { values } = parseArgs({
  options: { from: { type: 'string' }, to: { type: 'string' }, 'max-calls': { type: 'string' } },
});

const today = todayKst();
const defaults = collectionRange(null, today);
const from = values.from ?? defaults?.from;
const to = values.to ?? defaults?.to;
if (from === undefined || to === undefined) throw new Error('수집할 기간이 없습니다. --from 과 --to 를 지정하세요');
addDays(from, 0); // 형식 검증 (잘못되면 오류)
addDays(to, 0);
if (from > to) throw new Error(`--from(${from})이 --to(${to})보다 늦습니다`);
const maxCalls = Number(values['max-calls'] ?? 40);
// 일일 한도가 오퍼레이션당 1000회이므로 그 이하로만 허용한다.
if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 1000) throw new Error('--max-calls는 1 이상 1000 이하의 정수여야 합니다');

const db = openDb(process.env['DB_PATH'] || 'data/sparrow.db');
migrate(db);
const client = createG2bClient(loadG2bConfig(process.env, 'CONTRACT'));

console.log(`수집 시작: ${from} ~ ${to} (호출 상한 ${maxCalls}회)`);
const result = await runCollection({
  db, client, matcher: createMatcher(loadMonitoringConfig()), range: { from, to }, maxCalls, log: (m) => console.log(`  ${m}`),
});
console.log(
  result.status === 'success'
    ? `완료: 수신 ${result.fetched}건 중 9개사 계약 ${result.matched}건 저장, 호출 ${result.calls}회`
    : `실패: ${result.error} (호출 ${result.calls}회)`,
);
process.exitCode = result.status === 'success' ? 0 : 1;
