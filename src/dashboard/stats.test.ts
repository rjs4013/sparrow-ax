import assert from 'node:assert/strict';
import { test } from 'node:test';
import { byDemander, countIn, keywordCounts, keywordTrend, periodTrio, trendBuckets } from './stats.ts';

test('trendBuckets: 일 · 주(월~일) · 월 단위로 오래된 기간부터 n개를 만든다', () => {
  assert.deepEqual(trendBuckets('day', '2026-10-29', 3), [
    { label: '10-27', from: '2026-10-27', to: '2026-10-27' },
    { label: '10-28', from: '2026-10-28', to: '2026-10-28' },
    { label: '10-29', from: '2026-10-29', to: '2026-10-29' },
  ]);
  // 2026-10-29는 목요일 → 이 주는 10-26~11-01
  assert.deepEqual(trendBuckets('week', '2026-10-29', 3), [
    { label: '10-12~', from: '2026-10-12', to: '2026-10-18' },
    { label: '10-19~', from: '2026-10-19', to: '2026-10-25' },
    { label: '10-26~', from: '2026-10-26', to: '2026-11-01' },
  ]);
  assert.deepEqual(trendBuckets('month', '2026-10-29', 3), [
    { label: '2026-08', from: '2026-08-01', to: '2026-08-31' },
    { label: '2026-09', from: '2026-09-01', to: '2026-09-30' },
    { label: '2026-10', from: '2026-10-01', to: '2026-10-31' },
  ]);
  // 연도 경계
  assert.deepEqual(trendBuckets('month', '2027-01-15', 2).map((b) => b.label), ['2026-12', '2027-01']);
});

test('countIn: 기간(양끝 포함) 안의 항목 수', () => {
  const items = [{ date: '2026-10-01' }, { date: '2026-10-15' }, { date: '2026-10-31' }, { date: '2026-11-01' }, { date: '2026-09-30' }];
  assert.equal(countIn(items, { from: '2026-10-01', to: '2026-10-31' }), 3);
  assert.equal(countIn(items, { from: '2026-12-01', to: '2026-12-31' }), 0);
});

test('periodTrio: 고른 날짜 기준 일 · 주 · 월 건수', () => {
  const items = ['2026-10-29', '2026-10-29', '2026-10-27', '2026-10-05', '2026-09-30'].map((date) => ({ date }));
  assert.deepEqual(periodTrio(items, '2026-10-29'), { day: 2, week: 3, month: 4 });
});

test('byDemander: 입찰공고 · 낙찰 건수를 수요기관별로 합쳐 많은 순으로, 상위 limit곳 + 나머지', () => {
  const bids = [{ demander: 'A' }, { demander: 'A' }, { demander: 'B' }, { demander: 'C' }, { demander: 'D' }];
  const awards = [{ demander: 'B' }, { demander: 'B' }, { demander: 'E' }];
  const r = byDemander(bids, awards, 2);
  assert.deepEqual(r.rows, [{ name: 'B', bids: 1, awards: 2 }, { name: 'A', bids: 2, awards: 0 }]);
  // 나머지: C(1,0) D(1,0) E(0,1)
  assert.deepEqual(r.others, { orgs: 3, bids: 2, awards: 1 });
  assert.deepEqual(byDemander([], [], 5), { rows: [], others: { orgs: 0, bids: 0, awards: 0 } });
});

test('byDemander: 건수가 같으면 이름순, 이름이 빈 수요처는 "(수요처 없음)"으로 묶는다', () => {
  const r = byDemander([{ demander: '나' }, { demander: '가' }, { demander: '' }], [], 10);
  assert.deepEqual(r.rows.map((x) => x.name), ['(수요처 없음)', '가', '나']);
});

test('keywordCounts: 설정 키워드 순서로 세고, 설정에 없는 키워드는 무시한다', () => {
  const items = [{ keywords: ['솔루션', '컨설팅'] }, { keywords: ['솔루션'] }, { keywords: ['AI'] }, { keywords: [] }];
  assert.deepEqual(keywordCounts(items, ['컨설팅', '솔루션', 'SBOM']), [
    { keyword: '컨설팅', count: 1 }, { keyword: '솔루션', count: 2 }, { keyword: 'SBOM', count: 0 },
  ]);
});

test('keywordTrend: 기간별 키워드 건수와 합계 (합계 많은 순, 발생 없는 키워드는 뺀다)', () => {
  const buckets = trendBuckets('day', '2026-10-29', 3);
  const items = [
    { date: '2026-10-27', keywords: ['솔루션'] },
    { date: '2026-10-28', keywords: ['솔루션', '컨설팅'] },
    { date: '2026-10-29', keywords: ['컨설팅'] },
    { date: '2026-10-29', keywords: ['컨설팅', 'AI'] },
    { date: '2026-10-20', keywords: ['솔루션'] }, // 기간 밖
  ];
  const trend = keywordTrend(items, ['솔루션', '컨설팅', 'SBOM'], buckets);
  assert.deepEqual(trend, [
    { keyword: '컨설팅', counts: [0, 1, 2], total: 3 },
    { keyword: '솔루션', counts: [1, 1, 0], total: 2 },
  ]);
});
