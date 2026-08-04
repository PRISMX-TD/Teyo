import { NamedList } from '@/components/settings/named-list';
import { getMessages } from '@/lib/i18n';
import { createMoneyAccount, renameAccount, setAccountActive } from '@/server/actions/accounts';
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
    nameEn: a.nameEn,
    nameZh: a.nameZh,
    isActive: a.isActive,
    extra: a.isMoneyAccount ? (t.settings.accountType ?? '') : '',
  }));

  return (
    <>
      <h1>{t.settings.accounts}</h1>
      <NamedList
        orgSlug={orgSlug}
        items={items}
        locale={locale}
        onCreate={createMoneyAccount as unknown as (orgSlug: string, payload: Record<string, unknown>) => Promise<unknown>}
        onRename={renameAccount as unknown as (orgSlug: string, id: string, names: Record<string, string>) => Promise<unknown>}
        onToggle={setAccountActive as unknown as (orgSlug: string, id: string, active: boolean) => Promise<unknown>}
      />
    </>
  );
}
