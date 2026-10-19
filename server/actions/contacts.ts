'use server';

import { revalidatePath } from 'next/cache';
import { AuthError, requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  getContact,
  insertContact,
  updateContact,
  setContactActive,
} from '@/server/repositories/contacts';

const CONTACT_TYPES = new Set(['customer', 'vendor', 'both']);

/** 空白串一律存成 null：表单清空一个栏位的意思是「没有」，不是「一个空字符串」。 */
function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/**
 * 名称必填。客户端的「添加」按钮在名称为空时是灰的，但编辑框没有这道挡：
 * 清空名称再保存，updateContact 的 coalesce('', name) 会照样写进一个空串
 * ——那个联系人在发票、收款的下拉框里变成一行空白。
 */
function requireName(name: string | undefined): string {
  const trimmed = name?.trim() ?? '';
  if (trimmed === '') {
    throw new AuthError('forbidden', 'A contact needs a name.');
  }
  return trimmed;
}

/**
 * 各栏位的长度上限。contacts 的这几列都是不限长的 text，表单上也没有
 * maxLength——直接调 Action 就能塞进一份几 MB 的「备注」，之后每一张发票、
 * 每一个下拉框都要把它整段读出来。上限按「印在单据上还像话」来定。
 */
const CONTACT_FIELD_LIMITS = {
  name: 200,
  email: 254,
  phone: 60,
  address: 500,
  taxId: 60,
  paymentTerms: 200,
  notes: 2000,
} as const;

function assertFieldLengths(input: Partial<Record<keyof typeof CONTACT_FIELD_LIMITS, unknown>>): void {
  for (const [field, max] of Object.entries(CONTACT_FIELD_LIMITS)) {
    const value = input[field as keyof typeof CONTACT_FIELD_LIMITS];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      throw new AuthError('forbidden', `The contact ${field} must be text.`);
    }
    if (value.trim().length > max) {
      throw new AuthError('forbidden', `Keep the contact ${field} to ${max} characters or fewer.`);
    }
  }
}

function requireType(type: string): 'customer' | 'vendor' | 'both' {
  if (!CONTACT_TYPES.has(type)) {
    throw new AuthError('forbidden', `Unknown contact type: ${type}`);
  }
  return type as 'customer' | 'vendor' | 'both';
}

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
  const type = requireType(input.type);
  const name = requireName(input.name);
  assertFieldLengths(input);
  const result = await withTransaction(context.userId, async (tx) => {
    const { id } = await insertContact(tx, {
      organizationId: context.organizationId,
      type,
      name,
      email: blankToNull(input.email),
      phone: blankToNull(input.phone),
      address: blankToNull(input.address),
      taxId: blankToNull(input.taxId),
      paymentTerms: blankToNull(input.paymentTerms),
      notes: blankToNull(input.notes),
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
  assertFieldLengths(input);
  const fields = {
    ...input,
    ...(input.name !== undefined ? { name: requireName(input.name) } : {}),
    ...(input.type !== undefined ? { type: requireType(input.type) } : {}),
  };
  await withTransaction(context.userId, async (tx) => {
    const before = await getContact(tx, context.organizationId, id);
    if (!before) {
      throw new AuthError('not_found', 'Contact not found.');
    }

    await updateContact(tx, context.organizationId, id, fields);

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
      after: fields,
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
    if (!before) {
      throw new AuthError('not_found', 'Contact not found.');
    }

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
