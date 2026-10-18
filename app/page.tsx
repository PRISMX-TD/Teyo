import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Plus } from '@/components/ui/icons';
import { requireUserId } from '@/server/auth/guard';
import { getMessages } from '@/lib/i18n';
import { listUserOrganizations, getUserLocale } from '@/server/repositories/organizations';

/** 没有公司跳 /onboarding，只有一家直接进去，多家则列出供选择。 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const { notice } = await searchParams;
  const userId = await requireUserId();
  const orgs = await listUserOrganizations(userId);

  if (orgs.length === 0) {
    redirect(notice === 'no_access' ? '/onboarding?notice=no_access' : '/onboarding');
  }

  // 带着 no_access 过来时不直接跳：否则「你已无权访问那家公司」这句提示
  // 永远显示不出来，用户只会莫名其妙地落到另一家公司。
  if (orgs.length === 1 && notice !== 'no_access') {
    redirect(`/${orgs[0].slug}`);
  }

  const locale = (await getUserLocale(userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  return (
    <main className="landing">
      <span className="brand-mark brand-mark--lg" aria-hidden="true">
        T
      </span>
      <h1>{t.brand.name}</h1>
      <p>{t.brand.tagline}</p>
      {notice === 'no_access' ? (
        <p role="status" className="form-error">
          {t.onboarding.noAccess}
        </p>
      ) : null}
      <nav>
        <ul>
          {orgs.map((org) => (
            <li key={org.id}>
              <Link href={`/${org.slug}`}>
                {/* 公司名首字当头像：几家公司并排时，认字头比读全名快。 */}
                <span className="avatar avatar--sm" aria-hidden="true">
                  {(Array.from(org.name.trim())[0] ?? '?').toUpperCase()}
                </span>
                <span>{org.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {/* 不带 new=1 的话，/onboarding 会把已有公司的人直接送回第一家。 */}
      <p className="landing-new">
        <Link href="/onboarding?new=1">
          <Plus size={16} weight="bold" aria-hidden="true" />
          {t.nav.newCompany}
        </Link>
      </p>
    </main>
  );
}
