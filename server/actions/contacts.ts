'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  getContact,
  insertContact,
  updateContact,
  setContactActive,
} from '@/server/repositories/contacts';

export async function createContact(
  orgSlug: string,
  input: {
    type: 'customer' | 'vendor' | 'both';
    name: string;
    email?: string;
    phone?: string;
    address?: string;
    taxId?: string;
    paymentTerms?: string;
    notes?: string;
  },
): Promise<{ id: string }> {
  const context = await requirePermission(orgSlug, 'account:manage');
  const result = await withTransaction(context.userId, async (tx) => {
    const { id } = await insertContact(tx, {
      organizationId: context.organizationId,
      type: input.type,
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      address: input.address ?? null,
      taxId: input.taxId ?? null,
      paymentTerms: input.paymentTerms ?? null,
      notes: input.notes ?? null,
    });

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'contact.created',
      entityType: 'contact',
      entityId: id,
      after: input,
    });

    return { id };
  });

  revalidatePath(`/${orgSlug}/settings/contacts`);
  return result;
}

export async function updateContactAction(
  orgSlug: string,
  id: string,
  input: Partial<{
    type: string;
    name: string;
    email: string;
    phone: string;
    address: string;
    taxId: string;
    paymentTerms: string;
    notes: string;
  }>,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');
  await withTransaction(context.userId, async (tx) => {
    const before = await getContact(tx, context.organizationId, id);

    await updateContact(tx, context.organizationId, id, input);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'contact.updated',
      entityType: 'contact',
      entityId: id,
      before: {
        type: before?.type,
        name: before?.name,
      },
      after: input,
    });
  });

  revalidatePath(`/${orgSlug}/settings/contacts`);
}

export async function toggleContactActive(
  orgSlug: string,
  id: string,
  active: boolean,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');
  await withTransaction(context.userId, async (tx) => {
    const before = await getContact(tx, context.organizationId, id);

    await setContactActive(tx, context.organizationId, id, active);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: active ? 'contact.activated' : 'contact.deactivated',
      entityType: 'contact',
      entityId: id,
      before: { isActive: before?.isActive },
      after: { isActive: active },
    });
  });

  revalidatePath(`/${orgSlug}/settings/contacts`);
}
