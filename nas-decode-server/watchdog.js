/**
 * Cloudflare Quick Tunnel 자동 감시/복구 스크립트.
 *
 * 배경: Quick Tunnel(`cloudflared tunnel --url ...`)은 원래 임시/테스트용이라, cloudflared
 * 프로세스 자체는 안 죽어도 Cloudflare 쪽에서 예고 없이 세션을 끊어버리는 일이 있다(실측으로
 * 이틀 사이 두 번 발생). 그때마다 사람이 NAS에 접속해서 pm2 재시작 → 새 주소 확인 → Worker
 * 시크릿 갱신을 수동으로 해야 했는데, 이 스크립트가 그 과정을 전부 자동화한다.
 *
 * 동작:
 *   1) 마지막으로 확인된 주소로 주기적(기본 2분)으로 헬스체크
 *   2) 실패가 연속 CONSECUTIVE_FAILURES_THRESHOLD번 쌓이면 "터널 끊김"으로 판단
 *   3) pm2로 cf-tunnel 프로세스 재시작 → 로그에서 새로 발급된 trycloudflare.com 주소 추출
 *   4) 새 주소가 실제로 응답하는지 확인 후, Cloudflare KV(system:decode_proxy_url)에 직접 기록
 *      (Worker는 매 요청마다 이 KV 키를 읽으므로, 재배포나 시크릿 갱신 없이 바로 반영됨)
 *
 * 실행: pm2로 상시 실행 (환경변수 필요 — 아래 README 섹션 참고)
 *   CF_ACCOUNT_ID=... CF_KV_NAMESPACE_ID=... CF_API_TOKEN=... pm2 start watchdog.js --name tunnel-watchdog
 *
 * 필요 권한: CF_API_TOKEN은 "Workers KV Storage: Edit" 권한만 있는 별도 토큰을 새로 만들어서 쓸 것
 * (계정 전체 권한이 아니라 KV 쓰기만 가능한 토큰으로 최소화 — NAS가 뚫려도 피해 범위를 줄이기 위함).
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execAsync = promisify(exec);

const CHECK_INTERVAL_MS = 2 * 60 * 1000; // 2분마다 확인
const HEALTH_TIMEOUT_MS = 8000;
const CONSECUTIVE_FAILURES_THRESHOLD = 2; // 일시적 네트워크 끊김으로 오작동하지 않도록, 2번 연속 실패해야 복구 시도
const RESTART_POLL_ATTEMPTS = 10;
const RESTART_POLL_INTERVAL_MS = 2000;

const STATE_FILE = path.join(os.homedir(), '.cf-tunnel-watchdog-state.json');
const TUNNEL_LOG = path.join(os.homedir(), '.pm2', 'logs', 'cf-tunnel-error.log');
const DECODE_PROXY_URL_KV_KEY = 'system:decode_proxy_url';

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_KV_NAMESPACE_ID = process.env.CF_KV_NAMESPACE_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

if (!CF_ACCOUNT_ID || !CF_KV_NAMESPACE_ID || !CF_API_TOKEN) {
  console.error(
    '[watchdog] CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID, CF_API_TOKEN 환경변수가 모두 필요합니다. 종료합니다.'
  );
  process.exit(1);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { url: null, consecutiveFailures: 0 };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkHealth(baseUrl) {
  if (!baseUrl) return false;
  try {
    const res = await fetchWithTimeout(`${baseUrl}/health`, {}, HEALTH_TIMEOUT_MS);
    return res.ok;
  } catch {
    return false;
  }
}

function extractLatestTunnelUrl(logText) {
  const matches = [...logText.matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g)];
  return matches.length > 0 ? matches[matches.length - 1][0] : null;
}

async function restartTunnelAndGetNewUrl() {
  console.log('[watchdog] cf-tunnel 재시작 시도...');
  await execAsync('pm2 restart cf-tunnel');

  for (let i = 0; i < RESTART_POLL_ATTEMPTS; i++) {
    await new Promise((resolve) => setTimeout(resolve, RESTART_POLL_INTERVAL_MS));
    let logText;
    try {
      logText = fs.readFileSync(TUNNEL_LOG, 'utf8');
    } catch {
      continue; // 로그 파일이 아직 안 만들어졌을 수 있음
    }
    const url = extractLatestTunnelUrl(logText);
    if (url && (await checkHealth(url))) {
      return url;
    }
  }
  throw new Error('재시작 후에도 정상 응답하는 새 주소를 찾지 못함');
}

async function pushUrlToCloudflareKV(url) {
  const endpoint =
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}` +
    `/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/${encodeURIComponent(DECODE_PROXY_URL_KV_KEY)}`;

  const res = await fetchWithTimeout(
    endpoint,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'text/plain',
      },
      body: `${url}/decode`,
    },
    HEALTH_TIMEOUT_MS
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Cloudflare KV 갱신 실패 (${res.status}): ${text}`);
  }
}

async function tick() {
  const state = loadState();
  const healthy = await checkHealth(state.url);

  if (healthy) {
    if (state.consecutiveFailures > 0) {
      console.log('[watchdog] 정상으로 복구됨:', state.url);
    }
    saveState({ url: state.url, consecutiveFailures: 0 });
    return;
  }

  const consecutiveFailures = (state.consecutiveFailures || 0) + 1;
  console.log(`[watchdog] 헬스체크 실패 (${consecutiveFailures}/${CONSECUTIVE_FAILURES_THRESHOLD}):`, state.url);

  if (consecutiveFailures < CONSECUTIVE_FAILURES_THRESHOLD) {
    saveState({ url: state.url, consecutiveFailures });
    return;
  }

  console.log('[watchdog] 터널 끊김으로 판단 — 복구 절차 시작');
  try {
    const newUrl = await restartTunnelAndGetNewUrl();
    await pushUrlToCloudflareKV(newUrl);
    saveState({ url: newUrl, consecutiveFailures: 0, lastRecoveredAt: new Date().toISOString() });
    console.log('[watchdog] 복구 완료, 새 주소 반영:', newUrl);
  } catch (err) {
    console.error('[watchdog] 복구 실패:', String(err));
    saveState({ url: state.url, consecutiveFailures }); // 다음 tick에서 재시도
  }
}

console.log(`[watchdog] 시작 (${CHECK_INTERVAL_MS / 1000}초마다 확인)`);
tick();
setInterval(tick, CHECK_INTERVAL_MS);
