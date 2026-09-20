'use server';

import { createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { parseOrThrow } from '@/lib/schemas';
import type { Locale } from '@/lib/i18n';
import { withoutUserContext, withTransaction } from '@/server/db/transaction';
import { requireUserId } from '@/server/auth/guard';
import type { Role } from '@/server/domain/permissions';

const profileSchema = z
  .object({
    displayName: z.string().trim().min(1, 'Enter your name.').max(80, 'Keep your name under 80 characters.'),
    locale: z.enum(['en', 'zh']),
  })
  .strict();

/**
 * 改自己的资料。
 *
 * 走 withTransaction 而不是裸 sql。server/db/client.ts 自己的注释就写着
 * 「直接用这个 sql 实例查询不受 RLS 约束，仅限迁移、维护脚本与测试断言使用；
 * 一切用户请求都必须经由 withTransaction」——这里是用户请求，之前却是裸
 * sql，等于以 postgres 超级用户身份执行一条 where 只有 id 的 UPDATE。
 * 那条 where 今天是对的（id 来自 requireUserId），但它是唯一的防线：
 * 哪天有人把 userId 换成一个来自入参的值，RLS 一句话都不会说。
 *
 * 换回 withTransaction 之后这条语句在 app_users_self 策略下执行
 * （0002_rls.sql：`for all using (id = app_current_user_id())`），
 * 策略完全覆盖这个场景——用户改自己那一行，一行不多一行不少。
 */
export async function updateProfile(input: {
  displayName: string;
  locale: Locale;
}): Promise<void> {
  const userId = await requireUserId();
  const parsed = parseOrThrow(profileSchema, input, (m) => new Error(m));

  await withTransaction(userId, async (tx) => {
    await tx`
      update app_users
      set display_name = ${parsed.displayName}, locale = ${parsed.locale}
      where id = ${userId}
    `;
  });

  revalidatePath('/account');
}

const localeSchema = z.enum(['en', 'zh']);

/** 换界面语言。理由同 updateProfile：用户请求必须走 withTransaction。 */
export async function updateLocale(locale: string): Promise<void> {
  const userId = await requireUserId();
  const parsed = parseOrThrow(localeSchema, locale, (m) => new Error(m));

  await withTransaction(userId, async (tx) => {
    await tx`update app_users set locale = ${parsed} where id = ${userId}`;
  });

  // 必须 revalidate root layout，因为 app layout 里 getUserLocale 读的就是 app_users.locale
  revalidatePath('/', 'layout');
  revalidatePath('/account');
}

export type InvitationPreview = {
  organizationName: string;
  role: Role | 'viewer';
  state: 'valid' | 'expired' | 'revoked' | 'accepted' | 'invalid';
};

/**
 * 按邀请 token 查一眼「这是哪家公司、什么角色、还有效吗」。
 *
 * 加 requireUserId 的理由：这是一个 `'use server'` 的导出，也就是一个任何人
 * 都能直接 POST 的远程端点，而它内部走 withoutUserContext——以 postgres
 * 身份执行，绕开全部 RLS。也就是说，在这之前它是一个**完全无鉴权**的入口，
 * 谁都能拿 token 的 hash 去换公司名称与角色。
 *
 * 加上之后成本是零：唯一的调用方 app/(auth)/invite/[token]/page.tsx 本来就
 * 先调了 requireUserId()，那一次的结果被 React.cache 记住了（见
 * server/auth/session.ts / guard.ts），这里不会多一次网络往返。
 *
 * 为什么仍然保留 withoutUserContext：被邀请的人此刻还不是这家公司的成员，
 * 任何按成员关系过滤的策略都会让他什么也查不到——这正是邀请的定义。
 * 收窄在别处：token 只以 sha256 摘要的形式出现（原文只在邮件里），
 * app_find_invitation 也只返回预览需要的那几列。
 */
export async function getInvitationPreview(token: string): Promise<InvitationPreview> {
  await requireUserId();

  const tokenHash = createHash('sha256').update(token).digest('hex');

  const rows = await withoutUserContext(
    (tx) => tx`select * from app_find_invitation(${tokenHash})`,
  );

  if (rows.length === 0) {
    return { organizationName: '', role: 'viewer', state: 'invalid' };
  }

  const invitation = rows[0];
  const state = invitation.revoked_at
    ? 'revoked'
    : invitation.accepted_at
      ? 'accepted'
      : new Date(invitation.expires_at as string) <= new Date()
        ? 'expired'
        : 'valid';

  return {
    organizationName: (invitation.organization_name as string) ?? '',
    role: (invitation.role as Role) ?? 'viewer',
    state,
  };
}
