import { InventoryList } from '@/components/settings/inventory-list';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listInventoryItems } from '@/server/repositories/inventory';
import { listAllAccounts } from '@/server/repositories/accounts';

export default async function InventorySettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'account:manage');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const inventoryItems = await withTransaction(context.userId, (tx) =>
    listInventoryItems(tx, context.organizationId),
  );

  const accounts = await withTransaction(context.userId, (tx) =>
    listAllAccounts(tx, context.organizationId),
  );

  return (
    <>
      <h1>{t.inventory.title}</h1>
      <InventoryList
        orgSlug={orgSlug}
        locale={locale}
        items={inventoryItems}
        accounts={accounts.map((a) => ({
          id: a.id,
          code: a.code,
          nameEn: a.nameEn ?? '',
          nameZh: a.nameZh ?? '',
          type: a.type,
        }))}
      />
    </>
  );
}
