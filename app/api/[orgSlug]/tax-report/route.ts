/**
 * 税额汇总。
 *
 * server/actions/tax.ts 的 getTaxReportAction 早就写好、也测过
 * （tests/repositories/tax-report.test.ts），components/reports/tax-report-view.tsx
 * 也写好了——中间**缺的就是这一段**，把两者接起来。此前全仓库没有任何地方
 * import 过那个组件，也没有任何地方调用过那个 action。
 *
 * 这里是一层薄的 HTTP 适配：权限与日期校验仍然由 action 做（它是服务端唯一
 * 的入口，测试测的也是它），这边只负责把 bigint 换成字符串——JSON.stringify
 * 碰到 bigint 会直接抛 TypeError，整个响应挂掉。
 */
import { NextResponse } from 'next/server';
import { AuthError } from '@/server/auth/guard';
import { getTaxReportAction } from '@/server/actions/tax';
import type { TaxSideView } from '@/components/reports/tax-report-view';

export const dynamic = 'force-dynamic';

export type TaxReportResponse = {
  outputTax: TaxSideView;
  inputTax: TaxSideView;
  netPayableMinor: string;
  baseCurrency: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgSlug: string }> },
): Promise<NextResponse> {
  const { orgSlug } = await params;
  const url = new URL(request.url);
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';

  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  try {
    const report = await getTaxReportAction(orgSlug, from, to);
    const body: TaxReportResponse = {
      outputTax: {
        netMinor: report.outputTax.netMinor.toString(),
        taxMinor: report.outputTax.taxMinor.toString(),
        unmatchedTaxMinor: report.outputTax.unmatchedTaxMinor.toString(),
      },
      inputTax: {
        netMinor: report.inputTax.netMinor.toString(),
        taxMinor: report.inputTax.taxMinor.toString(),
        unmatchedTaxMinor: report.inputTax.unmatchedTaxMinor.toString(),
      },
      netPayableMinor: report.netPayableMinor.toString(),
      baseCurrency: report.baseCurrency,
    };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    // action 里的 dateRangeSchema 会把「起日晚于止日」一类挡下来。那是用户
    // 填错了，不是服务器坏了——400 而不是 500。
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
}
