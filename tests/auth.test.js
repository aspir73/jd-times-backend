import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyGoogleIdToken, isBootstrapAdmin } from '../src/auth.js';

const CLIENT_ID = 'test-client.apps.googleusercontent.com';

function b64url(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const keyPair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify']
);
const publicJwk = { ...(await crypto.subtle.exportKey('jwk', keyPair.publicKey)), kid: 'test-kid', alg: 'RS256', use: 'sig' };

async function signToken(claimOverrides = {}, headerOverrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: 'test-kid', typ: 'JWT', ...headerOverrides };
  const claims = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: '1234567890',
    email: 'someone@example.com',
    email_verified: true,
    name: '테스트',
    iat: now,
    exp: now + 3600,
    ...claimOverrides,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(signature)}`;
}

// Google JWKS 엔드포인트를 테스트 공개키로 대체 (KV 바인딩 없이 메모리 캐시만 사용)
global.fetch = async (url) => {
  if (String(url).startsWith('https://www.googleapis.com/oauth2/v3/certs')) {
    return new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
    });
  }
  throw new Error(`unexpected fetch: ${url}`);
};

const env = { GOOGLE_CLIENT_ID: CLIENT_ID };

test('accepts a correctly signed Google ID token', async () => {
  const claims = await verifyGoogleIdToken(await signToken(), env);
  assert.equal(claims.sub, '1234567890');
  assert.equal(claims.email, 'someone@example.com');
});

test('rejects a token issued for a different client', async () => {
  await assert.rejects(verifyGoogleIdToken(await signToken({ aud: 'other-client' }), env), /INVALID_AUDIENCE/);
});

test('rejects an expired token', async () => {
  const past = Math.floor(Date.now() / 1000) - 7200;
  await assert.rejects(verifyGoogleIdToken(await signToken({ exp: past }), env), /TOKEN_EXPIRED/);
});

test('rejects a token whose payload was tampered with', async () => {
  const token = await signToken();
  const [h, , s] = token.split('.');
  const forgedPayload = b64url(JSON.stringify({
    iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'attacker', email: 'admin@example.com',
    email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600,
  }));
  await assert.rejects(verifyGoogleIdToken(`${h}.${forgedPayload}.${s}`, env), /INVALID_SIGNATURE/);
});

test('rejects a token from a different issuer', async () => {
  await assert.rejects(verifyGoogleIdToken(await signToken({ iss: 'https://evil.example.com' }), env), /INVALID_ISSUER/);
});

test('rejects unverified emails', async () => {
  await assert.rejects(verifyGoogleIdToken(await signToken({ email_verified: false }), env), /EMAIL_NOT_VERIFIED/);
});

test('rejects tokens signed with an unknown key id', async () => {
  await assert.rejects(verifyGoogleIdToken(await signToken({}, { kid: 'unknown' }), env), /UNKNOWN_SIGNING_KEY/);
});

test('rejects non-RS256 algorithms', async () => {
  await assert.rejects(verifyGoogleIdToken(await signToken({}, { alg: 'none' }), env), /INVALID_TOKEN_HEADER/);
});

test('fails clearly when GOOGLE_CLIENT_ID is not configured', async () => {
  await assert.rejects(verifyGoogleIdToken(await signToken(), {}), /GOOGLE_CLIENT_ID_NOT_CONFIGURED/);
});

test('matches bootstrap admin emails case-insensitively', () => {
  const adminEnv = { ADMIN_EMAILS: ' Owner@Example.com , second@example.com' };
  assert.equal(isBootstrapAdmin('owner@example.com', adminEnv), true);
  assert.equal(isBootstrapAdmin('second@example.com', adminEnv), true);
  assert.equal(isBootstrapAdmin('someone@example.com', adminEnv), false);
  assert.equal(isBootstrapAdmin('owner@example.com', {}), false);
});
