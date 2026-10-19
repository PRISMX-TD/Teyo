import { BackLink } from '@/components/ui/back-link';
import { Plus } from '@/components/ui/icons';
import { InventoryList } from '@/components/settings/inventory-list';
import { getMessages } from '@/lib/i18n';
import { requirePagePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { getInventoryValuation, listInventoryItems } from '@/server/repositories/inventory';
import { InventoryValuation } from '@/components/reports/inventory-valuation';
import { listAllAccounts } from '@/server/repositories/accounts';

function trimQuantity(quantity: string): string {
  return quantity.includes('.') ? quantity.replace(/\.?0+$/, '') : quantity;
}

export default async function InventorySettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePagePermission(orgSlug, 'account:manage');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  // 三条查询互不依赖：同一个事务里一起发，原来是两次事务、三次串行。
  const [inventoryItems, valuation, accounts] = await withTransaction(context.userId, (tx) =>
    Promise.all([
      listInventoryItems(tx, context.organizationId),
      getInventoryValuation(tx, context.organizationId),
      listAllAccounts(tx, context.organizationId),
    ]),
  );

  return (
    <>
      <BackLink href={`/${orgSlug}/settings`}>{t.nav.settings}</BackLink>
      {/* 与分类、联系人同一个样子：页头的「新增」跳到物品列表下面的表单。 */}
      <div className="page-header">
        <h1>{t.inventory.title}</h1>
        <div className="page-header-actions">
          <a href="#add-item" className="add-button">
            <Plus size={16} weight="bold" aria-hidden="true" />
            {t.inventory.addItem}
          </a>
        </div>
      </div>
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
            // 数量是 numeric(12,4) 的原样字符串，「500.0000」直接印在卡片上。
            // 只去掉小数尾部的零，仍是合法的十进制串，组件怎么再格式化都行。
            valuation={valuation.map((v) => ({ ...v, quantity: trimQuantity(v.quantity) }))}
            locale={locale}
            baseCurrency={context.baseCurrency}
          />
        </>
      ) : null}
    </>
  );
}
