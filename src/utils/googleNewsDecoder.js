/**
 * 구글 뉴스 RSS의 리다이렉트 링크(news.google.com/rss/articles/CBMi...)를
 * 실제 원본 기사 URL로 디코딩한다.
 *
 * 구글이 공식 문서화하지 않은 내부 batchexecute API를 이용하는 방식이라(커뮤니티에서
 * 리버스 엔지니어링됨), 실패할 수 있다는 전제로 항상 안전하게 폴백하도록 작성했다.
 * 실패 시(네트워크 오류, 구글 쪽 변경, 429 등) 예외를 던지지 않고 원본 구글 링크를 그대로 반환한다.
 *
 * 호출 비용이 있으므로(요청 2회) 브라우즈 화면 전체 기사가 아니라 "스크랩" 시점에만 사용한다.
 */
export async function decodeGoogleNewsUrl(googleUrl) {
  try {
    const url = new URL(googleUrl);
    if (url.hostname !== 'news.google.com') return googleUrl;

    const pathParts = url.pathname.split('/').filter(Boolean);
    const gnArtId = pathParts[pathParts.length - 1];
    if (!gnArtId || gnArtId.length < 20) return googleUrl;

    const UA =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    // 1) 기사 페이지에서 서명(signature)/타임스탬프 추출
    const paramsRes = await fetch(`https://news.google.com/rss/articles/${gnArtId}`, {
      headers: { 'User-Agent': UA },
    });
    if (!paramsRes.ok) return googleUrl;
    const html = await paramsRes.text();

    const sigMatch = html.match(/data-n-a-sg="([^"]+)"/);
    const tsMatch = html.match(/data-n-a-ts="([^"]+)"/);
    if (!sigMatch || !tsMatch) return googleUrl;
    const signature = sigMatch[1];
    const timestamp = tsMatch[1];

    // 2) 구글 내부 batchexecute API 호출해서 실제 URL 요청
    const innerReq =
      '["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],' +
      `"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${gnArtId}",${timestamp},"${signature}"]`;
    const payload = [[['Fbv4je', innerReq]]];
    const body = 'f.req=' + encodeURIComponent(JSON.stringify(payload));

    const execRes = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Referer: 'https://news.google.com/',
        'User-Agent': UA,
      },
      body,
    });
    if (!execRes.ok) return googleUrl;

    const text = await execRes.text();
    const decodedUrl = parseBatchExecuteResponse(text);
    if (decodedUrl && decodedUrl.startsWith('http')) {
      return decodedUrl;
    }
    return googleUrl;
  } catch {
    return googleUrl;
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
