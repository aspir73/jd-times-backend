import { fetchArticlesForFeed } from './rss.js';
import { groupArticles } from './grouping.js';
import { hashArticleId } from './utils/hash.js';
import { formatKstDisplay } from './utils/kstDisplay.js';
import {
  getAllFeeds,
  getFeedById,
  insertFeed,
  updateFeed,
  deleteFeed,
  getStatusMap,
  upsertArticleStatus,
  bulkUpsertArticleStatus,
  addPick,
  removePick,
  getPicks,
  upsertArchivedArticles,
  getArchivedArticles,
} from './db.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

function buildGoogleRssUrl(keyword) {
  const q = encodeURIComponent(keyword);
  return `https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`;
}

/** 아카이브 DB row(snake_case)를 프론트에서 쓰는 article 포맷(camelCase)으로 변환 */
function archivedRowToArticle(row) {
  return {
    articleId: row.article_id,
    feedId: row.feed_id,
    feedTitle: row.feed_title || '',
    title: row.title,
    link: row.link,
    source: row.source || '',
    category: row.category || '일반',
    pubDate: row.pub_date || '',
    summary: row.summary || '',
  };
}

const DEFAULT_WINDOW_HOURS = 24 * 3; // 기본 표시 기간: 3일

/** ?hours= 파라미터 해석. 없으면 기본 7일, 'all'/'0'이면 필터 없음(전체 기간) */
function resolveWindowHours(hoursParam) {
  if (!hoursParam) return DEFAULT_WINDOW_HOURS;
  const normalized = hoursParam.toLowerCase();
  if (normalized === 'all' || normalized === '0') return null;
  const parsed = Number(hoursParam);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WINDOW_HOURS;
}

/**
 * GET /api/rss?feedId=1  또는  ?category=AI%2F보안  (둘 다 없으면 전체 피드)
 * ?force=true 로 캐시 무시하고 강제 새로고침
 * ?hours=168(기본, 7일) | 숫자 | 'all'(전체 기간)
 *
 * 실시간 RSS 수집 결과 + 아카이브(Cron/이전 수집분)를 병합해서 응답한다.
 * 실시간 수집 결과는 응답을 막지 않고 백그라운드로 아카이브에 반영된다.
 */
async function handleGetRss(request, env, ctx) {
  const url = new URL(request.url);
  const feedId = url.searchParams.get('feedId');
  const category = url.searchParams.get('category');
  const hoursParam = url.searchParams.get('hours');
  const force = url.searchParams.get('force') === 'true';
  const windowHours = resolveWindowHours(hoursParam);

  let feeds;
  if (feedId) {
    const feed = await getFeedById(env.DB, feedId);
    feeds = feed ? [feed] : [];
  } else {
    feeds = await getAllFeeds(env.DB, category);
  }

  if (feeds.length === 0) {
    return json({ clusters: [], totalArticles: 0, fetchedAt: new Date().toISOString() });
  }

  // 1) 실시간 RSS 수집 (실패한 피드는 건너뛰고 나머지는 정상 응답)
  const settledResults = await Promise.allSettled(
    feeds.map((feed) => fetchArticlesForFeed(feed, env, force))
  );

  const failedFeeds = [];
  let freshArticles = [];
  settledResults.forEach((result, idx) => {
    if (result.status === 'fulfilled') {
      freshArticles = freshArticles.concat(result.value);
    } else {
      failedFeeds.push({ feedId: feeds[idx].id, title: feeds[idx].title, error: String(result.reason) });
    }
  });

  // article_id 부여 (아카이브 저장 및 이후 상태 매핑에 필요)
  freshArticles = await Promise.all(
    freshArticles.map(async (a) => ({ ...a, articleId: await hashArticleId(a.link) }))
  );

  // 아카이브 반영은 응답을 기다리지 않고 백그라운드로 처리 (실패해도 응답에는 영향 없음)
  if (freshArticles.length > 0) {
    ctx.waitUntil(upsertArchivedArticles(env.DB, freshArticles).catch(() => {}));
  }

  // 2) 아카이브에서 같은 피드들의 과거 기사 조회 후 병합 (최신 실시간 데이터가 우선)
  const archivedRows = await getArchivedArticles(
    env.DB,
    feeds.map((f) => f.id)
  );
  const merged = new Map();
  for (const row of archivedRows) merged.set(row.article_id, archivedRowToArticle(row));
  for (const a of freshArticles) merged.set(a.articleId, a);
  let allArticles = [...merged.values()];

  // 3) 기간 필터 (기본 7일, ?hours=all 이면 전체)
  if (windowHours !== null) {
    const cutoff = Date.now() - windowHours * 60 * 60 * 1000;
    allArticles = allArticles.filter((a) => {
      const t = new Date(a.pubDate).getTime();
      return !Number.isNaN(t) && t >= cutoff;
    });
  }

  // 최신순 정렬 후 클러스터링
  allArticles.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
  const clusters = groupArticles(allArticles, 0.6);

  // read/bookmark/pick 상태 매핑 (articleId는 이미 부여되어 있음)
  const allIds = clusters.flatMap((c) => [
    c.primaryArticle.articleId,
    ...c.relatedArticles.map((r) => r.articleId),
  ]);
  const statusMap = await getStatusMap(env.DB, allIds);

  const withStatus = clusters.map((cluster) => {
    const applyStatus = (article) => {
      const status = statusMap.get(article.articleId);
      return {
        ...article,
        isRead: !!status?.is_read,
        isBookmarked: !!status?.is_bookmarked,
        isPicked: !!status?.is_picked,
        pubDateDisplay: formatKstDisplay(article.pubDate),
      };
    };
    const primaryArticle = applyStatus(cluster.primaryArticle);
    const relatedArticles = cluster.relatedArticles.map(applyStatus);

    // 유사 기사 그룹핑은 매 요청마다 다시 계산되므로, 대표 기사가 바뀌어도
    // 그룹 안에 이미 읽은 기사가 하나라도 있으면 전체를 "읽음"으로 취급한다.
    // (안 그러면 이미 읽은 소식인데 새 기사와 묶이면서 다시 "안읽음"으로 보이는 문제가 생김)
    const anyRead = primaryArticle.isRead || relatedArticles.some((a) => a.isRead);
    const finalPrimary = anyRead ? { ...primaryArticle, isRead: true } : primaryArticle;
    const finalRelated = anyRead
      ? relatedArticles.map((a) => ({ ...a, isRead: true }))
      : relatedArticles;

    return {
      ...cluster,
      primaryArticle: finalPrimary,
      relatedArticles: finalRelated,
    };
  });

  return json({
    clusters: withStatus,
    totalArticles: allArticles.length,
    fetchedAt: new Date().toISOString(),
    ...(failedFeeds.length > 0 ? { failedFeeds } : {}),
  });
}

/** GET /api/feeds?category=... */
async function handleGetFeeds(request, env) {
  const url = new URL(request.url);
  const category = url.searchParams.get('category');
  const feeds = await getAllFeeds(env.DB, category);
  return json({ feeds });
}

/**
 * POST /api/feeds
 * body: { type: 'GOOGLE_KEYWORD'|'MEDIA_PRESET'|'CUSTOM', title, keyword?, rssUrl?, category? }
 */
async function handlePostFeed(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'INVALID_JSON_BODY' }, 400);
  }

  const { type, title, keyword, rssUrl, category } = body;

  if (!type || !title) {
    return json({ error: 'MISSING_REQUIRED_FIELDS', required: ['type', 'title'] }, 400);
  }

  let finalRssUrl = rssUrl;
  if (type === 'GOOGLE_KEYWORD') {
    if (!keyword) return json({ error: 'KEYWORD_REQUIRED_FOR_GOOGLE_KEYWORD' }, 400);
    finalRssUrl = buildGoogleRssUrl(keyword);
  }

  if (!finalRssUrl) {
    return json({ error: 'RSS_URL_REQUIRED' }, 400);
  }

  try {
    const feedId = await insertFeed(env.DB, {
      title,
      type,
      keyword: keyword ?? null,
      rssUrl: finalRssUrl,
      category,
    });
    return json({ id: feedId, title, type, rssUrl: finalRssUrl, category: category || '일반' }, 201);
  } catch (err) {
    // UNIQUE 제약(rss_url 중복) 등
    return json({ error: 'FEED_INSERT_FAILED', detail: String(err) }, 409);
  }
}

/**
 * PATCH /api/articles/status
 * body: { articleId?: string, link?: string, isRead?: boolean, isBookmarked?: boolean }
 * articleId 대신 link를 주면 서버에서 해시하여 사용 가능.
 */
async function handlePatchStatus(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'INVALID_JSON_BODY' }, 400);
  }

  const { articleId, link, isRead, isBookmarked } = body;

  if (!articleId && !link) {
    return json({ error: 'ARTICLE_ID_OR_LINK_REQUIRED' }, 400);
  }
  if (isRead === undefined && isBookmarked === undefined) {
    return json({ error: 'NO_STATUS_FIELD_PROVIDED' }, 400);
  }

  const id = articleId || (await hashArticleId(link));
  const result = await upsertArticleStatus(env.DB, id, { isRead, isBookmarked });
  return json(result);
}

/**
 * PATCH /api/articles/status/bulk
 * body: { articleIds: string[], isRead?: boolean, isBookmarked?: boolean }
 * 전체 선택 → 읽음/읽지 않음 일괄 처리용.
 */
async function handleBulkPatchStatus(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'INVALID_JSON_BODY' }, 400);
  }

  const { articleIds, isRead, isBookmarked } = body;

  if (!Array.isArray(articleIds) || articleIds.length === 0) {
    return json({ error: 'ARTICLE_IDS_REQUIRED' }, 400);
  }
  if (isRead === undefined && isBookmarked === undefined) {
    return json({ error: 'NO_STATUS_FIELD_PROVIDED' }, 400);
  }

  const result = await bulkUpsertArticleStatus(env.DB, articleIds, { isRead, isBookmarked });
  return json(result);
}

/** PATCH /api/feeds/:id  body: { title?, category?, rssUrl? } */
async function handlePatchFeed(request, env, feedId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'INVALID_JSON_BODY' }, 400);
  }

  const updated = await updateFeed(env.DB, feedId, body);
  if (!updated) return json({ error: 'FEED_NOT_FOUND' }, 404);
  return json(updated);
}

/** DELETE /api/feeds/:id */
async function handleDeleteFeed(env, feedId) {
  const deleted = await deleteFeed(env.DB, feedId);
  if (!deleted) return json({ error: 'FEED_NOT_FOUND' }, 404);
  return json({ id: Number(feedId), deleted: true });
}

const PERIOD_HOURS = { today: 24, week: 24 * 7, month: 24 * 31 };

/**
 * POST /api/picks
 * body: { articleId, title, link, source?, category?, pubDate }
 * Today News에 담기 (RSS가 사라져도 남도록 스냅샷 저장)
 */
async function handleAddPick(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'INVALID_JSON_BODY' }, 400);
  }

  const { articleId, title, link } = body;
  if (!articleId || !title || !link) {
    return json({ error: 'MISSING_REQUIRED_FIELDS', required: ['articleId', 'title', 'link'] }, 400);
  }

  const result = await addPick(env.DB, body);
  return json(result, 201);
}

/** DELETE /api/picks/:articleId */
async function handleRemovePick(env, articleId) {
  const result = await removePick(env.DB, articleId);
  return json(result);
}

/** GET /api/picks?period=today|week|month  (기본: 전체) */
async function handleGetPicks(request, env) {
  const url = new URL(request.url);
  const period = url.searchParams.get('period');

  let sinceIso = null;
  if (period && PERIOD_HOURS[period]) {
    sinceIso = new Date(Date.now() - PERIOD_HOURS[period] * 60 * 60 * 1000).toISOString();
  }

  const picks = await getPicks(env.DB, sinceIso);
  const picksWithDisplay = picks.map((p) => ({ ...p, pub_date_display: formatKstDisplay(p.pub_date) }));
  return json({ picks: picksWithDisplay });
}

/** Cron 트리거: 등록된 모든 피드를 강제 수집해서 아카이브에 반영 (사람이 앱을 안 열어도 실행됨) */
async function runScheduledArchive(env) {
  const feeds = await getAllFeeds(env.DB);
  if (feeds.length === 0) return;

  const settled = await Promise.allSettled(
    feeds.map((feed) => fetchArticlesForFeed(feed, env, true)) // force=true: 캐시 무시하고 매번 새로 수집
  );

  let all = [];
  settled.forEach((result) => {
    if (result.status === 'fulfilled') all = all.concat(result.value);
  });

  const withIds = await Promise.all(
    all.map(async (a) => ({ ...a, articleId: await hashArticleId(a.link) }))
  );

  await upsertArchivedArticles(env.DB, withIds);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === '/api/rss' && request.method === 'GET') {
        return await handleGetRss(request, env, ctx);
      }
      if (pathname === '/api/feeds' && request.method === 'GET') {
        return await handleGetFeeds(request, env);
      }
      if (pathname === '/api/feeds' && request.method === 'POST') {
        return await handlePostFeed(request, env);
      }

      const feedIdMatch = pathname.match(/^\/api\/feeds\/(\d+)$/);
      if (feedIdMatch) {
        const feedId = feedIdMatch[1];
        if (request.method === 'PATCH') {
          return await handlePatchFeed(request, env, feedId);
        }
        if (request.method === 'DELETE') {
          return await handleDeleteFeed(env, feedId);
        }
      }

      if (pathname === '/api/picks' && request.method === 'GET') {
        return await handleGetPicks(request, env);
      }
      if (pathname === '/api/picks' && request.method === 'POST') {
        return await handleAddPick(request, env);
      }
      const pickIdMatch = pathname.match(/^\/api\/picks\/(.+)$/);
      if (pickIdMatch && request.method === 'DELETE') {
        return await handleRemovePick(env, decodeURIComponent(pickIdMatch[1]));
      }

      if (pathname === '/api/articles/status/bulk' && request.method === 'PATCH') {
        return await handleBulkPatchStatus(request, env);
      }
      if (pathname === '/api/articles/status' && request.method === 'PATCH') {
        return await handlePatchStatus(request, env);
      }

      return json({ error: 'NOT_FOUND' }, 404);
    } catch (err) {
      return json({ error: 'INTERNAL_ERROR', detail: String(err?.message || err) }, 500);
    }
  },

  /** Cloudflare Cron Trigger 진입점 (wrangler.toml의 [triggers] crons 설정에 의해 호출됨) */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledArchive(env));
  },
};
