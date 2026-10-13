import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Tx } from '@/server/db/transaction';

// 上限与类型和浏览器那一侧共用，定义在 lib/upload-rules.ts。
export { ALLOWED_ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES } from '@/lib/upload-rules';

/**
 * 签名 URL 有效期（秒）。不能放在 lib/supabase/storage.ts 里作默认参数——
 * 测试一旦 mock 掉那个模块，这个值就再也量不到了。放在此处即可被测试导入断言。
 */
export const SIGNED_URL_TTL_SECONDS = 300;

/**
 * 附件挂在哪里。一份附件只属于一处，数据库层由 0035 的
 * attachments_single_owner 约束保证。
 */
export type AttachmentOwner =
  | { type: 'transaction'; id: string }
  | { type: 'bill'; id: string };

export type AttachmentRow = {
  id: string;
  owner: AttachmentOwner;
  storagePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
};

/**
 * 路径形如 `<orgId>/<ownerId>/<uuid>.<ext>`，ownerId 是交易或账单的 id。
 *
 * 首段必须是 organization_id：Storage 策略取 (storage.foldername(name))[1] 判成员关系，
 * 首段一旦不是公司 id，隔离就没了。
 *
 * 原始文件名不进路径，只取扩展名。用户可控的名字进路径就等于把 `../` 与各种编码
 * 问题引进来；显示用的名字单独存在 file_name 列。
 */
export function buildStoragePath(
  organizationId: string,
  ownerId: string,
  fileName: string,
): string {
  const ext = path.extname(path.basename(fileName)).toLowerCase().replace(/[^.a-z0-9]/g, '');
  return `${organizationId}/${ownerId}/${randomUUID()}${ext}`;
}

export async function insertAttachment(
  tx: Tx,
  row: {
    organizationId: string;
    owner: AttachmentOwner;
    storagePath: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    uploadedBy: string;
  },
): Promise<{ id: string }> {
  const transactionId = row.owner.type === 'transaction' ? row.owner.id : null;
  const billId = row.owner.type === 'bill' ? row.owner.id : null;
  const [inserted] = await tx`
    insert into attachments (
      organization_id, transaction_id, bill_id, storage_path, file_name, mime_type, size_bytes,
      uploaded_by
    ) values (
      ${row.organizationId}, ${transactionId}, ${billId}, ${row.storagePath},
      ${row.fileName}, ${row.mimeType}, ${row.sizeBytes}, ${row.uploadedBy}
    )
    returning id
  `;
  return { id: inserted.id as string };
}

function mapRow(row: Record<string, unknown>): AttachmentRow {
  // attachments_single_owner 保证两列恰好一列非空。
  const owner: AttachmentOwner = row.transaction_id
    ? { type: 'transaction', id: row.transaction_id as string }
    : { type: 'bill', id: row.bill_id as string };
  return {
    id: row.id as string,
    owner,
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
  owner: AttachmentOwner,
): Promise<AttachmentRow[]> {
  // 两条写死的查询而不是拼列名：列名进 SQL 的路径越少越好，而所属类型
  // 只有两种。
  const rows =
    owner.type === 'transaction'
      ? await tx`
          select id, transaction_id, bill_id, storage_path, file_name, mime_type, size_bytes,
                 uploaded_by
          from attachments
          where organization_id = ${organizationId} and transaction_id = ${owner.id}
          order by created_at
        `
      : await tx`
          select id, transaction_id, bill_id, storage_path, file_name, mime_type, size_bytes,
                 uploaded_by
          from attachments
          where organization_id = ${organizationId} and bill_id = ${owner.id}
          order by created_at
        `;
  return rows.map(mapRow);
}

/**
 * 把一笔交易的附件整批挪到另一笔上。只给「换类型重录」用：原交易被作废、
 * 新交易接替它，收据是同一张，不该留在一笔已经作废、页面上连附件区都
 * 不显示的记录上。
 *
 * 存储里的对象不动——路径第二段仍是旧交易的 id，但路径只是对象的键，
 * Storage 策略只看第一段的公司 id，库里这一行才是「它属于谁」的唯一依据。
 */
export async function moveTransactionAttachments(
  tx: Tx,
  organizationId: string,
  fromTransactionId: string,
  toTransactionId: string,
): Promise<number> {
  const rows = await tx`
    update attachments
    set transaction_id = ${toTransactionId}
    where organization_id = ${organizationId} and transaction_id = ${fromTransactionId}
    returning id
  `;
  return rows.length;
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
  // id 来自客户端。不是 uuid 的串交给 Postgres 会抛 22P02 而不是「找不到」。
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attachmentId)) {
    throw new AttachmentNotFoundError('This attachment was not found in this company.');
  }

  const rows = await tx`
    select id, transaction_id, bill_id, storage_path, file_name, mime_type, size_bytes, uploaded_by
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
