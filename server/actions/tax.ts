'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  insertTaxRate,
  updateTaxRate,
  setDefaultTaxRate,
  deleteTaxRate,
  getTaxReport,
  listTaxRates,
  type TaxReport,
} from '@/server/repositories/tax';

/**
 * 税率上界 100%（10000 bps）。
 *
 * 原来只有 `min(0)`。没有上界时，一个手滑把 6 输成 600 的用户会得到一条
 * 6% 写成 600% 的税率，之后每一张用它的发票都会把税额算成净额的六倍，而
 * 发票本身（净额 + 税额 = 总额）与它过出来的分录全都配平——没有任何一道
 * 校验会发现，只有客户会。
 */
const MAX_RATE_BPS = 10_000;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const dateRangeSchema = z
  .object({
    from: z.string().regex(DATE_ONLY),
    to: z.string().regex(DATE_ONLY),
  })
  .refine((range) => range.from <= range.to, {
    message: 'The start date must be on or before the end date.',
  });

const createTaxRateSchema = z.object({
  nameEn: z.string().min(1).max(100),
  nameZh: z.string().min(1).max(100),
  rateBps: z.number().int().min(0).max(MAX_RATE_BPS),
  isDefault: z.boolean().default(false),
});

const updateTaxRateSchema = z.object({
  nameEn: z.string().min(1).max(100).optional(),
  nameZh: z.string().min(1).max(100).optional(),
  rateBps: z.number().int().min(0).max(MAX_RATE_BPS).optional(),
  isDefault: z.boolean().optional(),
});

/** 审计要用的「改之前是什么样」。税率表不大，整行读回来比拼装便宜。 */
async function findTaxRate(
  tx: Parameters<typeof listTaxRates>[0],
  organizationId: string,
  id: string,
) {
  const rates = await listTaxRates(tx, organizationId);
  return rates.find((rate) => rate.id === id) ?? null;
}

export async function createTaxRate(
  orgSlug: string,
  input: z.infer<typeof createTaxRateSchema>,
): Promise<{ id: string }> {
  const context = await requirePermission(orgSlug, 'account:manage');
  const parsed = createTaxRateSchema.parse(input);

  const result = await withTransaction(context.userId, async (tx) => {
    const { id } = await insertTaxRate(tx, {
      organizationId: context.organizationId,
      nameEn: parsed.nameEn,
      nameZh: parsed.nameZh,
      rateBps: parsed.rateBps,
      isDefault: parsed.isDefault,
    });

    if (parsed.isDefault) {
      await setDefaultTaxRate(tx, context.organizationId, id);
    }

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'tax_rate.created',
      entityType: 'tax_rate',
      entityId: id,
      after: parsed,
    });

    return { id };
  });

  revalidatePath(`/${orgSlug}/settings/tax`);
  return result;
}

export async function updateTaxRateAction(
  orgSlug: string,
  id: string,
  input: z.infer<typeof updateTaxRateSchema>,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');
  const parsed = updateTaxRateSchema.parse(input);

  await withTransaction(context.userId, async (tx) => {
    // before 原来是空的。改税率是一个会改变往后每一张发票税额的动作，只记
    // after 的话，事后对账时看到「这个月 6%、上个月 8%」也无从判断是谁在
    // 什么时候改的、从多少改到多少。
    const before = await findTaxRate(tx, context.organizationId, id);

    await updateTaxRate(tx, context.organizationId, id, parsed);

    if (parsed.isDefault) {
      await setDefaultTaxRate(tx, context.organizationId, id);
    }

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'tax_rate.updated',
      entityType: 'tax_rate',
      entityId: id,
      before: before
        ? {
            nameEn: before.nameEn,
            nameZh: before.nameZh,
            rateBps: before.rateBps,
            isDefault: before.isDefault,
          }
        : null,
      after: parsed,
    });
  });

  revalidatePath(`/${orgSlug}/settings/tax`);
}

export async function setDefaultTaxRateAction(
  orgSlug: string,
  id: string,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');

  await withTransaction(context.userId, async (tx) => {
    await setDefaultTaxRate(tx, context.organizationId, id);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'tax_rate.default_changed',
      entityType: 'tax_rate',
      entityId: id,
      after: { isDefault: true },
    });
  });

  revalidatePath(`/${orgSlug}/settings/tax`);
}

export async function deleteTaxRateAction(
  orgSlug: string,
  id: string,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');

  await withTransaction(context.userId, async (tx) => {
    // deleteTaxRate 是软删除（is_active = false），删掉之后 listTaxRates 就
    // 再也读不到这一行了——快照必须在删之前取。
    const before = await findTaxRate(tx, context.organizationId, id);

    await deleteTaxRate(tx, context.organizationId, id);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'tax_rate.deleted',
      entityType: 'tax_rate',
      entityId: id,
      before: before
        ? { nameEn: before.nameEn, rateBps: before.rateBps, isActive: true }
        : null,
      after: { isActive: false },
    });
  });

  revalidatePath(`/${orgSlug}/settings/tax`);
}

/**
 * 销项/进项税汇总。
 *
 * 返回类型直接引用仓储的 TaxReport，而不是再手抄一遍字段列表：原来那份手抄
 * 的类型少一个字段没人会发现——它与仓储返回的对象结构不一致时 TypeScript 只
 * 会认为「多返回了一个字段」，编译照样通过，而调用方永远看不到那个字段。
 * 同一个形状写两遍，第二遍就是给漂移留的口子。
 *
 * 额外带上 baseCurrency：报表里的每一个数都是本位币最小单位（取自
 * journal_lines.base_amount_minor），而调用方从这个返回值里看不出那是哪种钱。
 * 仓储不查这一列——OrgContext 里已经有了，多查一次只会多一种不一致的可能。
 *
 * 日期由调用方给，这里只校验它是一个日期。参数化查询已经挡住注入，这一句挡的
 * 是「把 'yesterday' 这种字符串传进来，Postgres 真的认」——报表会跟着系统时钟
 * 漂移，同一个月份两次导出给出不同的数。
 */
export async function getTaxReportAction(
  orgSlug: string,
  from: string,
  to: string,
): Promise<TaxReport & { baseCurrency: string }> {
  const context = await requirePermission(orgSlug, 'report:export');
  const range = dateRangeSchema.parse({ from, to });

  const report = await withTransaction(context.userId, (tx) =>
    getTaxReport(tx, context.organizationId, range.from, range.to),
  );

  return { ...report, baseCurrency: context.baseCurrency };
}
