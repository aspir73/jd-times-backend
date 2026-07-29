-- ============================================================
-- Migration 002: Today News "Pick" 기능 추가
-- 적용: wrangler d1 execute jd-times-db --remote --file=./migration_002_picks.sql
-- 기존 데이터를 보존하면서 컬럼/테이블만 추가합니다.
-- ============================================================

ALTER TABLE user_article_status ADD COLUMN is_picked BOOLEAN DEFAULT 0;

CREATE TABLE IF NOT EXISTS picked_articles (
  article_id VARCHAR(255) PRIMARY KEY,
  title TEXT NOT NULL,
  link TEXT NOT NULL,
  source VARCHAR(255),
  category VARCHAR(100),
  pub_date VARCHAR(100),
  picked_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_picked_at ON picked_articles(picked_at);
