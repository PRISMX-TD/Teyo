import type { Locale } from '@/lib/i18n';
import { sql } from '@/server/db/client';

/**
 * 往 app_users 写业务资料。用户可能通过邀请链接注册，所以这个函数必须幂等，
 * 且不能用空名字覆盖已有名字。
 *
 * ── 为什么它在这里，而不在 server/actions/auth.ts ──
 *
 * 它原来是 `'use server'` 模块的一个导出。Next.js 会把这类模块的**每一个
 * 导出**注册成可远程调用的端点，于是这个函数变成了一个任何人都能 POST 的
 * 接口——而它本身没有、也不能有会话检查（/auth/callback 调用它的那一刻，
 * cookie 才刚写好）。
 *
 * 更早的一版是 `values (${userId}, ${email}, ...)` 加 `on conflict (id) do
 * update set email = excluded.email`：只要知道某个用户的 uuid，任何人都能
 * 把他 app_users 里的邮箱和姓名改成任意值，而 app_users.email 正是同公司
 * 同事在界面上看到的那个邮箱。改成从 auth.users 里 select 之后，邮箱改写
 * 已经不可能（下面那段注释解释了原理），但 display_name 仍然改得动：一个
 * 同时知道你 uuid 和邮箱的人，可以把你在同事列表里的显示名改成任何东西。
 *
 * 搬到这个非 `'use server'` 的模块，端点本身就不存在了——这是结构性的，
 * 不依赖任何一处记得做检查。调用方（server/actions/auth.ts 与
 * app/auth/callback/route.ts）直接 import 它，行为完全不变。
 *
 * ── 为什么这里用裸 sql，而不是 withTransaction ──
 *
 * server/db/client.ts 立的规矩是「一切用户请求都必须经由 withTransaction」，
 * 而这个函数是那条规矩唯一必要的破例，理由有两条，缺一条都不足以破例：
 *
 *   1. 这一行正是「这个用户在本应用里的存在」本身。它被调用的时刻是注册
 *      刚完成、邮箱刚确认的那一瞬，此时 app_users 里还没有这一行，
 *      memberships 里更是一条都没有——而 withTransaction 会把角色切成
 *      teyo_app 并设 app.user_id，RLS 策略此刻找不到任何可以放行的依据。
 *   2. 它要读 auth.users（见下面那个 select）。auth.users 属于 Supabase Auth
 *      的 schema，teyo_app 这个受限角色对它没有任何权限——切过去之后这条
 *      语句会直接报权限错误。
 *
 * ── 为什么要从 auth.users 里 select 而不是直接 values ──
 *
 * 写入的前提因此变成「这个 id 与这个邮箱在 Supabase Auth 里确实是同一个
 * 人」：id 不存在、或者邮箱对不上，语句影响 0 行，什么都不会发生。顺带还
 * 消掉了一个长期的数据完整性问题——app_users.email 从此不可能与
 * auth.users.email 不一致。
 */
export async function ensureAppUser(
  userId: string,
  email: string,
  displayName: string,
  locale: Locale,
): Promise<void> {
  const fallback = email.split('@')[0] ?? 'user';
  const name = displayName.trim().length > 0 ? displayName.trim() : fallback;

  await sql`
    insert into app_users (id, email, display_name, locale)
    select u.id, ${email}, ${name}, ${locale}
    from auth.users u
    where u.id = ${userId}
      and lower(u.email) = lower(${email})
    on conflict (id) do update
      set email = excluded.email,
          display_name = case
            when ${displayName.trim()} = '' then app_users.display_name
            else excluded.display_name
          end
  `;
}
