import { getMessages } from '@/lib/i18n';
import { updateProfile, updateLocale } from '@/server/actions/profile';
import { requireUserId } from '@/server/auth/guard';
import { getUserLocale } from '@/server/repositories/organizations';
import { updatePassword } from '@/server/actions/auth';
import { withTransaction } from '@/server/db/transaction';
import { PasswordInput } from '@/components/auth/password-input';
import { BackLink } from '@/components/ui/back-link';
import { SignOut } from '@/components/ui/icons';
import { safeNextPath } from '@/lib/safe-next-path';
import { redirect } from 'next/navigation';

/**
 * 保存结果走「redirect 回本页 + 查询参数」，与 settings/general 同一套做法。
 * 之前三个表单保存后既不提示也不回显：改名框永远是空的，改密码的错误
 * （updatePassword 返回的 { error }）被直接丢掉，成功时反而把人踢回首页。
 *
 * 版面是 iOS 设置的分组：头像 + 名字在上，下面一组一张卡片，每组一句
 * 脚注说清楚改了会怎样。原来每一组都是「标题 + 输入框 + 一块白色的
 * 保存按钮」竖着叠，密码框连个标签都没有，最后一张卡片里只孤零零放着
 * 一颗红色的「退出」。
 */
type Saved = 'profile' | 'locale' | 'password';
type Failed = 'profile' | 'password';

/**
 * ?from= 是「返回」要回去的地方（顶栏头像、更多页、侧栏都会带上）。
 * 只认站内路径，且不能指回本页——否则「返回」原地打转。不合格就当没给，
 * 退回 '/'。每次保存都 redirect 回本页，所以 from 要跟着带回来，不然
 * 存过一次之后「返回」又变回 '/'。
 */
function returnPath(raw: unknown): string | undefined {
  // ?from=a&from=b 会解析成数组，不认。
  if (typeof raw !== 'string' || !raw) return undefined;
  const safe = safeNextPath(raw);
  if (safe === '/' || /^\/account(?:[/?#]|$)/.test(safe)) return undefined;
  return safe;
}

function accountHref(status: string, from: string | undefined): string {
  const back = returnPath(from);
  return back ? `/account?${status}&from=${encodeURIComponent(back)}` : `/account?${status}`;
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string; from?: string }>;
}) {
  const userId = await requireUserId();
  const locale = (await getUserLocale(userId)) as 'en' | 'zh';
  const t = getMessages(locale);
  const query = await searchParams;
  const saved = query.saved as Saved | undefined;
  const failed = query.error as Failed | undefined;
  const from = returnPath(query.from);

  const [me] = await withTransaction(
    userId,
    (tx) => tx`select display_name, email from app_users where id = ${userId}`,
  );
  const displayName = (me?.display_name as string | undefined) ?? '';
  const email = (me?.email as string | undefined) ?? '';
  // Array.from 按码点切：中文名、带重音的名字取第一个字不会切出半个字符。
  const initial = (Array.from(displayName.trim() || email)[0] ?? '?').toUpperCase();

  return (
    <main className="account-page">
      <BackLink href={from ?? '/'}>{t.common.back}</BackLink>
      <h1>{t.account.title}</h1>

      <div className="account-hero">
        <span className="avatar" aria-hidden="true">
          {initial}
        </span>
        <div className="account-hero-text">
          <span className="account-hero-name">{displayName || email}</span>
          {displayName && email ? <span className="account-hero-sub">{email}</span> : null}
        </div>
      </div>

      <section className="grouped" aria-labelledby="account-profile">
        <h2 id="account-profile" className="grouped-title">
          {t.account.profile}
        </h2>
        <form
          className="grouped-card"
          action={async (formData: FormData) => {
            'use server';
            try {
              await updateProfile({
                displayName: String(formData.get('displayName') ?? ''),
                locale,
              });
            } catch {
              // updateProfile 只会因名字为空或过长而拒绝；抛出去就是整页错误。
              redirect(accountHref('error=profile', from));
            }
            redirect(accountHref('saved=profile', from));
          }}
        >
          <label htmlFor="displayName">{t.account.displayName}</label>
          <div className="inline-field">
            <input
              id="displayName"
              name="displayName"
              required
              maxLength={80}
              autoComplete="name"
              defaultValue={displayName}
              aria-describedby="displayName-hint"
              aria-invalid={failed === 'profile' ? true : undefined}
            />
            <button type="submit">{t.settings.save}</button>
          </div>
        </form>
        <p id="displayName-hint" className="grouped-note">
          {t.account.displayNameHint}
        </p>
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

      <section className="grouped" aria-labelledby="account-language">
        <h2 id="account-language" className="grouped-title">
          {t.account.language}
        </h2>
        {/* 两种语言就是两颗提交按钮：点哪个就存哪个，不用先选再点「保存」。
            提交按钮的 name/value 会随表单一起提交（React 19 的 form action
            同样带上 submitter），所以服务端读到的仍是 locale 这一个字段。 */}
        <form
          className="grouped-card"
          action={async (formData: FormData) => {
            'use server';
            await updateLocale(String(formData.get('locale') ?? 'en'));
            redirect(accountHref('saved=locale', from));
          }}
        >
          <div className="segmented" role="group" aria-labelledby="account-language" aria-describedby="locale-hint">
            <button type="submit" name="locale" value="zh" aria-pressed={locale === 'zh'} lang="zh">
              {t.account.chinese}
            </button>
            <button type="submit" name="locale" value="en" aria-pressed={locale === 'en'} lang="en">
              {t.account.english}
            </button>
          </div>
        </form>
        <p id="locale-hint" className="grouped-note">
          {t.account.languageHint}
        </p>
        {saved === 'locale' ? (
          <p role="status" className="form-success">
            {t.settings.saved}
          </p>
        ) : null}
      </section>

      <section className="grouped" aria-labelledby="account-security">
        <h2 id="account-security" className="grouped-title">
          {t.account.security}
        </h2>
        <form
          className="grouped-card"
          action={async (formData: FormData) => {
            'use server';
            // 成功时 updatePassword 会 redirect 到 next；不传的话是 '/'，人被带离本页。
            const result = await updatePassword(
              String(formData.get('newPassword') ?? ''),
              accountHref('saved=password', from),
            );
            // 只带标记不带原文，理由同邀请页：不让任何人拼链接让页面显示任意文字。
            if (result?.error) redirect(accountHref('error=password', from));
          }}
        >
          <label htmlFor="newPassword">{t.account.newPassword}</label>
          <div className="inline-field">
            <PasswordInput
              id="newPassword"
              name="newPassword"
              minLength={8}
              required
              autoComplete="new-password"
              aria-describedby="newPassword-hint"
              aria-invalid={failed === 'password' ? true : undefined}
              showLabel={t.auth.showPassword}
              hideLabel={t.auth.hidePassword}
            />
            <button type="submit">{t.account.updatePassword}</button>
          </div>
        </form>
        <p id="newPassword-hint" className="grouped-note">
          {t.account.passwordHint}
        </p>
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

      <section className="grouped">
        <form
          action={async () => {
            'use server';
            const { signOut } = await import('@/server/actions/auth');
            await signOut();
          }}
        >
          <button type="submit" className="row-button is-destructive">
            <SignOut size={18} weight="bold" aria-hidden="true" />
            {t.auth.signOut}
          </button>
        </form>
      </section>
    </main>
  );
}
