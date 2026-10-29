// 응답 문자열을 숫자로. 쉼표를 지우고, 비었거나 숫자가 아니면 null이다.
export function toNumber(text: string): number | null {
  const s = text.replaceAll(',', '').trim();
  const n = s === '' ? NaN : Number(s);
  return Number.isFinite(n) ? n : null;
}
