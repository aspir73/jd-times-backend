/**
 * 원본 pubDate(UTC 등)를 받아, 화면에 바로 찍을 수 있는 한국시간 표시 문자열로 변환.
 * 서버(Cloudflare Workers)에서 항상 동일하게 계산되므로 브라우저/클라이언트 시간대와 무관하게
 * 모든 사용자에게 동일한 문자열이 내려간다. 프론트엔드는 이 값을 그대로 표시하기만 하면 된다.
 *
 * 주의: DB에 저장되는 원본 pubDate 자체는 절대 건드리지 않는다 (기간 검색용 시간 계산의 정확성을 위해).
 * 이 값은 오직 "표시용" 파생 필드다.
 */
export function formatKstDisplay(pubDateRaw) {
  if (!pubDateRaw) return '';
  const d = new Date(pubDateRaw);
  if (Number.isNaN(d.getTime())) return '';

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);

  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  let hour = get('hour');
  if (hour === '24') hour = '00';

  return `${get('month')}.${get('day')} ${hour}:${get('minute')}`;
}
