-- ============================================================
-- Migration 005: picked_articles에 digest_date(다이제스트 날짜) 컬럼 추가
-- 오전 9시 기준, 평일(월~금)만 존재하는 "스크랩 다이제스트 날짜"
-- 적용: wrangler d1 execute jd-times-db --remote --file=./migration_005_digest_date.sql
-- ============================================================

ALTER TABLE picked_articles ADD COLUMN digest_date VARCHAR(10);

CREATE INDEX IF NOT EXISTS idx_digest_date ON picked_articles(digest_date);
