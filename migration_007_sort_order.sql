-- ============================================================
-- Migration 007: picked_articles에 sort_order(순서 조정) 컬럼 추가
-- 적용: wrangler d1 execute jd-times-db --remote --file=./migration_007_sort_order.sql
-- ============================================================

ALTER TABLE picked_articles ADD COLUMN sort_order INTEGER DEFAULT 0;
