// 경쟁사 계약 수집 명령 (결정 14 하이브리드). 같은 구간을 다시 돌려도 안전하다(통합계약번호 + 업체 id로 갱신).
//   백필(처음 한 번, 체결일자 방식):  npm run collect -- --mode backfill --from 2026-01-01 --to 2026-10-28
//   매일 증분(등록일시 방식, 매일 새벽):  npm run collect -- --mode daily [--from 2026-10-27]  (--from: 그 날부터 다시 받음)
//   교차 검증(주 1회, 체결일자 방식):    npm run collect -- --mode verify [--days 14]
//   납품요구(쇼핑몰, 실제 수요기관 · 금액) 백필:  npm run collect -- --mode dlvr-backfill --from 2026-01-01 --to 2026-10-28
//   납품요구 매일(접수일자 방식):             npm run collect -- --mode dlvr-daily
//   입찰공고(개방표준) 매일(공고일시 방식):     npm run collect -- --mode bid-daily [--from 2026-10-20]  (--from: 그 날부터 다시 받음)
// 호출 횟수는 --max-calls로 제한한다(기본: 백필 40, 매일 80, 교차 검증 40, 납품요구 백필 40, 납품요구 매일 20, 입찰공고 매일 40).
import { parseArgs } from 'node:util';
import { openDb, migrate } from '../db/index.ts';
import { loadBidConfig } from '../filters/bids.ts';
import { createMatcher, loadMonitoringConfig } from '../filters/contracts.ts';
import { addDays, collectionRange, todayKst } from '../filters/dates.ts';
import { createG2bClient, loadG2bConfig } from '../g2b/client.ts';
import { runBidDaily, runCollection, runDaily, runDeliveryBackfill, runDeliveryDaily, runVerify } from './run.ts';

const { values } = parseArgs({
  options: {
    mode: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, days: { type: 'string' }, 'max-calls': { type: 'string' },
  },
});

const mode = values.mode ?? 'backfill';
const MODES = ['backfill', 'daily', 'verify', 'dlvr-backfill', 'dlvr-daily', 'bid-daily'] as const;
if (!(MODES as readonly string[]).includes(mode)) throw new Error(`--mode는 ${MODES.join(' | ')} 중 하나여야 합니다: ${mode}`);
const today = todayKst();
// 모드와 맞지 않는 옵션은 조용히 무시하지 않고 알린다.
const unsupported = ({ backfill: ['days'], daily: ['to', 'days'], verify: ['from', 'to'], 'dlvr-backfill': ['days'], 'dlvr-daily': ['from', 'to', 'days'], 'bid-daily': ['to', 'days'] } as Record<string, ('from' | 'to' | 'days')[]>)[mode]!;
for (const name of unsupported) if (values[name] !== undefined) throw new Error(`--${name}은 --mode ${mode}에서 쓸 수 없습니다`);

const maxCalls = Number(values['max-calls'] ?? (mode === 'daily' ? 80 : mode === 'dlvr-daily' ? 20 : 40));
// 일일 한도가 오퍼레이션당 1000회이므로 그 이하로만 허용한다.
if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 1000) throw new Error('--max-calls는 1 이상 1000 이하의 정수여야 합니다');

const db = openDb(process.env['DB_PATH'] || 'data/sparrow.db');
migrate(db);
// 계약정보(계약) · 나라장터쇼핑몰(납품요구) · 개방표준(입찰공고)은 서비스키 · 주소가 다르다.
const client = createG2bClient(loadG2bConfig(process.env, mode.startsWith('dlvr') ? 'SHOPPING' : mode.startsWith('bid') ? 'OPENSTD' : 'CONTRACT'));
const matcher = createMatcher(loadMonitoringConfig());
const log = (m: string) => console.log(`  ${m}`);

let ok: boolean;
if (mode === 'backfill') {
  const defaults = collectionRange(null, today);
  const from = values.from ?? defaults?.from;
  const to = values.to ?? defaults?.to;
  if (from === undefined || to === undefined) throw new Error('수집할 기간이 없습니다. --from 과 --to 를 지정하세요');
  addDays(from, 0); // 형식 검증 (잘못되면 오류)
  addDays(to, 0);
  if (from > to) throw new Error(`--from(${from})이 --to(${to})보다 늦습니다`);
  console.log(`백필 시작: ${from} ~ ${to} (호출 상한 ${maxCalls}회)`);
  const r = await runCollection({ db, client, matcher, range: { from, to }, maxCalls, log });
  console.log(r.status === 'success' ? `완료: 수신 ${r.fetched}건 중 9개사 계약 ${r.matched}건 저장, 호출 ${r.calls}회` : `실패: ${r.error} (호출 ${r.calls}회)`);
  ok = r.status === 'success';
} else if (mode === 'daily') {
  if (values.from !== undefined) addDays(values.from, 0); // 형식 검증
  console.log(`매일 증분 시작${values.from === undefined ? '' : ` (${values.from}부터 다시)`} (호출 상한 ${maxCalls}회)`);
  const r = await runDaily({ db, client, matcher, today, maxCalls, log, ...(values.from === undefined ? {} : { from: values.from }) });
  console.log(
    r.status === 'success'
      ? `완료: ${r.days}일 처리, 수신 ${r.fetched}건 중 9개사 계약 ${r.matched}건 저장, 호출 ${r.calls}회`
      : `실패: ${r.error} (${r.days}일 처리 후 중단, 호출 ${r.calls}회). 다음 실행이 실패한 날부터 이어 갑니다`,
  );
  ok = r.status === 'success';
} else if (mode === 'dlvr-backfill') {
  const defaults = collectionRange(null, today);
  const from = values.from ?? defaults?.from;
  const to = values.to ?? defaults?.to;
  if (from === undefined || to === undefined) throw new Error('수집할 기간이 없습니다. --from 과 --to 를 지정하세요');
  addDays(from, 0);
  addDays(to, 0);
  if (from > to) throw new Error(`--from(${from})이 --to(${to})보다 늦습니다`);
  console.log(`납품요구 백필 시작: ${from} ~ ${to} (호출 상한 ${maxCalls}회)`);
  const r = await runDeliveryBackfill({ db, client, matcher, range: { from, to }, maxCalls, log });
  console.log(r.status === 'success' ? `완료: 수신 ${r.fetched}행 중 9개사 납품요구 ${r.matched}행 저장, 호출 ${r.calls}회` : `실패: ${r.error} (호출 ${r.calls}회)`);
  ok = r.status === 'success';
} else if (mode === 'bid-daily') {
  if (values.from !== undefined) addDays(values.from, 0); // 형식 검증
  console.log(`입찰공고 매일 수집 시작${values.from === undefined ? '' : ` (${values.from}부터 다시)`} (호출 상한 ${maxCalls}회)`);
  const r = await runBidDaily({ db, client, keywords: loadBidConfig().keywords, today, maxCalls, log, ...(values.from === undefined ? {} : { from: values.from }) });
  console.log(
    r.status === 'success' && r.days === 0
      ? '완료: 받을 날이 없습니다(어제까지 이미 수집했거나 --from이 어제보다 늦습니다)'
      : r.status === 'success'
      ? `완료: ${r.days}일 처리, 수신 ${r.fetched}건 중 키워드 적중 ${r.matched}건 저장, 호출 ${r.calls}회`
      : `실패: ${r.error} (${r.days}일 처리 후 중단, 호출 ${r.calls}회). 다음 실행이 실패한 날부터 이어 갑니다`,
  );
  ok = r.status === 'success';
} else if (mode === 'dlvr-daily') {
  console.log(`납품요구 매일 수집 시작 (호출 상한 ${maxCalls}회)`);
  const r = await runDeliveryDaily({ db, client, matcher, today, maxCalls, log });
  console.log(r.status === 'success' ? `완료: 수신 ${r.fetched}행 중 9개사 납품요구 ${r.matched}행 저장, 호출 ${r.calls}회` : `실패: ${r.error} (호출 ${r.calls}회)`);
  ok = r.status === 'success';
} else {
  const days = Number(values.days ?? 14);
  // 등록이 체결 후 최대 7일(관측 한계 8일) 늦어질 수 있어 그보다 짧으면 검증 효력이 없다.
  if (!Number.isInteger(days) || days < 8 || days > 62) throw new Error('--days는 8 이상 62 이하의 정수여야 합니다');
  console.log(`교차 검증 시작: 최근 ${days}일 (호출 상한 ${maxCalls}회)`);
  const r = await runVerify({ db, client, matcher, today, days, maxCalls, log });
  console.log(
    r.status === 'success'
      ? `완료: 수신 ${r.fetched}건 중 9개사 계약 ${r.matched}건 확인, 새로 찾은 계약 ${r.newlyFound}건, 호출 ${r.calls}회`
      : `실패: ${r.error} (호출 ${r.calls}회)`,
  );
  ok = r.status === 'success';
}
process.exitCode = ok ? 0 : 1;
