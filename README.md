# JD Times Backend (Cloudflare Worker + D1 + KV)

## 1. 초기 설정

```bash
npm install

# D1 데이터베이스 생성 (최초 1회)
npx wrangler d1 create jd-times-db
# 출력된 database_id를 wrangler.toml의 <YOUR_D1_DATABASE_ID>에 붙여넣기

# KV 네임스페이스 생성 (최초 1회)
npx wrangler kv namespace create RSS_CACHE
# 출력된 id를 wrangler.toml의 <YOUR_KV_NAMESPACE_ID>에 붙여넣기

# 스키마 적용
npm run db:migrate:remote   # 배포용
npm run db:migrate:local    # 로컬 개발용 (wrangler dev)
```

## 2. 로컬 개발 / 배포

```bash
npm run dev       # http://localhost:8787 에서 로컬 실행
npm run deploy    # Cloudflare에 배포
```

## 3. API 엔드포인트

### GET /api/rss
피드를 수집(+15분 KV 캐싱) → 유사 뉴스 클러스터링 → read/bookmark 상태 병합 후 반환.

쿼리 파라미터 (모두 선택):
| 파라미터 | 설명 |
|---|---|
| `feedId` | 특정 피드 하나만 조회 |
| `category` | 카테고리로 필터링 (예: `AI/보안`) |
| `hours` | 최근 N시간 이내 기사만 필터링 (예: `24`) |

응답 예시:
```json
{
  "clusters": [
    {
      "clusterId": "c0_...",
      "keyword": "[AI 보안]",
      "primaryArticle": {
        "title": "AI 보안 위협 급증, 기업 대응 분주",
        "link": "https://news.google.com/rss/articles/...",
        "pubDate": "Sun, 26 Jul 2026 09:00:00 GMT",
        "source": "전자신문",
        "category": "AI/보안",
        "feedId": 1,
        "articleId": "3f1a...",
        "isRead": false,
        "isBookmarked": false
      },
      "relatedArticles": [ /* 동일 형식, 유사 기사들 */ ]
    }
  ],
  "totalArticles": 42
}
```
일부 피드 수집이 실패해도 나머지는 정상 반환되며, 실패 피드는 `failedFeeds` 필드로 함께 내려갑니다.

### GET /api/feeds
등록된 피드 목록 조회 (사이드바 카테고리 트리 구성용). `?category=` 필터 지원.

### POST /api/feeds
새 피드 등록.
```json
// 구글 키워드 방식 — keyword만 넘기면 서버가 RSS URL 자동 생성
{ "type": "GOOGLE_KEYWORD", "title": "AI 보안", "keyword": "AI 보안", "category": "AI/보안" }

// 언론사 프리셋 / 커스텀 — rssUrl 직접 지정
{ "type": "MEDIA_PRESET", "title": "전자신문", "rssUrl": "https://rss.etnews.com/Section901.xml", "category": "IT/테크" }
```

### PATCH /api/articles/status
읽음/북마크 상태 변경. `articleId` 또는 원본 `link` 중 하나만 넘기면 됨 (link는 서버에서 자동 해시).
```json
{ "articleId": "3f1a...", "isRead": true }
{ "link": "https://news.google.com/rss/articles/...", "isBookmarked": true }
```

## 4. 설계 메모

- **봇 차단 회피**: 데스크톱 Chrome UA + Accept-Language 헤더를 모든 RSS 요청에 동반 (`src/rss.js`).
- **캐싱**: 동일 `rss_url` 요청은 KV에 15분(900초) 저장 후 재사용하여 구글 서버 직접 요청 최소화.
- **클러스터링**: 조사 제거 후 명사 토큰화 → Jaccard 유사도 60% 이상이면 동일 그룹으로 묶음 (`src/grouping.js`). 대표 키워드는 그룹 내 최다 빈출 토큰 1~2개.
- **article_id**: 기사 링크(쿼리스트링 제거 + trailing slash 제거 후)의 SHA-256 해시. 프론트에서 별도 상태를 들고 있을 필요 없이 링크만으로 상태 조회/변경 가능.
- 실제 배포 전, 국내 언론사 프리셋 RSS 주소는 각 언론사 정책 확인 후 `schema.sql` 하단 시딩 INSERT 참고하여 등록 권장.
