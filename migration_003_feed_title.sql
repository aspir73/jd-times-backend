-- ============================================================
-- Migration 003: picked_articles에 feed_title(피드 이름) 컬럼 추가
-- 적용: wrangler d1 execute jd-times-db --remote --file=./migration_003_feed_title.sql
-- ============================================================

ALTER TABLE picked_articles ADD COLUMN feed_title VARCHAR(255);
