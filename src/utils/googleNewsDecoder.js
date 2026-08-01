/**
 * 구글 뉴스 RSS의 리다이렉트 링크(news.google.com/rss/articles/CBMi...)를
 * 실제 원본 기사 URL로 디코딩한다.
 *
 * 참고: 옛날 구글 뉴스 링크는 URL을 단순 Base64로 인코딩했지만, 지금 형태(CBMi...로 시작하는
 * 긴 문자열)는 구글 내부 protobuf 포맷이라 Base64 디코딩으로는 원본 URL이 나오지 않는다
 * (직접 디코딩해보면 사람이 읽을 수 없는 바이너리가 나옴). 그래서 구글이 공식 문서화하지 않은
 * 내부 batchexecute API를 호출하는 방식(커뮤니티에서 리버스 엔지니어링됨)을 쓴다.
 *
 * 실패할 수 있다는 전제로 항상 안전하게 폴백하도록 작성했다:
 * 0) (설정된 경우) NAS 등 가정용 IP에서 돌아가는 전용 릴레이 서버 경유 시도 → 실패 시
 * 1) batchexecute API 직접 호출 시도 → 실패 시
 * 2) 일반 HTTP 리다이렉트를 그냥 따라가 보기(가끔 통할 때가 있음) → 그래도 실패 시
 * 3) 원본 구글 링크 그대로 반환
 *
 * 0)이 있는 이유: 구글이 Cloudflare Workers의 IP 대역에서 오는 news.google.com 요청을
 * 차단한다(실측 확인 — 503 응답, 같은 헤더로 일반 IP에서 보내면 정상 동작함). 그래서 1)/2)는
 * Worker에서 직접 실행하면 사실상 항상 실패하고, 0)이 설정돼 있으면 그게 주로 쓰이게 된다.
 * 0)이 설정 안 돼 있거나(env.DECODE_PROXY_URL 없음) 실패하면 그대로 1)/2)/3)으로 넘어간다.
 *
 * 호출 비용이 있으므로(요청 여러 번) 브라우즈 화면 전체 기사가 아니라 "스크랩" 시점에만 사용한다.
 * @param {string} googleUrl
 * @param {{DECODE_PROXY_URL?: string, DECODE_PROXY_TOKEN?: string}} [env]
 */
export async function decodeGoogleNewsUrl(googleUrl, env = {}) {
  try {
    if (!googleUrl) return googleUrl;

    const url = new URL(googleUrl);
    if (!isGoogleNewsHost(url.hostname)) return googleUrl;

    if (env.DECODE_PROXY_URL) {
      const viaNas = await decodeViaNasProxy(googleUrl, env);
      if (viaNas) return normalizeUrl(viaNas);
    }

    const gnArtId = extractGoogleNewsArticleId(url);
    if (!gnArtId) {
      console.log('[decodeGoogleNewsUrl] gn_art_id 추출 실패:', url.pathname);
    }

    const viaBatchExecute = gnArtId ? await decodeViaBatchExecute(gnArtId) : null;
    if (viaBatchExecute) return normalizeUrl(viaBatchExecute);

    const viaHtml = await decodeViaHtmlFallback(googleUrl, gnArtId);
    if (viaHtml) return normalizeUrl(viaHtml);

    const viaRedirect = await decodeViaHttpRedirect(googleUrl);
    if (viaRedirect) return normalizeUrl(viaRedirect);

    return googleUrl;
  } catch (err) {
    console.log('[decodeGoogleNewsUrl] 예외 발생:', String(err));
    return googleUrl;
  }
}

/** 0차 시도: NAS 등 가정용 IP에서 돌아가는 전용 릴레이 서버(nas-decode-server) 경유 */
async function decodeViaNasProxy(googleUrl, env) {
  try {
    const proxyUrl = new URL(env.DECODE_PROXY_URL);
    proxyUrl.searchParams.set('url', googleUrl);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(proxyUrl.toString(), {
        headers: env.DECODE_PROXY_TOKEN ? { Authorization: `Bearer ${env.DECODE_PROXY_TOKEN}` } : {},
        signal: controller.signal,
      });
      if (!res.ok) {
        console.log('[decodeGoogleNewsUrl] NAS 프록시 실패, status:', res.status);
        return null;
      }
      const data = await res.json();
      if (data?.url && typeof data.url === 'string' && data.url.startsWith('http')) {
        console.log('[decodeGoogleNewsUrl] NAS 프록시 성공:', data.url);
        return data.url;
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.log('[decodeGoogleNewsUrl] NAS 프록시 예외:', String(err));
    return null;
  }
}

function isGoogleNewsHost(hostname) {
  return hostname === 'news.google.com' || hostname === 'news.google.co.kr' || hostname.endsWith('.news.google.com');
}

function extractGoogleNewsArticleId(url) {
  const pathParts = url.pathname.split('/').filter(Boolean);

  for (let i = 0; i < pathParts.length - 1; i += 1) {
    if (pathParts[i] === 'articles' && pathParts[i + 1]) {
      return pathParts[i + 1];
    }
  }

  const fallback = pathParts[pathParts.length - 1];
  return fallback && !['rss', 'articles'].includes(fallback) ? fallback : null;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 실제 RSS 수집(rss.js)에서 효과가 있었던 것과 동일한 브라우저 위장 헤더 */
const BROWSER_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  Referer: 'https://www.google.com/',
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Upgrade-Insecure-Requests': '1',
};

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 재시도 포함 fetch — 429/5xx면 최대 3번, 지수 백오프(0.5s, 1.5s)로 재시도 */
async function fetchWithRetry(url, options, maxAttempts = 3) {
  let lastRes = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, options);
    if (res.ok) return res;
    lastRes = res;
    if (!RETRYABLE_STATUS.has(res.status) || attempt === maxAttempts) return res;
    console.log(`[decodeGoogleNewsUrl] status ${res.status}, ${attempt}번째 시도 실패 — 재시도`);
    await sleep(500 * Math.pow(3, attempt - 1));
  }
  return lastRes;
}

/** 1차 시도: 구글 내부 batchexecute API */
async function decodeViaBatchExecute(gnArtId) {
  // 1) 기사 페이지에서 서명(signature)/타임스탬프 추출
  const paramsRes = await fetchWithRetry(`https://news.google.com/rss/articles/${gnArtId}`, {
    headers: BROWSER_HEADERS,
  });
  if (!paramsRes.ok) {
    console.log('[decodeGoogleNewsUrl] 1단계 실패, status:', paramsRes.status);
    return null;
  }
  const html = await paramsRes.text();

  const sigMatch = html.match(/data-n-a-sg="([^"]+)"/);
  const tsMatch = html.match(/data-n-a-ts="([^"]+)"/);
  if (!sigMatch || !tsMatch) {
    console.log('[decodeGoogleNewsUrl] signature/timestamp 못 찾음. html 길이:', html.length);
    return null;
  }
  const signature = sigMatch[1];
  const timestamp = tsMatch[1];

  // 2) 구글 내부 batchexecute API 호출해서 실제 URL 요청
  const innerReq =
    '["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],' +
    `"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${gnArtId}",${timestamp},"${signature}"]`;
  const payload = [[['Fbv4je', innerReq]]];
  const body = 'f.req=' + encodeURIComponent(JSON.stringify(payload));

  const execRes = await fetchWithRetry('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST',
    headers: {
      ...BROWSER_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body,
  });
  if (!execRes.ok) {
    console.log('[decodeGoogleNewsUrl] 2단계 실패, status:', execRes.status);
    return null;
  }

  const text = await execRes.text();
  const decodedUrl = parseBatchExecuteResponse(text);
  if (decodedUrl && decodedUrl.startsWith('http')) {
    console.log('[decodeGoogleNewsUrl] batchexecute 성공:', decodedUrl);
    return decodedUrl;
  }
  console.log('[decodeGoogleNewsUrl] 응답 파싱 실패. 응답 앞부분:', text.slice(0, 200));
  return null;
}

/** 2차 폴백: 그냥 HTTP 리다이렉트를 따라가서 최종 도착지를 본다 (가끔 통함) */
async function decodeViaHtmlFallback(googleUrl, gnArtId) {
  const targetUrl = gnArtId ? `https://news.google.com/rss/articles/${gnArtId}` : googleUrl;

  try {
    const res = await fetchWithRetry(targetUrl, {
      headers: BROWSER_HEADERS,
    });
    if (!res.ok) return null;

    const html = await res.text();
    const urls = extractCandidateUrlsFromHtml(html);
    for (const candidate of urls) {
      if (candidate.startsWith('http') && !isGoogleNewsHost(new URL(candidate).hostname)) {
        console.log('[decodeGoogleNewsUrl] HTML fallback 성공:', candidate);
        return candidate;
      }
    }
    return null;
  } catch (err) {
    console.log('[decodeGoogleNewsUrl] HTML fallback 실패:', String(err));
    return null;
  }
}

async function decodeViaHttpRedirect(googleUrl) {
  try {
    const res = await fetch(googleUrl, {
      headers: BROWSER_HEADERS,
      redirect: 'manual',
    });

    const location = res.headers.get('location');
    if (location) {
      const resolved = new URL(location, googleUrl).toString();
      if (!isGoogleNewsHost(new URL(resolved).hostname)) {
        console.log('[decodeGoogleNewsUrl] HTTP 리다이렉트 폴백 성공:', resolved);
        return resolved;
      }
    }

    if (res.url && !isGoogleNewsHost(new URL(res.url).hostname)) {
      console.log('[decodeGoogleNewsUrl] HTTP 리다이렉트 폴백 성공:', res.url);
      return res.url;
    }
    return null;
  } catch (err) {
    console.log('[decodeGoogleNewsUrl] 리다이렉트 폴백 실패:', String(err));
    return null;
  }
}

function extractCandidateUrlsFromHtml(html) {
  const candidates = [];
  const seen = new Set();
  const patterns = [
    /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/gi,
    /(?:data-url|href)=["']([^"']+)["']/gi,
  ];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const rawValue = match[1];
      if (!rawValue) continue;
      const decoded = decodeHtmlEntities(rawValue).trim();
      if (!decoded.startsWith('http')) continue;
      if (!seen.has(decoded)) {
        seen.add(decoded);
        candidates.push(decoded);
      }
    }
  }

  return candidates;
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** 추적용 쿼리 파라미터(utm_* 등)를 제거해서 URL을 정규화 */
const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'oc',
];

function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    for (const param of TRACKING_PARAMS) {
      u.searchParams.delete(param);
    }
    // 트레일링 슬래시 통일 (루트 경로 제외)
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return rawUrl; // 파싱 자체가 안 되면 원본 그대로 (안전)
  }
}

/** batchexecute 응답(특유의 이중 JSON 포맷)에서 실제 URL만 뽑아낸다 */
function parseBatchExecuteResponse(text) {
  try {
    const parts = text.split('\n\n');
    if (parts.length < 2) return null;
    const outer = JSON.parse(parts[1]);

    for (const entry of outer) {
      if (!Array.isArray(entry) || typeof entry[2] !== 'string') continue;
      try {
        const inner = JSON.parse(entry[2]);
        if (Array.isArray(inner) && inner[0] === 'garturlres' && typeof inner[1] === 'string') {
          return inner[1];
        }
      } catch {
        // 이 entry는 JSON이 아니거나 형식이 다름 - 다음 entry 계속 탐색
      }
    }
    return null;
  } catch {
    return null;
  }
}
