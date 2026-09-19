import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { syncRatesForDate } from '@/server/services/exchange-rate-sync';

export const dynamic = 'force-dynamic';

/** 定长比较，避免用 !== 比对密钥时通过响应时间逐字节试探。 */
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(`Bearer ${expected}`);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 汇率按哪个时区的「今天」同步。
 *
 * exchange_rates 是全局表（唯一一张不带 organization_id 的业务表），所以
 * 这里没有「当前公司」可问，只能选一个市场时区。选马来西亚是因为
 * organizations.timezone 的默认值就是 Asia/Kuala_Lumpur——这是产品的主
 * 市场，也是绝大多数用户按下保存时心里的那个日期。
 */
const RATE_SYNC_TIMEZONE = 'Asia/Kuala_Lumpur';

/**
 * 指定时区的今天，格式 YYYY-MM-DD。
 *
 * 这里原来是 `new Date()` 加 getFullYear/getMonth/getDate，注释写着
 * 「不能用 toISOString()：那会先转 UTC，在 UTC+8 的凌晨 2 点跑会把日期
 * 退回前一天」。方向是对的，但这组 getter 读的是**运行环境的本地时区**，
 * 而 Vercel 的 Node 运行时 TZ 就是 UTC——它躲开了 toISOString，却又原路
 * 回到了同一个 UTC 日期。注释描述的意图，代码一天都没有实现过。
 *
 * Intl 的 en-CA 恰好输出 YYYY-MM-DD，且 timeZone 是显式参数，不依赖进程
 * 的 TZ 环境变量，本地跑和线上跑得到同一个答案。
 */
function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export async function GET(request: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;

  // 未配置密钥时直接拒绝，而不是放行：否则漏配环境变量就等于把端点公开。
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET is not configured.' }, { status: 500 });
  }

  if (!secretMatches(request.headers.get('authorization'), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const today = todayIn(RATE_SYNC_TIMEZONE);

  try {
    const result = await syncRatesForDate(today);
    // failures 必须出现在响应体里。四个 base 里坏了一个时，同步整体算成功
    // （另外三个确实写进去了），但如果只回一个 inserted 数字，「部分失败」
    // 与「全部成功」在 Vercel 的 cron 日志里长得一模一样——而部分失败意味着
    // 某个币种从今天起查不到汇率，用户那一侧表现为存不下单子。
    return NextResponse.json({
      date: today,
      inserted: result.inserted,
      failures: result.failures,
      // 有失败但整体成功时给一个显式状态位，省得监控去判断数组长度。
      status: result.failures.length === 0 ? 'ok' : 'partial',
    });
  } catch (error) {
    return NextResponse.json({ date: today, error: (error as Error).message }, { status: 502 });
  }
}
