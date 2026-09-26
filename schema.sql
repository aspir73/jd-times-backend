-- ============================================================
-- JD Times - Cloudflare D1 스키마 (통합본)
-- 적용(새 DB): wrangler d1 execute jd-times-db --file=./schema.sql
--
-- 이 파일은 migration_002~008의 결과까지 전부 반영된 "현재 최종 스키마"다.
-- 이미 운영 중인 DB에는 절대 다시 실행하지 말 것(CREATE TABLE은 IF NOT EXISTS라
-- 안전하지만, 과거 히스토리 추적용으로 각 migration_*.sql 파일은 그대로 남겨둔다).
-- ============================================================

-- 1. 구독 피드 테이블
CREATE TABLE IF NOT EXISTS feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,              -- 'GOOGLE_KEYWORD' | 'MEDIA_PRESET' | 'CUSTOM'
  keyword VARCHAR(255),                    -- GOOGLE_KEYWORD인 경우 원본 키워드 보관 (재생성/표시용)
  rss_url TEXT NOT NULL UNIQUE,
  category VARCHAR(100) DEFAULT '일반',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_feeds_category ON feeds(category);

-- 2. 기사 상태 관리 테이블 (READ/UNREAD/BOOKMARK/PICK)
CREATE TABLE IF NOT EXISTS user_article_status (
  article_id VARCHAR(255) PRIMARY KEY,     -- 기사 link의 SHA-256 해시
  is_read BOOLEAN DEFAULT 0,
  is_bookmarked BOOLEAN DEFAULT 0,
  is_picked BOOLEAN DEFAULT 0,             -- migration_002: Today News "스크랩" 여부
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_status_bookmarked ON user_article_status(is_bookmarked);

-- 3. Today News 스크랩 스냅샷 (RSS가 사라져도 남도록 별도 보관)
CREATE TABLE IF NOT EXISTS picked_articles (
  article_id VARCHAR(255) PRIMARY KEY,
  title TEXT NOT NULL,
  link TEXT NOT NULL,
  source VARCHAR(255),
  category VARCHAR(100),
  feed_title VARCHAR(255),                 -- migration_003
  pub_date VARCHAR(100),
  digest_date VARCHAR(10),                 -- migration_005: "다이제스트 날짜"(YYYY-MM-DD, 오전 9시 기준)
  sort_order INTEGER DEFAULT 0,            -- migration_007: 사용자가 지정한 표시 순서
  picked_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_picked_at ON picked_articles(picked_at);
CREATE INDEX IF NOT EXISTS idx_digest_date ON picked_articles(digest_date);

-- 4. 아카이브 테이블 (Cron + 실시간 수집 결과 누적, "전체 기간" 검색의 기반)
CREATE TABLE IF NOT EXISTS archived_articles (
  article_id VARCHAR(255) PRIMARY KEY,
  feed_id INTEGER,
  feed_title VARCHAR(255),
  title TEXT NOT NULL,
  link TEXT NOT NULL,
  source VARCHAR(255),
  category VARCHAR(100),
  pub_date VARCHAR(100),
  pub_date_epoch INTEGER,                  -- migration_008: pub_date를 파싱한 밀리초 타임스탬프 (SQL 필터/정렬용)
  summary TEXT,
  embedding TEXT,                          -- migration_006: bge-m3 임베딩 벡터(JSON 문자열 캐시)
  first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_archived_feed ON archived_articles(feed_id);
CREATE INDEX IF NOT EXISTS idx_archived_pub_date_epoch ON archived_articles(pub_date_epoch);

-- 5. (선택) 국내 언론사 프리셋 - 최초 시딩용, 필요시 주석 해제 후 사용
-- INSERT INTO feeds (title, type, rss_url, category) VALUES
--  ('전자신문', 'MEDIA_PRESET', 'https://rss.etnews.com/Section901.xml', 'IT/테크'),
--  ('한국경제', 'MEDIA_PRESET', 'https://www.hankyung.com/feed/economy', '경제'),
--  ('조선일보', 'MEDIA_PRESET', 'https://www.chosun.com/arc/outboundfeeds/rss/', '종합');
