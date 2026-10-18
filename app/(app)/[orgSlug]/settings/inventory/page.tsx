import { BackLink } from '@/components/ui/back-link';
import { InventoryList } from '@/components/settings/inventory-list';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { getInventoryValuation, listInventoryItems } from '@/server/repositories/inventory';
import { InventoryValuation } from '@/components/reports/inventory-valuation';
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

  const { inventoryItems, valuation } = await withTransaction(context.userId, async (tx) => ({
    inventoryItems: await listInventoryItems(tx, context.organizationId),
    valuation: await getInventoryValuation(tx, context.organizationId),
  }));

  const accounts = await withTransaction(context.userId, (tx) =>
    listAllAccounts(tx, context.organizationId),
  );

  return (
    <>
      <BackLink href={`/${orgSlug}/settings`}>{t.nav.settings}</BackLink>
      <h1>{t.inventory.title}</h1>
      <InventoryList
        orgSlug={orgSlug}
        locale={locale}
        baseCurrency={context.baseCurrency}
        items={inventoryItems}
        accounts={accounts.map((a) => ({
          id: a.id,
          code: a.code,
          nameEn: a.nameEn ?? '',
          nameZh: a.nameZh ?? '',
          type: a.type,
        }))}
      />

      {/* 估值表此前没有任何页面渲染（组件与 getInventoryValuation 都零引用）。
          它是与资产负债表上「存货」科目对账的那张表：合计应当恰好等于
          科目余额，停用但仍有在库数量的物料也算在里面。 */}
      {valuation.length > 0 ? (
        <>
          <h2>{t.inventory.valuation}</h2>
          <InventoryValuation
            valuation={valuation}
            locale={locale}
            baseCurrency={context.baseCurrency}
          />
        </>
      ) : null}
    </>
  );
}
