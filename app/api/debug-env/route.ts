import { NextResponse } from 'next/server';
import { sql } from '@/server/db/client';

/**
 * 临时诊断端点：确认线上环境变量与数据库连通性。
 * 用 CRON_SECRET 作为访问凭据，避免公开暴露基础设施信息。
 * 定位完 500 后必须删除。
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization');
  if (!secret || auth !== `Bearer ${secret}`) {
    return new NextResponse('Not found', { status: 404 });
  }

  // 只报是否存在，不回显值
  const present = Object.fromEntries(
    [
      'DATABASE_URL',
      'NEXT_PUBLIC_SUPABASE_URL',
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'CRON_SECRET',
    ].map((k) => [k, Boolean(process.env[k])]),
  );

  let db: string;
  try {
    const rows = await sql`select 1 as ok`;
    db = rows[0]?.ok === 1 ? 'connected' : 'unexpected result';
  } catch (e) {
    const err = e as { code?: string; message: string };
    db = `FAIL ${err.code ?? ''} ${err.message}`;
  }

  return NextResponse.json({ present, db });
}
