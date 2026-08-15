import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireUserId } from '@/server/auth/guard';
import { getMessages } from '@/lib/i18n';
import { listUserOrganizations, getUserLocale } from '@/server/repositories/organizations';

/** 有公司就跳第一家公司，没有就跳 /onboarding，只有一家则展示链接。 */
export default async function HomePage() {
  const userId = await requireUserId();
  const orgs = await listUserOrganizations(userId);

  if (orgs.length === 0) {
    redirect('/onboarding');
  }

  if (orgs.length === 1) {
    redirect(`/${orgs[0].slug}`);
  }

  const locale = (await getUserLocale(userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  return (
    <main className="landing">
      <h1>{t.brand.name}</h1>
      <p>{t.brand.tagline}</p>
      <nav>
        <ul>
          {orgs.map((org) => (
            <li key={org.id}>
              <Link href={`/${org.slug}`}>{org.name}</Link>
            </li>
          ))}
        </ul>
      </nav>
    </main>
  );
}
