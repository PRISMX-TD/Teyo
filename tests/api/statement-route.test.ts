/**
 * 客户 / 供应商对账单端点。
 *
 * 这个路由此前**根本不存在**：components/reports/reports-view.tsx 的
 * StatementTab 一直在 fetch `/api/{orgSlug}/statement`，拿回 404，
 * catch 分支把「加载失败」摆上屏幕——报表页那两个标签页从上线起没出过一次数。
 *
 * 这一组测的是接上之后**不能再错的那两件事**：
 *
 *   1. 金额必须以字符串出网。仓储返回 bigint，而 JSON.stringify 碰到 bigint
 *      直接抛 TypeError——整个响应挂掉，不是给 0 或 null。客户端那边原来把
 *      res.json() 断言成 CustomerStatement（字段写的是 bigint），是一句
 *      运行时不成立的话。
 *   2. 起止日期反了要挡下来。SQL 的区间过滤对倒置的区间是安静地返回空集，
 *      一份「本期没有任何往来」的对账单，和一份真的没有往来的长得一样。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requirePermission = vi.hoisted(() => vi.fn());
const withTransaction = vi.hoisted(() => vi.fn());
const getCustomerStatement = vi.hoisted(() => vi.fn());
const getVendorStatement = vi.hoisted(() => vi.fn());

class FakeAuthError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

vi.mock('@/server/auth/guard', () => ({
  requirePermission,
  AuthError: FakeAuthError,
}));
vi.mock('@/server/db/transaction', () => ({ withTransaction }));
vi.mock('@/server/repositories/aging', () => ({ getCustomerStatement, getVendorStatement }));

const { GET } = await import('@/app/api/[orgSlug]/statement/route');

const CONTACT = '11111111-2222-4333-8444-555555555555';

const SAMPLE = {
  openingBalance: 100_000n,
  lines: [
    { date: '2026-03-05', description: 'INV-1', reference: 'INV-1', amount: 50_000n, balance: 150_000n },
  ],
  closingBalance: 150_000n,
  notice: null,
};

function call(query: string) {
  return GET(new Request(`https://example.com/api/acme/statement?${query}`), {
    params: Promise.resolve({ orgSlug: 'acme' }),
  });
}

beforeEach(() => {
  requirePermission.mockReset();
  withTransaction.mockReset();
  getCustomerStatement.mockReset();
  getVendorStatement.mockReset();

  requirePermission.mockResolvedValue({ userId: 'u1', organizationId: 'org1' });
  // withTransaction 在真实实现里是「开事务、把 tx 交给回调」。这里直接执行
  // 回调即可——被测的是路由，不是事务本身。
  withTransaction.mockImplementation(async (_userId: string, fn: (tx: unknown) => unknown) => fn({}));
  getCustomerStatement.mockResolvedValue(SAMPLE);
  getVendorStatement.mockResolvedValue({ ...SAMPLE, notice: { count: 2, currencies: ['SGD', 'USD'] } });
});

describe('GET /api/[orgSlug]/statement', () => {
  it('金额全部以字符串出网——bigint 会让 JSON.stringify 整个抛掉', async () => {
    const response = await call(`type=customer&contactId=${CONTACT}&from=2026-03-01&to=2026-03-31`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.openingBalance).toBe('100000');
    expect(body.closingBalance).toBe('150000');
    expect(body.lines[0].amount).toBe('50000');
    expect(body.lines[0].balance).toBe('150000');
    // 整个响应里不能有任何一个数字型金额：出现 number 就说明某处漏了
    // toString()，而 number 在超过 2^53 的最小单位上会静默丢精度。
    expect(typeof body.openingBalance).toBe('string');
    expect(typeof body.lines[0].amount).toBe('string');
  });

  it('type=vendor 走供应商那一支，并把 notice 原样带出去', async () => {
    const response = await call(`type=vendor&contactId=${CONTACT}&from=2026-03-01&to=2026-03-31`);

    expect(response.status).toBe(200);
    expect(getVendorStatement).toHaveBeenCalledOnce();
    expect(getCustomerStatement).not.toHaveBeenCalled();
    // notice 说的是「有几张外币单据换不出本位币、没被算进金额」。丢掉它，
    // 用户看到的就是一份金额偏小但毫无异样的对账单。
    await expect(response.json()).resolves.toMatchObject({
      notice: { count: 2, currencies: ['SGD', 'USD'] },
    });
  });

  it('起日晚于止日直接 400，而不是安静地回一份空对账单', async () => {
    const response = await call(`type=customer&contactId=${CONTACT}&from=2026-03-31&to=2026-03-01`);

    expect(response.status).toBe(400);
    expect(getCustomerStatement).not.toHaveBeenCalled();
  });

  it('参数缺失或不成形一律 400，不碰数据库', async () => {
    for (const query of [
      'type=customer&from=2026-03-01&to=2026-03-31',
      `type=partner&contactId=${CONTACT}&from=2026-03-01&to=2026-03-31`,
      `type=customer&contactId=not-a-uuid&from=2026-03-01&to=2026-03-31`,
      `type=customer&contactId=${CONTACT}&from=March&to=2026-03-31`,
    ]) {
      const response = await call(query);
      expect(response.status, query).toBe(400);
    }
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('没有权限时回 403，而不是把 AuthError 冒成 500', async () => {
    requirePermission.mockRejectedValue(new FakeAuthError('forbidden', 'nope'));

    const response = await call(`type=customer&contactId=${CONTACT}&from=2026-03-01&to=2026-03-31`);

    expect(response.status).toBe(403);
  });

  it('不缓存——对账单随时会因为新记一笔款而变', async () => {
    const response = await call(`type=customer&contactId=${CONTACT}&from=2026-03-01&to=2026-03-31`);

    expect(response.headers.get('cache-control')).toContain('no-store');
  });
});
