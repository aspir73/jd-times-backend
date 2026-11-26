import { fetchArticlesForFeed } from './rss.js';
import { groupArticles, groupArticlesHybrid, HYBRID_EMBEDDING_MAX_N } from './grouping.js';
import { hashArticleId } from './utils/hash.js';
import { formatKstDisplay } from './utils/kstDisplay.js';
import { decodeGoogleNewsUrl } from './utils/googleNewsDecoder.js';
import { computeEmbeddings } from './utils/embeddings.js';
import { backfillOriginalLinks, isDailyExportRun, sendDailyExport } from './dailyExport.js';

/**
 * 매시 정각 Cron (wrangler.toml crons와 같은 문자열이어야 함).
 * 3의 배수 시(UTC)에는 예전 '0 *\/3 * * *'처럼 전체 수집, 나머지 시각에는 원문 링크 변환만 한다.
 * (무료 플랜은 계정당 Cron 5개 제한이라 변환 전용 Cron을 따로 둘 수 없어 하나로 합침)
 */
const HOURLY_CRON = '0 * * * *';
const DECODE_ONLY_BUDGET = 45; // 외부 요청 50개 한도 안 (변환 1건 = NAS 릴레이 요청 1개)
import {
  verifyGoogleIdToken,
  upsertGoogleUser,
  createSession,
  getSessionUser,
  deleteSession,
  deleteAllSessionsForUser,
  publicUser,
} from './auth.js';
import {
  getSubscribedFeeds,
  getPriorityFeedIds,
  recordFeedFetchResults,
  getUserFeeds,
  getUserFeed,
  subscribeUserToFeed,
  updateUserFeed,
  unsubscribeUserFeed,
  FeedConflictError,
  getStatusMap,
  upsertArticleStatus,
  bulkUpsertArticleStatus,
  addPick,
  removePick,
  getPicks,
  updatePickOrder,
  upsertArchivedArticles,
  getArchivedArticles,
  resetDailyMarkers,
  listUsersWithStats,
  getUserById,
  updateUserByAdmin,
  listFeedCatalog,
  assignFeedToUsers,
  deleteFeedCompletely,
  getAdminStats,
} from './db.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
};

/**
 * 요청 헤더의 X-API-Key와 env.API_KEY를 상수시간으로 비교.
 * 둘 다 SHA-256으로 해시해서 길이를 고정시킨 뒤 바이트 단위로 비교하므로,
 * 문자열 길이/내용에 따라 비교 시간이 달라지는 타이밍 사이드채널을 피한다.
 */
async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

/**
 * 앱 단위 공유 키(API_KEY). 사용자 인증은 세션 토큰이 담당하고, 이 키는 우리 프론트가 아닌 곳에서
 * Worker를 두드리는 봇을 걸러내는 가벼운 1차 관문으로 남겨둔다.
 * env.API_KEY가 설정 안 돼 있으면(로컬 개발 등) 건너뛴다.
 */
async function checkApiKey(request, env) {
  if (!env.API_KEY) return true;
  const provided = request.headers.get('X-API-Key') || '';
  return timingSafeEqual(provided, env.API_KEY);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function buildGoogleRssUrl(keyword) {
  const q = encodeURIComponent(keyword);
  return `https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`;
}

function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 아카이브 DB row(snake_case)를 프론트에서 쓰는 article 포맷(camelCase)으로 변환.
 * 주의: embedding은 여기서 JSON.parse하지 않고 원문 문자열 그대로 둔다 — bge-m3 벡터(1024차원)
 * JSON을 매 요청마다 수백~수천 건씩 파싱하는 게 CPU 비용의 대부분을 차지했었다(실측 확인).
 * 실제로 임베딩 기반 클러스터링에 쓰일 때만(parseEmbeddingIfNeeded 참고) 그때 가서 파싱한다.
 * 어차피 클러스터 응답(strip)에서 embedding 필드는 항상 제거되므로 프론트에는 영향 없다.
 */
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
    embedding: row.embedding || null, // 아직 JSON 문자열 그대로 (미파싱)
  };
}

/** priorityArticles가 hybrid 클러스터링의 임베딩 상한 이내일 때만, 그 안전한 개수만큼만 파싱한다 */
function parseEmbeddingsIfWithinBudget(priorityArticles) {
  if (priorityArticles.length > HYBRID_EMBEDDING_MAX_N) return; // 어차피 단어겹침 전용으로 처리되어 임베딩 미사용
  for (const a of priorityArticles) {
    if (typeof a.embedding === 'string') {
      try {
        a.embedding = JSON.parse(a.embedding);
      } catch {
        a.embedding = null;
      }
    }
  }
}

const DEFAULT_WINDOW_HOURS = 24 * 2; // 기본 표시 기간: 2일 (Workers 무료 플랜 CPU 10ms 예산 안에서 안정적으로 처리 가능한 기사 수로 맞춤)

/** '보안'/'LG전자' 피드(사용자가 정한 피드 이름 기준) — 임베딩 클러스터링 대상 & 매일 10시 스크랩/북마크 리셋 대상 */
const PRIORITY_FEED_TITLES = ['보안', 'LG전자'];

/** 일반 사용자가 스스로 구독할 수 있는 피드 수 상한 (사용자가 늘어도 Cron 수집량이 폭증하지 않게). 어드민 API는 제한 없음 */
const MAX_FEEDS_PER_USER = 50;

/** ?hours= 파라미터 해석. 없으면 기본 2일, 'all'/'0'이면 필터 없음(전체 기간) */
function resolveWindowHours(hoursParam) {
  if (!hoursParam) return DEFAULT_WINDOW_HOURS;
  const normalized = hoursParam.toLowerCase();
  if (normalized === 'all' || normalized === '0') return null;
  const parsed = Number(hoursParam);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WINDOW_HOURS;
}

// ============================================================
// 인증
// ============================================================

/**
 * POST /api/auth/google
 * body: { credential }  — Google Identity Services가 준 ID 토큰
 * 신규 가입자는 pending 상태로 만들어지고, 세션은 발급되지만 어드민 승인 전까지 /api/auth/me 외에는 403.
 */
async function handleGoogleLogin(request, env) {
  const body = await readJson(request);
  if (!body?.credential) return json({ error: 'CREDENTIAL_REQUIRED' }, 400);

  let claims;
  try {
    claims = await verifyGoogleIdToken(body.credential, env);
  } catch (err) {
    return json({ error: 'INVALID_GOOGLE_TOKEN', detail: String(err?.message || err) }, 401);
  }

  const user = await upsertGoogleUser(env.DB, claims, env);
  const { token, expiresAt } = await createSession(env.DB, user.id);
  return json({ token, expiresAt, user: publicUser(user) });
}

// ============================================================
// 기사 목록
// ============================================================

/**
 * GET /api/rss?feedId=1  또는  ?category=AI%2F보안  (둘 다 없으면 이 사용자의 전체 구독 피드)
 * ?force=true 로 캐시 무시하고 강제 새로고침
 * ?hours=48(기본, 2일) | 숫자 | 'all'(전체 기간)
 *
 * 실시간 RSS 수집 결과 + 아카이브(Cron/이전 수집분)를 병합해서 응답한다.
 * 수집·아카이브는 사용자 공용이고, 피드 이름/카테고리와 읽음·북마크·스크랩 상태만 사용자별로 입힌다.
 */
async function handleGetRss(request, env, ctx, user) {
  const url = new URL(request.url);
  const feedId = url.searchParams.get('feedId');
  const category = url.searchParams.get('category');
  const hoursParam = url.searchParams.get('hours');
  const force = url.searchParams.get('force') === 'true';
  const windowHours = resolveWindowHours(hoursParam);

  let feeds;
  if (feedId) {
    const feed = await getUserFeed(env.DB, user.id, feedId);
    feeds = feed ? [feed] : [];
  } else {
    feeds = await getUserFeeds(env.DB, user.id, category);
  }

  if (feeds.length === 0) {
    return json({ clusters: [], totalArticles: 0, fetchedAt: new Date().toISOString() });
  }

  // 사용자가 정한 피드 이름/카테고리 (응답에만 입힘 — 아카이브에는 카탈로그 공용 값으로 저장)
  const userFeedMeta = new Map(feeds.map((f) => [f.id, { title: f.title, category: f.category }]));

  // 1) 실시간 RSS 수집 (실패한 피드는 건너뛰고 나머지는 정상 응답). KV 캐시가 RSS 주소 기준이라 사용자 간에 공유된다
  const settledResults = await Promise.allSettled(
    feeds.map((feed) =>
      fetchArticlesForFeed(
        { id: feed.id, rss_url: feed.rss_url, title: feed.catalog_title, category: feed.catalog_category },
        env,
        force
      )
    )
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

  // 2) 아카이브에서 같은 피드들의 과거 기사 조회 후 병합 (최신 실시간 데이터가 우선, 임베딩은 있으면 이어받음)
  // 기간 필터와 같은 기준(windowHours)으로 DB 단에서부터 걸러서, 화면에 안 쓰일 기간 밖 기사까지
  // 매번 통째로 읽어와 처리하는 낭비를 없앤다(아카이브가 쌓일수록 CPU 제한을 넘기는 주요 원인이었다).
  const archiveSinceEpoch = windowHours !== null ? Date.now() - windowHours * 60 * 60 * 1000 : null;
  const archivedRows = await getArchivedArticles(
    env.DB,
    feeds.map((f) => f.id),
    archiveSinceEpoch
  );
  const archivedMap = new Map(archivedRows.map((row) => [row.article_id, archivedRowToArticle(row)]));

  // 실시간으로 새로 받아온 기사는 기존 아카이브에 임베딩이 캐시되어 있으면 그대로 이어받음
  freshArticles = freshArticles.map((a) => ({
    ...a,
    embedding: archivedMap.get(a.articleId)?.embedding ?? null,
  }));

  // 아카이브 반영은 응답을 기다리지 않고 백그라운드로 처리 (실패해도 응답에는 영향 없음)
  // 시간창 필터와 무관하게 이번에 새로 수집한 기사는 전부 저장 — "전체 기간" 검색의 완전성을 위해
  if (freshArticles.length > 0) {
    ctx.waitUntil(upsertArchivedArticles(env.DB, freshArticles).catch(() => {}));
  }

  const merged = new Map(archivedMap);
  for (const a of freshArticles) merged.set(a.articleId, a);

  // 이 사용자의 피드 이름/카테고리로 표시
  let allArticles = [...merged.values()].map((a) => {
    const meta = userFeedMeta.get(a.feedId);
    return meta ? { ...a, feedTitle: meta.title, category: meta.category || '일반' } : a;
  });

  // 3) 기간 필터 (?hours=all 이면 전체) — 화면에 표시할 대상만 추림
  if (windowHours !== null) {
    const cutoff = Date.now() - windowHours * 60 * 60 * 1000;
    allArticles = allArticles.filter((a) => {
      const t = new Date(a.pubDate).getTime();
      return !Number.isNaN(t) && t >= cutoff;
    });
  }

  // 4) '보안'/'LG전자' 피드 기사만 임베딩 기반(의미 유사) 클러스터링 대상으로 삼는다.
  //    나머지는 기존 단어겹침 방식 사용.
  //    주의: 임베딩 계산(Workers AI 호출)은 여기서 실시간으로 하지 않는다 — Workers 무료 플랜의
  //    CPU 10ms 제한을 넘겨서 요청 자체가 503(Exceeded CPU Limit)으로 죽는 문제가 있었다.
  //    대신 3시간마다(오전 7~10시는 30분마다) 도는 Cron(runScheduledArchive)이 백그라운드에서
  //    미리 계산해 아카이브에 저장해두고, 여기서는 그 캐시된 값만 이어받는다. 그래서 방금 수집된
  //    기사는 다음 Cron 주기까지 임베딩이 없을 수 있고, 그동안은 단어겹침 신호만으로 클러스터링된다.
  const priorityArticles = allArticles.filter((a) => PRIORITY_FEED_TITLES.includes(a.feedTitle));
  const otherArticles = allArticles.filter((a) => !PRIORITY_FEED_TITLES.includes(a.feedTitle));

  // 클러스터링: 보안/LG전자는 임베딩 기반(의미 유사), 나머지는 단어겹침 기반(AI 호출 없음) — 결과를 합쳐서 반환
  priorityArticles.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
  otherArticles.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());

  parseEmbeddingsIfWithinBudget(priorityArticles);
  const priorityClusters = groupArticlesHybrid(priorityArticles);
  const otherClusters = groupArticles(otherArticles);

  const clusters = [...priorityClusters, ...otherClusters].sort(
    (a, b) => new Date(b.primaryArticle.pubDate).getTime() - new Date(a.primaryArticle.pubDate).getTime()
  );

  // read/bookmark/pick 상태 매핑 (articleId는 이미 부여되어 있음)
  const allIds = clusters.flatMap((c) => [
    c.primaryArticle.articleId,
    ...c.relatedArticles.map((r) => r.articleId),
  ]);
  const statusMap = await getStatusMap(env.DB, user.id, allIds);

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

// ============================================================
// 피드 구독 (사용자 본인 + 어드민이 대신 관리할 때 공용)
// ============================================================

/**
 * 피드 등록 body 검증 → 정규화된 값 또는 { error }
 * body: { type: 'GOOGLE_KEYWORD'|'MEDIA_PRESET'|'CUSTOM', title, keyword?, rssUrl?, category? }
 */
function parseFeedPayload(body) {
  const { type, title, keyword, rssUrl, category } = body || {};
  if (!type || !title) return { error: 'MISSING_REQUIRED_FIELDS', required: ['type', 'title'] };

  let finalRssUrl = rssUrl;
  if (type === 'GOOGLE_KEYWORD') {
    if (!keyword) return { error: 'KEYWORD_REQUIRED_FOR_GOOGLE_KEYWORD' };
    finalRssUrl = buildGoogleRssUrl(keyword);
  }
  if (!finalRssUrl) return { error: 'RSS_URL_REQUIRED' };
  if (!isHttpUrl(finalRssUrl)) return { error: 'INVALID_RSS_URL' };

  return { type, title: String(title).trim(), keyword: keyword ?? null, rssUrl: finalRssUrl, category: category || '일반' };
}

async function createFeedForUser(env, userId, body, { enforceLimit }) {
  const payload = parseFeedPayload(body);
  if (payload.error) return json(payload, 400);

  if (enforceLimit) {
    const count = (await getUserFeeds(env.DB, userId)).length;
    if (count >= MAX_FEEDS_PER_USER) return json({ error: 'FEED_LIMIT_REACHED', limit: MAX_FEEDS_PER_USER }, 400);
  }

  try {
    const feed = await subscribeUserToFeed(env.DB, userId, payload);
    return json(feed, 201);
  } catch (err) {
    if (err instanceof FeedConflictError) return json({ error: 'ALREADY_SUBSCRIBED' }, 409);
    throw err;
  }
}

/** PATCH 피드 body: { title?, category?, rssUrl?, keyword? } — 이 사용자의 구독만 바뀐다 */
async function patchFeedForUser(request, env, userId, feedId) {
  const body = await readJson(request);
  if (!body) return json({ error: 'INVALID_JSON_BODY' }, 400);
  if (body.rssUrl !== undefined && !isHttpUrl(body.rssUrl)) return json({ error: 'INVALID_RSS_URL' }, 400);

  try {
    const updated = await updateUserFeed(env.DB, userId, feedId, body);
    if (!updated) return json({ error: 'FEED_NOT_FOUND' }, 404);
    return json(updated);
  } catch (err) {
    if (err instanceof FeedConflictError) return json({ error: 'ALREADY_SUBSCRIBED' }, 409);
    throw err;
  }
}

async function deleteFeedForUser(env, userId, feedId) {
  const deleted = await unsubscribeUserFeed(env.DB, userId, feedId);
  if (!deleted) return json({ error: 'FEED_NOT_FOUND' }, 404);
  return json({ id: Number(feedId), deleted: true });
}

// ============================================================
// 기사 상태 / 스크랩
// ============================================================

/**
 * PATCH /api/articles/status
 * body: { articleId?: string, link?: string, isRead?: boolean, isBookmarked?: boolean }
 * articleId 대신 link를 주면 서버에서 해시하여 사용 가능.
 */
async function handlePatchStatus(request, env, user) {
  const body = await readJson(request);
  if (!body) return json({ error: 'INVALID_JSON_BODY' }, 400);

  const { articleId, link, isRead, isBookmarked } = body;

  if (!articleId && !link) {
    return json({ error: 'ARTICLE_ID_OR_LINK_REQUIRED' }, 400);
  }
  if (isRead === undefined && isBookmarked === undefined) {
    return json({ error: 'NO_STATUS_FIELD_PROVIDED' }, 400);
  }

  const id = articleId || (await hashArticleId(link));
  const result = await upsertArticleStatus(env.DB, user.id, id, { isRead, isBookmarked });
  return json(result);
}

/**
 * PATCH /api/articles/status/bulk
 * body: { articleIds: string[], isRead?: boolean, isBookmarked?: boolean }
 * 전체 선택 → 읽음/읽지 않음 일괄 처리용.
 */
async function handleBulkPatchStatus(request, env, user) {
  const body = await readJson(request);
  if (!body) return json({ error: 'INVALID_JSON_BODY' }, 400);

  const { articleIds, isRead, isBookmarked } = body;

  if (!Array.isArray(articleIds) || articleIds.length === 0) {
    return json({ error: 'ARTICLE_IDS_REQUIRED' }, 400);
  }
  if (isRead === undefined && isBookmarked === undefined) {
    return json({ error: 'NO_STATUS_FIELD_PROVIDED' }, 400);
  }

  const result = await bulkUpsertArticleStatus(env.DB, user.id, articleIds, { isRead, isBookmarked });
  return json(result);
}

const PERIOD_HOURS = { today: 24, week: 24 * 7, month: 24 * 31 };

/**
 * POST /api/picks
 * body: { articleId, title, link, source?, category?, pubDate }
 * Today News에 담기 (RSS가 사라져도 남도록 스냅샷 저장)
 */
async function handleAddPick(request, env, user) {
  const body = await readJson(request);
  if (!body) return json({ error: 'INVALID_JSON_BODY' }, 400);

  const { articleId, title, link } = body;
  if (!articleId || !title || !link) {
    return json({ error: 'MISSING_REQUIRED_FIELDS', required: ['articleId', 'title', 'link'] }, 400);
  }

  // 구글 뉴스 리다이렉트 링크면 원본 기사 URL로 디코딩 시도 (실패해도 조용히 원본 링크 유지)
  const resolvedLink = await decodeGoogleNewsUrl(link, env);

  const result = await addPick(env.DB, user.id, { ...body, link: resolvedLink });
  return json(result, 201);
}

/** DELETE /api/picks/:articleId */
async function handleRemovePick(env, user, articleId) {
  const result = await removePick(env.DB, user.id, articleId);
  return json(result);
}

/**
 * PATCH /api/picks/reorder
 * body: { articleIds: string[] }  — 원하는 순서 그대로 (0번이 맨 앞)
 */
async function handleReorderPicks(request, env, user) {
  const body = await readJson(request);
  if (!body) return json({ error: 'INVALID_JSON_BODY' }, 400);

  const { articleIds } = body;
  if (!Array.isArray(articleIds) || articleIds.length === 0) {
    return json({ error: 'ARTICLE_IDS_REQUIRED' }, 400);
  }

  const orderedItems = articleIds.map((articleId, index) => ({ articleId, sortOrder: index }));
  const result = await updatePickOrder(env.DB, user.id, orderedItems);
  return json(result);
}

/** GET /api/picks?period=today|week|month  (기본: 전체) */
async function handleGetPicks(request, env, user) {
  const url = new URL(request.url);
  const period = url.searchParams.get('period');

  let sinceIso = null;
  if (period && PERIOD_HOURS[period]) {
    sinceIso = new Date(Date.now() - PERIOD_HOURS[period] * 60 * 60 * 1000).toISOString();
  }

  // link 디코딩은 스크랩 시점(handleAddPick)에 이미 끝난 상태 — 조회할 때마다 다시 시도하면
  // (구글의 비공식 batchexecute API가 실패할 경우) 기사 하나당 최대 10번까지 순차 재시도가 붙어서
  // Today/주간/월간 조회 자체가 몇십 초씩 걸리는 문제가 있었다(실측 확인).
  const picks = await getPicks(env.DB, user.id, sinceIso);
  const picksWithDisplay = picks.map((p) => ({
    ...p,
    pub_date_display: formatKstDisplay(p.pub_date),
  }));
  return json({ picks: picksWithDisplay });
}

// ============================================================
// 어드민
// ============================================================

const USER_STATUSES = new Set(['pending', 'active', 'suspended']);
const USER_ROLES = new Set(['user', 'admin']);

/** PATCH /api/admin/users/:id  body: { status?, role? } */
async function handleAdminPatchUser(request, env, admin, userId) {
  const body = await readJson(request);
  if (!body) return json({ error: 'INVALID_JSON_BODY' }, 400);

  const { status, role } = body;
  if (status !== undefined && !USER_STATUSES.has(status)) return json({ error: 'INVALID_STATUS' }, 400);
  if (role !== undefined && !USER_ROLES.has(role)) return json({ error: 'INVALID_ROLE' }, 400);
  // 실수로 자기 자신을 정지/강등해서 어드민이 아무도 없게 되는 것 방지
  if (Number(userId) === admin.id) return json({ error: 'CANNOT_MODIFY_SELF' }, 400);

  const updated = await updateUserByAdmin(env.DB, userId, { status, role });
  if (!updated) return json({ error: 'USER_NOT_FOUND' }, 404);
  if (updated.status === 'suspended') await deleteAllSessionsForUser(env.DB, updated.id);
  return json({ user: publicUser(updated) });
}

/** POST /api/admin/feeds/:id/assign  body: { userIds: number[] } 또는 { allActive: true } */
async function handleAdminAssignFeed(request, env, feedId) {
  const body = await readJson(request);
  if (!body) return json({ error: 'INVALID_JSON_BODY' }, 400);

  let userIds = Array.isArray(body.userIds) ? body.userIds : [];
  if (body.allActive) {
    userIds = (await listUsersWithStats(env.DB)).filter((u) => u.status === 'active').map((u) => u.id);
  }
  if (userIds.length === 0) return json({ error: 'USER_IDS_REQUIRED' }, 400);

  const result = await assignFeedToUsers(env.DB, feedId, userIds);
  if (!result) return json({ error: 'FEED_NOT_FOUND' }, 404);
  return json(result);
}

/** /api/admin/* 라우팅 (호출 전에 어드민 권한 확인됨) */
async function routeAdmin(request, env, admin, pathname) {
  const method = request.method;

  // 07시 시트 내보내기를 지금 바로 한 번 실행 (Apps Script 연결 확인용) — 지난 24시간 수집분
  if (pathname === '/api/admin/export-sheet' && method === 'POST') {
    return json(await sendDailyExport(env));
  }
  if (pathname === '/api/admin/stats' && method === 'GET') {
    return json(await getAdminStats(env.DB));
  }
  if (pathname === '/api/admin/users' && method === 'GET') {
    return json({ users: await listUsersWithStats(env.DB) });
  }

  const userMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (userMatch && method === 'PATCH') {
    return handleAdminPatchUser(request, env, admin, userMatch[1]);
  }

  // 특정 사용자의 구독 피드를 어드민이 대신 관리
  const userFeedsMatch = pathname.match(/^\/api\/admin\/users\/(\d+)\/feeds$/);
  if (userFeedsMatch) {
    const userId = Number(userFeedsMatch[1]);
    if (!(await getUserById(env.DB, userId))) return json({ error: 'USER_NOT_FOUND' }, 404);
    if (method === 'GET') return json({ feeds: await getUserFeeds(env.DB, userId) });
    if (method === 'POST') return createFeedForUser(env, userId, await readJson(request), { enforceLimit: false });
  }
  const userFeedMatch = pathname.match(/^\/api\/admin\/users\/(\d+)\/feeds\/(\d+)$/);
  if (userFeedMatch) {
    const [, userId, feedId] = userFeedMatch;
    if (method === 'PATCH') return patchFeedForUser(request, env, Number(userId), feedId);
    if (method === 'DELETE') return deleteFeedForUser(env, Number(userId), feedId);
  }

  if (pathname === '/api/admin/feeds' && method === 'GET') {
    return json({ feeds: await listFeedCatalog(env.DB) });
  }
  const assignMatch = pathname.match(/^\/api\/admin\/feeds\/(\d+)\/assign$/);
  if (assignMatch && method === 'POST') {
    return handleAdminAssignFeed(request, env, assignMatch[1]);
  }
  const feedMatch = pathname.match(/^\/api\/admin\/feeds\/(\d+)$/);
  if (feedMatch && method === 'DELETE') {
    const deleted = await deleteFeedCompletely(env.DB, feedMatch[1]);
    if (!deleted) return json({ error: 'FEED_NOT_FOUND' }, 404);
    return json({ id: Number(feedMatch[1]), deleted: true });
  }

  return json({ error: 'NOT_FOUND' }, 404);
}

// ============================================================
// Cron
// ============================================================

/** Cron 트리거: 구독자가 있는 모든 피드를 강제 수집해서 아카이브에 반영 (사람이 앱을 안 열어도 실행됨) */
async function runScheduledArchive(env) {
  const feeds = await getSubscribedFeeds(env.DB);
  if (feeds.length === 0) return;

  const settled = await Promise.allSettled(
    feeds.map((feed) => fetchArticlesForFeed(feed, env, true)) // force=true: 캐시 무시하고 매번 새로 수집
  );

  let all = [];
  const fetchResults = [];
  settled.forEach((result, idx) => {
    if (result.status === 'fulfilled') {
      all = all.concat(result.value);
      fetchResults.push({ feedId: feeds[idx].id, ok: true, count: result.value.length });
    } else {
      fetchResults.push({ feedId: feeds[idx].id, ok: false, error: String(result.reason) });
    }
  });

  const withIds = await Promise.all(
    all.map(async (a) => ({ ...a, articleId: await hashArticleId(a.link) }))
  );

  // '보안'/'LG전자'로 구독된 피드 기사는 임베딩까지 미리 계산해서 저장해둔다.
  // (Cron은 사용자 요청을 기다리게 하지 않으니, 실시간 요청에서 못 다 채운 나머지를 여기서 채운다.
  //  실시간 응답이 임베딩 계산 때문에 느려지거나 타임아웃 나는 걸 막기 위한 구조.)
  const priorityFeedIds = await getPriorityFeedIds(env.DB, PRIORITY_FEED_TITLES);
  const priorityItems = withIds.filter((a) => priorityFeedIds.has(a.feedId));
  const EMBEDDING_BATCH_SIZE = 50;
  for (let i = 0; i < priorityItems.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = priorityItems.slice(i, i + EMBEDDING_BATCH_SIZE);
    const vectors = await computeEmbeddings(
      env.AI,
      batch.map((a) => a.title)
    );
    batch.forEach((a, idx) => {
      a.embedding = vectors[idx] ?? null;
    });
  }
  console.log('[cron] 임베딩 사전 계산:', priorityItems.filter((a) => a.embedding).length, '/', priorityItems.length);

  await upsertArchivedArticles(env.DB, withIds);
  await recordFeedFetchResults(env.DB, fetchResults);

  // 새 기사 링크를 원문 주소로 조금씩 변환 (07시 시트 내보내기·CEO 기사 선정에서 원문을 직접 읽기 위함).
  // 무료 플랜은 실행당 외부 요청 50개 제한 — 피드 수집(재시도 포함 피드당 최대 2회)에 쓰고 남은 만큼만 쓴다.
  const decodeBudget = Math.max(0, 40 - feeds.length * 2);
  try {
    const r = await backfillOriginalLinks(env, decodeBudget);
    if (r.tried) console.log('[cron] 원문 링크 변환:', r.decoded, '/', r.tried);
  } catch (err) {
    console.log('[cron] 원문 링크 변환 실패(무시):', String(err?.message || err));
  }
}

// ============================================================
// 라우팅
// ============================================================

async function routeUser(request, env, ctx, user, pathname) {
  const method = request.method;

  if (pathname === '/api/rss' && method === 'GET') {
    return handleGetRss(request, env, ctx, user);
  }
  if (pathname === '/api/feeds' && method === 'GET') {
    const category = new URL(request.url).searchParams.get('category');
    return json({ feeds: await getUserFeeds(env.DB, user.id, category) });
  }
  if (pathname === '/api/feeds' && method === 'POST') {
    return createFeedForUser(env, user.id, await readJson(request), { enforceLimit: user.role !== 'admin' });
  }

  const feedIdMatch = pathname.match(/^\/api\/feeds\/(\d+)$/);
  if (feedIdMatch) {
    const feedId = feedIdMatch[1];
    if (method === 'PATCH') return patchFeedForUser(request, env, user.id, feedId);
    if (method === 'DELETE') return deleteFeedForUser(env, user.id, feedId);
  }

  if (pathname === '/api/picks/reorder' && method === 'PATCH') {
    return handleReorderPicks(request, env, user);
  }
  if (pathname === '/api/picks' && method === 'GET') {
    return handleGetPicks(request, env, user);
  }
  if (pathname === '/api/picks' && method === 'POST') {
    return handleAddPick(request, env, user);
  }
  const pickIdMatch = pathname.match(/^\/api\/picks\/(.+)$/);
  if (pickIdMatch && method === 'DELETE') {
    return handleRemovePick(env, user, decodeURIComponent(pickIdMatch[1]));
  }

  if (pathname === '/api/articles/status/bulk' && method === 'PATCH') {
    return handleBulkPatchStatus(request, env, user);
  }
  if (pathname === '/api/articles/status' && method === 'PATCH') {
    return handlePatchStatus(request, env, user);
  }

  return json({ error: 'NOT_FOUND' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (!(await checkApiKey(request, env))) {
      return json({ error: 'UNAUTHORIZED' }, 401);
    }

    const { pathname } = new URL(request.url);

    try {
      if (pathname === '/api/auth/google' && request.method === 'POST') {
        return await handleGoogleLogin(request, env);
      }

      const user = await getSessionUser(request, env, ctx);
      if (!user) return json({ error: 'LOGIN_REQUIRED' }, 401);

      if (pathname === '/api/auth/me' && request.method === 'GET') {
        return json({ user: publicUser(user) });
      }
      if (pathname === '/api/auth/logout' && request.method === 'POST') {
        await deleteSession(request, env);
        return json({ ok: true });
      }

      // 승인 대기/정지 계정은 위의 본인 정보 조회·로그아웃만 가능
      if (user.status !== 'active') {
        return json({ error: user.status === 'pending' ? 'ACCOUNT_PENDING' : 'ACCOUNT_SUSPENDED' }, 403);
      }

      if (pathname.startsWith('/api/admin/')) {
        if (user.role !== 'admin') return json({ error: 'FORBIDDEN' }, 403);
        return await routeAdmin(request, env, user, pathname);
      }

      return await routeUser(request, env, ctx, user, pathname);
    } catch (err) {
      return json({ error: 'INTERNAL_ERROR', detail: String(err?.message || err) }, 500);
    }
  },

  /** Cloudflare Cron Trigger 진입점 (wrangler.toml의 [triggers] crons 설정에 의해 호출됨) */
  async scheduled(event, env, ctx) {
    if (event.cron === '0 1 * * *') {
      // 01:00 UTC = 오전 10시 KST — Today News 확정 시점.
      // 마감 직전 마지막 수집을 한 번 더 한 뒤(막판에 나온 기사도 놓치지 않도록), 지정 피드의 표시 상태 리셋.
      ctx.waitUntil(
        runScheduledArchive(env).then(() => resetDailyMarkers(env.DB, PRIORITY_FEED_TITLES))
      );
    } else if (isDailyExportRun(event)) {
      // 22:00 UTC = 오전 7시 KST — 수집(+원문 링크 변환) 후 지난 24시간 수집분을 구글 시트로 내보낸다.
      ctx.waitUntil(
        runScheduledArchive(env)
          .then(() => sendDailyExport(env, { endMs: event.scheduledTime }))
          .then((r) => console.log('[cron] 시트 내보내기:', JSON.stringify(r).slice(0, 300)))
          .catch((err) => console.log('[cron] 시트 내보내기 실패:', String(err?.message || err)))
      );
    } else if (event.cron === HOURLY_CRON && new Date(event.scheduledTime).getUTCHours() % 3 !== 0) {
      // 3의 배수가 아닌 매시 정각 — 수집 없이 원문 링크 변환만 (외부 요청 50개 한도를 변환에 거의 다 씀).
      // 수집 Cron 안의 변환 몫(피드 수에 따라 20건 안팎)만으로는 하루 수집량(150건+)을 못 따라가서 추가.
      ctx.waitUntil(
        backfillOriginalLinks(env, DECODE_ONLY_BUDGET)
          .then((r) => console.log('[cron] 원문 링크 변환:', JSON.stringify(r)))
          .catch((err) => console.log('[cron] 원문 링크 변환 실패:', String(err?.message || err)))
      );
    } else {
      // '0 * * * *' 중 3시간마다(종일), '*/30 22-23 * * *'·'30 0 * * *'(오전 7~10시 KST, 30분마다) 모두 수집만.
      ctx.waitUntil(runScheduledArchive(env));
    }
  },
};
