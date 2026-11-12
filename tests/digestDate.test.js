import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDigestDate } from '../src/utils/digestDate.js';

// KST = UTC+9. 2026-11-12(목), 11-13(금), 11-16(월)

test('scraps before 10:00 KST belong to that day\'s digest', () => {
  assert.equal(computeDigestDate('2026-11-12T00:59:00Z'), '2026-11-12'); // 목 09:59 KST
  assert.equal(computeDigestDate('2026-11-12T00:00:00Z'), '2026-11-12'); // 목 09:00 KST (예전 마감 시각)
});

test('scraps from 10:00 KST roll over to the next digest', () => {
  assert.equal(computeDigestDate('2026-11-12T01:00:00Z'), '2026-11-13'); // 목 10:00 KST
  assert.equal(computeDigestDate('2026-11-12T14:00:00Z'), '2026-11-13'); // 목 23:00 KST
});

test('weekend digests carry over to Monday', () => {
  assert.equal(computeDigestDate('2026-11-13T01:00:00Z'), '2026-11-16'); // 금 10:00 KST → 월
  assert.equal(computeDigestDate('2026-11-14T03:00:00Z'), '2026-11-16'); // 토 12:00 KST → 월
});
