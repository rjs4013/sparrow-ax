// 날짜는 'YYYY-MM-DD' 문자열로 다룬다. 계산은 UTC 기준 달력 연산이라 실행 PC의 시간대와 무관하다.
export type IsoDate = string;

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function toUtcMs(date: IsoDate): number {
  const m = ISO.exec(date);
  if (!m) throw new Error(`날짜 형식이 올바르지 않습니다 (YYYY-MM-DD): ${date}`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // 2026-02-30 같은 존재하지 않는 날짜는 Date가 보정해 버리므로 되돌려 비교한다.
  if (fromUtcMs(ms) !== date) throw new Error(`존재하지 않는 날짜입니다: ${date}`);
  return ms;
}

function fromUtcMs(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromUtcMs(toUtcMs(date) + days * 86_400_000);
}

// from부터 to까지(양끝 포함) 하루씩. from이 to보다 늦으면 빈 배열.
// API 일일 호출 한도 때문에 수집기는 이 단위로 나눠 호출한다.
export function eachDay(from: IsoDate, to: IsoDate): IsoDate[] {
  const days: IsoDate[] = [];
  for (let d = from; toUtcMs(d) <= toUtcMs(to); d = addDays(d, 1)) days.push(d);
  return days;
}

// 한국 시간 기준의 오늘 날짜. 한국은 일광절약시간이 없어 UTC+9 고정이라 ICU 로케일 출력에 기대지 않는다.
export function todayKst(now: Date = new Date()): IsoDate {
  return fromUtcMs(now.getTime() + 9 * 3_600_000);
}

// 이번 실행에서 수집할 납품요구일자 범위(양끝 포함). 수집할 날이 없으면 null.
// - 마지막 성공 수집일이 있으면 그 다음 날부터 어제까지 (주말 · 실패한 날을 자동 보충)
// - 없으면(첫 실행) 올해 1월 1일부터 어제까지. 오늘이 1월 1일이면 어제(작년 12월 31일) 하루.
export function collectionRange(
  lastSuccess: IsoDate | null,
  today: IsoDate,
): { from: IsoDate; to: IsoDate } | null {
  const todayMs = toUtcMs(today);
  // 마지막 성공일이 오늘보다 미래면 "수집할 날 없음"과 구별되는 시계 · 저장값 오류다.
  if (lastSuccess !== null && toUtcMs(lastSuccess) > todayMs) {
    throw new Error(`마지막 성공 수집일(${lastSuccess})이 오늘(${today})보다 미래입니다. 시계나 저장된 값을 확인하세요`);
  }
  const yesterday = addDays(today, -1);
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const from = lastSuccess === null ? (yearStart < yesterday ? yearStart : yesterday) : addDays(lastSuccess, 1);
  return from > yesterday ? null : { from, to: yesterday };
}

// 기간을 달력 월 조각으로 나눈다. 체결일자 검색(PPSSrch)은 기간이 길면(3개월) 거절되고 28~31일은 통과한다.
export function monthRanges(from: IsoDate, to: IsoDate): { from: IsoDate; to: IsoDate }[] {
  const ranges: { from: IsoDate; to: IsoDate }[] = [];
  let start = from;
  while (toUtcMs(start) <= toUtcMs(to)) {
    const end = monthEnd(start);
    ranges.push({ from: start, to: end < to ? end : to });
    start = addDays(end, 1);
  }
  return ranges;
}

function monthEnd(date: IsoDate): IsoDate {
  const [y, m] = [Number(date.slice(0, 4)), Number(date.slice(5, 7))];
  return fromUtcMs(Date.UTC(y, m, 1) - 86_400_000);
}

export type PeriodView = 'day' | 'week' | 'month';

// 화면의 조회 기간. 주는 월요일~일요일, 월은 1일~말일.
export function periodRange(view: PeriodView, date: IsoDate): { from: IsoDate; to: IsoDate } {
  if (view === 'day') return { from: date, to: date };
  if (view === 'week') {
    const from = addDays(date, -((new Date(toUtcMs(date)).getUTCDay() + 6) % 7));
    return { from, to: addDays(from, 6) };
  }
  return { from: `${date.slice(0, 7)}-01`, to: monthEnd(date) };
}

// 이전(-1) · 다음(1) 기간의 기준일. 월은 항상 그 달 1일을 돌려준다.
export function shiftPeriod(view: PeriodView, date: IsoDate, direction: -1 | 1): IsoDate {
  if (view === 'day') return addDays(date, direction);
  if (view === 'week') return addDays(date, 7 * direction);
  const first = `${date.slice(0, 7)}-01`;
  return direction === 1 ? addDays(monthEnd(first), 1) : `${addDays(first, -1).slice(0, 7)}-01`;
}
