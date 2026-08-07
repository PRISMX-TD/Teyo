import Link from 'next/link';
import { CoAList } from '@/components/settings/coa-list';
import { getMessages } from '@/lib/i18n';
import { createAccount, renameAccount, setAccountActive } from '@/server/actions/accounts';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listAllAccounts } from '@/server/repositories/accounts';

export default async function AccountsSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'account:manage');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const accounts = await withTransaction(context.userId, (tx) =>
    listAllAccounts(tx, context.organizationId),
  );

  const items = accounts.map((a) => ({
    id: a.id,
    code: a.code,
    nameEn: a.nameEn,
    nameZh: a.nameZh,
    type: a.type,
    isMoneyAccount: a.isMoneyAccount,
    isActive: a.isActive,
  }));

  return (
    <>
      <Link href={`/${orgSlug}/settings`} style={{ display: 'inline-block', marginBottom: 'var(--space-4)', color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
        &larr; {locale === 'zh' ? '设置' : 'Settings'}
      </Link>
      <h1>{t.settings.accounts}</h1>
      <CoAList
        orgSlug={orgSlug}
        items={items}
        locale={locale}
        createAction={createAccount as unknown as (orgSlug: string, payload: Record<string, unknown>) => Promise<unknown>}
        renameAction={renameAccount as unknown as (orgSlug: string, id: string, names: Record<string, string>) => Promise<unknown>}
        toggleAction={setAccountActive as unknown as (orgSlug: string, id: string, active: boolean) => Promise<unknown>}
      />
    </>
  );
}
