-- migration_010: 수집 기사의 원문 링크 저장 (2026-11-27)
-- 구글 뉴스 RSS 링크(news.google.com/rss/articles/...)는 자동 접속 시 원문으로 열리지 않아서,
-- 수집 Cron이 새 기사의 링크를 NAS 릴레이로 조금씩 원문 주소로 변환해 여기에 저장한다.
-- (매일 07시 구글 시트 내보내기와 CEO 보고 기사 선정에서 원문을 직접 읽기 위함)
-- 기존 행/데이터는 건드리지 않고 칸만 추가한다.

ALTER TABLE archived_articles ADD COLUMN original_link TEXT;               -- 변환된 원문 URL (실패/미처리면 NULL)
ALTER TABLE archived_articles ADD COLUMN decode_attempts INTEGER NOT NULL DEFAULT 0; -- 변환 시도 횟수 (3회 실패하면 포기)

-- 07시 내보내기(지난 24시간 수집분)와 변환 대기열 조회용
CREATE INDEX IF NOT EXISTS idx_archived_first_seen ON archived_articles(first_seen_at);
