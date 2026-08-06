'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  getProject,
  insertProject,
  updateProject,
  setProjectStatus,
} from '@/server/repositories/projects';

export async function createProject(
  orgSlug: string,
  input: {
    name: string;
    description?: string;
    contactId?: string;
    budgetMinor?: string;
    startDate?: string;
    endDate?: string;
  },
): Promise<{ id: string }> {
  const context = await requirePermission(orgSlug, 'account:manage');

  const result = await withTransaction(context.userId, async (tx) => {
    const { id } = await insertProject(tx, {
      organizationId: context.organizationId,
      name: input.name,
      description: input.description,
      contactId: input.contactId,
      budgetMinor: input.budgetMinor ? BigInt(input.budgetMinor) : undefined,
      startDate: input.startDate,
      endDate: input.endDate,
    });

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'project.created',
      entityType: 'project',
      entityId: id,
      after: input,
    });

    return { id };
  });

  revalidatePath(`/${orgSlug}/projects`);
  return result;
}

export async function updateProjectAction(
  orgSlug: string,
  id: string,
  input: Partial<{
    name: string;
    description: string;
    contactId: string;
    budgetMinor: string;
    startDate: string;
    endDate: string;
  }>,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');

  await withTransaction(context.userId, async (tx) => {
    const before = await getProject(tx, context.organizationId, id);

    await updateProject(tx, context.organizationId, id, {
      name: input.name,
      description: input.description,
      contactId: input.contactId,
      budgetMinor: input.budgetMinor ? BigInt(input.budgetMinor) : undefined,
      startDate: input.startDate,
      endDate: input.endDate,
    });

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'project.updated',
      entityType: 'project',
      entityId: id,
      before: { name: before?.name },
      after: input,
    });
  });

  revalidatePath(`/${orgSlug}/projects`);
  revalidatePath(`/${orgSlug}/projects/${id}`);
}

export async function setProjectStatusAction(
  orgSlug: string,
  id: string,
  status: 'active' | 'completed' | 'cancelled',
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');

  await withTransaction(context.userId, async (tx) => {
    const before = await getProject(tx, context.organizationId, id);

    await setProjectStatus(tx, context.organizationId, id, status);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'project.status_changed',
      entityType: 'project',
      entityId: id,
      before: { status: before?.status },
      after: { status },
    });
  });

  revalidatePath(`/${orgSlug}/projects`);
  revalidatePath(`/${orgSlug}/projects/${id}`);
}
