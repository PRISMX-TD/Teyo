import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Tx } from '@/server/db/transaction';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * 签名 URL 有效期（秒）。不能放在 lib/supabase/storage.ts 里作默认参数——
 * 测试一旦 mock 掉那个模块，这个值就再也量不到了。放在此处即可被测试导入断言。
 */
export const SIGNED_URL_TTL_SECONDS = 300;

export const ALLOWED_ATTACHMENT_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
];

export type AttachmentRow = {
  id: string;
  transactionId: string;
  storagePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
};

/**
 * 路径形如 `<orgId>/<transactionId>/<uuid>.<ext>`。
 *
 * 首段必须是 organization_id：Storage 策略取 (storage.foldername(name))[1] 判成员关系，
 * 首段一旦不是公司 id，隔离就没了。
 *
 * 原始文件名不进路径，只取扩展名。用户可控的名字进路径就等于把 `../` 与各种编码
 * 问题引进来；显示用的名字单独存在 file_name 列。
 */
export function buildStoragePath(
  organizationId: string,
  transactionId: string,
  fileName: string,
): string {
  const ext = path.extname(path.basename(fileName)).toLowerCase().replace(/[^.a-z0-9]/g, '');
  return `${organizationId}/${transactionId}/${randomUUID()}${ext}`;
}

export async function insertAttachment(
  tx: Tx,
  row: {
    organizationId: string;
    transactionId: string;
    storagePath: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    uploadedBy: string;
  },
): Promise<{ id: string }> {
  const [inserted] = await tx`
    insert into attachments (
      organization_id, transaction_id, storage_path, file_name, mime_type, size_bytes, uploaded_by
    ) values (
      ${row.organizationId}, ${row.transactionId}, ${row.storagePath},
      ${row.fileName}, ${row.mimeType}, ${row.sizeBytes}, ${row.uploadedBy}
    )
    returning id
  `;
  return { id: inserted.id as string };
}

function mapRow(row: Record<string, unknown>): AttachmentRow {
  return {
    id: row.id as string,
    transactionId: row.transaction_id as string,
    storagePath: row.storage_path as string,
    fileName: row.file_name as string,
    mimeType: row.mime_type as string,
    sizeBytes: Number(row.size_bytes),
    uploadedBy: row.uploaded_by as string,
  };
}

export async function listAttachments(
  tx: Tx,
  organizationId: string,
  transactionId: string,
): Promise<AttachmentRow[]> {
  const rows = await tx`
    select id, transaction_id, storage_path, file_name, mime_type, size_bytes, uploaded_by
    from attachments
    where organization_id = ${organizationId} and transaction_id = ${transactionId}
    order by created_at
  `;
  return rows.map(mapRow);
}

export class AttachmentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentNotFoundError';
  }
}

/**
 * organization_id 收窄不可省。attachments_read 策略只挡非成员，
 * 用户同属两家公司时对两边都放行，跨公司隔离只剩这个条件在挡。
 */
export async function getAttachment(
  tx: Tx,
  organizationId: string,
  attachmentId: string,
): Promise<AttachmentRow> {
  const rows = await tx`
    select id, transaction_id, storage_path, file_name, mime_type, size_bytes, uploaded_by
    from attachments
    where id = ${attachmentId} and organization_id = ${organizationId}
  `;

  const row = rows.at(0);
  if (!row) {
    throw new AttachmentNotFoundError('This attachment was not found in this company.');
  }
  return mapRow(row);
}

export async function deleteAttachmentRow(
  tx: Tx,
  organizationId: string,
  attachmentId: string,
): Promise<void> {
  await tx`
    delete from attachments
    where id = ${attachmentId} and organization_id = ${organizationId}
  `;
}
