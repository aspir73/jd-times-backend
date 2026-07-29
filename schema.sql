-- ============================================================
-- JD Times - Cloudflare D1 스키마
-- 적용: wrangler d1 execute jd-times-db --file=./schema.sql
-- ============================================================

-- 1. 구독 피드 테이블
CREATE TABLE IF NOT EXISTS feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,              -- 'GOOGLE_KEYWORD' | 'MEDIA_PRESET' | 'CUSTOM'
  keyword VARCHAR(255),                    -- GOOGLE_KEYWORD인 경우 원본 키워드 보관 (재생성/표시용)
  rss_url TEXT NOT NULL UNIQUE,
  category VARCHAR(100) DEFAULT '일반',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_feeds_category ON feeds(category);

-- 2. 기사 상태 관리 테이블 (READ/UNREAD/BOOKMARK)
CREATE TABLE IF NOT EXISTS user_article_status (
  article_id VARCHAR(255) PRIMARY KEY,     -- 기사 link의 SHA-256 해시
  is_read BOOLEAN DEFAULT 0,
  is_bookmarked BOOLEAN DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_status_bookmarked ON user_article_status(is_bookmarked);

-- 3. (선택) 국내 언론사 프리셋 - 최초 시딩용, 필요시 주석 해제 후 사용
-- INSERT INTO feeds (title, type, rss_url, category) VALUES
--  ('전자신문', 'MEDIA_PRESET', 'https://rss.etnews.com/Section901.xml', 'IT/테크'),
--  ('한국경제', 'MEDIA_PRESET', 'https://www.hankyung.com/feed/economy', '경제'),
--  ('조선일보', 'MEDIA_PRESET', 'https://www.chosun.com/arc/outboundfeeds/rss/', '종합');
