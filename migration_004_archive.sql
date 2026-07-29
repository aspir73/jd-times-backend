-- ============================================================
-- Migration 004: 아카이브 테이블 추가 (Cron + 실시간 수집 대상)
-- 적용: wrangler d1 execute jd-times-db --remote --file=./migration_004_archive.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS archived_articles (
  article_id VARCHAR(255) PRIMARY KEY,
  feed_id INTEGER,
  feed_title VARCHAR(255),
  title TEXT NOT NULL,
  link TEXT NOT NULL,
  source VARCHAR(255),
  category VARCHAR(100),
  pub_date VARCHAR(100),
  summary TEXT,
  first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_archived_feed ON archived_articles(feed_id);
