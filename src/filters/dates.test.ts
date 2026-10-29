import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, collectionRange, eachDay, todayKst, monthRanges, periodRange, shiftPeriod } from './dates.ts';

test('마지막 성공일 다음 날부터 어제까지: 월요일 실행은 주말을 포함한다', () => {
  // 2026-10-23(금) 성공, 2026-10-26(월) 실행
  assert.deepEqual(collectionRange('2026-10-23', '2026-10-26'), { from: '2026-10-24', to: '2026-10-25' });
});

test('어제까지 이미 수집했으면 수집할 날이 없다', () => {
  assert.equal(collectionRange('2026-10-27', '2026-10-28'), null);
  assert.equal(collectionRange('2026-10-28', '2026-10-28'), null);
});

test('실패해서 며칠 밀린 경우 밀린 날을 모두 보충한다', () => {
  assert.deepEqual(collectionRange('2026-10-20', '2026-10-28'), { from: '2026-10-21', to: '2026-10-27' });
});

test('첫 실행은 올해 1월 1일부터 어제까지', () => {
  assert.deepEqual(collectionRange(null, '2026-10-28'), { from: '2026-01-01', to: '2026-10-27' });
  assert.deepEqual(collectionRange(null, '2026-01-02'), { from: '2026-01-01', to: '2026-01-01' });
});

test('첫 실행이 1월 1일이면 작년 12월 31일 하루만', () => {
  assert.deepEqual(collectionRange(null, '2026-01-01'), { from: '2025-12-31', to: '2025-12-31' });
});

test('연말 · 윤년 경계의 날짜 계산', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2025-02-28', 1), '2025-03-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('형식이 틀리거나 존재하지 않는 날짜는 오류', () => {
  for (const bad of ['2026-2-1', '20261028', '2026-13-01', '2026-02-30', '', 'abc']) {
    assert.throws(() => addDays(bad, 1), Error, bad);
  }
  assert.throws(() => collectionRange(null, '2026-02-30'));
  assert.throws(() => collectionRange('2026-10-xx', '2026-10-28'));
});

test('eachDay는 양끝을 포함하고, 거꾸로면 빈 배열', () => {
  assert.deepEqual(eachDay('2026-10-24', '2026-10-26'), ['2026-10-24', '2026-10-25', '2026-10-26']);
  assert.deepEqual(eachDay('2026-10-24', '2026-10-24'), ['2026-10-24']);
  assert.deepEqual(eachDay('2026-10-26', '2026-10-24'), []);
});

test('todayKst는 한국 시간 기준 날짜다', () => {
  assert.equal(todayKst(new Date('2026-10-27T14:59:59Z')), '2026-10-27');
  assert.equal(todayKst(new Date('2026-10-27T15:00:00Z')), '2026-10-28');
  assert.equal(todayKst(new Date('2026-12-31T15:00:00Z')), '2027-01-01');
  assert.equal(todayKst(new Date('2024-02-28T15:00:00Z')), '2024-02-29');
});

test('마지막 성공일이 오늘보다 미래면 "수집할 날 없음"이 아니라 오류', () => {
  assert.throws(() => collectionRange('2026-10-29', '2026-10-28'), /미래/);
  assert.throws(() => collectionRange('2027-01-01', '2026-10-28'), /미래/);
  assert.equal(collectionRange('2026-10-28', '2026-10-28'), null); // 오늘과 같으면 조용히 없음
});

test('monthRanges는 기간을 달력 월 조각으로 나눈다 (API 기간 상한 대응)', () => {
  assert.deepEqual(monthRanges('2026-01-01', '2026-01-31'), [{ from: '2026-01-01', to: '2026-01-31' }]);
  assert.deepEqual(monthRanges('2026-01-15', '2026-03-10'), [
    { from: '2026-01-15', to: '2026-01-31' },
    { from: '2026-02-01', to: '2026-02-28' },
    { from: '2026-03-01', to: '2026-03-10' },
  ]);
  assert.deepEqual(monthRanges('2028-02-27', '2028-03-01'), [
    { from: '2028-02-27', to: '2028-02-29' },
    { from: '2028-03-01', to: '2028-03-01' },
  ]);
  assert.deepEqual(monthRanges('2026-12-30', '2027-01-02'), [
    { from: '2026-12-30', to: '2026-12-31' },
    { from: '2027-01-01', to: '2027-01-02' },
  ]);
  assert.deepEqual(monthRanges('2026-02-02', '2026-02-01'), []);
});

test('periodRange: 일 · 주(월~일) · 월', () => {
  assert.deepEqual(periodRange('day', '2026-10-29'), { from: '2026-10-29', to: '2026-10-29' });
  // 2026-10-29는 목요일
  assert.deepEqual(periodRange('week', '2026-10-29'), { from: '2026-10-26', to: '2026-11-01' });
  assert.deepEqual(periodRange('week', '2026-10-26'), { from: '2026-10-26', to: '2026-11-01' });
  assert.deepEqual(periodRange('week', '2026-11-01'), { from: '2026-10-26', to: '2026-11-01' });
  assert.deepEqual(periodRange('month', '2026-02-10'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(periodRange('month', '2028-02-10'), { from: '2028-02-01', to: '2028-02-29' });
});

test('shiftPeriod: 이전 · 다음 기간으로 이동 (월은 말일 보정 없이 1일 기준)', () => {
  assert.equal(shiftPeriod('day', '2026-10-29', -1), '2026-10-28');
  assert.equal(shiftPeriod('week', '2026-10-29', 1), '2026-11-05');
  assert.equal(shiftPeriod('month', '2026-03-31', -1), '2026-02-01');
  assert.equal(shiftPeriod('month', '2026-12-15', 1), '2027-01-01');
  assert.equal(shiftPeriod('month', '2026-01-15', -1), '2025-12-01');
});
