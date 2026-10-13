'use server';

import { revalidatePath } from 'next/cache';
import { createOrgSchema, periodLockSchema, updateOrgSchema } from '@/lib/schemas';
import { BRANDING_BUCKET, getStorageClient } from '@/lib/supabase/storage';
import { requirePermission, requireUserId } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  generateUniqueSlug,
  getOrganizationSettings,
  insertOrganization,
  setOrganizationLogoPath,
  setPeriodLock,
  updateOrganizationSettings,
} from '@/server/repositories/organizations';
import { seedChartOfAccounts } from '@/server/services/account-seed';
import { ALLOWED_LOGO_TYPES, MAX_LOGO_BYTES } from '@/lib/upload-rules';
import { buildLogoPath } from '@/server/services/organization-logo';

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
    address?: string;
    registrationNumber?: string;
    taxNumber?: string;
    phone?: string;
    email?: string;
    paymentDetails?: string;
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
      address: data.address ?? null,
      registrationNumber: data.registrationNumber ?? null,
      taxNumber: data.taxNumber ?? null,
      phone: data.phone ?? null,
      email: data.email ?? null,
      paymentDetails: data.paymentDetails ?? null,
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

/**
 * 上传或替换公司 logo。
 *
 * 顺序与收据上传（server/actions/attachments.ts）相同：先校验、再写对象、
 * 再在事务里改库；改库失败就把刚写进去的对象删掉，不留孤儿。
 *
 * 旧 logo 在事务提交**之后**才删。反过来的话，删完旧图、改库却失败，
 * 库里那一行仍然指着一个已经不存在的对象，发票上的 logo 就此变成一个
 * 永远取不到的签名 URL。旧图删失败不报错：新 logo 已经生效，用户要的
 * 事情做成了，剩下的只是存储里多一张没人引用的小图。
 */
export async function uploadOrganizationLogo(orgSlug: string, file: File): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');

  if (!ALLOWED_LOGO_TYPES.includes(file.type)) {
    throw new Error('Use a PNG, JPG or WebP image for the logo.');
  }
  if (file.size > MAX_LOGO_BYTES) {
    throw new Error('The logo must be 1 MB or smaller.');
  }

  const storage = getStorageClient(BRANDING_BUCKET);
  const logoPath = buildLogoPath(context.organizationId, file.name);
  await storage.upload(logoPath, file);

  const { previousPath } = await withTransaction(context.userId, async (tx) => {
    const result = await setOrganizationLogoPath(tx, context.organizationId, logoPath);
    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'organization.update',
      entityType: 'organization',
      entityId: context.organizationId,
      before: { logoPath: result.previousPath },
      after: { logoPath, fileName: file.name, sizeBytes: file.size },
    });
    return result;
  }).catch(async (error: unknown) => {
    await storage.remove(logoPath).catch(() => {});
    throw error;
  });

  if (previousPath) {
    await storage.remove(previousPath).catch(() => {});
  }

  revalidatePath(`/${orgSlug}/settings/general`);
}

/** 去掉 logo。同样是先改库、提交之后再删对象。 */
export async function removeOrganizationLogo(orgSlug: string): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');

  const { previousPath } = await withTransaction(context.userId, async (tx) => {
    const result = await setOrganizationLogoPath(tx, context.organizationId, null);
    if (result.previousPath) {
      await recordAudit(tx, {
        organizationId: context.organizationId,
        actorUserId: context.userId,
        action: 'organization.update',
        entityType: 'organization',
        entityId: context.organizationId,
        before: { logoPath: result.previousPath },
        after: { logoPath: null },
      });
    }
    return result;
  });

  if (previousPath) {
    await getStorageClient(BRANDING_BUCKET).remove(previousPath).catch(() => {});
  }

  revalidatePath(`/${orgSlug}/settings/general`);
}
