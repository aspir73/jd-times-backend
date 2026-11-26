/**
 * 매일 07시(KST) 구글 시트 내보내기 + 그 준비 작업(수집 기사 원문 링크 변환).
 *
 * 흐름:
 *  1) 수집 Cron이 돌 때마다 backfillOriginalLinks()가 아직 변환 안 된 새 기사 링크를 NAS 릴레이로
 *     원문 주소로 바꿔 archived_articles.original_link에 저장한다 (무료 플랜은 한 번 실행에 외부 요청
 *     50개 제한이라 한 번에 조금씩만 — 하루 15회쯤 돌면서 하루치 수백 건을 따라잡는다).
 *  2) 07:00 KST Cron에서 sendDailyExport()가 지난 24시간 동안 처음 수집된 기사를 모아
 *     Google Apps Script 웹 앱(EXPORT_WEBHOOK_URL)으로 보내고, 스크립트가 드라이브 시트에 줄을 추가한다.
 *
 * 설정(wrangler secret):
 *  - EXPORT_WEBHOOK_URL   : Apps Script 웹 앱 배포 주소 (…/exec)
 *  - EXPORT_WEBHOOK_TOKEN : Apps Script의 SHARED_TOKEN과 같은 값 (요청 본문에 실어 보내 위조 요청 차단)
 *  둘 중 하나라도 없으면 내보내기는 조용히 건너뛴다.
 * 선택(vars): EXPORT_USER_ID — 이 사용자가 구독한 피드의 기사만 내보낸다 (기본 1 = 기존 소유자/어드민)
 */
import { decodeGoogleNewsUrlViaNasOnly } from './utils/googleNewsDecoder.js';

const MAX_DECODE_ATTEMPTS = 3;
const DECODE_CONCURRENCY = 5;

/** 07시 내보내기 대상인지: '*\/30 22-23 * * *' 중 22:00 UTC(=07:00 KST) 실행 */
export function isDailyExportRun(event) {
  if (event.cron !== '*/30 22-23 * * *') return false;
  const t = new Date(event.scheduledTime);
  return t.getUTCHours() === 22 && t.getUTCMinutes() === 0;
}

/**
 * 변환 안 된 최근 기사 링크를 원문 주소로 바꿔 저장. 오래된 것부터(최근 2일 안) limit건.
 * 실패하면 decode_attempts만 올리고, 3번 실패한 기사는 더 시도하지 않는다.
 * @returns {Promise<{tried:number, decoded:number}>}
 */
export async function backfillOriginalLinks(env, limit) {
  if (!limit || limit <= 0) return { tried: 0, decoded: 0 };
  const { results } = await env.DB.prepare(
    `SELECT article_id, link FROM archived_articles
      WHERE original_link IS NULL
        AND decode_attempts < ?
        AND first_seen_at >= datetime('now', '-2 days')
        AND link LIKE 'https://news.google.com/%'
      ORDER BY first_seen_at ASC
      LIMIT ?`
  )
    .bind(MAX_DECODE_ATTEMPTS, limit)
    .all();
  if (!results?.length) return { tried: 0, decoded: 0 };

  const updates = [];
  let decodedCount = 0;
  for (let i = 0; i < results.length; i += DECODE_CONCURRENCY) {
    const batch = results.slice(i, i + DECODE_CONCURRENCY);
    const decoded = await Promise.all(batch.map((row) => decodeGoogleNewsUrlViaNasOnly(row.link, env)));
    batch.forEach((row, idx) => {
      if (decoded[idx]) decodedCount++;
      updates.push(
        decoded[idx]
          ? env.DB.prepare(
              'UPDATE archived_articles SET original_link = ?, decode_attempts = decode_attempts + 1 WHERE article_id = ?'
            ).bind(decoded[idx], row.article_id)
          : env.DB.prepare(
              'UPDATE archived_articles SET decode_attempts = decode_attempts + 1 WHERE article_id = ?'
            ).bind(row.article_id)
      );
    });
  }
  await env.DB.batch(updates);
  return { tried: results.length, decoded: decodedCount };
}

const pad = (n) => String(n).padStart(2, '0');

/** epoch ms → 'YYYY-MM-DD HH:mm' (KST) */
export function formatKst(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** SQLite CURRENT_TIMESTAMP 문자열('YYYY-MM-DD HH:MM:SS', UTC) → epoch ms */
function sqliteUtcToMs(value) {
  return value ? Date.parse(`${value.replace(' ', 'T')}Z`) : NaN;
}

/** epoch ms → SQLite 비교용 'YYYY-MM-DD HH:MM:SS' (UTC) */
function msToSqliteUtc(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * [endMs-24h, endMs) 동안 처음 수집된 기사 중, userId가 구독한 피드의 기사 목록 (오래된 순).
 * 피드 이름·카테고리는 그 사용자가 붙인 이름을 쓴다.
 */
export async function getDailyExportRows(db, { userId, endMs }) {
  const startMs = endMs - 24 * 3600 * 1000;
  const { results } = await db
    .prepare(
      `SELECT a.article_id, a.title, a.link, a.original_link, a.source, a.summary,
              a.pub_date_epoch, a.first_seen_at,
              COALESCE(uf.title, a.feed_title) AS feed_title,
              COALESCE(uf.category, a.category) AS category
         FROM archived_articles a
         JOIN user_feeds uf ON uf.feed_id = a.feed_id AND uf.user_id = ?
        WHERE a.first_seen_at >= ? AND a.first_seen_at < ?
        ORDER BY a.first_seen_at ASC, a.pub_date_epoch ASC`
    )
    .bind(userId, msToSqliteUtc(startMs), msToSqliteUtc(endMs))
    .all();

  return (results || []).map((r) => ({
    id: r.article_id,
    collectedAt: formatKst(sqliteUtcToMs(r.first_seen_at)),
    publishedAt: formatKst(r.pub_date_epoch),
    feed: r.feed_title || '',
    category: r.category || '',
    source: r.source || '',
    title: r.title || '',
    link: r.original_link || r.link,
    linkIsOriginal: !!r.original_link,
    summary: (r.summary || '').slice(0, 500),
  }));
}

/**
 * 지난 24시간 수집분을 Apps Script로 보낸다.
 * @returns {Promise<{skipped?:string, sent?:number, originalLinks?:number, response?:any}>}
 */
export async function sendDailyExport(env, { endMs = Date.now() } = {}) {
  if (!env.EXPORT_WEBHOOK_URL || !env.EXPORT_WEBHOOK_TOKEN) return { skipped: 'NOT_CONFIGURED' };

  const userId = Number(env.EXPORT_USER_ID || 1);
  const rows = await getDailyExportRows(env.DB, { userId, endMs });
  const exportDate = formatKst(endMs).slice(0, 10);

  const res = await fetch(env.EXPORT_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: env.EXPORT_WEBHOOK_TOKEN, exportDate, rows }),
  });
  const text = await res.text();
  let response;
  try {
    response = JSON.parse(text);
  } catch {
    response = { raw: text.slice(0, 300) };
  }
  if (!res.ok || response?.ok === false) {
    throw new Error(`시트 내보내기 실패 (${res.status}): ${JSON.stringify(response).slice(0, 300)}`);
  }
  return { sent: rows.length, originalLinks: rows.filter((r) => r.linkIsOriginal).length, exportDate, response };
}
