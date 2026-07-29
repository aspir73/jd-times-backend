/**
 * RSS 프록시 수집기
 * - 구글 봇 차단(403/429) 회피를 위한 User-Agent / Header 위장
 * - Cloudflare KV에 15분(900초) 캐싱하여 구글 서버 직접 요청 최소화
 */

const CACHE_TTL_SECONDS = 900; // 15분

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

/**
 * KV 캐시를 우선 조회하고, 없으면 원본 RSS를 fetch 후 캐싱.
 * @param {string} rssUrl
 * @param {KVNamespace} kv - env.RSS_CACHE 바인딩
 * @returns {Promise<string>} 원본 XML 텍스트
 */
export async function fetchRssWithCache(rssUrl, kv, force = false) {
  const cacheKey = `rss:${rssUrl}`;

  if (!force) {
    const cached = await kv.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const MAX_ATTEMPTS = 3;
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(rssUrl, { headers: DESKTOP_CHROME_HEADERS });

    if (res.ok) {
      const xmlText = await res.text();
      await kv.put(cacheKey, xmlText, { expirationTtl: CACHE_TTL_SECONDS });
      return xmlText;
    }

    lastError = new Error(`RSS fetch failed (${res.status}): ${rssUrl}`);

    if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_ATTEMPTS) {
      throw lastError;
    }

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
    const cached = await kv.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
  }

  const proxyUrl = new URL('https://api.rss2json.com/v1/api.json');
  proxyUrl.searchParams.set('rss_url', rssUrl);
  if (apiKey) {
    proxyUrl.searchParams.set('api_key', apiKey);
    proxyUrl.searchParams.set('count', '50');
    proxyUrl.searchParams.set('order_by', 'pubDate');
    proxyUrl.searchParams.set('order_dir', 'desc');
  }

  const res = await fetch(proxyUrl.toString());
  if (!res.ok) {
    throw new Error(`rss2json fetch failed (${res.status}): ${rssUrl}`);
  }

  const data = await res.json();
  if (data.status !== 'ok') {
    throw new Error(`rss2json returned error: ${data.message || 'unknown'}`);
  }

  await kv.put(cacheKey, JSON.stringify(data.items), { expirationTtl: CACHE_TTL_SECONDS });
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
 * 피드 하나에 대해 기사를 수집하는 최상위 함수.
 * 1) 직접 fetch(+재시도) 시도 → 실패 시
 * 2) RSS2JSON_API_KEY가 설정되어 있으면 rss2json.com 경유로 재시도
 * @param {{id, rss_url, title, category}} feed
 * @param {{RSS_CACHE: KVNamespace, RSS2JSON_API_KEY?: string}} env
 */
export async function fetchArticlesForFeed(feed, env, force = false) {
  const feedMeta = { id: feed.id, title: feed.title, category: feed.category };

  try {
    const xml = await fetchRssWithCache(feed.rss_url, env.RSS_CACHE, force);
    return parseRssItems(xml, feedMeta);
  } catch (directError) {
    if (!env.RSS2JSON_API_KEY) {
      throw directError;
    }
    // 직접 fetch 실패 시 rss2json.com 프록시로 대체 시도
    const items = await fetchViaRss2Json(feed.rss_url, env.RSS2JSON_API_KEY, env.RSS_CACHE, force);
    return parseRss2JsonItems(items, feedMeta);
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
