import { redirect } from 'next/navigation';
import { requireUserId } from '@/server/auth/guard';
import { getMessages } from '@/lib/i18n';
import { listUserOrganizations } from '@/server/repositories/organizations';
import { createOrganization } from '@/server/actions/organizations';

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
          const name = String(formData.get('companyName') ?? '').trim();
          if (!name || name.length < 2) return;

          // 复用 createOrganization：它会在同一事务内写入 owner membership。
          // 少了那一步，accounts / categories 的 RLS 策略（要求 owner 或 admin）
          // 会拒绝 seed 插入，报 "new row violates row-level security policy"。
          const { slug } = await createOrganization({
            name,
            baseCurrency: String(formData.get('baseCurrency') ?? 'MYR').trim().toUpperCase(),
            timezone: String(formData.get('timezone') ?? 'Asia/Kuala_Lumpur').trim(),
            industry: String(formData.get('industry') ?? '').trim() || undefined,
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
