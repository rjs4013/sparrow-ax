export interface G2bConfig {
  baseUrl: string;
  serviceKey: string;
}

// 서비스키는 환경변수로만 받는다. 값은 오류 메시지·로그에 절대 남기지 않는다.
export function loadG2bConfig(env: Record<string, string | undefined>): G2bConfig {
  const serviceKey = env['G2B_SERVICE_KEY']?.trim();
  const baseUrl = env['G2B_BASE_URL']?.trim();
  if (!serviceKey) throw new Error('G2B_SERVICE_KEY가 설정되지 않았습니다 (.env 확인)');
  if (!baseUrl) throw new Error('G2B_BASE_URL이 설정되지 않았습니다 (.env 확인)');
  return { baseUrl, serviceKey };
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function createG2bClient(config: G2bConfig, fetchImpl: FetchLike = fetch) {
  // 빈 키로 만들면 마스킹이 모든 글자 사이에 끼어들어 메시지가 망가지고 인증도 실패한다.
  if (!config.serviceKey) throw new Error('serviceKey가 비어 있습니다');
  // URL 직렬화는 키를 퍼센트 인코딩하므로 원문과 인코딩된 형태를 모두 마스킹한다.
  const keyForms = [
    config.serviceKey,
    encodeURIComponent(config.serviceKey),
    new URLSearchParams({ k: config.serviceKey }).toString().slice(2),
  ];
  const redact = (text: string) => keyForms.reduce((t, form) => t.split(form).join('***'), text);

  function build(path: string, params: Record<string, string | number>, key: string): string {
    const url = new URL(path.replace(/^\//, ''), config.baseUrl.replace(/\/?$/, '/'));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    url.searchParams.set('serviceKey', key);
    url.searchParams.set('type', 'json');
    return url.toString();
  }

  // 서비스키가 들어 있는 URL을 반환한다. 호출자는 이 값을 로그나 메시지에 쓰지 않는다.
  function buildUrl(path: string, params: Record<string, string | number> = {}): string {
    return build(path, params, config.serviceKey);
  }

  async function get(path: string, params: Record<string, string | number> = {}): Promise<unknown> {
    let res;
    try {
      res = await fetchImpl(buildUrl(path, params));
    } catch (err) {
      throw new Error(redact(`나라장터 API 호출 실패: ${err instanceof Error ? err.message : String(err)}`));
    }
    // 오류 메시지에는 키가 없는 URL만 쓴다.
    if (!res.ok) throw new Error(`나라장터 API 응답 오류 ${res.status}: ${build(path, params, '***')}`);
    try {
      return await res.json();
    } catch (err) {
      throw new Error(redact(`나라장터 API 응답을 JSON으로 읽지 못했습니다: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  return { buildUrl, get };
}
