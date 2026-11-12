import { computeDigestDate } from './utils/digestDate.js';

// ============================================================
// 피드 카탈로그 (RSS 주소당 1행, 사용자 공용)
// ============================================================

/** Cron 수집 대상: 구독자가 한 명이라도 있는 피드만 (아무도 안 보는 피드는 수집 비용 낭비) */
export async function getSubscribedFeeds(db) {
  const { results } = await db
    .prepare('SELECT * FROM feeds WHERE id IN (SELECT DISTINCT feed_id FROM user_feeds) ORDER BY id')
    .all();
  return results;
}

export async function getFeedById(db, feedId) {
  return db.prepare('SELECT * FROM feeds WHERE id = ?').bind(feedId).first();
}

async function getFeedByUrl(db, rssUrl) {
  return db.prepare('SELECT * FROM feeds WHERE rss_url = ?').bind(rssUrl).first();
}

/** 같은 RSS 주소가 이미 카탈로그에 있으면 그 피드를, 없으면 새로 만들어 반환 */
async function findOrCreateFeed(db, { title, type, keyword, rssUrl, category }) {
  const existing = await getFeedByUrl(db, rssUrl);
  if (existing) return existing;

  await db
    .prepare(
      `INSERT INTO feeds (title, type, keyword, rss_url, category)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(rss_url) DO NOTHING`
    )
    .bind(title, type, keyword ?? null, rssUrl, category || '일반')
    .run();
  return getFeedByUrl(db, rssUrl);
}

/** 보안/LG전자처럼 "우선 피드" 이름으로 구독 중인 사람이 한 명이라도 있는 피드 ID 목록 (임베딩 사전 계산 대상) */
export async function getPriorityFeedIds(db, titles) {
  if (!titles || titles.length === 0) return new Set();
  const placeholders = titles.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `SELECT DISTINCT feed_id AS id FROM user_feeds WHERE title IN (${placeholders})
       UNION
       SELECT id FROM feeds WHERE title IN (${placeholders})`
    )
    .bind(...titles, ...titles)
    .all();
  return new Set(results.map((r) => r.id));
}

/**
 * Cron 수집 결과를 피드별로 기록 (어드민 "전체 피드 현황"용).
 * @param {Array<{feedId: number, ok: boolean, error?: string, count?: number}>} results
 */
export async function recordFeedFetchResults(db, results) {
  if (!results || results.length === 0) return;
  const now = Date.now();
  const statements = results.map((r) =>
    db
      .prepare(
        `UPDATE feeds SET last_fetch_at = ?, last_fetch_ok = ?, last_fetch_error = ?, last_item_count = ? WHERE id = ?`
      )
      .bind(now, r.ok ? 1 : 0, r.ok ? null : String(r.error || '').slice(0, 500), r.ok ? r.count ?? 0 : null, r.feedId)
  );
  for (let i = 0; i < statements.length; i += 50) {
    await db.batch(statements.slice(i, i + 50));
  }
}

// ============================================================
// 사용자별 구독 (user_feeds)
// ============================================================

/**
 * 사용자의 구독 피드 목록. 프론트가 쓰던 기존 feeds 행 모양(id/title/type/keyword/rss_url/category)을
 * 그대로 유지한다 — id는 카탈로그 feed_id, title/category는 사용자가 정한 값.
 * catalog_title/catalog_category는 아카이브에 저장되는 공용 값(내부용).
 */
const USER_FEED_SELECT = `
  SELECT f.id, uf.title, f.type, COALESCE(uf.keyword, f.keyword) AS keyword, f.rss_url, uf.category,
         uf.created_at, f.title AS catalog_title, f.category AS catalog_category
  FROM user_feeds uf JOIN feeds f ON f.id = uf.feed_id`;

export async function getUserFeeds(db, userId, category = null) {
  const query = category
    ? db.prepare(`${USER_FEED_SELECT} WHERE uf.user_id = ? AND uf.category = ? ORDER BY uf.created_at DESC`).bind(userId, category)
    : db.prepare(`${USER_FEED_SELECT} WHERE uf.user_id = ? ORDER BY uf.created_at DESC`).bind(userId);
  const { results } = await query.all();
  return results;
}

export async function getUserFeed(db, userId, feedId) {
  return db.prepare(`${USER_FEED_SELECT} WHERE uf.user_id = ? AND uf.feed_id = ?`).bind(userId, feedId).first();
}

export class FeedConflictError extends Error {}

/**
 * 사용자에게 피드 구독 추가. 같은 RSS가 카탈로그에 있으면 재사용한다.
 * 이미 구독 중이면 FeedConflictError.
 */
export async function subscribeUserToFeed(db, userId, { title, type, keyword, rssUrl, category }) {
  const feed = await findOrCreateFeed(db, { title, type, keyword, rssUrl, category });
  const { meta } = await db
    .prepare(
      `INSERT INTO user_feeds (user_id, feed_id, title, category, keyword)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, feed_id) DO NOTHING`
    )
    .bind(userId, feed.id, title, category || '일반', keyword ?? null)
    .run();
  if (meta.changes === 0) throw new FeedConflictError('ALREADY_SUBSCRIBED');
  return getUserFeed(db, userId, feed.id);
}

/**
 * 사용자 구독 수정. 이름/카테고리/키워드는 이 사용자 것만 바뀐다.
 * RSS 주소가 바뀌면 다른 구독자에게 영향이 없도록, 새 주소의 카탈로그 피드로 구독을 옮긴다
 * (기존 카탈로그 피드는 다른 구독자가 계속 쓰고, 아무도 안 쓰면 Cron 수집 대상에서 자연히 빠진다).
 */
export async function updateUserFeed(db, userId, feedId, { title, category, rssUrl, keyword }) {
  const current = await getUserFeed(db, userId, feedId);
  if (!current) return null;

  const nextTitle = title ?? current.title;
  const nextCategory = category ?? current.category;
  const nextKeyword = keyword ?? current.keyword;

  if (rssUrl && rssUrl !== current.rss_url) {
    const target = await findOrCreateFeed(db, {
      title: nextTitle,
      type: current.type,
      keyword: nextKeyword,
      rssUrl,
      category: nextCategory,
    });
    const alreadySubscribed = await getUserFeed(db, userId, target.id);
    if (alreadySubscribed) throw new FeedConflictError('ALREADY_SUBSCRIBED');

    await db.batch([
      db
        .prepare('INSERT INTO user_feeds (user_id, feed_id, title, category, keyword, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(userId, target.id, nextTitle, nextCategory, nextKeyword, current.created_at),
      db.prepare('DELETE FROM user_feeds WHERE user_id = ? AND feed_id = ?').bind(userId, feedId),
    ]);
    return getUserFeed(db, userId, target.id);
  }

  await db
    .prepare('UPDATE user_feeds SET title = ?, category = ?, keyword = ? WHERE user_id = ? AND feed_id = ?')
    .bind(nextTitle, nextCategory, nextKeyword, userId, feedId)
    .run();
  return getUserFeed(db, userId, feedId);
}

/** 구독 해제 (카탈로그 피드와 아카이브 기사는 다른 구독자를 위해 남긴다) */
export async function unsubscribeUserFeed(db, userId, feedId) {
  const { meta } = await db
    .prepare('DELETE FROM user_feeds WHERE user_id = ? AND feed_id = ?')
    .bind(userId, feedId)
    .run();
  return meta.changes > 0;
}

// ============================================================
// 사용자별 기사 상태 (읽음/북마크/스크랩)
// ============================================================

/**
 * 여러 article_id에 대해 동일한 read/bookmark 상태를 한 번에 적용 (전체 선택 → 일괄 읽음 처리 등).
 * D1의 batch API로 하나의 트랜잭션에 묶어 처리한다.
 */
export async function bulkUpsertArticleStatus(db, userId, articleIds, { isRead, isBookmarked }) {
  const uniqueIds = [...new Set(articleIds)];
  if (uniqueIds.length === 0) return { updated: 0 };

  const nextRead = isRead !== undefined ? (isRead ? 1 : 0) : null;
  const nextBookmarked = isBookmarked !== undefined ? (isBookmarked ? 1 : 0) : null;

  // COALESCE로 전달되지 않은 필드는 기존 값을 유지 (신규 행은 0으로 시작)
  const statements = uniqueIds.map((id) =>
    db
      .prepare(
        `INSERT INTO user_article_status (user_id, article_id, is_read, is_bookmarked, updated_at)
         VALUES (?, ?, COALESCE(?, 0), COALESCE(?, 0), CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, article_id) DO UPDATE SET
           is_read = COALESCE(?, is_read),
           is_bookmarked = COALESCE(?, is_bookmarked),
           updated_at = CURRENT_TIMESTAMP`
      )
      .bind(userId, id, nextRead, nextBookmarked, nextRead, nextBookmarked)
  );

  await db.batch(statements);
  return { updated: uniqueIds.length };
}

/**
 * 매일 오전 10시(Today News 확정 시점) — 지정된 이름의 피드에 속한 기사의 스크랩/북마크 "표시 상태"를 초기화.
 * 사용자마다 자기가 그 이름으로 구독한 피드 기준으로 적용된다.
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
         AND EXISTS (
           SELECT 1 FROM archived_articles a
           JOIN user_feeds uf ON uf.feed_id = a.feed_id AND uf.user_id = user_article_status.user_id
           WHERE a.article_id = user_article_status.article_id
             AND uf.title IN (${placeholders})
         )`
    )
    .bind(...feedTitles)
    .run();

  return { updated: result.meta.changes ?? 0 };
}

/**
 * 여러 article_id에 대한 이 사용자의 read/bookmark/pick 상태를 한 번에 조회.
 * D1(SQLite)은 한 쿼리당 바인딩 가능한 변수 개수에 제한(약 100개)이 있어
 * 청크 단위로 나눠 조회한 뒤 결과를 병합한다.
 * @returns {Map<string, {is_read: number, is_bookmarked: number, is_picked: number}>}
 */
export async function getStatusMap(db, userId, articleIds) {
  const uniqueIds = [...new Set(articleIds)];
  if (uniqueIds.length === 0) return new Map();

  const CHUNK_SIZE = 90; // D1 변수 제한(100)보다 여유 있게 설정 (user_id 1개 포함)
  const map = new Map();

  for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const { results } = await db
      .prepare(
        `SELECT article_id, is_read, is_bookmarked, is_picked
         FROM user_article_status
         WHERE user_id = ? AND article_id IN (${placeholders})`
      )
      .bind(userId, ...chunk)
      .all();

    for (const row of results) {
      map.set(row.article_id, row);
    }
  }

  return map;
}

/**
 * READ / UNREAD / BOOKMARK 상태 upsert.
 * isRead, isBookmarked 중 전달된 값만 갱신 (부분 업데이트 지원).
 */
export async function upsertArticleStatus(db, userId, articleId, { isRead, isBookmarked }) {
  const current = await db
    .prepare('SELECT * FROM user_article_status WHERE user_id = ? AND article_id = ?')
    .bind(userId, articleId)
    .first();

  const nextRead = isRead !== undefined ? (isRead ? 1 : 0) : current?.is_read ?? 0;
  const nextBookmarked =
    isBookmarked !== undefined ? (isBookmarked ? 1 : 0) : current?.is_bookmarked ?? 0;

  await db
    .prepare(
      `INSERT INTO user_article_status (user_id, article_id, is_read, is_bookmarked, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, article_id) DO UPDATE SET
         is_read = excluded.is_read,
         is_bookmarked = excluded.is_bookmarked,
         updated_at = CURRENT_TIMESTAMP`
    )
    .bind(userId, articleId, nextRead, nextBookmarked)
    .run();

  return { articleId, isRead: !!nextRead, isBookmarked: !!nextBookmarked };
}

// ============================================================
// 아카이브 (사용자 공용)
// ============================================================

/**
 * article.embedding을 DB 저장용 문자열로 변환.
 * embedding은 두 가지 형태로 들어올 수 있다: 아카이브에서 그대로 이어받은 미파싱 JSON 문자열,
 * 또는 이번 요청/Cron에서 새로 계산된 숫자 배열. 문자열이면 이미 저장 가능한 형태이므로 그대로
 * 두고(다시 JSON.stringify하면 이중 인코딩되어 값이 깨진다), 배열이면 새로 stringify한다.
 */
function toEmbeddingColumn(embedding) {
  if (embedding == null) return null;
  return typeof embedding === 'string' ? embedding : JSON.stringify(embedding);
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
      .map((a) => {
        const epoch = a.pubDate ? Date.parse(a.pubDate) : NaN;
        return db
          .prepare(
            `INSERT INTO archived_articles
               (article_id, feed_id, feed_title, title, link, source, category, pub_date, pub_date_epoch, summary, embedding, first_seen_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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
            Number.isFinite(epoch) ? epoch : null,
            a.summary ?? '',
            toEmbeddingColumn(a.embedding)
          );
      });
    if (statements.length > 0) await db.batch(statements);
  }
}

/**
 * 특정 feed_id 목록에 대한 아카이브 기사 조회.
 * @param {number|null} sinceEpoch - 주어지면 이 시각(ms) 이후 pub_date_epoch만 조회 — 화면에 안 쓰일
 *   기간 밖 기사까지 매번 통째로 읽어와 처리하던 CPU 낭비를 없애기 위함(실측으로 확인된 병목).
 *   pub_date를 파싱 못해 pub_date_epoch이 NULL인 행은 기존 JS 필터와 동일하게 제외된다.
 */
export async function getArchivedArticles(db, feedIds, sinceEpoch = null) {
  if (!feedIds || feedIds.length === 0) return [];

  const epochClause = sinceEpoch !== null ? ' AND pub_date_epoch >= ?' : '';
  const CHUNK_SIZE = 90;
  let all = [];
  for (let i = 0; i < feedIds.length; i += CHUNK_SIZE) {
    const chunk = feedIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const bindArgs = sinceEpoch !== null ? [...chunk, sinceEpoch] : chunk;
    const { results } = await db
      .prepare(`SELECT * FROM archived_articles WHERE feed_id IN (${placeholders})${epochClause}`)
      .bind(...bindArgs)
      .all();
    all = all.concat(results);
  }
  return all;
}

// ============================================================
// 사용자별 Today News 스크랩
// ============================================================

/**
 * Today News용 Pick 추가.
 * user_article_status.is_picked를 세우는 동시에, RSS가 사라져도 남도록 picked_articles에 스냅샷 저장.
 */
export async function addPick(db, userId, article) {
  const { articleId, title, link, source, category, feedTitle, pubDate } = article;
  const pickedAtIso = new Date().toISOString();
  const digestDate = computeDigestDate(pickedAtIso);

  await db.batch([
    db
      .prepare(
        `INSERT INTO user_article_status (user_id, article_id, is_read, is_bookmarked, is_picked, updated_at)
         VALUES (?, ?, 0, 0, 1, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, article_id) DO UPDATE SET
           is_picked = 1,
           updated_at = CURRENT_TIMESTAMP`
      )
      .bind(userId, articleId),
    db
      .prepare(
        `INSERT INTO picked_articles (user_id, article_id, title, link, source, category, feed_title, pub_date, digest_date, picked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, article_id) DO UPDATE SET
           title = excluded.title,
           link = excluded.link,
           source = excluded.source,
           category = excluded.category,
           feed_title = excluded.feed_title,
           pub_date = excluded.pub_date,
           digest_date = excluded.digest_date,
           picked_at = CURRENT_TIMESTAMP`
      )
      .bind(userId, articleId, title, link, source ?? '', category ?? '일반', feedTitle ?? '', pubDate ?? '', digestDate),
  ]);

  return { articleId, isPicked: true, digestDate };
}

/** Pick 해제 (스냅샷 삭제 + 플래그 해제) */
export async function removePick(db, userId, articleId) {
  await db.batch([
    db
      .prepare(
        `UPDATE user_article_status SET is_picked = 0, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND article_id = ?`
      )
      .bind(userId, articleId),
    db.prepare('DELETE FROM picked_articles WHERE user_id = ? AND article_id = ?').bind(userId, articleId),
  ]);

  return { articleId, isPicked: false };
}

/**
 * 기간 내 Pick된 기사 스냅샷 목록 조회 (최신순).
 * @param {string|null} sinceIso - 이 시각 이후로 Pick된 것만 (없으면 전체)
 */
export async function getPicks(db, userId, sinceIso = null) {
  const order = 'ORDER BY digest_date DESC, sort_order ASC, picked_at DESC';
  const query = sinceIso
    ? db.prepare(`SELECT * FROM picked_articles WHERE user_id = ? AND picked_at >= ? ${order}`).bind(userId, sinceIso)
    : db.prepare(`SELECT * FROM picked_articles WHERE user_id = ? ${order}`).bind(userId);

  const { results } = await query.all();
  return results;
}

/**
 * 스크랩 기사들의 순서(sort_order)를 한 번에 갱신.
 * @param {Array<{articleId: string, sortOrder: number}>} orderedItems
 */
export async function updatePickOrder(db, userId, orderedItems) {
  if (!orderedItems || orderedItems.length === 0) return { updated: 0 };

  const statements = orderedItems.map(({ articleId, sortOrder }) =>
    db
      .prepare('UPDATE picked_articles SET sort_order = ? WHERE user_id = ? AND article_id = ?')
      .bind(sortOrder, userId, articleId)
  );
  await db.batch(statements);
  return { updated: orderedItems.length };
}

// ============================================================
// 어드민
// ============================================================

/** 사용자 목록 + 구독/스크랩 수 (승인 대기자가 맨 위) */
export async function listUsersWithStats(db) {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.email, u.name, u.picture, u.role, u.status, u.created_at, u.approved_at,
              u.last_login_at, u.last_seen_at,
              (SELECT COUNT(*) FROM user_feeds uf WHERE uf.user_id = u.id) AS feed_count,
              (SELECT COUNT(*) FROM picked_articles p WHERE p.user_id = u.id) AS pick_count
       FROM users u
       ORDER BY CASE u.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, u.created_at DESC`
    )
    .all();
  return results;
}

export async function getUserById(db, userId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
}

/** 어드민이 사용자 상태/권한 변경. 처음 active가 될 때 approved_at 기록 */
export async function updateUserByAdmin(db, userId, { status, role }) {
  const user = await getUserById(db, userId);
  if (!user) return null;

  const nextStatus = status ?? user.status;
  const nextRole = role ?? user.role;
  await db
    .prepare(
      `UPDATE users SET status = ?, role = ?,
         approved_at = CASE WHEN ? = 'active' AND approved_at IS NULL THEN CURRENT_TIMESTAMP ELSE approved_at END
       WHERE id = ?`
    )
    .bind(nextStatus, nextRole, nextStatus, userId)
    .run();
  return getUserById(db, userId);
}

/** 전체 피드 카탈로그 + 구독자 수/이름, 아카이브 기사 수, 마지막 수집 상태 */
export async function listFeedCatalog(db) {
  const { results } = await db
    .prepare(
      `SELECT f.*,
              (SELECT COUNT(*) FROM user_feeds uf WHERE uf.feed_id = f.id) AS subscriber_count,
              (SELECT GROUP_CONCAT(COALESCE(u.name, u.email, '사용자 ' || u.id), ', ')
                 FROM user_feeds uf JOIN users u ON u.id = uf.user_id WHERE uf.feed_id = f.id) AS subscribers,
              (SELECT COUNT(*) FROM archived_articles a WHERE a.feed_id = f.id) AS article_count
       FROM feeds f
       ORDER BY subscriber_count DESC, f.created_at DESC`
    )
    .all();
  return results;
}

/** 카탈로그 피드를 여러 사용자에게 일괄 구독시킴 (이미 구독 중인 사용자는 건너뜀) */
export async function assignFeedToUsers(db, feedId, userIds) {
  const feed = await getFeedById(db, feedId);
  if (!feed) return null;
  const uniqueIds = [...new Set(userIds.map(Number).filter(Number.isFinite))];
  if (uniqueIds.length === 0) return { added: 0 };

  const statements = uniqueIds.map((uid) =>
    db
      .prepare(
        `INSERT INTO user_feeds (user_id, feed_id, title, category, keyword)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, feed_id) DO NOTHING`
      )
      .bind(uid, feed.id, feed.title, feed.category || '일반', feed.keyword ?? null)
  );
  const results = await db.batch(statements);
  const added = results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
  return { added };
}

/** 카탈로그에서 피드 완전 삭제 (모든 사용자의 구독 포함). 아카이브 기사는 스크랩 기록 보존을 위해 남긴다 */
export async function deleteFeedCompletely(db, feedId) {
  const results = await db.batch([
    db.prepare('DELETE FROM user_feeds WHERE feed_id = ?').bind(feedId),
    db.prepare('DELETE FROM feeds WHERE id = ?').bind(feedId),
  ]);
  return (results[1].meta?.changes ?? 0) > 0;
}

/** 어드민 대시보드 통계 */
export async function getAdminStats(db) {
  const kstDay = (col) => `date(${col}, '+9 hours')`;
  const [userStatus, activity, feeds, subs, articles, picks, signups, pickDays] = await db.batch([
    db.prepare('SELECT status, COUNT(*) AS c FROM users GROUP BY status'),
    db.prepare(
      `SELECT
         SUM(CASE WHEN last_seen_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS active_1d,
         SUM(CASE WHEN last_seen_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS active_7d,
         SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS new_7d
       FROM users`
    ),
    db.prepare(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN id IN (SELECT feed_id FROM user_feeds) THEN 1 ELSE 0 END) AS subscribed,
         SUM(CASE WHEN last_fetch_ok = 0 AND id IN (SELECT feed_id FROM user_feeds) THEN 1 ELSE 0 END) AS failing
       FROM feeds`
    ),
    db.prepare('SELECT COUNT(*) AS c FROM user_feeds'),
    db.prepare(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN first_seen_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS new_1d
       FROM archived_articles`
    ),
    db.prepare(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN picked_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS new_7d
       FROM picked_articles`
    ),
    db.prepare(
      `SELECT ${kstDay('created_at')} AS day, COUNT(*) AS c FROM users
       WHERE created_at >= datetime('now', '-30 days') GROUP BY day ORDER BY day`
    ),
    db.prepare(
      `SELECT ${kstDay('picked_at')} AS day, COUNT(*) AS c FROM picked_articles
       WHERE picked_at >= datetime('now', '-30 days') GROUP BY day ORDER BY day`
    ),
  ]);

  const byStatus = Object.fromEntries(userStatus.results.map((r) => [r.status, r.c]));
  const act = activity.results[0] || {};
  const f = feeds.results[0] || {};
  const a = articles.results[0] || {};
  const p = picks.results[0] || {};

  return {
    users: {
      total: Object.values(byStatus).reduce((s, c) => s + c, 0),
      active: byStatus.active ?? 0,
      pending: byStatus.pending ?? 0,
      suspended: byStatus.suspended ?? 0,
      active1d: act.active_1d ?? 0,
      active7d: act.active_7d ?? 0,
      new7d: act.new_7d ?? 0,
    },
    feeds: { total: f.total ?? 0, subscribed: f.subscribed ?? 0, failing: f.failing ?? 0 },
    subscriptions: subs.results[0]?.c ?? 0,
    articles: { total: a.total ?? 0, new1d: a.new_1d ?? 0 },
    picks: { total: p.total ?? 0, new7d: p.new_7d ?? 0 },
    signupsByDay: signups.results.map((r) => ({ day: r.day, count: r.c })),
    picksByDay: pickDays.results.map((r) => ({ day: r.day, count: r.c })),
  };
}
