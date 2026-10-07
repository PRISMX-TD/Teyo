'use server';

import { revalidatePath } from 'next/cache';
import { getStorageClient } from '@/lib/supabase/storage';
import { withTransaction } from '@/server/db/transaction';
import { AuthError, requirePermission, type OrgContext } from '@/server/auth/guard';
import { canEditTransaction } from '@/server/domain/permissions';
import type { Tx } from '@/server/db/transaction';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  ALLOWED_ATTACHMENT_TYPES,
  MAX_ATTACHMENT_BYTES,
  SIGNED_URL_TTL_SECONDS,
  buildStoragePath,
  deleteAttachmentRow,
  getAttachment,
  insertAttachment,
} from '@/server/repositories/attachments';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 确认这笔交易属于本公司，且这个人有权改它。
 *
 * 附件是这笔账的凭证，加一张、删一张都是在改这笔记录——授权必须和
 * updateTransaction / voidTransaction 用同一条 canEditTransaction。原来这里
 * 只要 transaction:create，于是 bookkeeper 可以删掉别人那笔账的收据，而他
 * 连那笔账本身都改不了。
 */
async function assertCanEditTransaction(
  tx: Tx,
  context: OrgContext,
  transactionId: string,
): Promise<void> {
  // 不是 uuid 的 id 直接交给 Postgres 会抛 22P02，语义上它就是「找不到」。
  const rows = UUID_PATTERN.test(transactionId)
    ? await tx`
        select created_by from transactions
        where id = ${transactionId} and organization_id = ${context.organizationId}
      `
    : [];
  const row = rows.at(0);
  if (!row) {
    throw new AuthError('not_found', 'That record was not found in this company.');
  }
  if (!canEditTransaction(context.role, row.created_by === context.userId)) {
    throw new AuthError('forbidden', 'Your role cannot change the receipts on this record.');
  }
}

export async function uploadAttachment(
  orgSlug: string,
  transactionId: string,
  file: File,
): Promise<{ id: string }> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  if (!ALLOWED_ATTACHMENT_TYPES.includes(file.type)) {
    throw new Error(`Unsupported file type: ${file.type}`);
  }

  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`File size ${file.size} exceeds the ${MAX_ATTACHMENT_BYTES} byte limit.`);
  }

  // 先确认交易属于本公司、且这个人能改它，再上传，避免把文件写到不该去的路径。
  await withTransaction(context.userId, (tx) =>
    assertCanEditTransaction(tx, context, transactionId),
  );

  const storagePath = buildStoragePath(context.organizationId, transactionId, file.name);
  const storage = getStorageClient();
  await storage.upload(storagePath, file);

  const result = await withTransaction(context.userId, async (tx) => {
    const inserted = await insertAttachment(tx, {
      organizationId: context.organizationId,
      transactionId,
      storagePath,
      fileName: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      uploadedBy: context.userId,
    });

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'transaction.updated',
      entityType: 'attachment',
      entityId: inserted.id,
      after: { transactionId, fileName: file.name, sizeBytes: file.size },
    });

    return inserted;
  }).catch(async (error: unknown) => {
    // 对象已经进了存储、库里那一行却没写成：不清掉的话它就是一个谁也
    // 找不到、谁也删不掉的孤儿文件。清理失败不盖过原始错误。
    await storage.remove(storagePath).catch(() => {});
    throw error;
  });

  revalidatePath(`/${orgSlug}/transactions/${transactionId}`);
  return result;
}

export async function getAttachmentSignedUrl(
  orgSlug: string,
  attachmentId: string,
): Promise<string> {
  const context = await requirePermission(orgSlug, 'transaction:read');

  const attachment = await withTransaction(context.userId, (tx) =>
    getAttachment(tx, context.organizationId, attachmentId),
  );

  // 只发短时效签名 URL，永不暴露 public URL：bucket 是私有的，
  // public URL 一旦泄露就等于永久可读。
  return getStorageClient().createSignedUrl(attachment.storagePath, SIGNED_URL_TTL_SECONDS);
}

/**
 * 删除附件时先删库里的行，成功后再删对象。
 *
 * 顺序不能反：若先删对象再删行失败，数据库里会留下指向不存在对象的孤立记录，
 * 之后每次取签名 URL 都会报 404。若先删行失败则停住，对象仍然完整。
 */
export async function deleteAttachment(orgSlug: string, attachmentId: string): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  const attachment = await withTransaction(context.userId, async (tx) => {
    const found = await getAttachment(tx, context.organizationId, attachmentId);
    await assertCanEditTransaction(tx, context, found.transactionId);
    return found;
  });

  await withTransaction(context.userId, async (tx) => {
    await deleteAttachmentRow(tx, context.organizationId, attachmentId);
    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'transaction.updated',
      entityType: 'attachment',
      entityId: attachmentId,
      before: { fileName: attachment.fileName },
      after: null,
    });
  });

  await getStorageClient().remove(attachment.storagePath);

  revalidatePath(`/${orgSlug}/transactions/${attachment.transactionId}`);
}
