/**
 * 사용자 인증: Google 로그인(ID 토큰 검증) + 세션 토큰.
 *
 * 흐름:
 *   1) 프론트가 Google Identity Services로 로그인 → Google이 서명한 ID 토큰(JWT)을 받음
 *   2) POST /api/auth/google 로 그 토큰을 보내면, 여기서 Google 공개키로 서명·만료·대상(aud)을 검증
 *   3) 사용자 행을 만들거나 갱신하고, 무작위 세션 토큰을 발급 (DB에는 SHA-256 해시만 저장)
 *   4) 이후 모든 요청은 Authorization: Bearer <세션 토큰> 으로 인증
 *
 * 비밀번호를 다루지 않으므로 해시 연산(PBKDF2 등)이 없어 Workers 무료 플랜 CPU 한도에도 부담이 없다.
 * RS256 검증은 WebCrypto 네이티브 연산이라 비용이 매우 작다.
 */

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const JWKS_KV_KEY = 'system:google_jwks';
const JWKS_DEFAULT_TTL_SECONDS = 60 * 60;
const CLOCK_SKEW_SECONDS = 60;

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일
const LAST_SEEN_WRITE_INTERVAL_MS = 10 * 60 * 1000; // last_seen_at은 10분에 한 번만 갱신 (매 요청 DB 쓰기 방지)

// 같은 Worker 인스턴스 안에서는 메모리에 캐시 (KV 왕복도 줄임)
let jwksMemoryCache = null; // { keys, expiresAt }

function base64UrlToBytes(input) {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlToJson(input) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(input)));
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Google 공개키(JWKS) 조회: 메모리 → KV → 네트워크 순. 키 회전에 대비해 kid가 없으면 강제로 새로 받는다 */
async function getGoogleJwks(env, { forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && jwksMemoryCache && jwksMemoryCache.expiresAt > now) return jwksMemoryCache.keys;

  if (!forceRefresh && env.RSS_CACHE) {
    const cached = await env.RSS_CACHE.get(JWKS_KV_KEY, 'json');
    if (cached?.keys && cached.expiresAt > now) {
      jwksMemoryCache = cached;
      return cached.keys;
    }
  }

  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) throw new Error(`GOOGLE_JWKS_FETCH_FAILED (${res.status})`);
  const { keys } = await res.json();

  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('Cache-Control') || '')?.[1]);
  const ttlSeconds = Number.isFinite(maxAge) && maxAge > 0 ? maxAge : JWKS_DEFAULT_TTL_SECONDS;
  const entry = { keys, expiresAt: now + ttlSeconds * 1000 };
  jwksMemoryCache = entry;
  if (env.RSS_CACHE) {
    await env.RSS_CACHE.put(JWKS_KV_KEY, JSON.stringify(entry), { expirationTtl: Math.max(60, ttlSeconds) });
  }
  return keys;
}

/**
 * Google ID 토큰 검증. 성공하면 payload(claims)를, 실패하면 예외를 던진다.
 * @param {string} idToken
 * @param {{GOOGLE_CLIENT_ID: string, RSS_CACHE?: KVNamespace}} env
 */
export async function verifyGoogleIdToken(idToken, env) {
  if (!env.GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID_NOT_CONFIGURED');
  if (typeof idToken !== 'string') throw new Error('INVALID_TOKEN');

  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('INVALID_TOKEN');
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = base64UrlToJson(headerB64);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('INVALID_TOKEN_HEADER');

  let keys = await getGoogleJwks(env);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await getGoogleJwks(env, { forceRefresh: true });
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error('UNKNOWN_SIGNING_KEY');

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlToBytes(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  if (!valid) throw new Error('INVALID_SIGNATURE');

  const claims = base64UrlToJson(payloadB64);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!GOOGLE_ISSUERS.has(claims.iss)) throw new Error('INVALID_ISSUER');
  if (claims.aud !== env.GOOGLE_CLIENT_ID) throw new Error('INVALID_AUDIENCE');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) throw new Error('TOKEN_EXPIRED');
  if (!claims.sub) throw new Error('INVALID_TOKEN');
  if (!claims.email || claims.email_verified !== true) throw new Error('EMAIL_NOT_VERIFIED');

  return claims;
}

/** ADMIN_EMAILS(쉼표 구분) 시크릿에 들어 있는 이메일인지 */
export function isBootstrapAdmin(email, env) {
  if (!email || !env.ADMIN_EMAILS) return false;
  const list = env.ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return list.includes(email.toLowerCase());
}

/** 프론트로 내보낼 사용자 정보 (내부 필드 제외) */
export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    picture: row.picture,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
  };
}

/**
 * 검증된 Google claims로 사용자 행을 찾거나 만든다.
 * - ADMIN_EMAILS에 있는 이메일은 자동으로 admin + active (최초 운영자 부트스트랩용)
 * - 그 외 신규 가입자는 pending (어드민 승인 대기)
 * - 기존 단일 사용자 시절 데이터(user id 1, google_sub 없음)는 첫 어드민 로그인 때 그 계정에 연결
 */
export async function upsertGoogleUser(db, claims, env) {
  const { sub, email, name = null, picture = null } = claims;
  const bootstrapAdmin = isBootstrapAdmin(email, env);

  let user = await db.prepare('SELECT * FROM users WHERE google_sub = ?').bind(sub).first();

  if (!user && bootstrapAdmin) {
    const legacy = await db.prepare('SELECT * FROM users WHERE id = 1 AND google_sub IS NULL').first();
    if (legacy) {
      await db
        .prepare('UPDATE users SET google_sub = ?, email = ?, name = ?, picture = ? WHERE id = 1')
        .bind(sub, email, name, picture)
        .run();
      user = await db.prepare('SELECT * FROM users WHERE id = 1').first();
    }
  }

  if (!user) {
    const role = bootstrapAdmin ? 'admin' : 'user';
    const status = bootstrapAdmin ? 'active' : 'pending';
    await db
      .prepare(
        `INSERT INTO users (google_sub, email, name, picture, role, status, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, ${bootstrapAdmin ? 'CURRENT_TIMESTAMP' : 'NULL'})`
      )
      .bind(sub, email, name, picture, role, status)
      .run();
    user = await db.prepare('SELECT * FROM users WHERE google_sub = ?').bind(sub).first();
  }

  // 로그인할 때마다 프로필(이름/사진/이메일) 최신화. 부트스트랩 어드민은 혹시 정지/강등돼 있어도 복구
  await db
    .prepare(
      `UPDATE users SET email = ?, name = ?, picture = ?, last_login_at = CURRENT_TIMESTAMP, last_seen_at = CURRENT_TIMESTAMP
       ${bootstrapAdmin ? ", role = 'admin', status = 'active', approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP)" : ''}
       WHERE id = ?`
    )
    .bind(email, name, picture, user.id)
    .run();

  return db.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
}

/** 새 세션 발급. 반환값(원문 토큰)은 프론트에만 전달되고 DB에는 해시만 남는다 */
export async function createSession(db, userId) {
  const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256Hex(token);
  const expiresAt = Date.now() + SESSION_TTL_MS;

  await db.batch([
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(tokenHash, userId, expiresAt),
    // 만료된 세션 정리 (이 사용자 것만 — 가볍게)
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').bind(userId, Date.now()),
  ]);

  return { token, expiresAt };
}

function extractBearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

/**
 * 요청의 세션 토큰으로 사용자 조회. 없거나 만료면 null.
 * last_seen_at은 10분 이상 지났을 때만 백그라운드로 갱신한다(어드민 "활성 사용자" 통계용).
 */
export async function getSessionUser(request, env, ctx) {
  const token = extractBearerToken(request);
  if (!token) return null;

  const tokenHash = await sha256Hex(token);
  const user = await env.DB
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`
    )
    .bind(tokenHash, Date.now())
    .first();
  if (!user) return null;

  const lastSeen = user.last_seen_at ? Date.parse(`${user.last_seen_at.replace(' ', 'T')}Z`) : 0;
  if (!Number.isFinite(lastSeen) || Date.now() - lastSeen > LAST_SEEN_WRITE_INTERVAL_MS) {
    const write = env.DB.prepare('UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').bind(user.id).run();
    if (ctx?.waitUntil) ctx.waitUntil(write.catch(() => {}));
  }

  return user;
}

/** 로그아웃: 이 요청의 세션만 삭제 */
export async function deleteSession(request, env) {
  const token = extractBearerToken(request);
  if (!token) return;
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
}

/** 계정 정지 시 그 사용자의 모든 세션 무효화 */
export async function deleteAllSessionsForUser(db, userId) {
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
}
