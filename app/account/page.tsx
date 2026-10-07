import { getMessages } from '@/lib/i18n';
import { updateProfile, updateLocale } from '@/server/actions/profile';
import { requireUserId } from '@/server/auth/guard';
import { getUserLocale } from '@/server/repositories/organizations';
import { updatePassword } from '@/server/actions/auth';
import { withTransaction } from '@/server/db/transaction';
import Link from 'next/link';
import { redirect } from 'next/navigation';

/**
 * 保存结果走「redirect 回本页 + 查询参数」，与 settings/general 同一套做法。
 * 之前三个表单保存后既不提示也不回显：改名框永远是空的，改密码的错误
 * （updatePassword 返回的 { error }）被直接丢掉，成功时反而把人踢回首页。
 */
type Saved = 'profile' | 'locale' | 'password';
type Failed = 'profile' | 'password';

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const userId = await requireUserId();
  const locale = (await getUserLocale(userId)) as 'en' | 'zh';
  const t = getMessages(locale);
  const query = await searchParams;
  const saved = query.saved as Saved | undefined;
  const failed = query.error as Failed | undefined;

  const [me] = await withTransaction(
    userId,
    (tx) => tx`select display_name from app_users where id = ${userId}`,
  );
  const displayName = (me?.display_name as string | undefined) ?? '';

  return (
    <main className="account-page">
      <Link href="/" className="back-link">
        ← {t.common.back}
      </Link>
      <h1>{t.account.title}</h1>

      <section>
        <h2>{t.account.displayName}</h2>
        <form
          action={async (formData: FormData) => {
            'use server';
            try {
              await updateProfile({
                displayName: String(formData.get('displayName') ?? ''),
                locale,
              });
            } catch {
              // updateProfile 只会因名字为空或过长而拒绝；抛出去就是整页错误。
              redirect('/account?error=profile');
            }
            redirect('/account?saved=profile');
          }}
        >
          <label htmlFor="displayName" className="visually-hidden">
            {t.account.displayName}
          </label>
          <input
            id="displayName"
            name="displayName"
            required
            maxLength={80}
            defaultValue={displayName}
          />

          <button type="submit">{t.settings.save}</button>
        </form>
        {saved === 'profile' ? (
          <p role="status" className="form-success">
            {t.settings.saved}
          </p>
        ) : null}
        {failed === 'profile' ? (
          <p role="alert" className="form-error">
            {t.account.nameInvalid}
          </p>
        ) : null}
      </section>

      <section>
        <h2>{t.account.language}</h2>
        <form
          action={async (formData: FormData) => {
            'use server';
            await updateLocale(String(formData.get('locale') ?? 'en'));
            redirect('/account?saved=locale');
          }}
        >
          <label htmlFor="locale" className="visually-hidden">
            {t.account.language}
          </label>
          <select id="locale" name="locale" defaultValue={locale}>
            <option value="en">{t.account.english}</option>
            <option value="zh">{t.account.chinese}</option>
          </select>

          <button type="submit">{t.settings.save}</button>
        </form>
        {saved === 'locale' ? (
          <p role="status" className="form-success">
            {t.settings.saved}
          </p>
        ) : null}
      </section>

      <section>
        <h2>{t.account.changePassword}</h2>
        <form
          action={async (formData: FormData) => {
            'use server';
            // 成功时 updatePassword 会 redirect 到 next；不传的话是 '/'，人被带离本页。
            const result = await updatePassword(
              String(formData.get('newPassword') ?? ''),
              '/account?saved=password',
            );
            // 只带标记不带原文，理由同邀请页：不让任何人拼链接让页面显示任意文字。
            if (result?.error) redirect('/account?error=password');
          }}
        >
          <label htmlFor="newPassword" className="visually-hidden">
            {t.account.newPassword}
          </label>
          <input id="newPassword" name="newPassword" type="password" minLength={8} required />

          <button type="submit">{t.auth.resetPassword}</button>
        </form>
        {saved === 'password' ? (
          <p role="status" className="form-success">
            {t.settings.saved}
          </p>
        ) : null}
        {failed === 'password' ? (
          <p role="alert" className="form-error">
            {t.account.passwordRejected}
          </p>
        ) : null}
      </section>

      <section>
        <form
          action={async () => {
            'use server';
            const { signOut } = await import('@/server/actions/auth');
            await signOut();
          }}
        >
          <button type="submit">{t.auth.signOut}</button>
        </form>
      </section>
    </main>
  );
}
