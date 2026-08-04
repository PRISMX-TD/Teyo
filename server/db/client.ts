import postgres from 'postgres';

/**
 * 全应用唯一的连接池，惰性创建。
 *
 * 惰性很关键：构建期 Next.js 会为每个路由收集配置，进而加载 root layout 的
 * 整张模块图。Vercel 在构建阶段不注入运行时环境变量，若在模块顶层读
 * DATABASE_URL 并抛错，构建会直接失败（Failed to collect configuration
 * for /_not-found）。改为首次查询时才解析连接串，构建期只要没人真的发查询
 * 就不会碰到这个变量。
 *
 * 注意：计划里原本在这里写 `connection: { role: 'teyo_app' }`，但实测该启动参数
 * 会被 Supabase pooler 静默忽略——连接仍是 postgres 且 rolbypassrls=true，
 * 于是所有 RLS 策略形同不存在。因此角色切换改为在每个事务内显式执行，
 * 见 server/db/transaction.ts 的 withTransaction。
 *
 * 直接用这个 sql 实例查询不受 RLS 约束，仅限迁移、维护脚本与测试断言使用；
 * 一切用户请求都必须经由 withTransaction。
 */
let pool: postgres.Sql | null = null;

function getPool(): postgres.Sql {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set.');
  }

  pool = postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    transform: { undefined: null },
  });

  return pool;
}

/**
 * 代理到惰性连接池。对调用方而言用法与 postgres.js 的 sql 实例完全一致
 * （模板标签调用、sql.begin、sql.end、sql(identifier) 等），
 * 区别只是首次访问时才建池。
 */
export const sql = new Proxy((() => {}) as unknown as postgres.Sql, {
  apply(_target, _thisArg, args: unknown[]) {
    return Reflect.apply(getPool() as never, undefined, args);
  },
  get(_target, property, receiver) {
    const value = Reflect.get(getPool(), property, receiver);
    return typeof value === 'function' ? value.bind(getPool()) : value;
  },
  has(_target, property) {
    return Reflect.has(getPool(), property);
  },
});
