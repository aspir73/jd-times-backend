/**
 * 유사도 기반 클러스터링 & 대표 키워드(1~2 워딩) 추출 엔진
 *
 * v3: 기본 클러스터링은 Cloudflare Workers AI 임베딩(bge-m3) 기반 코사인 유사도로 전환.
 * 단어 겹침(기존 groupArticles)은 임베딩 실패 시 폴백용으로 유지.
 */
import { cosineSimilarity } from './utils/embeddings.js';

// 제거 대상 한국어 조사/불용어 (어미 매칭용, 접미사로 사용)
const PARTICLES = [
  '으로부터', '에게서', '까지는', '에서는',
  '으로는', '이라고', '라고는', '에서도',
  '부터', '까지', '에서', '으로', '에게',
  '이라', '라는', '이는', '으는',
  '이나', '나마', '조차', '마저', '마다',
  '에도', '와의', '과의', '한테',
  '은', '는', '이', '가', '을', '를',
  '에', '의', '와', '과', '도', '만', '로',
];

const STOPWORDS = new Set([
  '단독', '속보', '종합', '오늘', '내일', '어제',
  '기자', '뉴스', '이번', '지난', '올해', '내년',
]);

/**
 * 대표기사 선정용 언론사 신뢰도 가중치.
 * 주요 통신사/일간지/전문지에 가점을 주고, 목록에 없는 언론사는 기본값(1)을 사용한다.
 * (참고: 본문 길이는 저희가 원문을 긁어오지 않아서 점수에 못 넣고, 대신 RSS 요약문 유무/길이로 대체한다.)
 */
const SOURCE_CREDIBILITY = {
  연합뉴스: 2.0,
  '연합뉴스TV': 1.8,
  KBS: 1.8,
  MBC: 1.8,
  SBS: 1.8,
  YTN: 1.6,
  조선일보: 1.6,
  중앙일보: 1.6,
  동아일보: 1.6,
  한국경제: 1.6,
  매일경제: 1.6,
  전자신문: 1.5,
  보안뉴스: 1.5,
  한겨레: 1.4,
  경향신문: 1.4,
  머니투데이: 1.3,
  이데일리: 1.3,
  뉴시스: 1.3,
  뉴스1: 1.3,
};

/** 대표기사 선정 점수: 언론사 신뢰도 + 최신성 + 요약문 존재/길이 */
function scoreArticleForPrimary(article) {
  const credibility = SOURCE_CREDIBILITY[article.source] ?? 1;

  const ageMs = Date.now() - new Date(article.pubDate).getTime();
  const ageHours = Number.isFinite(ageMs) ? Math.max(0, ageMs / (1000 * 60 * 60)) : 999;
  const recencyScore = Math.max(0, 1 - ageHours / 48); // 48시간 지나면 0에 수렴

  const summaryLen = (article.summary || '').length;
  const summaryScore = Math.min(summaryLen / 200, 1); // 200자 이상이면 만점

  return credibility * 2 + recencyScore * 1.5 + summaryScore * 1;
}

/** 클러스터 멤버 중 대표기사를 점수 기준으로 선택, 나머지는 관련기사로 (최신순 정렬) */
function selectPrimaryArticle(members) {
  const sortedByScore = [...members].sort(
    (a, b) => scoreArticleForPrimary(b) - scoreArticleForPrimary(a)
  );
  const [primaryArticle] = sortedByScore;
  const relatedArticles = members
    .filter((m) => m !== primaryArticle)
    .sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
  return [primaryArticle, ...relatedArticles];
}

/**
 * 언론사마다 다르게 쓰는 축약/동의 표현을 같은 단어로 정규화.
 * (예: "영업이익"을 "영업익"으로 줄여 쓰는 언론사가 많아, 그대로 두면 완전히 다른 단어로 처리되어
 *  명백히 같은 실적 발표 기사인데도 안 묶이는 문제가 있었다.)
 */
const SYNONYM_MAP = {
  영업익: '영업이익',
  순익: '순이익',
  당기순이익: '순이익',
  매출액: '매출',
  작년: '전년',
};

const DEFAULT_TIME_WINDOW_HOURS = 48;

/** 제목에서 조사를 제거하고 명사 후보 토큰을 추출 */
function tokenize(title) {
  const raw = title
    .replace(/[^\uAC00-\uD7A3a-zA-Z0-9\s]/g, ' ') // 특수문자 제거
    .split(/\s+/)
    .filter(Boolean);

  const tokens = [];
  for (let word of raw) {
    if (word.length < 2) continue;

    // 가장 긴 조사부터 매칭하여 어간만 남김
    for (const p of PARTICLES) {
      if (word.length > p.length + 1 && word.endsWith(p)) {
        word = word.slice(0, -p.length);
        break;
      }
    }

    if (word.length >= 2 && !STOPWORDS.has(word)) {
      tokens.push(SYNONYM_MAP[word] || word);
    }
  }
  return tokens;
}

/** 배치 전체에서 토큰별 문서빈도(DF) 계산 */
function computeDocFreq(tokenSets) {
  const df = new Map();
  for (const set of tokenSets) {
    for (const t of set) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  return df;
}

/** 스무딩된 IDF: 배치 내 거의 모든 기사에 등장하는 단어(피드 키워드 등)는 0에 가깝게, 드문 단어는 크게 */
function idfWeight(token, docFreq, totalDocs) {
  const df = docFreq.get(token) || 0;
  return Math.log((totalDocs + 1) / (df + 1)) + 0.01; // +0.01: 완전히 0이 되어 union 분모가 0이 되는 것 방지
}

/** IDF 가중 Jaccard 유사도 */
function weightedSimilarity(setA, setB, docFreq, totalDocs) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let interWeight = 0;
  let unionWeight = 0;
  const seen = new Set();

  for (const t of setA) {
    seen.add(t);
    const w = idfWeight(t, docFreq, totalDocs);
    unionWeight += w;
    if (setB.has(t)) interWeight += w;
  }
  for (const t of setB) {
    if (!seen.has(t)) unionWeight += idfWeight(t, docFreq, totalDocs);
  }
  return unionWeight === 0 ? 0 : interWeight / unionWeight;
}

function rawJaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function hoursBetween(dateStrA, dateStrB) {
  const a = new Date(dateStrA).getTime();
  const b = new Date(dateStrB).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0; // 날짜 파싱 실패 시 시간창 체크는 건너뜀(안전 쪽으로)
  return Math.abs(a - b) / (1000 * 60 * 60);
}

/** 제목 토큰들에서 빈도 상위 1~2개 단어로 대표 키워드 생성 */
function extractKeyword(titlesTokens) {
  const freq = new Map();
  for (const tokens of titlesTokens) {
    // 같은 기사 내 중복 토큰은 1회만 카운트 (여러 기사에 걸친 빈도를 보기 위함)
    for (const t of new Set(tokens)) {
      freq.set(t, (freq.get(t) || 0) + 1);
    }
  }

  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 2).map(([word]) => word);
  return top.join(' ') || (titlesTokens[0]?.[0] ?? '');
}

/**
 * 하이브리드 클러스터링: 단어겹침(가중 Jaccard)과 임베딩(코사인) 두 신호를
 * 하나의 Union-Find에서 함께 사용한다 — 둘 중 하나라도 임계값을 넘으면 묶는다.
 *
 * 왜 필요한가: 임베딩만 쓰면, AI 호출이 일부 실패하거나 임계값이 실제 데이터와
 * 안 맞을 때 "LG전자, 주당 500원 중간배당" 같은 누가 봐도 같은 사건(단어가 거의 다 겹침)조차
 * 놓칠 수 있다. 단어겹침은 이런 명백한 경우를 항상 잡아주는 안전망 역할을 하고,
 * 임베딩은 단어가 안 겹치는 의역 사례까지 추가로 잡아준다.
 *
 * @param {Array} articles - { title, link, pubDate, source, category, feedId, embedding }
 * @param {object} options
 * @param {number} options.lexicalThreshold - 가중 Jaccard 임계값 (기본 0.2)
 * @param {number} options.embeddingThreshold - 코사인 유사도 임계값 (기본 0.65 — 실측 로그로 재조정 중)
 * @param {number} options.timeWindowHours - 이 시간 이상 차이나면 묶지 않음 (기본 48시간)
 */
export function groupArticlesHybrid(
  articles,
  { lexicalThreshold = 0.25, embeddingThreshold = 0.65, timeWindowHours = DEFAULT_TIME_WINDOW_HOURS } = {}
) {
  const withTokens = articles.map((a) => ({ ...a, _tokens: tokenize(a.title) }));
  const tokenSets = withTokens.map((a) => new Set(a._tokens));
  const n = withTokens.length;

  if (n === 0) return [];

  // 원래 "보안/LG전자 소량 배치" 전제로 O(n^2) 전수비교를 하도록 만들었는데, 실제로는 며칠치
  // 아카이브가 쌓이면 수백 건까지 늘어날 수 있어 안전장치를 둔다 (초과 시 임베딩 전용 방식으로 대체).
  const MAX_FULL_PAIRWISE_N = 500;
  if (n > MAX_FULL_PAIRWISE_N) {
    console.log(`[groupArticlesHybrid] 배치가 ${n}건이라 전수비교 대신 임베딩 전용 방식으로 대체`);
    return groupArticlesByEmbedding(articles, embeddingThreshold, timeWindowHours);
  }

  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // 실제 임베딩 유사도 분포를 보기 위한 진단 로그용 (기준값 재조정 근거 마련)
  let maxEmbScoreSeen = 0;
  let embMatchCount = 0;

  // 어휘 신호는 IDF 가중치를 쓰지 않는다: 배치가 좁은 주제(단일/소수 피드)로 한정되어 있어서
  // "LG전자"·"영업이익"처럼 정확히 연결고리가 되는 핵심 단어가 오히려 흔하다는 이유로
  // 가중치가 깎여버리는 역효과가 있었다 (실측 사례로 확인됨). 그래서 순수 겹침 비율을 사용한다.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (hoursBetween(withTokens[i].pubDate, withTokens[j].pubDate) > timeWindowHours) continue;

      const lexScore = rawJaccardSimilarity(tokenSets[i], tokenSets[j]);
      if (lexScore >= lexicalThreshold) {
        union(i, j);
        continue;
      }

      if (withTokens[i].embedding && withTokens[j].embedding) {
        const embScore = cosineSimilarity(withTokens[i].embedding, withTokens[j].embedding);
        if (embScore > maxEmbScoreSeen) maxEmbScoreSeen = embScore;
        if (embScore >= embeddingThreshold) {
          union(i, j);
          embMatchCount++;
        }
      }
    }
  }

  if (n > 1) {
    console.log(
      `[groupArticlesHybrid] n=${n}, 임베딩으로 새로 묶인 쌍=${embMatchCount}, 관측된 최고 임베딩 점수=${maxEmbScoreSeen.toFixed(3)}`
    );
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  return [...groups.values()].map((indices, idx) => {
    const members = indices.map((i) => withTokens[i]);
    const [primaryArticle, ...relatedArticles] = selectPrimaryArticle(members);
    const keyword = extractKeyword(members.map((m) => m._tokens));

    const strip = ({ _tokens, embedding, ...rest }) => rest;

    return {
      clusterId: `c${idx}_${primaryArticle.pubDate ?? ''}`.replace(/\W+/g, ''),
      keyword: `[${keyword}]`,
      primaryArticle: strip(primaryArticle),
      relatedArticles: relatedArticles.map(strip),
    };
  });
}

/**
 * 임베딩(의미 벡터) 기반 클러스터링.
 * 단어가 하나도 안 겹쳐도 "의미가 비슷하면" 묶을 수 있다 (예: "해킹당했다" ↔ "보안이 뚫렸다").
 * article.embedding이 이미 채워져 있어야 한다 (호출부에서 computeEmbeddings로 미리 준비).
 *
 * 비용 최적화: pubDate로 정렬한 뒤, 슬라이딩 윈도우로 timeWindowHours를 벗어나는 순간
 * 더 볼 필요가 없으므로 즉시 break — O(n^2) 전수비교를 피한다.
 *
 * @param {Array} articles - { title, link, pubDate, source, category, feedId, embedding }
 * @param {number} threshold - 코사인 유사도 임계값 (기본 0.86 — 배포 후 실측 기반 재조정 필요)
 * @param {number} timeWindowHours
 */
export function groupArticlesByEmbedding(articles, threshold = 0.86, timeWindowHours = DEFAULT_TIME_WINDOW_HOURS) {
  const withTokens = articles
    .map((a) => ({ ...a, _tokens: tokenize(a.title) }))
    .sort((a, b) => new Date(a.pubDate).getTime() - new Date(b.pubDate).getTime());
  const n = withTokens.length;

  const MAX_PAIRWISE_N = 600;
  if (n > MAX_PAIRWISE_N) {
    return withTokens.map((a, idx) => {
      const strip = ({ _tokens, embedding, ...rest }) => rest;
      return {
        clusterId: `c${idx}_${a.pubDate ?? ''}`.replace(/\W+/g, ''),
        keyword: `[${extractKeyword([a._tokens])}]`,
        primaryArticle: strip(a),
        relatedArticles: [],
      };
    });
  }

  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (let i = 0; i < n; i++) {
    if (!withTokens[i].embedding) continue; // 임베딩 실패한 기사는 비교 대상에서 제외(안전)
    for (let j = i + 1; j < n; j++) {
      // pubDate로 정렬되어 있으므로, 시간창을 벗어나는 순간 이후는 다 벗어남 → 더 볼 필요 없음
      if (hoursBetween(withTokens[i].pubDate, withTokens[j].pubDate) > timeWindowHours) break;
      if (!withTokens[j].embedding) continue;

      const score = cosineSimilarity(withTokens[i].embedding, withTokens[j].embedding);
      if (score >= threshold) union(i, j);
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  return [...groups.values()].map((indices, idx) => {
    const members = indices.map((i) => withTokens[i]);
    const [primaryArticle, ...relatedArticles] = selectPrimaryArticle(members);
    const keyword = extractKeyword(members.map((m) => m._tokens));

    const strip = ({ _tokens, embedding, ...rest }) => rest;

    return {
      clusterId: `c${idx}_${primaryArticle.pubDate ?? ''}`.replace(/\W+/g, ''),
      keyword: `[${keyword}]`,
      primaryArticle: strip(primaryArticle),
      relatedArticles: relatedArticles.map(strip),
    };
  });
}

/**
 * 기사 배열을 유사도 기준으로 클러스터링 (단어 겹침 기반, 레거시/폴백용).
 * Union-Find(합집합-찾기) 기반: 모든 기사 쌍의 유사도를 비교해서 임계값 이상이면 연결하고,
 * 최종적으로 서로 연결된 기사들을 하나의 클러스터로 묶는다.
 *
 * @param {Array} articles - { title, link, pubDate, source, category, feedId }
 * @param {number} threshold - IDF 가중 Jaccard 유사도 임계값 (기본 0.2)
 * @param {number} timeWindowHours - 이 시간(시간 단위) 이상 차이나면 묶지 않음 (기본 48시간)
 * @returns {Array} 클러스터 배열: { clusterId, keyword, primaryArticle, relatedArticles }
 */
export function groupArticles(articles, threshold = 0.2, timeWindowHours = DEFAULT_TIME_WINDOW_HOURS) {
  const withTokens = articles.map((a) => ({
    ...a,
    _tokens: tokenize(a.title),
  }));
  const tokenSets = withTokens.map((a) => new Set(a._tokens));
  const n = withTokens.length;

  // 전체 쌍 비교는 O(n^2) — "전체 기간" 검색 등으로 매우 많아지면 Workers CPU 시간을 지킬 수 없으므로
  // 지나치게 큰 배치는 클러스터링을 건너뛰고 기사 하나하나를 개별 클러스터로 처리 (안전장치)
  const MAX_PAIRWISE_N = 1200;
  if (n > MAX_PAIRWISE_N) {
    return withTokens.map((a, idx) => {
      const strip = ({ _tokens, ...rest }) => rest;
      return {
        clusterId: `c${idx}_${a.pubDate ?? ''}`.replace(/\W+/g, ''),
        keyword: `[${extractKeyword([a._tokens])}]`,
        primaryArticle: strip(a),
        relatedArticles: [],
      };
    });
  }

  const docFreq = computeDocFreq(tokenSets);
  const totalDocs = n;

  // --- Union-Find ---
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // --- 역색인으로 후보쌍 생성 (O(n^2) 전수비교 대신) ---
  // 토큰을 아예 공유하지 않는 두 기사의 가중 유사도는 반드시 0이므로, "겹치는 단어가 있는 쌍"만
  // 비교 대상으로 삼아도 정확도 손실이 없다.
  // (주의) 예전엔 "문서의 30% 이상에 등장하는 단어는 색인 제외"를 했었는데, 이게 오히려 버그였다:
  // 특정 피드 하나만 조회하면 그 피드의 핵심 키워드(예: "안랩")가 사실상 모든 기사에 등장해서
  // 제외 대상이 되어버렸고, 정작 기사들을 이어주는 연결고리 단어가 사라져 전혀 묶이지 않는
  // 문제가 있었다. 지금은 버킷 크기 상한(MAX_BUCKET_SIZE) 하나로만 비용을 제어한다.
  const invertedIndex = new Map(); // token -> indices[]
  for (let i = 0; i < n; i++) {
    for (const t of tokenSets[i]) {
      if (!invertedIndex.has(t)) invertedIndex.set(t, []);
      invertedIndex.get(t).push(i);
    }
  }

  // 버킷이 너무 크면(반복되는 헤드라인 패턴 등) 그 토큰은 후보 생성에서 제외 (비용 폭증 방지)
  const MAX_BUCKET_SIZE = 80;
  const comparedPairs = new Set(); // "i,j" (i<j) 중복 비교 방지
  for (const indices of invertedIndex.values()) {
    if (indices.length > MAX_BUCKET_SIZE) continue;
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const i = indices[a];
        const j = indices[b];
        const pairKey = i < j ? `${i},${j}` : `${j},${i}`;
        if (comparedPairs.has(pairKey)) continue;
        comparedPairs.add(pairKey);

        if (hoursBetween(withTokens[i].pubDate, withTokens[j].pubDate) > timeWindowHours) continue;
        const score = weightedSimilarity(tokenSets[i], tokenSets[j], docFreq, totalDocs);
        if (score >= threshold) union(i, j);
      }
    }
  }

  // 같은 그룹(root)끼리 모으기
  const groups = new Map(); // root -> indices[]
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  return [...groups.values()].map((indices, idx) => {
    const members = indices.map((i) => withTokens[i]);
    const [primaryArticle, ...relatedArticles] = selectPrimaryArticle(members);
    const keyword = extractKeyword(members.map((m) => m._tokens));

    const strip = ({ _tokens, ...rest }) => rest;

    return {
      clusterId: `c${idx}_${primaryArticle.pubDate ?? ''}`.replace(/\W+/g, ''),
      keyword: `[${keyword}]`,
      primaryArticle: strip(primaryArticle),
      relatedArticles: relatedArticles.map(strip),
    };
  });
}
