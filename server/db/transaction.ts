import type postgres from 'postgres';
import { sql } from '@/server/db/client';

export type Tx = postgres.TransactionSql<Record<string, never>>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 在单个事务内运行 fn，并建立 RLS 上下文：
 *   1. 切到 teyo_app —— 该角色没有 BYPASSRLS，策略对它真正生效；
 *   2. 设置 app.user_id —— 策略函数 app_current_user_id() 读取它。
 *
 * 两者都用 `set local`，随事务结束自动失效，不会泄漏到连接池里的下一次使用。
 * 缺少第 1 步的话，连接会以 postgres 身份运行并绕过全部策略，
 * 跨公司隔离将完全失效，因此这一步不可省略。
 */
export async function withTransaction<T>(
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID.test(userId)) {
    throw new Error(`withTransaction requires a UUID user id, received "${userId}".`);
  }

  const result = await sql.begin(async (tx) => {
    await tx`set local role teyo_app`;
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return (await fn(tx as Tx)) as unknown as never;
  });

  return result as unknown as T;
}

/**
 * 供无用户上下文的场景使用：Cron 同步汇率、按 token 查邀请。
 *
 * 这里刻意不切到 teyo_app：exchange_rates 只有读策略而没有写策略，
 * 若切换角色，Cron 写入汇率会被 RLS 拦下。此函数因此绕过 RLS，
 * 只能用于不含用户输入过滤的全局数据操作。
 */
export async function withoutUserContext<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    return (await fn(tx as Tx)) as unknown as never;
  });

  return result as unknown as T;
}
