import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { admin } from '@/tests/helpers/db';
import {
  createTestOrgWithSeed,
  createTestUser,
  joinOrg,
  resetTestData,
} from '@/tests/helpers/test-db';

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

/** 内存版 Storage，记录被写入的路径供断言。 */
const uploaded = new Map<string, { size: number; contentType: string }>();

vi.mock('@/lib/supabase/storage', () => ({
  getStorageClient: () => ({
    upload: async (path: string, file: File) => {
      uploaded.set(path, { size: file.size, contentType: file.type });
      return { path };
    },
    createSignedUrl: async (path: string, expiresIn: number) => {
      if (!uploaded.has(path)) throw new Error('object not found');
      return `https://storage.test/${path}?expires=${expiresIn}`;
    },
    remove: async (path: string) => {
      uploaded.delete(path);
    },
  }),
}));

const { SIGNED_URL_TTL_SECONDS, buildStoragePath } = await import(
  '@/server/repositories/attachments'
);
const { deleteAttachment, getAttachmentSignedUrl, uploadAttachment } = await import(
  '@/server/actions/attachments'
);
const { createTransaction } = await import('@/server/actions/transactions');

let ownerId: string;
let viewerId: string;
let orgId: string;
let orgSlug: string;
let transactionId: string;

const suffix = randomUUID().slice(0, 8);

function receipt(name = 'receipt.jpg', type = 'image/jpeg', bytes = 1024): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

beforeAll(async () => {
  await resetTestData();
  ownerId = await createTestUser(`owner-att-${suffix}@example.com`, 'Owner');
  viewerId = await createTestUser(`viewer-att-${suffix}@example.com`, 'Viewer');

  const org = await createTestOrgWithSeed(ownerId, 'Attach Co', `attach-co-${suffix}`, 'MYR');
  orgId = org.id;
  orgSlug = org.slug;
  await joinOrg(viewerId, orgId, 'viewer');

  currentUserId = ownerId;
  const created = await createTransaction(orgSlug, {
    kind: 'expense',
    occurredOn: '2026-08-01',
    amount: '55.00',
    currency: 'MYR',
    moneyAccountId: org.accountsByCode.cash,
    categoryId: org.categoriesByAccountCode.rent,
    description: 'With receipt',
    clientUuid: randomUUID(),
  });
  transactionId = created.id;
});

afterAll(async () => {
  await resetTestData();
  await admin.end();
});

describe('buildStoragePath', () => {
  it('puts the organization id first so storage policies can scope by folder', () => {
    const path = buildStoragePath(orgId, transactionId, 'receipt.jpg');
    expect(path.startsWith(`${orgId}/`)).toBe(true);
    expect(path).toContain(transactionId);
  });

  it('strips directory traversal and unsafe characters from the file name', () => {
    const path = buildStoragePath(orgId, transactionId, '../../etc/passwd');
    expect(path).not.toContain('..');
    expect(path.split('/')).toHaveLength(3);
  });

  it('keeps the file extension', () => {
    expect(buildStoragePath(orgId, transactionId, 'photo.PNG')).toMatch(/\.png$/);
  });
});

describe('uploadAttachment', () => {
  it('stores the file under the organization folder and records a row', async () => {
    currentUserId = ownerId;
    const { id } = await uploadAttachment(orgSlug, transactionId, receipt());

    const [row] = await admin`
      select organization_id, transaction_id, storage_path, file_name, mime_type, size_bytes, uploaded_by
      from attachments where id = ${id}
    `;
    expect(row.organization_id).toBe(orgId);
    expect(row.transaction_id).toBe(transactionId);
    expect(row.storage_path.startsWith(`${orgId}/`)).toBe(true);
    expect(row.file_name).toBe('receipt.jpg');
    expect(row.mime_type).toBe('image/jpeg');
    expect(Number(row.size_bytes)).toBe(1024);
    expect(row.uploaded_by).toBe(ownerId);
  });

  it('rejects a disallowed mime type', async () => {
    currentUserId = ownerId;
    await expect(
      uploadAttachment(orgSlug, transactionId, receipt('virus.exe', 'application/x-msdownload')),
    ).rejects.toThrow(/type/i);
  });

  it('rejects a file over the size limit', async () => {
    currentUserId = ownerId;
    await expect(
      uploadAttachment(orgSlug, transactionId, receipt('big.jpg', 'image/jpeg', 11 * 1024 * 1024)),
    ).rejects.toThrow(/size/i);
  });

  it('blocks a viewer from uploading', async () => {
    currentUserId = viewerId;
    // 断言 code 而不是 message：AuthError 的 forbidden 在 code 上，
    // message 是「Your role (viewer) cannot perform ...」，配 /forbidden/i 会永远不匹配。
    await expect(uploadAttachment(orgSlug, transactionId, receipt())).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('rejects a transaction that belongs to another company the same user owns', async () => {
    // 第二家公司的 owner 必须与第一家相同。换成「别人的公司」这条测试就是假阳性：
    // RLS 会挡掉非成员的 select，即使应用层完全不做 organization_id 收窄也照样拒绝。
    // 同一用户同属两家公司时策略对两边全部放行，此时只剩应用层在挡。
    const other = await createTestOrgWithSeed(ownerId, 'Other Att', `other-att-${suffix}`, 'MYR');

    currentUserId = ownerId;
    const foreign = await createTransaction(other.slug, {
      kind: 'expense',
      occurredOn: '2026-08-01',
      amount: '10.00',
      currency: 'MYR',
      moneyAccountId: other.accountsByCode.cash,
      categoryId: other.categoriesByAccountCode.rent,
      description: 'Foreign',
      clientUuid: randomUUID(),
    });

    await expect(uploadAttachment(orgSlug, foreign.id, receipt())).rejects.toMatchObject({
      code: 'not_found',
    });

    // attachments 没有「organization_id 必须与所属交易一致」的约束，
    // 所以收窄失守时这里会真的落下一行跨公司的附件。
    const rows = await admin`select id from attachments where transaction_id = ${foreign.id}`;
    expect(rows).toHaveLength(0);
  });
});

describe('getAttachmentSignedUrl', () => {
  it('returns a short-lived signed url, never a public one', async () => {
    currentUserId = ownerId;
    const { id } = await uploadAttachment(orgSlug, transactionId, receipt('signed.jpg'));

    const url = await getAttachmentSignedUrl(orgSlug, id);
    expect(SIGNED_URL_TTL_SECONDS).toBe(300);
    expect(url).toContain(`expires=${SIGNED_URL_TTL_SECONDS}`);
    expect(url).not.toContain('/public/');
  });

  it('lets a viewer read the receipt', async () => {
    currentUserId = ownerId;
    const { id } = await uploadAttachment(orgSlug, transactionId, receipt('viewable.jpg'));

    currentUserId = viewerId;
    await expect(getAttachmentSignedUrl(orgSlug, id)).resolves.toContain('https://storage.test/');
  });
});

describe('deleteAttachment', () => {
  it('removes the row and the stored object', async () => {
    currentUserId = ownerId;
    const { id } = await uploadAttachment(orgSlug, transactionId, receipt('gone.jpg'));

    await deleteAttachment(orgSlug, id);

    const rows = await admin`select id from attachments where id = ${id}`;
    expect(rows).toHaveLength(0);
  });

  it('blocks a viewer from deleting', async () => {
    currentUserId = ownerId;
    const { id } = await uploadAttachment(orgSlug, transactionId, receipt('keep.jpg'));

    currentUserId = viewerId;
    await expect(deleteAttachment(orgSlug, id)).rejects.toMatchObject({ code: 'forbidden' });

    // 拒绝之后行与对象都要还在，否则「拒绝」只是没报成功而已。
    const rows = await admin`select id from attachments where id = ${id}`;
    expect(rows).toHaveLength(1);
  });
});
