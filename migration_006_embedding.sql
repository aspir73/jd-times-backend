-- ============================================================
-- Migration 006: archived_articles에 embedding(임베딩 벡터 캐시) 컬럼 추가
-- 적용: wrangler d1 execute jd-times-db --remote --file=./migration_006_embedding.sql
-- ============================================================

ALTER TABLE archived_articles ADD COLUMN embedding TEXT;
