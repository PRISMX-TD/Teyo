// 这是一个公网可达端点，鉴权必须有测试兜底：
// 一旦 CRON_SECRET 校验失效，任何人都能反复触发外部 API 同步。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const syncRatesForDate = vi.hoisted(() => vi.fn());

vi.mock('@/server/services/exchange-rate-sync', () => ({ syncRatesForDate }));

const { GET } = await import('@/app/api/cron/exchange-rates/route');

const original = process.env.CRON_SECRET;

beforeEach(() => {
  syncRatesForDate.mockReset();
  syncRatesForDate.mockResolvedValue({ inserted: 3 });
  process.env.CRON_SECRET = 'test-secret';
});

afterEach(() => {
  process.env.CRON_SECRET = original;
});

function get(headers: Record<string, string> = {}) {
  return GET(new Request('https://example.com/api/cron/exchange-rates', { headers }));
}

describe('GET /api/cron/exchange-rates', () => {
  it('runs the sync when the secret matches', async () => {
    const response = await get({ authorization: 'Bearer test-secret' });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ inserted: 3 });
    expect(syncRatesForDate).toHaveBeenCalledOnce();
  });

  it('rejects a missing authorization header', async () => {
    const response = await get();
    expect(response.status).toBe(401);
    expect(syncRatesForDate).not.toHaveBeenCalled();
  });

  it('rejects a wrong secret', async () => {
    const response = await get({ authorization: 'Bearer nope' });
    expect(response.status).toBe(401);
    expect(syncRatesForDate).not.toHaveBeenCalled();
  });

  it('rejects the bare secret without the Bearer prefix', async () => {
    const response = await get({ authorization: 'test-secret' });
    expect(response.status).toBe(401);
    expect(syncRatesForDate).not.toHaveBeenCalled();
  });

  it('refuses to run when CRON_SECRET is not configured', async () => {
    delete process.env.CRON_SECRET;
    const response = await get({ authorization: 'Bearer test-secret' });
    // 漏配环境变量必须是拒绝而不是放行。
    expect(response.status).toBe(500);
    expect(syncRatesForDate).not.toHaveBeenCalled();
  });

  it('reports a sync failure as 502 instead of throwing', async () => {
    syncRatesForDate.mockRejectedValue(new Error('upstream down'));
    const response = await get({ authorization: 'Bearer test-secret' });
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: 'upstream down' });
  });
});
