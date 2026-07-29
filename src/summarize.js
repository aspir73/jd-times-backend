/**
 * 북마크한 기사의 원문 페이지에서 요약을 추출.
 * 실제 AI 요약이 아니라, 기사 페이지의 og:description / meta description을
 * 가져오는 방식 (대부분의 국내 언론사가 SEO를 위해 기사 요약을 이 메타태그에 넣어둠).
 * 메타 설명이 없는 경우 본문 첫 문단으로 대체.
 */

const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
};

const MAX_SUMMARY_CHARS = 200;

function extractMetaContent(html, attr, value) {
  const patterns = [
    new RegExp(`<meta[^>]+${attr}=["']${value}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*${attr}=["']${value}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}

function extractFirstParagraph(html) {
  const bodyMatch = html.match(/<body[\s\S]*?<\/body>/i);
  const scope = bodyMatch ? bodyMatch[0] : html;
  const paragraphs = scope.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [];
  for (const p of paragraphs) {
    const text = p.replace(/<[^>]+>/g, ' ').trim();
    if (text.length > 20) return text; // 너무 짧은(광고/버튼) 문단은 건너뜀
  }
  return '';
}

function cleanText(str = '') {
  return str
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(str, maxChars = MAX_SUMMARY_CHARS) {
  if (str.length <= maxChars) return str;
  const cut = str.slice(0, maxChars);
  return cut.replace(/\s+\S*$/, '') + '…';
}

export async function fetchArticleSummary(link) {
  const res = await fetch(link, { headers: REQUEST_HEADERS, redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`기사 페이지 요청 실패 (${res.status})`);
  }

  const html = await res.text();

  let desc =
    extractMetaContent(html, 'property', 'og:description') ||
    extractMetaContent(html, 'name', 'description') ||
    extractMetaContent(html, 'name', 'twitter:description');

  if (!desc) {
    desc = extractFirstParagraph(html);
  }

  const cleaned = cleanText(desc);
  if (!cleaned) {
    throw new Error('요약을 추출할 수 없습니다');
  }

  return truncate(cleaned);
}
