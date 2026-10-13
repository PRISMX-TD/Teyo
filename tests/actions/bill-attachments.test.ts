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

/** 内存版 Storage，与 attachments.test.ts 同一个形状。 */
const uploaded = new Map<string, { size: number; contentType: string }>();
/** 上传「进行中」要发生的事，用来模拟上传途中账单被别人作废。 */
let duringUpload: (() => Promise<void>) | null = null;

vi.mock('@/lib/supabase/storage', () => ({
  getStorageClient: () => ({
    upload: async (path: string, file: File) => {
      uploaded.set(path, { size: file.size, contentType: file.type });
      if (duringUpload) {
        const hook = duringUpload;
        duringUpload = null;
        await hook();
      }
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

const { deleteAttachment, getAttachmentSignedUrl, uploadAttachment, uploadBillAttachment } =
  await import('@/server/actions/attachments');
const { createBill, voidBill } = await import('@/server/actions/bills');
const { createTransaction } = await import('@/server/actions/transactions');
const { listAttachments } = await import('@/server/repositories/attachments');
const { withTransaction } = await import('@/server/db/transaction');

let ownerId: string;
let bookkeeperId: string;
let viewerId: string;
let orgId: string;
let orgSlug: string;
let vendorId: string;
let otherOrgId: string;
let otherSlug: string;
let otherVendorId: string;
/** 两家公司各一笔普通支出，给交易那一侧的约束用例用。 */
let transactionId: string;
let otherTransactionId: string;

const suffix = randomUUID().slice(0, 8);

/** exchange_rates 没有公司维度隔离，各测试文件只能靠日期错开。2033-02 这一格没人用。 */
const DAY = '2033-02-14';
const DUE = '2033-03-14';

function pdf(name = 'vendor-bill.pdf', bytes = 2048): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}

async function insertVendor(organizationId: string, name: string): Promise<string> {
  const [contact] = await admin`
    insert into contacts (organization_id, type, name)
    values (${organizationId}, 'vendor', ${name})
    returning id
  `;
  return contact.id as string;
}

async function newBill(slug = orgSlug, contactId = vendorId): Promise<string> {
  currentUserId = ownerId;
  const { id } = await createBill(slug, {
    contactId,
    issueDate: DAY,
    dueDate: DUE,
    currency: 'MYR',
    items: [{ description: 'Stock', amount: '80.00' }],
  });
  return id;
}

beforeAll(async () => {
  await resetTestData();
  ownerId = await createTestUser(`owner-billatt-${suffix}@example.com`, 'Owner');
  bookkeeperId = await createTestUser(`book-billatt-${suffix}@example.com`, 'Bookkeeper');
  viewerId = await createTestUser(`viewer-billatt-${suffix}@example.com`, 'Viewer');

  const org = await createTestOrgWithSeed(ownerId, 'Bill Att Co', `bill-att-${suffix}`, 'MYR');
  orgId = org.id;
  orgSlug = org.slug;
  await joinOrg(bookkeeperId, orgId, 'bookkeeper');
  await joinOrg(viewerId, orgId, 'viewer');
  vendorId = await insertVendor(orgId, 'Paper Supplier');

  currentUserId = ownerId;
  transactionId = (
    await createTransaction(orgSlug, {
      kind: 'expense',
      occurredOn: DAY,
      amount: '12.00',
      currency: 'MYR',
      moneyAccountId: org.accountsByCode.cash,
      categoryId: org.categoriesByAccountCode.rent,
      description: 'Plain expense',
      clientUuid: randomUUID(),
    })
  ).id;

  // 第二家公司的 owner 与第一家相同，理由见 attachments.test.ts 的跨公司用例。
  const other = await createTestOrgWithSeed(ownerId, 'Other Bill Att', `other-billatt-${suffix}`, 'MYR');
  otherOrgId = other.id;
  otherSlug = other.slug;
  otherVendorId = await insertVendor(otherOrgId, 'Other Supplier');
  otherTransactionId = (
    await createTransaction(otherSlug, {
      kind: 'expense',
      occurredOn: DAY,
      amount: '5.00',
      currency: 'MYR',
      moneyAccountId: other.accountsByCode.cash,
      categoryId: other.categoriesByAccountCode.rent,
      description: 'Foreign expense',
      clientUuid: randomUUID(),
    })
  ).id;
});

afterAll(async () => {
  await resetTestData();
  await admin.end();
});

describe('uploadBillAttachment', () => {
  it('stores the file against the bill, not against its journal entry', async () => {
    const billId = await newBill();

    currentUserId = ownerId;
    const { id } = await uploadBillAttachment(orgSlug, billId, pdf());

    const [row] = await admin`
      select organization_id, transaction_id, bill_id, storage_path, file_name, mime_type
      from attachments where id = ${id}
    `;
    expect(row.organization_id).toBe(orgId);
    expect(row.bill_id).toBe(billId);
    expect(row.transaction_id).toBeNull();
    expect(row.storage_path.startsWith(`${orgId}/${billId}/`)).toBe(true);
    expect(row.file_name).toBe('vendor-bill.pdf');
    expect(row.mime_type).toBe('application/pdf');
  });

  it('lists the bill’s attachments and nothing from its transactions', async () => {
    const billId = await newBill();
    currentUserId = ownerId;
    await uploadBillAttachment(orgSlug, billId, pdf('page-1.pdf'));
    await uploadBillAttachment(orgSlug, billId, pdf('page-2.pdf'));

    const files = await withTransaction(ownerId, (tx) =>
      listAttachments(tx, orgId, { type: 'bill', id: billId }),
    );
    expect(files.map((file) => file.fileName)).toEqual(['page-1.pdf', 'page-2.pdf']);
    expect(files.every((file) => file.owner.type === 'bill' && file.owner.id === billId)).toBe(
      true,
    );
  });

  it('records the upload in the audit log as a bill change', async () => {
    const billId = await newBill();
    currentUserId = ownerId;
    const { id } = await uploadBillAttachment(orgSlug, billId, pdf('audited.pdf'));

    const [log] = await admin`
      select action, entity_type, after from audit_logs where entity_id = ${id}
    `;
    expect(log.action).toBe('bill.updated');
    expect(log.entity_type).toBe('attachment');
    expect(log.after).toMatchObject({ billId, fileName: 'audited.pdf' });
  });

  it('uses the same gate as editing the bill: a bookkeeper cannot attach', async () => {
    // updateBill 要 transaction:edit:any，记账员没有。附件是账单的凭证，
    // 门与改账单本身相同。
    const billId = await newBill();
    currentUserId = bookkeeperId;
    await expect(uploadBillAttachment(orgSlug, billId, pdf())).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('blocks a viewer', async () => {
    const billId = await newBill();
    currentUserId = viewerId;
    await expect(uploadBillAttachment(orgSlug, billId, pdf())).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('refuses a voided bill', async () => {
    const billId = await newBill();
    currentUserId = ownerId;
    await voidBill(orgSlug, billId, 'Entered twice');

    await expect(uploadBillAttachment(orgSlug, billId, pdf())).rejects.toMatchObject({
      code: 'forbidden',
    });
    const rows = await admin`select id from attachments where bill_id = ${billId}`;
    expect(rows).toHaveLength(0);
  });

  it('refuses a bill voided while the file was uploading, and cleans up the object', async () => {
    const billId = await newBill();
    currentUserId = ownerId;
    const before = uploaded.size;
    duringUpload = async () => {
      await admin`update bills set voided_at = now() where id = ${billId}`;
    };

    await expect(uploadBillAttachment(orgSlug, billId, pdf())).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(await admin`select id from attachments where bill_id = ${billId}`).toHaveLength(0);
    expect(uploaded.size).toBe(before);
  });

  it('rejects a bill that belongs to another company the same user owns', async () => {
    const foreignBill = await newBill(otherSlug, otherVendorId);

    currentUserId = ownerId;
    await expect(uploadBillAttachment(orgSlug, foreignBill, pdf())).rejects.toMatchObject({
      code: 'not_found',
    });
    const rows = await admin`select id from attachments where bill_id = ${foreignBill}`;
    expect(rows).toHaveLength(0);
  });

  it('treats a malformed bill id as not found rather than a database error', async () => {
    currentUserId = ownerId;
    await expect(uploadBillAttachment(orgSlug, 'not-a-uuid', pdf())).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('rejects a disallowed file type before touching storage', async () => {
    const billId = await newBill();
    currentUserId = ownerId;
    const before = uploaded.size;
    await expect(
      uploadBillAttachment(
        orgSlug,
        billId,
        new File([new Uint8Array(10)], 'bill.docx', {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      ),
    ).rejects.toThrow(/type/i);
    expect(uploaded.size).toBe(before);
  });
});

describe('bill attachments: preview and delete', () => {
  it('lets a viewer preview a bill attachment', async () => {
    const billId = await newBill();
    currentUserId = ownerId;
    const { id } = await uploadBillAttachment(orgSlug, billId, pdf('viewable.pdf'));

    currentUserId = viewerId;
    await expect(getAttachmentSignedUrl(orgSlug, id)).resolves.toContain('https://storage.test/');
  });

  it('removes the row and the object for someone allowed to edit the bill', async () => {
    const billId = await newBill();
    currentUserId = ownerId;
    const { id } = await uploadBillAttachment(orgSlug, billId, pdf('gone.pdf'));
    const [{ storage_path: storagePath }] = await admin`
      select storage_path from attachments where id = ${id}
    `;

    await deleteAttachment(orgSlug, id);

    expect(await admin`select id from attachments where id = ${id}`).toHaveLength(0);
    expect(uploaded.has(storagePath as string)).toBe(false);
  });

  it('does not let a bookkeeper delete a bill attachment', async () => {
    const billId = await newBill();
    currentUserId = ownerId;
    const { id } = await uploadBillAttachment(orgSlug, billId, pdf('keep.pdf'));

    currentUserId = bookkeeperId;
    await expect(deleteAttachment(orgSlug, id)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await admin`select id from attachments where id = ${id}`).toHaveLength(1);
  });
});

describe('attachments table constraints (0035)', () => {
  it('cascades a bill’s attachments when the bill is deleted', async () => {
    const billId = await newBill();
    currentUserId = ownerId;
    const { id } = await uploadBillAttachment(orgSlug, billId, pdf('cascade.pdf'));

    // 应用里没有硬删账单的路径（作废走 voided_at），这里直接用 admin 删，
    // 只为确认外键的删除语义与交易那一侧一致。
    await admin`delete from bills where id = ${billId}`;

    expect(await admin`select id from attachments where id = ${id}`).toHaveLength(0);
  });

  it('rejects an attachment that belongs to both a transaction and a bill', async () => {
    const billId = await newBill();

    await expect(admin`
      insert into attachments (organization_id, transaction_id, bill_id, storage_path, file_name,
                               mime_type, size_bytes, uploaded_by)
      values (${orgId}, ${transactionId}, ${billId}, ${`${orgId}/both/${randomUUID()}.pdf`},
              'both.pdf', 'application/pdf', 1, ${ownerId})
    `).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects an attachment that belongs to nothing', async () => {
    await expect(admin`
      insert into attachments (organization_id, storage_path, file_name, mime_type, size_bytes,
                               uploaded_by)
      values (${orgId}, ${`${orgId}/none/${randomUUID()}.pdf`}, 'none.pdf', 'application/pdf', 1,
              ${ownerId})
    `).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects an attachment whose company differs from its bill’s', async () => {
    const foreignBill = await newBill(otherSlug, otherVendorId);

    await expect(admin`
      insert into attachments (organization_id, bill_id, storage_path, file_name, mime_type,
                               size_bytes, uploaded_by)
      values (${orgId}, ${foreignBill}, ${`${orgId}/x/${randomUUID()}.pdf`}, 'x.pdf',
              'application/pdf', 1, ${ownerId})
    `).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects an attachment whose company differs from its transaction’s', async () => {
    // 0035 之前这一行在库里是合法的：attachments.transaction_id 只校验「交易
    // 存在」，跨公司全靠应用层的 organization_id 收窄在挡。
    await expect(admin`
      insert into attachments (organization_id, transaction_id, storage_path, file_name,
                               mime_type, size_bytes, uploaded_by)
      values (${orgId}, ${otherTransactionId}, ${`${orgId}/y/${randomUUID()}.pdf`}, 'y.pdf',
              'application/pdf', 1, ${ownerId})
    `).rejects.toMatchObject({ code: '23503' });
  });

  it('still accepts a plain transaction receipt through the action', async () => {
    currentUserId = ownerId;
    const { id } = await uploadAttachment(
      orgSlug,
      transactionId,
      new File([new Uint8Array(8)], 'r.jpg', { type: 'image/jpeg' }),
    );
    const [row] = await admin`select transaction_id, bill_id from attachments where id = ${id}`;
    expect(row.transaction_id).toBe(transactionId);
    expect(row.bill_id).toBeNull();
  });
});
