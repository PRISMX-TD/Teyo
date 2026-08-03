'use server';

import { revalidatePath } from 'next/cache';
import { getStorageClient } from '@/lib/supabase/storage';
import { withTransaction } from '@/server/db/transaction';
import { AuthError, requirePermission } from '@/server/auth/guard';
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

  // 先确认交易属于本公司，再上传，避免把文件写到不该去的路径。
  await withTransaction(context.userId, async (tx) => {
    const rows = await tx`
      select id from transactions
      where id = ${transactionId} and organization_id = ${context.organizationId}
    `;
    if (rows.length === 0) {
      throw new AuthError('not_found', `Transaction ${transactionId} was not found in this company.`);
    }
  });

  const storagePath = buildStoragePath(context.organizationId, transactionId, file.name);
  await getStorageClient().upload(storagePath, file);

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

  const attachment = await withTransaction(context.userId, (tx) =>
    getAttachment(tx, context.organizationId, attachmentId),
  );

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
