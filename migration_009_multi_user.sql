-- migration_009: 다중 사용자 지원 (Google 로그인 + 어드민 승인)
--
-- 구조:
--   - feeds: RSS 주소당 1행인 "공용 카탈로그"로 바뀐다. 같은 RSS를 여러 사용자가 구독해도 한 번만 수집.
--   - user_feeds: 사용자별 구독. 피드 이름/카테고리/키워드는 사용자마다 따로 둔다.
--   - user_article_status / picked_articles: (user_id, article_id) 단위로 분리.
--
-- 기존 데이터: 지금까지의 피드 구독·읽음·북마크·스크랩은 전부 user id 1("기존 소유자")에게 옮긴다.
-- 이 행은 google_sub가 비어 있다가, ADMIN_EMAILS에 등록된 이메일로 처음 로그인할 때 그 계정에 연결된다.
--
-- 실행: wrangler d1 execute jd-times-db --remote --file=./migration_009_multi_user.sql
-- (한 번만 실행할 것 — 테이블 재구성이 포함되어 있어 두 번 실행하면 실패한다)

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

INSERT INTO users (id, google_sub, email, name, role, status, approved_at)
VALUES (1, NULL, NULL, '기존 소유자', 'admin', 'active', CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash VARCHAR(64) PRIMARY KEY,      -- 세션 토큰의 SHA-256 (원문은 저장하지 않음)
  user_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at INTEGER NOT NULL              -- 만료 시각 (epoch ms)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

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

INSERT INTO user_feeds (user_id, feed_id, title, category, keyword, created_at)
SELECT 1, id, title, category, keyword, created_at FROM feeds;

-- 어드민 "전체 피드 현황"용 수집 상태 기록
ALTER TABLE feeds ADD COLUMN last_fetch_at INTEGER;
ALTER TABLE feeds ADD COLUMN last_fetch_ok INTEGER;
ALTER TABLE feeds ADD COLUMN last_fetch_error TEXT;
ALTER TABLE feeds ADD COLUMN last_item_count INTEGER;

-- user_article_status: PK를 (user_id, article_id)로 바꾸기 위해 재구성 (SQLite는 PK 변경 불가)
CREATE TABLE user_article_status_new (
  user_id INTEGER NOT NULL,
  article_id VARCHAR(255) NOT NULL,
  is_read BOOLEAN DEFAULT 0,
  is_bookmarked BOOLEAN DEFAULT 0,
  is_picked BOOLEAN DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, article_id)
);
INSERT INTO user_article_status_new (user_id, article_id, is_read, is_bookmarked, is_picked, updated_at)
SELECT 1, article_id, is_read, is_bookmarked, is_picked, updated_at FROM user_article_status;
DROP TABLE user_article_status;
ALTER TABLE user_article_status_new RENAME TO user_article_status;
CREATE INDEX IF NOT EXISTS idx_status_user_bookmarked ON user_article_status(user_id, is_bookmarked);

-- picked_articles: 같은 이유로 재구성
CREATE TABLE picked_articles_new (
  user_id INTEGER NOT NULL,
  article_id VARCHAR(255) NOT NULL,
  title TEXT NOT NULL,
  link TEXT NOT NULL,
  source VARCHAR(255),
  category VARCHAR(100),
  feed_title VARCHAR(255),
  pub_date VARCHAR(100),
  digest_date VARCHAR(10),
  sort_order INTEGER DEFAULT 0,
  picked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, article_id)
);
INSERT INTO picked_articles_new
  (user_id, article_id, title, link, source, category, feed_title, pub_date, digest_date, sort_order, picked_at)
SELECT 1, article_id, title, link, source, category, feed_title, pub_date, digest_date, sort_order, picked_at
FROM picked_articles;
DROP TABLE picked_articles;
ALTER TABLE picked_articles_new RENAME TO picked_articles;
CREATE INDEX IF NOT EXISTS idx_picked_user_at ON picked_articles(user_id, picked_at);
CREATE INDEX IF NOT EXISTS idx_picked_user_digest ON picked_articles(user_id, digest_date);
