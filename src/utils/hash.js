/**
 * 기사 link를 고유 article_id(SHA-256 hex)로 변환.
 * Cloudflare Workers는 Web Crypto API(crypto.subtle)를 네이티브 지원.
 */
export async function hashArticleId(link) {
  const normalized = (link || '').trim().split('?')[0].replace(/\/$/, '');
  const data = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
