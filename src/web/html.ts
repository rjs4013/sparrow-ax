// 화면 공용 도우미. 계약명 · 업체명 등은 외부(나라장터) 데이터이므로 모두 이스케이프해서 출력한다.
export const esc = (v: string | number): string =>
  String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const won = (n: number | null): string => (n === null ? '-' : n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','));
