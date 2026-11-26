import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  backfillOriginalLinks,
  formatKst,
  getDailyExportRows,
  isDailyExportRun,
  sendDailyExport,
} from '../src/dailyExport.js';

/** node:sqlite 위에 D1 바인딩과 같은 모양(prepare/bind/all/run, batch)을 얹은 테스트용 DB */
function fakeD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const prepare = (sql) => {
    const make = (params) => ({
      bind: (...p) => make(p),
      all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
      run: async () => sqlite.prepare(sql).run(...params),
      first: async () => sqlite.prepare(sql).get(...params) ?? null,
      _exec: () => sqlite.prepare(sql).run(...params),
    });
    return make([]);
  };
  return { sqlite, prepare, batch: async (stmts) => stmts.map((s) => s._exec()) };
}

const GOOGLE = (n) => `https://news.google.com/rss/articles/CBMi${n}?oc=5`;

function seed(db) {
  const s = db.sqlite;
  s.exec(`INSERT INTO feeds (id, title, type, rss_url, category) VALUES
    (1, '보안', 'GOOGLE_KEYWORD', 'https://news.google.com/rss/search?q=a', '보안'),
    (2, '남의피드', 'GOOGLE_KEYWORD', 'https://news.google.com/rss/search?q=b', '기타')`);
  s.exec(`INSERT INTO user_feeds (user_id, feed_id, title, category) VALUES (1, 1, '내 보안', 'AI/보안'), (2, 2, '남의피드', '기타')`);
  const ins = s.prepare(`INSERT INTO archived_articles
      (article_id, feed_id, feed_title, title, link, source, category, pub_date, pub_date_epoch, summary, first_seen_at, original_link)
      VALUES (?, ?, '보안', ?, ?, '보안뉴스', '보안', '', ?, '요약', ?, ?)`);
  // 내보내기 기준 시각: 2026-11-27 22:00 UTC (= 11-28 07:00 KST)
  ins.run('a-old', 1, '어제 6시 반 기사(범위 밖)', GOOGLE(1), Date.parse('2026-11-26T21:00:00Z'), '2026-11-26 21:30:00', null);
  ins.run('a-in1', 1, 'AI 모델 취약점 공개', GOOGLE(2), Date.parse('2026-11-27T01:00:00Z'), '2026-11-27 02:00:00', 'https://www.boannews.com/a/1');
  ins.run('a-in2', 1, '삼성 보안 업데이트', GOOGLE(3), Date.parse('2026-11-27T10:00:00Z'), '2026-11-27 12:00:00', null);
  ins.run('a-edge', 1, '07시 정각 수집(다음 날 몫)', GOOGLE(4), Date.parse('2026-11-27T21:59:00Z'), '2026-11-27 22:00:00', null);
  ins.run('b-other', 2, '다른 사용자 피드 기사', GOOGLE(5), Date.parse('2026-11-27T05:00:00Z'), '2026-11-27 05:00:00', null);
}

const END = Date.parse('2026-11-27T22:00:00Z');

test('only the 22:00 UTC run of the morning cron exports', () => {
  assert.equal(isDailyExportRun({ cron: '*/30 22-23 * * *', scheduledTime: Date.parse('2026-11-27T22:00:00Z') }), true);
  assert.equal(isDailyExportRun({ cron: '*/30 22-23 * * *', scheduledTime: Date.parse('2026-11-27T22:30:00Z') }), false);
  assert.equal(isDailyExportRun({ cron: '0 */3 * * *', scheduledTime: Date.parse('2026-11-27T21:00:00Z') }), false);
});

test('formatKst renders Korean time', () => {
  assert.equal(formatKst(Date.parse('2026-11-27T22:00:00Z')), '2026-11-28 07:00');
  assert.equal(formatKst(NaN), '');
});

test('export rows: last 24h, only the user\'s feeds, user\'s feed names, original link preferred', async () => {
  const db = fakeD1();
  seed(db);
  const rows = await getDailyExportRows(db, { userId: 1, endMs: END });
  assert.deepEqual(rows.map((r) => r.id), ['a-in1', 'a-in2']);
  assert.equal(rows[0].feed, '내 보안');
  assert.equal(rows[0].category, 'AI/보안');
  assert.equal(rows[0].link, 'https://www.boannews.com/a/1');
  assert.equal(rows[0].linkIsOriginal, true);
  assert.equal(rows[1].link, GOOGLE(3)); // 아직 변환 안 됐으면 구글 링크로 대체
  assert.equal(rows[0].collectedAt, '2026-11-27 11:00');
});

test('backfill decodes pending links, counts attempts, gives up after 3 failures', async () => {
  const db = fakeD1();
  seed(db);
  db.sqlite.exec(`UPDATE archived_articles SET first_seen_at = datetime('now', '-1 hours')`);
  db.sqlite.exec(`UPDATE archived_articles SET original_link = NULL`);

  const realFetch = globalThis.fetch;
  // NAS 릴레이 흉내: CBMi3 은 항상 실패, 나머지는 원문 주소 반환
  globalThis.fetch = async (url) => {
    const target = new URL(url).searchParams.get('url');
    if (target.includes('CBMi3')) return new Response('fail', { status: 502 });
    return Response.json({ url: `https://news.example.com/${target.match(/CBMi(\d+)/)[1]}?utm_source=x` });
  };
  const env = { DB: db, RSS_CACHE: { get: async () => 'https://relay.example/decode' }, DECODE_PROXY_TOKEN: 't' };
  try {
    const first = await backfillOriginalLinks(env, 10);
    assert.deepEqual(first, { tried: 5, decoded: 4 });
    const row = db.sqlite.prepare(`SELECT original_link, decode_attempts FROM archived_articles WHERE article_id='a-in1'`).get();
    assert.equal(row.original_link, 'https://news.example.com/2'); // 추적 파라미터 제거
    await backfillOriginalLinks(env, 10);
    await backfillOriginalLinks(env, 10);
    const failed = db.sqlite.prepare(`SELECT original_link, decode_attempts FROM archived_articles WHERE article_id='a-in2'`).get();
    assert.deepEqual({ ...failed }, { original_link: null, decode_attempts: 3 });
    assert.deepEqual(await backfillOriginalLinks(env, 10), { tried: 0, decoded: 0 }); // 3번 실패하면 포기
    assert.deepEqual(await backfillOriginalLinks(env, 0), { tried: 0, decoded: 0 });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('sendDailyExport skips when not configured and posts token + rows when configured', async () => {
  const db = fakeD1();
  seed(db);
  assert.deepEqual(await sendDailyExport({ DB: db }, { endMs: END }), { skipped: 'NOT_CONFIGURED' });

  const realFetch = globalThis.fetch;
  let posted;
  globalThis.fetch = async (url, init) => {
    posted = { url, body: JSON.parse(init.body) };
    return Response.json({ ok: true, appended: 2 });
  };
  try {
    const r = await sendDailyExport({ DB: db, EXPORT_WEBHOOK_URL: 'https://script.google.com/x/exec', EXPORT_WEBHOOK_TOKEN: 'secret' }, { endMs: END });
    assert.equal(r.sent, 2);
    assert.equal(r.originalLinks, 1);
    assert.equal(posted.body.token, 'secret');
    assert.equal(posted.body.exportDate, '2026-11-28');
    assert.equal(posted.body.rows.length, 2);

    globalThis.fetch = async () => Response.json({ ok: false, error: 'BAD_TOKEN' });
    await assert.rejects(
      sendDailyExport({ DB: db, EXPORT_WEBHOOK_URL: 'https://x/exec', EXPORT_WEBHOOK_TOKEN: 'bad' }, { endMs: END }),
      /BAD_TOKEN/
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
