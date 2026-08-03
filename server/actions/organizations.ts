'use server';

import { revalidatePath } from 'next/cache';
import { createOrgSchema, periodLockSchema, updateOrgSchema } from '@/lib/schemas';
import { requirePermission, requireUserId } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  generateUniqueSlug,
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
  input: { name: string; timezone: string; industry?: string },
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');
  const data = updateOrgSchema.parse(input);

  await withTransaction(context.userId, async (tx) => {
    await updateOrganizationSettings(tx, context.organizationId, {
      name: data.name,
      timezone: data.timezone,
      industry: data.industry ?? null,
    });

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'organization.update',
      entityType: 'organization',
      entityId: context.organizationId,
      after: data,
    });
  });

  revalidatePath(`/${orgSlug}/settings/general`);
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
