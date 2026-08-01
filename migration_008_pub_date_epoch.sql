-- ============================================================
-- Migration 008: archived_articles에 pub_date_epoch(정렬/필터 가능한 밀리초 타임스탬프) 추가
-- 적용: wrangler d1 execute jd-times-db --remote --file=./migration_008_pub_date_epoch.sql
--
-- 배경: pub_date는 RSS 원본 형식("Tue, 28 Jul 2026 14:24:34 GMT") 문자열이라 SQL에서 시간순
-- 비교/필터가 불가능했다. 그래서 지금까지는 아카이브 전체 행을 매 요청마다 통째로 읽어온 뒤
-- JS에서 날짜 필터링을 했는데, 아카이브가 쌓일수록(현재 4천 건 이상) 이 부분이 Workers 무료
-- 플랜의 CPU 10ms 제한을 넘기는 주요 원인이 되었다(실측 확인). epoch 컬럼을 추가해 SQL의
-- WHERE 절에서 바로 기간 필터링을 하면, 필요 없는 행은 애초에 읽어오지 않아도 된다.
-- ============================================================

ALTER TABLE archived_articles ADD COLUMN pub_date_epoch INTEGER;

CREATE INDEX IF NOT EXISTS idx_archived_pub_date_epoch ON archived_articles(pub_date_epoch);
