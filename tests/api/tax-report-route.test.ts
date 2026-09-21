/**
 * 税额汇总端点。
 *
 * getTaxReportAction（server/actions/tax.ts）和 TaxReportView
 * （components/reports/tax-report-view.tsx）此前都已经写好，但**没有任何
 * 地方 import 过其中任何一个**——中间缺的就是这一段。
 *
 * 这一组盯住三件事：bigint 必须以字符串出网、unmatchedTaxMinor 不能在路上
 * 被丢掉、坏日期要在碰数据库之前挡下来。
 *
 * unmatchedTaxMinor 值得单独一条：它装的是「税科目动了、但同一笔交易里
 * 找不到任何收入/费用」的那部分，最典型的就是向税局缴税。仓储特意把它单列
 * 出来（见 server/repositories/tax.ts 的注释），如果在序列化这一层被丢掉，
 * 读表的人就再也无法把报表和总账对上，而且报表本身看起来完全正常。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getTaxReportAction = vi.hoisted(() => vi.fn());

class FakeAuthError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

vi.mock('@/server/auth/guard', () => ({ AuthError: FakeAuthError }));
vi.mock('@/server/actions/tax', () => ({ getTaxReportAction }));

const { GET } = await import('@/app/api/[orgSlug]/tax-report/route');

function call(query: string) {
  return GET(new Request(`https://example.com/api/acme/tax-report?${query}`), {
    params: Promise.resolve({ orgSlug: 'acme' }),
  });
}

beforeEach(() => {
  getTaxReportAction.mockReset();
  getTaxReportAction.mockResolvedValue({
    outputTax: { netMinor: 1_000_000n, taxMinor: 60_000n, unmatchedTaxMinor: -12_000n },
    inputTax: { netMinor: 400_000n, taxMinor: 24_000n, unmatchedTaxMinor: 0n },
    netPayableMinor: 36_000n,
    baseCurrency: 'MYR',
  });
});

describe('GET /api/[orgSlug]/tax-report', () => {
  it('每一个金额都是字符串，负数也不例外', async () => {
    const response = await call('from=2026-01-01&to=2026-03-31');

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.outputTax).toEqual({
      netMinor: '1000000',
      taxMinor: '60000',
      // 缴过税的期间这个数是负的——把它当成「一定非负」而用无符号写法处理，
      // 会让缴税月份的报表凭空多出一截。
      unmatchedTaxMinor: '-12000',
    });
    expect(body.inputTax).toEqual({
      netMinor: '400000',
      taxMinor: '24000',
      unmatchedTaxMinor: '0',
    });
    expect(body.netPayableMinor).toBe('36000');
    expect(body.baseCurrency).toBe('MYR');
  });

  it('日期不成形就 400，不去调 action', async () => {
    for (const query of ['from=2026-01-01', 'from=yesterday&to=2026-03-31', 'from=2026-01-01&to=31-03-2026']) {
      const response = await call(query);
      expect(response.status, query).toBe(400);
    }
    expect(getTaxReportAction).not.toHaveBeenCalled();
  });

  it('action 自己拒绝的区间（起日晚于止日）落成 400，不是 500', async () => {
    getTaxReportAction.mockRejectedValue(new Error('from must be on or before to'));

    const response = await call('from=2026-03-31&to=2026-01-01');

    expect(response.status).toBe(400);
  });

  it('没有权限时回 403', async () => {
    getTaxReportAction.mockRejectedValue(new FakeAuthError('forbidden', 'nope'));

    const response = await call('from=2026-01-01&to=2026-03-31');

    expect(response.status).toBe(403);
  });

  it('不缓存', async () => {
    const response = await call('from=2026-01-01&to=2026-03-31');

    expect(response.headers.get('cache-control')).toContain('no-store');
  });
});
