import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeGoogleNewsUrl } from '../src/utils/googleNewsDecoder.js';

test('decodes the original article URL from Google News article HTML', async () => {
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    if (typeof url === 'string' && url.startsWith('https://news.google.com/rss/articles/')) {
      return new Response(
        '<html><head><meta property="og:url" content="https://example.com/news/article?utm_source=test"></head><body><a href="https://example.com/news/article?utm_source=test">Read</a></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } }
      );
    }

    if (typeof url === 'string' && url.startsWith('https://news.google.com/_/DotsSplashUi/data/batchexecute')) {
      return new Response('', { status: 200, headers: { 'content-type': 'text/plain' } });
    }

    throw new Error(`Unexpected fetch request: ${url}`);
  };

  try {
    const result = await decodeGoogleNewsUrl('https://news.google.com/rss/articles/CBMiQjJQaG9nLmh0bWwQmV0YQ');
    assert.equal(result, 'https://example.com/news/article');
  } finally {
    global.fetch = originalFetch;
  }
});
