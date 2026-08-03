import { redirect } from 'next/navigation';
import { requireUserId } from '@/server/auth/guard';
import { getMessages } from '@/lib/i18n';
import {
  listUserOrganizations,
  generateUniqueSlug,
  insertOrganization,
} from '@/server/repositories/organizations';
import { withTransaction } from '@/server/db/transaction';
import { seedChartOfAccounts } from '@/server/services/account-seed';

export default async function OnboardingPage() {
  const userId = await requireUserId();
  const existingOrgs = await listUserOrganizations(userId);

  if (existingOrgs.length > 0) {
    // 已有公司 → 跳第一家
    redirect(`/${existingOrgs[0].slug}`);
  }

  const t = getMessages('en');

  return (
    <main className="onboarding-page">
      <h1>{t.onboarding.title}</h1>
      <p>{t.onboarding.subtitle}</p>

      <form
        action={async (formData: FormData) => {
          'use server';
          const userId = await requireUserId();
          const name = String(formData.get('companyName') ?? '').trim();
          const baseCurrency = String(formData.get('baseCurrency') ?? 'MYR').trim().toUpperCase();
          const timezone = String(formData.get('timezone') ?? 'Asia/Kuala_Lumpur').trim();
          const industry = String(formData.get('industry') ?? '').trim() || null;

          if (!name || name.length < 2) return;

          // 创建公司 + seed → 页面刷新后走上面的 redirect
          const slug = await withTransaction(userId, async (tx) => {
            const s = await generateUniqueSlug(tx, name);
            const id = await insertOrganization(tx, {
              name,
              slug: s,
              baseCurrency,
              timezone,
              industry,
              createdBy: userId,
            });
            await seedChartOfAccounts(tx, id);
            return s;
          });

          redirect(`/${slug}`);
        }}
      >
        <label htmlFor="companyName">{t.onboarding.companyName}</label>
        <input id="companyName" name="companyName" type="text" required minLength={2} />

        <label htmlFor="baseCurrency">{t.onboarding.baseCurrency}</label>
        <select id="baseCurrency" name="baseCurrency" defaultValue="MYR">
          <option value="MYR">MYR</option>
          <option value="SGD">SGD</option>
          <option value="USD">USD</option>
        </select>
        <p className="hint">{t.onboarding.baseCurrencyHint}</p>

        <label htmlFor="timezone">{t.onboarding.timezone}</label>
        <select id="timezone" name="timezone" defaultValue="Asia/Kuala_Lumpur">
          <option value="Asia/Kuala_Lumpur">Asia/Kuala Lumpur (GMT+8)</option>
          <option value="Asia/Singapore">Asia/Singapore (GMT+8)</option>
          <option value="Asia/Shanghai">Asia/Shanghai (GMT+8)</option>
        </select>

        <label htmlFor="industry">{t.onboarding.industry}</label>
        <input id="industry" name="industry" type="text" />

        <button type="submit">{t.onboarding.submit}</button>
      </form>
    </main>
  );
}
