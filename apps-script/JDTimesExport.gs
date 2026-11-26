/**
 * JD Times → 구글 시트 내보내기 (Google Apps Script 웹 앱)
 *
 * 매일 07:00(KST) JD Times 백엔드(Cloudflare Worker)가 지난 24시간 수집 기사를 이 웹 앱으로 POST하면,
 * 내 드라이브의 "JD Times 수집 기사" 스프레드시트에 월별 탭(예: 2026-11)으로 한 줄씩 추가한다.
 * "CEO 보고" 탭도 함께 만들어 두며, 여기에는 CEO 보고용으로 선정된 기사가 기록된다.
 *
 * 설치 (처음 한 번):
 *  1) script.google.com → 새 프로젝트 → 이 코드 전체 붙여넣기 → 저장
 *  2) 위쪽 함수 선택에서 setup 선택 → 실행 → 권한 허용
 *     → 실행 로그에 표시되는 "시트 주소"와 "토큰"을 확인 (토큰은 Worker에 등록할 비밀값)
 *  3) 배포 → 새 배포 → 유형: 웹 앱 → 다음 사용자로 실행: 나 / 액세스 권한: 모든 사용자 → 배포
 *     → 표시되는 웹 앱 URL(…/exec)을 복사
 *  (코드를 수정했다면: 배포 → 배포 관리 → 편집 → 버전: 새 버전 → 배포. URL은 그대로 유지됨)
 */

const SPREADSHEET_NAME = 'JD Times 수집 기사';
const ARTICLE_HEADERS = ['수집일시', '발행일시', '피드', '카테고리', '언론사', '제목', '원문링크', '원문여부', '요약', '기사ID'];
const CEO_SHEET_NAME = 'CEO 보고';
const CEO_HEADERS = ['보고일', '순위', '분류', '제목', '언론사', '원문링크', '핵심 내용', '선정 이유', '원문 확인', '기사ID'];

/** 처음 한 번 실행: 스프레드시트 생성 + 공유 토큰 발급 */
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SHARED_TOKEN')) {
    props.setProperty('SHARED_TOKEN', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  }
  const ss = getSpreadsheet_();
  ensureSheet_(ss, CEO_SHEET_NAME, CEO_HEADERS);
  Logger.log('시트 주소: ' + ss.getUrl());
  Logger.log('토큰(Worker의 EXPORT_WEBHOOK_TOKEN): ' + props.getProperty('SHARED_TOKEN'));
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const token = PropertiesService.getScriptProperties().getProperty('SHARED_TOKEN');
    if (!token || body.token !== token) return json_({ ok: false, error: 'BAD_TOKEN' });

    const rows = Array.isArray(body.rows) ? body.rows : [];
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      const ss = getSpreadsheet_();
      ensureSheet_(ss, CEO_SHEET_NAME, CEO_HEADERS);

      // 수집일시 기준 월별 탭으로 나눠 추가 (같은 기사ID가 이미 있으면 건너뜀 — 재전송돼도 중복 없음)
      const byMonth = {};
      rows.forEach(function (r) {
        const month = String(r.collectedAt || body.exportDate || '').slice(0, 7) || 'unknown';
        (byMonth[month] = byMonth[month] || []).push(r);
      });

      let appended = 0;
      let skipped = 0;
      Object.keys(byMonth).sort().forEach(function (month) {
        const sheet = ensureSheet_(ss, month, ARTICLE_HEADERS);
        const idCol = ARTICLE_HEADERS.indexOf('기사ID') + 1;
        const existing = new Set();
        if (sheet.getLastRow() > 1) {
          sheet.getRange(2, idCol, sheet.getLastRow() - 1, 1).getValues().forEach(function (v) { existing.add(String(v[0])); });
        }
        const values = [];
        byMonth[month].forEach(function (r) {
          if (!r.id || existing.has(String(r.id))) { skipped++; return; }
          existing.add(String(r.id));
          values.push([
            r.collectedAt || '', r.publishedAt || '', r.feed || '', r.category || '', r.source || '',
            r.title || '', r.link || '', r.linkIsOriginal ? 'Y' : 'N', r.summary || '', r.id,
          ]);
        });
        if (values.length) {
          sheet.getRange(sheet.getLastRow() + 1, 1, values.length, ARTICLE_HEADERS.length)
            .setNumberFormat('@') // 날짜·숫자 자동 변환 막기 (문자열 그대로 저장)
            .setValues(values);
          appended += values.length;
        }
      });

      return json_({ ok: true, appended: appended, skipped: skipped, spreadsheetUrl: ss.getUrl() });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/** 브라우저로 웹 앱 주소를 열었을 때 살아 있는지 확인용 */
function doGet() {
  return json_({ ok: true, service: 'JD Times sheet export' });
}

function getSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SPREADSHEET_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (err) { /* 지워졌으면 새로 만든다 */ }
  }
  const ss = SpreadsheetApp.create(SPREADSHEET_NAME);
  props.setProperty('SPREADSHEET_ID', ss.getId());
  return ss;
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    // 새로 만든 스프레드시트의 빈 기본 탭("시트1"/"Sheet1")은 첫 탭으로 재사용
    const first = ss.getSheets()[0];
    if (ss.getSheets().length === 1 && first.getLastRow() === 0 && /^(시트1|Sheet1)$/.test(first.getName())) {
      sheet = first.setName(name);
    } else {
      sheet = ss.insertSheet(name);
    }
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#f1f3f4');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
