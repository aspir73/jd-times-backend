/**
 * 스크랩 시각(KST) → "다이제스트 날짜(YYYY-MM-DD)" 계산.
 * 규칙: 오전 9시 이전 스크랩 = 그날 다이제스트 / 9시 이후 = 다음날 다이제스트.
 * 주말(토/일)에 해당하면 다음 월요일로 이월 (다이제스트는 평일만 존재).
 */
export function computeDigestDate(scrapedAtIso) {
  const d = new Date(scrapedAtIso);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type).value;

  const y = Number(get('year'));
  const m = Number(get('month'));
  const day = Number(get('day'));
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;

  const candidate = new Date(Date.UTC(y, m - 1, day));
  if (hour >= 9) candidate.setUTCDate(candidate.getUTCDate() + 1);

  const weekday = candidate.getUTCDay(); // 0=일, 6=토
  if (weekday === 6) candidate.setUTCDate(candidate.getUTCDate() + 2);
  else if (weekday === 0) candidate.setUTCDate(candidate.getUTCDate() + 1);

  const yy = candidate.getUTCFullYear();
  const mm = String(candidate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(candidate.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
