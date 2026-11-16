import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchArticlesForFeed, rssCacheKey } from '../src/rss.js';

// 2026-11-16 운영에서 매 수집마다 실패하던 "보안" 피드 주소. D1에는 프론트(buildGoogleNewsUrl)가 만든
// 퍼센트 인코딩 형태로 저장되므로 같은 방식으로 만든다 → "rss:" 키가 574바이트(운영 오류 메시지와 동일)
const LONG_QUERY =
  '보안 (개인정보 OR AI OR 에이전트 OR 오픈AI OR 앤트로픽 OR CRA OR 양자 OR 취약점 OR 제미나이 OR 해킹) -주가 -특징주 -목표주가 -목표가 -증권 -코스피';
const LONG_URL = (() => {
  const u = new URL('https://news.google.com/rss/search');
  u.searchParams.set('q', LONG_QUERY);
  u.searchParams.set('hl', 'ko');
  u.searchParams.set('gl', 'KR');
  u.searchParams.set('ceid', 'KR:ko');
  return u.toString().replace(/\+/g, '%20');
})();
const SHORT_URL = 'https://news.google.com/rss/search?q=보안&hl=ko&gl=KR&ceid=KR:ko';

const bytes = (s) => new TextEncoder().encode(s).length;

/** Cloudflare KV처럼 512바이트 넘는 키를 거부하는 가짜 KV */
function strictKv() {
  const store = new Map();
  const check = (key) => {
    if (bytes(key) > 512) throw new Error(`KV GET failed: 414 UTF-8 encoded length of ${bytes(key)} exceeds key length limit of 512.`);
  };
  return {
    store,
    async get(key) { check(key); return store.get(key) ?? null; },
    async put(key, value) { check(key); store.set(key, value); },
  };
}

const RSS_XML = `<?xml version="1.0"?><rss><channel>
<item><title>AI 에이전트 보안 취약점 공개 - 보안뉴스</title><link>https://example.com/a</link><pubDate>Mon, 16 Nov 2026 01:00:00 GMT</pubDate><source>보안뉴스</source></item>
</channel></rss>`;

test('short URLs keep the original key so existing caches still hit', async () => {
  assert.equal(await rssCacheKey('rss', SHORT_URL), `rss:${SHORT_URL}`);
});

test('oversized URLs get a stable hashed key under the KV limit', async () => {
  assert.equal(bytes(`rss:${LONG_URL}`), 574, 'fixture should reproduce the production failure');
  const a = await rssCacheKey('rss', LONG_URL);
  const b = await rssCacheKey('rss', LONG_URL);
  assert.equal(a, b);
  assert.match(a, /^rss:sha256:[0-9a-f]{64}$/);
  assert.notEqual(await rssCacheKey('rss2json', LONG_URL), a);
});

test('a feed with a very long search query is collected and cached', async () => {
  const kv = strictKv();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(RSS_XML, { status: 200 });
  try {
    const articles = await fetchArticlesForFeed({ id: 21, rss_url: LONG_URL, title: '보안', category: '보안' }, { RSS_CACHE: kv });
    assert.equal(articles.length, 1);
    assert.match(articles[0].title, /AI 에이전트/);
    assert.equal(kv.store.size, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('KV errors never fail a feed fetch', async () => {
  const brokenKv = { async get() { throw new Error('KV down'); }, async put() { throw new Error('KV down'); } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(RSS_XML, { status: 200 });
  try {
    const articles = await fetchArticlesForFeed({ id: 1, rss_url: SHORT_URL, title: '보안', category: '보안' }, { RSS_CACHE: brokenKv });
    assert.equal(articles.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
