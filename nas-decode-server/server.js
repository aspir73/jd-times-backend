/**
 * 구글 뉴스 리다이렉트 링크(news.google.com/rss/articles/...)를 원본 기사 URL로 디코딩하는
 * 전용 릴레이 서버. NAS 등 가정용 IP에서 이 서버를 돌린다.
 *
 * 배경: Cloudflare Workers의 IP 대역에서 news.google.com에 요청을 보내면 구글이 503으로
 * 차단한다(실측 확인 — 같은 요청을 일반 IP에서 보내면 정상 응답함). 그래서 백엔드(Worker)가
 * 직접 구글에 묻는 대신, 가정용 IP를 쓰는 이 서버에게 "이 링크 원본이 뭐야?"라고 대신 물어보게
 * 한다.
 *
 * 보안: 아무 URL이나 중계하는 범용 프록시가 되지 않도록 news.google.com 계열 호스트만 허용하고,
 * 토큰 인증을 요구한다. 외부(Cloudflare Tunnel 등)에 노출해도 이 두 가지 제약 덕분에
 * SSRF/오픈 릴레이로 악용되기 어렵다.
 *
 * 실행: DECODE_TOKEN=원하는비밀값 node server.js
 * 환경변수:
 *   - DECODE_TOKEN (필수) — Worker가 보내는 Authorization: Bearer 값과 대조
 *   - PORT (선택, 기본 8787)
 */

import http from 'node:http';

const TOKEN = process.env.DECODE_TOKEN;
const PORT = Number(process.env.PORT) || 8787;

if (!TOKEN) {
  console.error('DECODE_TOKEN 환경변수가 필요합니다. 예: DECODE_TOKEN=원하는비밀값 node server.js');
  process.exit(1);
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const BROWSER_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
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
const REQUEST_TIMEOUT_MS = 10000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url, options, maxAttempts = 3) {
  let lastRes = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetchWithTimeout(url, options);
    if (res.ok) return res;
    lastRes = res;
    if (!RETRYABLE_STATUS.has(res.status) || attempt === maxAttempts) return res;
    await sleep(500 * Math.pow(3, attempt - 1));
  }
  return lastRes;
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

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
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

const TRACKING_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'oc'];

function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    for (const param of TRACKING_PARAMS) u.searchParams.delete(param);
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return rawUrl;
  }
}

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

/** 1차 시도: 구글 내부 batchexecute API (서명/타임스탬프 추출 후 실제 URL 조회) */
async function decodeViaBatchExecute(gnArtId) {
  const paramsRes = await fetchWithRetry(`https://news.google.com/rss/articles/${gnArtId}`, {
    headers: BROWSER_HEADERS,
  });
  if (!paramsRes.ok) {
    console.log(`[decode] 1단계 실패, status: ${paramsRes.status}`);
    return null;
  }
  const html = await paramsRes.text();

  const sigMatch = html.match(/data-n-a-sg="([^"]+)"/);
  const tsMatch = html.match(/data-n-a-ts="([^"]+)"/);
  if (!sigMatch || !tsMatch) {
    console.log(`[decode] signature/timestamp 못 찾음. html 길이: ${html.length}`);
    return null;
  }
  const signature = sigMatch[1];
  const timestamp = tsMatch[1];

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
    console.log(`[decode] 2단계 실패, status: ${execRes.status}`);
    return null;
  }

  const text = await execRes.text();
  const decodedUrl = parseBatchExecuteResponse(text);
  if (decodedUrl && decodedUrl.startsWith('http')) return decodedUrl;
  console.log(`[decode] 응답 파싱 실패. 앞부분: ${text.slice(0, 200)}`);
  return null;
}

/** 2차 폴백: 기사 페이지 HTML에서 og:url 등 원문 후보 링크를 뽑아본다 */
async function decodeViaHtmlFallback(googleUrl, gnArtId) {
  const targetUrl = gnArtId ? `https://news.google.com/rss/articles/${gnArtId}` : googleUrl;
  try {
    const res = await fetchWithRetry(targetUrl, { headers: BROWSER_HEADERS });
    if (!res.ok) return null;
    const html = await res.text();
    for (const candidate of extractCandidateUrlsFromHtml(html)) {
      if (candidate.startsWith('http') && !isGoogleNewsHost(new URL(candidate).hostname)) {
        return candidate;
      }
    }
    return null;
  } catch (err) {
    console.log(`[decode] HTML fallback 실패: ${String(err)}`);
    return null;
  }
}

/** 3차 폴백: 그냥 HTTP 리다이렉트를 따라가서 최종 도착지를 본다 */
async function decodeViaHttpRedirect(googleUrl) {
  try {
    const res = await fetchWithTimeout(googleUrl, { headers: BROWSER_HEADERS, redirect: 'manual' });
    const location = res.headers.get('location');
    if (location) {
      const resolved = new URL(location, googleUrl).toString();
      if (!isGoogleNewsHost(new URL(resolved).hostname)) return resolved;
    }
    if (res.url && !isGoogleNewsHost(new URL(res.url).hostname)) return res.url;
    return null;
  } catch (err) {
    console.log(`[decode] 리다이렉트 폴백 실패: ${String(err)}`);
    return null;
  }
}

async function decodeGoogleNewsUrl(googleUrl) {
  const url = new URL(googleUrl);
  if (!isGoogleNewsHost(url.hostname)) {
    throw Object.assign(new Error('NOT_A_GOOGLE_NEWS_URL'), { status: 400 });
  }

  const gnArtId = extractGoogleNewsArticleId(url);

  const viaBatchExecute = gnArtId ? await decodeViaBatchExecute(gnArtId) : null;
  if (viaBatchExecute) return normalizeUrl(viaBatchExecute);

  const viaHtml = await decodeViaHtmlFallback(googleUrl, gnArtId);
  if (viaHtml) return normalizeUrl(viaHtml);

  const viaRedirect = await decodeViaHttpRedirect(googleUrl);
  if (viaRedirect) return normalizeUrl(viaRedirect);

  return null;
}

function checkAuth(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return token === TOKEN;
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://localhost:${PORT}`);

  if (requestUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (requestUrl.pathname !== '/decode') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'NOT_FOUND' }));
    return;
  }

  if (!checkAuth(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
    return;
  }

  const target = requestUrl.searchParams.get('url');
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'MISSING_URL_PARAM' }));
    return;
  }

  try {
    const resolvedUrl = await decodeGoogleNewsUrl(target);
    if (!resolvedUrl) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: null }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url: resolvedUrl }));
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    console.log(`[decode] 요청 처리 실패: ${String(err)}`);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'DECODE_FAILED', detail: String(err.message || err) }));
  }
});

server.listen(PORT, () => {
  console.log(`[decode-server] listening on :${PORT}`);
});
