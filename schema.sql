-- ============================================================
-- JD Times - Cloudflare D1 스키마 (통합본)
-- 적용(새 DB): wrangler d1 execute jd-times-db --file=./schema.sql
--
-- 이 파일은 migration_002~009의 결과까지 전부 반영된 "현재 최종 스키마"다.
-- 이미 운영 중인 DB에는 절대 다시 실행하지 말 것(CREATE TABLE은 IF NOT EXISTS라
-- 안전하지만, 과거 히스토리 추적용으로 각 migration_*.sql 파일은 그대로 남겨둔다).
-- ============================================================

-- 1. 사용자 (migration_009) — Google 로그인, 가입 후 어드민 승인
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub VARCHAR(255) UNIQUE,          -- Google 계정 고유 ID (ID 토큰의 sub)
  email VARCHAR(255),
  name VARCHAR(255),
  picture TEXT,
  role VARCHAR(20) NOT NULL DEFAULT 'user',      -- 'user' | 'admin'
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending' | 'active' | 'suspended'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  approved_at DATETIME,
  last_login_at DATETIME,
  last_seen_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- 2. 로그인 세션 (migration_009)
CREATE TABLE IF NOT EXISTS sessions (
  token_hash VARCHAR(64) PRIMARY KEY,      -- 세션 토큰의 SHA-256 (원문은 저장하지 않음)
  user_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at INTEGER NOT NULL              -- 만료 시각 (epoch ms)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 3. 피드 카탈로그 — RSS 주소당 1행. 여러 사용자가 같은 RSS를 구독해도 한 번만 수집한다.
--    title/category는 처음 등록한 사람의 값(아카이브 저장용 기본값)이고,
--    화면에 보이는 이름/카테고리는 사용자별 user_feeds 값을 쓴다.
CREATE TABLE IF NOT EXISTS feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,              -- 'GOOGLE_KEYWORD' | 'MEDIA_PRESET' | 'CUSTOM'
  keyword VARCHAR(255),                    -- GOOGLE_KEYWORD인 경우 원본 키워드 보관 (재생성/표시용)
  rss_url TEXT NOT NULL UNIQUE,
  category VARCHAR(100) DEFAULT '일반',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_fetch_at INTEGER,                   -- migration_009: 마지막 Cron 수집 시각 (epoch ms)
  last_fetch_ok INTEGER,                   -- 1 성공 / 0 실패
  last_fetch_error TEXT,
  last_item_count INTEGER
);

CREATE INDEX IF NOT EXISTS idx_feeds_category ON feeds(category);

-- 4. 사용자별 구독 (migration_009)
CREATE TABLE IF NOT EXISTS user_feeds (
  user_id INTEGER NOT NULL,
  feed_id INTEGER NOT NULL,
  title VARCHAR(255) NOT NULL,
  category VARCHAR(100) DEFAULT '일반',
  keyword VARCHAR(255),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, feed_id)
);

CREATE INDEX IF NOT EXISTS idx_user_feeds_feed ON user_feeds(feed_id);

-- 5. 사용자별 기사 상태 (READ/UNREAD/BOOKMARK/PICK)
CREATE TABLE IF NOT EXISTS user_article_status (
  user_id INTEGER NOT NULL,
  article_id VARCHAR(255) NOT NULL,        -- 기사 link의 SHA-256 해시
  is_read BOOLEAN DEFAULT 0,
  is_bookmarked BOOLEAN DEFAULT 0,
  is_picked BOOLEAN DEFAULT 0,             -- Today News "스크랩" 여부
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, article_id)
);

CREATE INDEX IF NOT EXISTS idx_status_user_bookmarked ON user_article_status(user_id, is_bookmarked);

-- 6. 사용자별 Today News 스크랩 스냅샷 (RSS가 사라져도 남도록 별도 보관)
CREATE TABLE IF NOT EXISTS picked_articles (
  user_id INTEGER NOT NULL,
  article_id VARCHAR(255) NOT NULL,
  title TEXT NOT NULL,
  link TEXT NOT NULL,
  source VARCHAR(255),
  category VARCHAR(100),
  feed_title VARCHAR(255),
  pub_date VARCHAR(100),
  digest_date VARCHAR(10),                 -- "다이제스트 날짜"(YYYY-MM-DD, 오전 9시 기준)
  sort_order INTEGER DEFAULT 0,            -- 사용자가 지정한 표시 순서
  picked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, article_id)
);

CREATE INDEX IF NOT EXISTS idx_picked_user_at ON picked_articles(user_id, picked_at);
CREATE INDEX IF NOT EXISTS idx_picked_user_digest ON picked_articles(user_id, digest_date);

-- 7. 아카이브 테이블 (Cron + 실시간 수집 결과 누적, "전체 기간" 검색의 기반) — 사용자 공용
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
  original_link TEXT,                      -- migration_010: 구글 뉴스 링크를 변환한 원문 URL (미처리/실패면 NULL)
  decode_attempts INTEGER NOT NULL DEFAULT 0, -- migration_010: 원문 변환 시도 횟수 (3회 실패 시 포기)
  first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_archived_feed ON archived_articles(feed_id);
CREATE INDEX IF NOT EXISTS idx_archived_pub_date_epoch ON archived_articles(pub_date_epoch);
CREATE INDEX IF NOT EXISTS idx_archived_first_seen ON archived_articles(first_seen_at);
