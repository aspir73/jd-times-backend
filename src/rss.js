/**
 * RSS 프록시 수집기
 * - 구글 봇 차단(403/429) 회피를 위한 User-Agent / Header 위장
 * - Cloudflare KV에 15분(900초) 신선도 기준으로 캐싱하여 구글 서버 직접 요청 최소화
 * - stale-while-revalidate: direct fetch와 rss2json 대체 경로를 모두 시도했는데도 둘 다
 *   실패/타임아웃일 때만, 마지막 수단으로 만료된 캐시를 서빙한다(fetchArticlesForFeed 참고).
 *   주의: fetchRssWithCache/fetchViaRss2Json 각각의 내부에서 실패를 삼키고 캐시로 폴백하면 안
 *   된다 — 그러면 direct가 실패해도 "성공"한 것처럼 보여서 rss2json 쪽을 아예 시도하지 못하고,
 *   결과적으로 새 기사가 있어도 계속 예전 캐시만 보여주는 문제가 생긴다(실제로 겪었던 버그).
 */

const CACHE_FRESH_SECONDS = 900; // 15분 이내면 신선하다고 보고 캐시를 그대로 서빙
const CACHE_STORAGE_SECONDS = 60 * 60 * 24 * 3; // KV 보관 기간(신선도와 별개, 완전 유실 방지용 안전판) — 3일
const FETCH_TIMEOUT_MS = 6000; // 구글 응답이 느릴 때 무한정 기다리지 않기 위한 타임아웃

const DESKTOP_CHROME_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://www.google.com/',
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

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 캐시 항목을 읽는다 (신선도와 무관하게 있으면 반환, 형식이 깨졌으면 null) */
async function readCacheEntry(kv, cacheKey) {
  const raw = await kv.get(cacheKey);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null; // 예전 포맷(순수 XML 문자열) 등 — 캐시 없는 것으로 취급
  }
}

function isFreshEntry(entry) {
  return !!entry?.fetchedAt && Date.now() - entry.fetchedAt < CACHE_FRESH_SECONDS * 1000;
}

/**
 * KV 캐시가 신선하면(15분 이내) 그대로 반환, 아니면(또는 force) 실시간으로 새로 받아온다.
 * 실시간 fetch가 실패/타임아웃이면 예외를 던진다 — 캐시 폴백은 여기서 하지 않고
 * fetchArticlesForFeed가 rss2json까지 다 시도해본 뒤 최종적으로 처리한다.
 * @param {string} rssUrl
 * @param {KVNamespace} kv - env.RSS_CACHE 바인딩
 * @returns {Promise<string>} 원본 XML 텍스트
 */
export async function fetchRssWithCache(rssUrl, kv, force = false) {
  const cacheKey = `rss:${rssUrl}`;

  if (!force) {
    const cached = await readCacheEntry(kv, cacheKey);
    if (isFreshEntry(cached)) return cached.xml;
  }

  const MAX_ATTEMPTS = 2; // 타임아웃이 있으니 재시도는 줄여서 최악의 대기 시간을 제한
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetchWithTimeout(rssUrl, { headers: DESKTOP_CHROME_HEADERS }, FETCH_TIMEOUT_MS);
    } catch (err) {
      lastError = err; // 타임아웃(AbortError) 포함 — 계속 느릴 가능성이 높으므로 재시도하지 않고 종료
      break;
    }

    if (res.ok) {
      const xmlText = await res.text();
      await kv.put(cacheKey, JSON.stringify({ xml: xmlText, fetchedAt: Date.now() }), {
        expirationTtl: CACHE_STORAGE_SECONDS,
      });
      return xmlText;
    }

    lastError = new Error(`RSS fetch failed (${res.status}): ${rssUrl}`);
    if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_ATTEMPTS) break;

    // 지수 백오프: 500ms, 1500ms
    await sleep(500 * Math.pow(3, attempt - 1));
  }

  throw lastError;
}

/**
 * rss2json.com을 경유한 RSS 수집 (직접 fetch가 구글에 차단될 때의 대체 경로).
 * rss2json 서버가 대신 구글에 요청하므로 Worker의 IP 차단 문제를 우회할 수 있음.
 * @param {string} rssUrl
 * @param {string} apiKey - rss2json.com 무료 계정에서 발급받은 API 키 (없으면 최근 10건만 조회 가능)
 * @param {KVNamespace} kv
 */
export async function fetchViaRss2Json(rssUrl, apiKey, kv, force = false) {
  const cacheKey = `rss2json:${rssUrl}`;

  if (!force) {
    const cached = await readCacheEntry(kv, cacheKey);
    if (isFreshEntry(cached)) return cached.items;
  }

  const proxyUrl = new URL('https://api.rss2json.com/v1/api.json');
  proxyUrl.searchParams.set('rss_url', rssUrl);
  if (apiKey) {
    proxyUrl.searchParams.set('api_key', apiKey);
    proxyUrl.searchParams.set('count', '50');
    proxyUrl.searchParams.set('order_by', 'pubDate');
    proxyUrl.searchParams.set('order_dir', 'desc');
  }

  const res = await fetchWithTimeout(proxyUrl.toString(), {}, FETCH_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`rss2json fetch failed (${res.status}): ${rssUrl}`);
  }

  const data = await res.json();
  if (data.status !== 'ok') {
    throw new Error(`rss2json returned error: ${data.message || 'unknown'}`);
  }

  await kv.put(cacheKey, JSON.stringify({ items: data.items, fetchedAt: Date.now() }), {
    expirationTtl: CACHE_STORAGE_SECONDS,
  });
  return data.items;
}

/** rss2json.com 응답 아이템을 내부 article 포맷으로 변환 (parseRssItems와 동일한 후처리 적용) */
export function parseRss2JsonItems(items, feedMeta = {}) {
  return items.map((item) => {
    let title = (item.title || '').trim();
    const link = item.link || '';
    const pubDate = item.pubDate || '';
    let source = item.author || '';

    if (source && title.endsWith(` - ${source}`)) {
      title = title.slice(0, -(source.length + 3)).trim();
    } else if (!source && title.includes(' - ')) {
      const parts = title.split(' - ');
      source = parts[parts.length - 1].trim();
      title = parts.slice(0, -1).join(' - ').trim();
    }

    const rawDescription = (item.description || item.content || '').replace(/<[^>]+>/g, ' ');
    const summary = extractSummary(rawDescription, title, source);

    return {
      title,
      link,
      pubDate,
      source: source || feedMeta.title || '',
      category: feedMeta.category || '일반',
      feedId: feedMeta.id ?? null,
      feedTitle: feedMeta.title || '',
      summary,
    };
  });
}

/**
 * direct/rss2json 둘 다 실시간 수집에 실패했을 때 마지막 수단으로 쓰는 폴백.
 * 두 캐시(direct, rss2json) 중 더 최근에 갱신된 쪽을 골라서 서빙한다 — 데이터 없이 실패하는
 * 것보다는 오래된 기사라도 보여주는 게 낫기 때문. 어느 쪽 캐시도 없으면 그제서야 예외를 던진다.
 */
async function fallbackToStaleCache(env, feed, feedMeta) {
  const directEntry = await readCacheEntry(env.RSS_CACHE, `rss:${feed.rss_url}`);
  const rss2jsonEntry = env.RSS2JSON_API_KEY
    ? await readCacheEntry(env.RSS_CACHE, `rss2json:${feed.rss_url}`)
    : null;

  const directTime = directEntry?.fetchedAt ?? -1;
  const rss2jsonTime = rss2jsonEntry?.fetchedAt ?? -1;

  if (directTime < 0 && rss2jsonTime < 0) {
    throw new Error(`실시간 수집 실패, 캐시도 없음: ${feed.rss_url}`);
  }

  if (directTime >= rss2jsonTime) {
    console.log('[rss] 실시간 수집 실패 — 오래된 캐시로 폴백(direct):', feed.rss_url, new Date(directTime).toISOString());
    return parseRssItems(directEntry.xml, feedMeta);
  }
  console.log('[rss] 실시간 수집 실패 — 오래된 캐시로 폴백(rss2json):', feed.rss_url, new Date(rss2jsonTime).toISOString());
  return parseRss2JsonItems(rss2jsonEntry.items, feedMeta);
}

/**
 * 피드 하나에 대해 기사를 수집하는 최상위 함수.
 * 0) 직접 fetch 캐시, rss2json 캐시 중 신선한(15분 이내) 게 있으면 바로 사용 — 구글이 특정
 *    피드에서 계속 느릴 때(실측: 27~30초) 이미 신선한 대체 캐시가 있는데도 매번 direct fetch
 *    타임아웃(6초)을 다시 치르는 낭비를 막기 위함.
 * 1) 없으면(또는 force) 직접 fetch를 실시간으로 시도 → 실패 시
 * 2) RSS2JSON_API_KEY가 설정되어 있으면 rss2json.com 경유로 실시간 재시도 → 그래도 실패 시
 * 3) 마지막 수단으로 오래된 캐시 서빙 (fallbackToStaleCache)
 *
 * 주의: 1)/2) 각각에서 실패를 조용히 캐시로 무마하면 안 된다 — direct가 막혀도 "성공"한 것처럼
 * 보여서 rss2json을 아예 시도하지 못하고, 결과적으로 새 기사가 있어도 계속 예전 캐시만 보여주는
 * 문제가 생긴다(실제로 겪은 버그: 구글에 새 기사가 있는데도 8시간 넘게 업데이트가 안 됨).
 * @param {{id, rss_url, title, category}} feed
 * @param {{RSS_CACHE: KVNamespace, RSS2JSON_API_KEY?: string}} env
 */
export async function fetchArticlesForFeed(feed, env, force = false) {
  const feedMeta = { id: feed.id, title: feed.title, category: feed.category };

  if (!force) {
    const freshDirect = await readCacheEntry(env.RSS_CACHE, `rss:${feed.rss_url}`);
    if (isFreshEntry(freshDirect)) return parseRssItems(freshDirect.xml, feedMeta);

    if (env.RSS2JSON_API_KEY) {
      const freshRss2json = await readCacheEntry(env.RSS_CACHE, `rss2json:${feed.rss_url}`);
      if (isFreshEntry(freshRss2json)) return parseRss2JsonItems(freshRss2json.items, feedMeta);
    }
  }

  try {
    // 신선한 캐시가 없다고 이미 확인했으니(또는 force) 항상 실시간으로 시도
    const xml = await fetchRssWithCache(feed.rss_url, env.RSS_CACHE, true);
    return parseRssItems(xml, feedMeta);
  } catch (directError) {
    if (!env.RSS2JSON_API_KEY) {
      return fallbackToStaleCache(env, feed, feedMeta);
    }
    try {
      const items = await fetchViaRss2Json(feed.rss_url, env.RSS2JSON_API_KEY, env.RSS_CACHE, true);
      return parseRss2JsonItems(items, feedMeta);
    } catch {
      return fallbackToStaleCache(env, feed, feedMeta);
    }
  }
}

function extractSummary(rawDescription, title, source) {
  if (!rawDescription) return '';
  const cleaned = rawDescription.replace(/\s+/g, ' ').trim();
  const titleNorm = (title || '').replace(/\s+/g, ' ').trim();
  const comboNorm = `${titleNorm} ${source || ''}`.replace(/\s+/g, ' ').trim();
  // 구글 뉴스 description은 실제 요약이 아니라 "제목 + 언론사명" 링크뿐인 경우가 대부분 → 그런 경우는 빈 값 처리
  if (!cleaned || cleaned === titleNorm || cleaned === comboNorm || cleaned.length <= titleNorm.length + 2) {
    return '';
  }
  return cleaned;
}

function decodeEntities(str = '') {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, '') // 남은 하위 태그(예: <b>) 제거
    .trim();
}

function extractTag(itemXml, tag) {
  const match = itemXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? decodeEntities(match[1]) : '';
}

/**
 * 구글 뉴스 RSS의 <item> 블록을 파싱.
 * 구글 뉴스 특성상 <source>가 언론사명, <title>이 "제목 - 언론사" 형태인 경우가 많아 분리 처리.
 */
export function parseRssItems(xmlText, feedMeta = {}) {
  const itemBlocks = xmlText.match(/<item[\s\S]*?<\/item>/gi) || [];

  return itemBlocks.map((itemXml) => {
    let title = extractTag(itemXml, 'title');
    const link = extractTag(itemXml, 'link');
    const pubDate = extractTag(itemXml, 'pubDate');
    let source = extractTag(itemXml, 'source');

    // 구글 뉴스 형식: "실제 제목 - 언론사명"
    // <source> 태그가 이미 있어도 title 끝에 동일한 언론사명이 접미사로 붙어있는 경우가 많아 별도 제거.
    if (source && title.endsWith(` - ${source}`)) {
      title = title.slice(0, -(source.length + 3)).trim();
    } else if (!source && title.includes(' - ')) {
      const parts = title.split(' - ');
      source = parts[parts.length - 1].trim();
      title = parts.slice(0, -1).join(' - ').trim();
    }

    const rawDescription = extractTag(itemXml, 'description');
    const summary = extractSummary(rawDescription, title, source);

    return {
      title,
      link,
      pubDate,
      source: source || feedMeta.title || '',
      category: feedMeta.category || '일반',
      feedId: feedMeta.id ?? null,
      feedTitle: feedMeta.title || '',
      summary,
    };
  });
}
