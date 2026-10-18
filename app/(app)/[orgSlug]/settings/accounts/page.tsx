import { BackLink } from '@/components/ui/back-link';
import { Plus } from '@/components/ui/icons';
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
      <BackLink href={`/${orgSlug}/settings`}>{t.nav.settings}</BackLink>
      {/* 新增表单在几十个科目的最下面；页头给一个跳过去的入口。 */}
      <div className="page-header">
        <h1>{t.settings.accounts}</h1>
        <div className="page-header-actions">
          <a href="#add-account" className="add-button">
            <Plus size={16} weight="bold" aria-hidden="true" />
            {t.settings.addAccount}
          </a>
        </div>
      </div>
      <CoAList
        orgSlug={orgSlug}
        items={items}
        locale={locale}
        createAction={createAccount}
        renameAction={renameAccount}
        toggleAction={setAccountActive}
      />
    </>
  );
}
