import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/server/db/client';
import {
  createTestOrgWithSeed,
  createTestUser,
  resetTestData,
  seedRate,
} from '@/tests/helpers/test-db';

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
  requireUserId: () => {
    if (!currentUserId) throw new Error('unauthenticated');
    return Promise.resolve(currentUserId);
  },
}));

const { lookupRate } = await import('@/server/actions/rates');

let ownerId: string;
let orgSlug: string;

beforeAll(async () => {
  await resetTestData();
  ownerId = await createTestUser('owner-rate@example.com', 'Owner');
  const org = await createTestOrgWithSeed(ownerId, 'Rate Co', 'rate-co', 'MYR');
  orgSlug = org.slug;
  currentUserId = ownerId;

  // SGD -> MYR = 3.2，用唯一日期避免与其他汇率测试的并行竞态
  await seedRate('SGD', 'MYR', 3_20000000n, '2025-03-15');
});

afterAll(async () => {
  await resetTestData();
  await sql.end();
});

describe('lookupRate', () => {
  it('returns the stored rate for a foreign currency', async () => {
    const result = await lookupRate(orgSlug, 'SGD', '2025-03-15');
    expect(result).toEqual({ rate: '3.20', source: 'auto' });
  });

  it('returns exactly 1 when the currency matches the base currency', async () => {
    const result = await lookupRate(orgSlug, 'MYR', '2025-03-15');
    expect(result).toEqual({ rate: '1.00', source: 'auto' });
  });

  it('reports unavailable when no rate is cached', async () => {
    const result = await lookupRate(orgSlug, 'JPY', '2025-03-15');
    expect(result).toEqual({ rate: null, source: 'unavailable' });
  });

  it('requires membership of the organization', async () => {
    const strangerId = await createTestUser('stranger-rate@example.com', 'Stranger');
    currentUserId = strangerId;
    await expect(lookupRate(orgSlug, 'SGD', '2025-03-15')).rejects.toThrow();
    currentUserId = ownerId;
  });
});
