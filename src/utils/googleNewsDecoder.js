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
 * 1) batchexecute API 시도 → 실패 시
 * 2) 일반 HTTP 리다이렉트를 그냥 따라가 보기(가끔 통할 때가 있음) → 그래도 실패 시
 * 3) 원본 구글 링크 그대로 반환
 *
 * 호출 비용이 있으므로(요청 여러 번) 브라우즈 화면 전체 기사가 아니라 "스크랩" 시점에만 사용한다.
 */
export async function decodeGoogleNewsUrl(googleUrl) {
  try {
    const url = new URL(googleUrl);
    if (url.hostname !== 'news.google.com') return googleUrl;

    const pathParts = url.pathname.split('/').filter(Boolean);
    const gnArtId = pathParts[pathParts.length - 1];
    if (!gnArtId || gnArtId.length < 20) {
      console.log('[decodeGoogleNewsUrl] gn_art_id 추출 실패:', url.pathname);
      return googleUrl;
    }

    const viaBatchExecute = await decodeViaBatchExecute(gnArtId);
    if (viaBatchExecute) return normalizeUrl(viaBatchExecute);

    const viaRedirect = await decodeViaHttpRedirect(googleUrl);
    if (viaRedirect) return normalizeUrl(viaRedirect);

    return googleUrl;
  } catch (err) {
    console.log('[decodeGoogleNewsUrl] 예외 발생:', String(err));
    return googleUrl;
  }
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 1차 시도: 구글 내부 batchexecute API */
async function decodeViaBatchExecute(gnArtId) {
  // 1) 기사 페이지에서 서명(signature)/타임스탬프 추출
  const paramsRes = await fetch(`https://news.google.com/rss/articles/${gnArtId}`, {
    headers: { 'User-Agent': UA },
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

  const execRes = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      Referer: 'https://news.google.com/',
      'User-Agent': UA,
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
async function decodeViaHttpRedirect(googleUrl) {
  try {
    const res = await fetch(googleUrl, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
    });
    // 리다이렉트를 안 타고 그대로 news.google.com에 남아있으면 실패로 간주
    if (res.url && !res.url.includes('news.google.com')) {
      console.log('[decodeGoogleNewsUrl] HTTP 리다이렉트 폴백 성공:', res.url);
      return res.url;
    }
    return null;
  } catch (err) {
    console.log('[decodeGoogleNewsUrl] 리다이렉트 폴백 실패:', String(err));
    return null;
  }
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
