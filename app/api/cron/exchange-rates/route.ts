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
 * 本地日期，不能用 toISOString()：那会先转 UTC，
 * 在 UTC+8 的凌晨 2 点跑会把日期退回前一天。
 */
function todayLocal(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
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

  const today = todayLocal();

  try {
    const result = await syncRatesForDate(today);
    return NextResponse.json({ date: today, inserted: result.inserted });
  } catch (error) {
    return NextResponse.json({ date: today, error: (error as Error).message }, { status: 502 });
  }
}
