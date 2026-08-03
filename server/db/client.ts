import postgres from 'postgres';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not set.');
}

/**
 * 全应用唯一的连接池。
 *
 * 注意：计划里原本在这里写 `connection: { role: 'teyo_app' }`，但实测该启动参数
 * 会被 Supabase pooler 静默忽略——连接仍是 postgres 且 rolbypassrls=true，
 * 于是所有 RLS 策略形同不存在。因此角色切换改为在每个事务内显式执行，
 * 见 server/db/transaction.ts 的 withTransaction。
 *
 * 直接用这个 sql 实例查询不受 RLS 约束，仅限迁移、维护脚本与测试断言使用；
 * 一切用户请求都必须经由 withTransaction。
 */
export const sql = postgres(connectionString, {
  max: 10,
  idle_timeout: 20,
  transform: { undefined: null },
});
