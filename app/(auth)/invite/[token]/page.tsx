import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getInvitationPreview } from '@/server/actions/profile';
import { acceptInvitation } from '@/server/actions/members';
import { signOut } from '@/server/actions/auth';
import { getMessages } from '@/lib/i18n';
import { AuthError } from '@/server/auth/guard';
import { getCurrentUserId } from '@/server/auth/session';
import { getUserLocale } from '@/server/repositories/organizations';

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;
  const invitePath = `/invite/${token}`;

  const userId = await getCurrentUserId();
  // 未登录时带着邀请地址去登录/注册，登录后才能回到这里点「接受」，
  // 否则新用户会被一路带到 /onboarding 去建公司。
  if (!userId) redirect(`/login?next=${encodeURIComponent(invitePath)}`);

  const locale = (await getUserLocale(userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const preview = await getInvitationPreview(token);
  const org = preview.organizationName;

  async function accept() {
    'use server';
    let orgSlug: string;
    try {
      ({ orgSlug } = await acceptInvitation(token));
    } catch (err) {
      // 不能让它冒泡到 error.tsx：生产构建会把消息换成通用摘要，用户只看到
      // 「出了点问题」。页面加载与点击之间邀请被撤销、过期、或重复提交都会走到这里。
      if (err instanceof AuthError) {
        // 只带一个标记，不带消息原文：否则任何人都能拼一条链接让页面显示任意文字。
        // 重新加载后 preview 会给出具体状态（已撤销、已过期、已是成员……）。
        redirect(`${invitePath}?error=1`);
      }
      throw err;
    }
    redirect(`/${orgSlug}`);
  }

  async function switchAccount() {
    'use server';
    await signOut(invitePath);
  }

  return (
    <main className="invite-page">
      {preview.state === 'member' ? (
        <>
          <h1>{t.invite.alreadyMember}</h1>
          <p>
            <Link href={`/${preview.organizationSlug}`}>
              {t.invite.goToCompany.replace('{org}', org)}
            </Link>
          </p>
        </>
      ) : preview.state === 'suspended' ? (
        <h1>{t.invite.suspended.replace('{org}', org)}</h1>
      ) : preview.state === 'wrongAccount' ? (
        <>
          <h1>{t.invite.title}</h1>
          <p>{t.invite.wrongAccount.replace('{email}', preview.signedInEmail ?? '')}</p>
          <form action={switchAccount}>
            <button type="submit">{t.invite.switchAccount}</button>
          </form>
        </>
      ) : preview.state === 'invalid' ? (
        <>
          <h1>{t.invite.invalid}</h1>
          <p>{t.invite.expired}</p>
        </>
      ) : preview.state === 'accepted' || preview.state === 'expired' || preview.state === 'revoked' ? (
        // 已接受的邀请对当前账号来说就是失效的（是本人接受的话上面 member 分支已处理）。
        <h1>{t.invite.expired}</h1>
      ) : (
        <>
          <h1>{t.invite.title}</h1>
          <p>{t.invite.body.replace('{org}', org).replace('{role}', preview.role)}</p>
          {error ? (
            <p role="alert" className="form-error">
              {t.invite.acceptFailed}
            </p>
          ) : null}
          <form action={accept}>
            <button type="submit">{t.invite.accept}</button>
          </form>
        </>
      )}
    </main>
  );
}
