import { computeDigestDate } from './utils/digestDate.js';

export async function getAllFeeds(db, category = null) {
  const query = category
    ? db.prepare('SELECT * FROM feeds WHERE category = ? ORDER BY created_at DESC').bind(category)
    : db.prepare('SELECT * FROM feeds ORDER BY created_at DESC');
  const { results } = await query.all();
  return results;
}

export async function getFeedById(db, feedId) {
  const { results } = await db
    .prepare('SELECT * FROM feeds WHERE id = ?')
    .bind(feedId)
    .all();
  return results[0] || null;
}

export async function insertFeed(db, { title, type, keyword, rssUrl, category }) {
  const { meta } = await db
    .prepare(
      `INSERT INTO feeds (title, type, keyword, rss_url, category)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(title, type, keyword ?? null, rssUrl, category || '일반')
    .run();
  return meta.last_row_id;
}

export async function updateFeed(db, feedId, { title, category, rssUrl }) {
  const existing = await getFeedById(db, feedId);
  if (!existing) return null;

  const nextTitle = title ?? existing.title;
  const nextCategory = category ?? existing.category;
  const nextRssUrl = rssUrl ?? existing.rss_url;

  await db
    .prepare(
      `UPDATE feeds SET title = ?, category = ?, rss_url = ? WHERE id = ?`
    )
    .bind(nextTitle, nextCategory, nextRssUrl, feedId)
    .run();

  return { id: Number(feedId), title: nextTitle, category: nextCategory, rss_url: nextRssUrl };
}

export async function deleteFeed(db, feedId) {
  const { meta } = await db.prepare('DELETE FROM feeds WHERE id = ?').bind(feedId).run();
  return meta.changes > 0;
}

/**
 * 여러 article_id에 대해 동일한 read/bookmark 상태를 한 번에 적용 (전체 선택 → 일괄 읽음 처리 등).
 * D1의 batch API로 하나의 트랜잭션에 묶어 처리한다.
 */
export async function bulkUpsertArticleStatus(db, articleIds, { isRead, isBookmarked }) {
  const uniqueIds = [...new Set(articleIds)];
  if (uniqueIds.length === 0) return { updated: 0 };

  const nextRead = isRead !== undefined ? (isRead ? 1 : 0) : null;
  const nextBookmarked = isBookmarked !== undefined ? (isBookmarked ? 1 : 0) : null;

  // COALESCE로 전달되지 않은 필드는 기존 값을 유지 (신규 행은 0으로 시작)
  const statements = uniqueIds.map((id) =>
    db
      .prepare(
        `INSERT INTO user_article_status (article_id, is_read, is_bookmarked, updated_at)
         VALUES (?, COALESCE(?, 0), COALESCE(?, 0), CURRENT_TIMESTAMP)
         ON CONFLICT(article_id) DO UPDATE SET
           is_read = COALESCE(?, is_read),
           is_bookmarked = COALESCE(?, is_bookmarked),
           updated_at = CURRENT_TIMESTAMP`
      )
      .bind(id, nextRead, nextBookmarked, nextRead, nextBookmarked)
  );

  await db.batch(statements);
  return { updated: uniqueIds.length };
}

/**
 * 매일 오전 9시(Today News 확정 시점) — 지정된 카테고리의 스크랩/북마크 "표시 상태"를 초기화.
 * 주의: Today News의 영구 기록(picked_articles)은 절대 건드리지 않는다. 어제자 다이제스트는
 * 그대로 보존되고, 여기서는 오직 브라우즈 화면에 보이는 실시간 별/리본 아이콘 상태만 리셋한다.
 */
export async function resetDailyMarkers(db, feedTitles) {
  if (!feedTitles || feedTitles.length === 0) return { updated: 0 };

  const placeholders = feedTitles.map(() => '?').join(',');
  const result = await db
    .prepare(
      `UPDATE user_article_status
       SET is_picked = 0, is_bookmarked = 0, updated_at = CURRENT_TIMESTAMP
       WHERE (is_picked = 1 OR is_bookmarked = 1)
         AND article_id IN (
           SELECT article_id FROM archived_articles WHERE feed_title IN (${placeholders})
         )`
    )
    .bind(...feedTitles)
    .run();

  return { updated: result.meta.changes ?? 0 };
}

/**
 * 여러 article_id에 대한 read/bookmark 상태를 한 번에 조회.
 * D1(SQLite)은 한 쿼리당 바인딩 가능한 변수 개수에 제한(약 100개)이 있어
 * 청크 단위로 나눠 조회한 뒤 결과를 병합한다.
 * @returns {Map<string, {is_read: number, is_bookmarked: number}>}
 */
export async function getStatusMap(db, articleIds) {
  const uniqueIds = [...new Set(articleIds)];
  if (uniqueIds.length === 0) return new Map();

  const CHUNK_SIZE = 90; // D1 변수 제한(100)보다 여유 있게 설정
  const map = new Map();

  for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const { results } = await db
      .prepare(
        `SELECT article_id, is_read, is_bookmarked, is_picked
         FROM user_article_status
         WHERE article_id IN (${placeholders})`
      )
      .bind(...chunk)
      .all();

    for (const row of results) {
      map.set(row.article_id, row);
    }
  }

  return map;
}

/**
 * 기사 배열을 아카이브에 upsert (있으면 last_seen_at만 갱신, 없으면 신규 삽입).
 * 배치를 너무 크게 묶으면 D1 제한에 걸릴 수 있어 작은 청크로 나눠 처리.
 */
export async function upsertArchivedArticles(db, articles) {
  if (!articles || articles.length === 0) return;

  const CHUNK = 20;
  for (let i = 0; i < articles.length; i += CHUNK) {
    const chunk = articles.slice(i, i + CHUNK);
    const statements = chunk
      .filter((a) => a.articleId && a.title && a.link)
      .map((a) =>
        db
          .prepare(
            `INSERT INTO archived_articles
               (article_id, feed_id, feed_title, title, link, source, category, pub_date, summary, embedding, first_seen_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(article_id) DO UPDATE SET
               title = excluded.title,
               summary = excluded.summary,
               embedding = COALESCE(excluded.embedding, archived_articles.embedding),
               last_seen_at = CURRENT_TIMESTAMP`
          )
          .bind(
            a.articleId,
            a.feedId ?? null,
            a.feedTitle ?? '',
            a.title,
            a.link,
            a.source ?? '',
            a.category ?? '일반',
            a.pubDate ?? '',
            a.summary ?? '',
            a.embedding ? JSON.stringify(a.embedding) : null
          )
      );
    if (statements.length > 0) await db.batch(statements);
  }
}

/** 특정 feed_id 목록(또는 전체)에 대한 아카이브 기사 조회 */
export async function getArchivedArticles(db, feedIds) {
  if (!feedIds || feedIds.length === 0) {
    const { results } = await db.prepare('SELECT * FROM archived_articles').all();
    return results;
  }

  const CHUNK_SIZE = 90;
  let all = [];
  for (let i = 0; i < feedIds.length; i += CHUNK_SIZE) {
    const chunk = feedIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const { results } = await db
      .prepare(`SELECT * FROM archived_articles WHERE feed_id IN (${placeholders})`)
      .bind(...chunk)
      .all();
    all = all.concat(results);
  }
  return all;
}

/**
 * Today News용 Pick 추가.
 * user_article_status.is_picked를 세우는 동시에, RSS가 사라져도 남도록 picked_articles에 스냅샷 저장.
 */
export async function addPick(db, article) {
  const { articleId, title, link, source, category, feedTitle, pubDate } = article;
  const pickedAtIso = new Date().toISOString();
  const digestDate = computeDigestDate(pickedAtIso);

  await db.batch([
    db
      .prepare(
        `INSERT INTO user_article_status (article_id, is_read, is_bookmarked, is_picked, updated_at)
         VALUES (?, 0, 0, 1, CURRENT_TIMESTAMP)
         ON CONFLICT(article_id) DO UPDATE SET
           is_picked = 1,
           updated_at = CURRENT_TIMESTAMP`
      )
      .bind(articleId),
    db
      .prepare(
        `INSERT INTO picked_articles (article_id, title, link, source, category, feed_title, pub_date, digest_date, picked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(article_id) DO UPDATE SET
           title = excluded.title,
           link = excluded.link,
           source = excluded.source,
           category = excluded.category,
           feed_title = excluded.feed_title,
           pub_date = excluded.pub_date,
           digest_date = excluded.digest_date,
           picked_at = CURRENT_TIMESTAMP`
      )
      .bind(articleId, title, link, source ?? '', category ?? '일반', feedTitle ?? '', pubDate ?? '', digestDate),
  ]);

  return { articleId, isPicked: true, digestDate };
}

/** Pick 해제 (스냅샷 삭제 + 플래그 해제) */
export async function removePick(db, articleId) {
  await db.batch([
    db
      .prepare(
        `UPDATE user_article_status SET is_picked = 0, updated_at = CURRENT_TIMESTAMP
         WHERE article_id = ?`
      )
      .bind(articleId),
    db.prepare('DELETE FROM picked_articles WHERE article_id = ?').bind(articleId),
  ]);

  return { articleId, isPicked: false };
}

/**
 * 기간 내 Pick된 기사 스냅샷 목록 조회 (최신순).
 * @param {string|null} sinceIso - 이 시각 이후로 Pick된 것만 (없으면 전체)
 */
export async function getPicks(db, sinceIso = null) {
  const query = sinceIso
    ? db
        .prepare('SELECT * FROM picked_articles WHERE picked_at >= ? ORDER BY picked_at DESC')
        .bind(sinceIso)
    : db.prepare('SELECT * FROM picked_articles ORDER BY picked_at DESC');

  const { results } = await query.all();
  return results;
}

/**
 * READ / UNREAD / BOOKMARK 상태 upsert.
 * isRead, isBookmarked 중 전달된 값만 갱신 (부분 업데이트 지원).
 */
export async function upsertArticleStatus(db, articleId, { isRead, isBookmarked }) {
  const existing = await db
    .prepare('SELECT * FROM user_article_status WHERE article_id = ?')
    .bind(articleId)
    .all();

  const current = existing.results[0];
  const nextRead = isRead !== undefined ? (isRead ? 1 : 0) : current?.is_read ?? 0;
  const nextBookmarked =
    isBookmarked !== undefined ? (isBookmarked ? 1 : 0) : current?.is_bookmarked ?? 0;

  await db
    .prepare(
      `INSERT INTO user_article_status (article_id, is_read, is_bookmarked, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(article_id) DO UPDATE SET
         is_read = excluded.is_read,
         is_bookmarked = excluded.is_bookmarked,
         updated_at = CURRENT_TIMESTAMP`
    )
    .bind(articleId, nextRead, nextBookmarked)
    .run();

  return { articleId, isRead: !!nextRead, isBookmarked: !!nextBookmarked };
}
