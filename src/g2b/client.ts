export interface G2bConfig {
  baseUrl: string;
  serviceKey: string;
}

// 포털에서 서비스마다 키를 따로 받으므로 변수도 서비스별이다 (G2B_{서비스}_SERVICE_KEY, G2B_{서비스}_BASE_URL).
export type G2bService = 'CONTRACT' | 'OPENSTD';

// 서비스키는 쿼리스트링으로 가므로 https가 아니면 평문으로 노출된다. 그 경우 호출하지 않는다.
function requireHttps(baseUrl: string): void {
  let protocol: string | undefined;
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    // 주소 형식이 아니면 아래에서 같은 오류로 거부한다.
  }
  if (protocol !== 'https:') throw new Error('나라장터 요청주소는 https여야 합니다 (.env 확인)');
}

// 서비스키는 환경변수로만 받는다. 값은 오류 메시지·로그에 절대 남기지 않는다.
export function loadG2bConfig(env: Record<string, string | undefined>, service: G2bService): G2bConfig {
  const keyVar = `G2B_${service}_SERVICE_KEY`;
  const urlVar = `G2B_${service}_BASE_URL`;
  const serviceKey = env[keyVar]?.trim();
  const baseUrl = env[urlVar]?.trim();
  if (!serviceKey) throw new Error(`${keyVar}가 설정되지 않았습니다 (.env 확인)`);
  if (!baseUrl) throw new Error(`${urlVar}가 설정되지 않았습니다 (.env 확인)`);
  requireHttps(baseUrl);
  return { baseUrl, serviceKey };
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// 리다이렉트를 따라가면 키가 붙은 주소가 다른 곳으로 갈 수 있고, 월 범위 조회는 10~24초가 걸리므로 제한 시간은 넉넉히 둔다.
const REQUEST_TIMEOUT_MS = 60_000;
const defaultFetch: FetchLike = (url) => fetch(url, { redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

export function createG2bClient(config: G2bConfig, fetchImpl: FetchLike = defaultFetch) {
  // 빈 키로 만들면 마스킹이 모든 글자 사이에 끼어들어 메시지가 망가지고 인증도 실패한다.
  if (!config.serviceKey) throw new Error('serviceKey가 비어 있습니다');
  requireHttps(config.baseUrl);
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
    // path가 절대 주소면 baseUrl이 무시되어 키가 다른 곳으로 가므로, 결과 주소가 baseUrl의 출처와 같은지 다시 확인한다.
    if (url.origin !== new URL(config.baseUrl).origin) throw new Error('요청 경로가 요청주소의 출처를 벗어났습니다');
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
