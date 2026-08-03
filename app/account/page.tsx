import { getMessages } from '@/lib/i18n';
import { updateProfile } from '@/server/actions/profile';
import { requireUserId } from '@/server/auth/guard';
import { getUserLocale } from '@/server/repositories/organizations';
import { updatePassword } from '@/server/actions/auth';

export default async function AccountPage() {
  const userId = await requireUserId();
  const locale = (await getUserLocale(userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  return (
    <main className="account-page">
      <h1>{t.account.title}</h1>

      <section>
        <h2>{t.account.displayName}</h2>
        <form
          action={async (formData: FormData) => {
            'use server';
            await updateProfile({
              displayName: String(formData.get('displayName') ?? ''),
              locale,
            });
          }}
        >
          <label htmlFor="displayName">{t.account.displayName}</label>
          <input id="displayName" name="displayName" required />

          <button type="submit">{t.settings.save}</button>
        </form>
      </section>

      <section>
        <h2>{t.account.language}</h2>
        <form
          action={async (formData: FormData) => {
            'use server';
            await updateProfile({
              displayName: String(formData.get('displayName') ?? ''),
              locale: String(formData.get('locale')) as 'en' | 'zh',
            });
          }}
        >
          <label htmlFor="locale">{t.account.language}</label>
          <select id="locale" name="locale" defaultValue={locale}>
            <option value="en">{t.account.english}</option>
            <option value="zh">{t.account.chinese}</option>
          </select>

          <button type="submit">{t.settings.save}</button>
        </form>
      </section>

      <section>
        <h2>{t.account.changePassword}</h2>
        <form
          action={async (formData: FormData) => {
            'use server';
            await updatePassword(String(formData.get('newPassword') ?? ''));
          }}
        >
          <label htmlFor="newPassword">{t.account.newPassword}</label>
          <input id="newPassword" name="newPassword" type="password" minLength={8} required />

          <button type="submit">{t.auth.resetPassword}</button>
        </form>
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
