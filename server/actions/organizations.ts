'use server';

import { revalidatePath } from 'next/cache';
import { createOrgSchema, periodLockSchema, updateOrgSchema } from '@/lib/schemas';
import { requirePermission, requireUserId } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  generateUniqueSlug,
  getOrganizationSettings,
  insertOrganization,
  setPeriodLock,
  updateOrganizationSettings,
} from '@/server/repositories/organizations';
import { seedChartOfAccounts } from '@/server/services/account-seed';

export type CreateOrgInput = {
  name: string;
  baseCurrency: string;
  timezone: string;
  industry?: string;
};

export async function createOrganization(
  input: CreateOrgInput,
): Promise<{ id: string; slug: string }> {
  const userId = await requireUserId();
  const data = createOrgSchema.parse(input);

  return withTransaction(userId, async (tx) => {
    const slug = await generateUniqueSlug(tx, data.name);

    const organizationId = await insertOrganization(tx, {
      name: data.name,
      slug,
      baseCurrency: data.baseCurrency,
      timezone: data.timezone,
      industry: data.industry ?? null,
      createdBy: userId,
    });

    // owner 记录必须先插入：后面写 accounts / categories / audit_logs 的 RLS 策略
    // 都要求 app_has_role 或 app_is_member 通过，没有这条 membership 就全被拒。
    await tx`
      insert into memberships (user_id, organization_id, role, status)
      values (${userId}, ${organizationId}, 'owner', 'active')
    `;

    await seedChartOfAccounts(tx, organizationId);

    await recordAudit(tx, {
      organizationId,
      actorUserId: userId,
      action: 'organization.create',
      entityType: 'organization',
      entityId: organizationId,
      after: { name: data.name, slug, baseCurrency: data.baseCurrency },
    });

    return { id: organizationId, slug };
  });
}

export async function updateOrganization(
  orgSlug: string,
  input: {
    name: string;
    timezone: string;
    industry?: string;
    fiscalYearStartMonth: number | string;
  },
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');
  const data = updateOrgSchema.parse(input);

  await withTransaction(context.userId, async (tx) => {
    // 改财年起始月会改变**每一张**报表的默认期间，所以审计的 before 必须
    // 带上旧值：日后看到「去年的损益表怎么突然换了个期间」，答案只能从这
    // 一条记录里找回来。其余字段一并带上，before/after 才对称。
    const before = await getOrganizationSettings(tx, context.organizationId);

    await updateOrganizationSettings(tx, context.organizationId, {
      name: data.name,
      timezone: data.timezone,
      industry: data.industry ?? null,
      fiscalYearStartMonth: data.fiscalYearStartMonth,
    });

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'organization.update',
      entityType: 'organization',
      entityId: context.organizationId,
      before,
      after: data,
    });
  });

  revalidatePath(`/${orgSlug}/settings/general`);
  // 财年一变，这三个页面的默认区间就全变了。不 revalidate 的话，用户改完
  // 财年回到报表页，看到的仍然是按旧财年缓存的那一版数字——而那张表看起来
  // 完全正常，没有任何迹象表明它用的是已经被改掉的期间。
  revalidatePath(`/${orgSlug}/reports`);
  revalidatePath(`/${orgSlug}/general-ledger`);
  revalidatePath(`/${orgSlug}/settings/year-end`);
}

export async function updatePeriodLock(
  orgSlug: string,
  input: { lockedUntil: string | null },
): Promise<void> {
  const context = await requirePermission(orgSlug, 'period:lock');
  const data = periodLockSchema.parse(input);

  await withTransaction(context.userId, async (tx) => {
    await setPeriodLock(tx, context.organizationId, data.lockedUntil);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: data.lockedUntil === null ? 'period.unlock' : 'period.lock',
      entityType: 'organization',
      entityId: context.organizationId,
      before: { lockedUntil: context.lockedUntil },
      after: { lockedUntil: data.lockedUntil },
    });
  });

  revalidatePath(`/${orgSlug}/settings/general`);
}
