import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * 内存版 Storage，按 bucket 分开记。logo 必须写进 branding，不能落进收据的
 * receipts bucket——那边的上限和类型是给收据定的。
 */
const objects = new Map<string, { bucket: string; size: number; contentType: string }>();
let signedUrlFails = false;

vi.mock('@/lib/supabase/storage', () => ({
  RECEIPTS_BUCKET: 'receipts',
  BRANDING_BUCKET: 'branding',
  getStorageClient: (bucket = 'receipts') => ({
    upload: async (path: string, file: File) => {
      objects.set(path, { bucket, size: file.size, contentType: file.type });
      return { path };
    },
    createSignedUrl: async (path: string, expiresIn: number) => {
      if (signedUrlFails || !objects.has(path)) throw new Error('object not found');
      return `https://storage.test/${bucket}/${path}?expires=${expiresIn}`;
    },
    remove: async (path: string) => {
      objects.delete(path);
    },
  }),
}));

const { removeOrganizationLogo, updateOrganization, uploadOrganizationLogo } = await import(
  '@/server/actions/organizations'
);
const { createInvoice, updateInvoice } = await import('@/server/actions/invoices');
const { createPayment } = await import('@/server/actions/payments');
const { getInvoicePdfData } = await import('@/server/repositories/invoice-pdf');
const { getLogoSignedUrl, LOGO_SIGNED_URL_TTL_SECONDS } = await import(
  '@/server/services/organization-logo'
);
const { withTransaction } = await import('@/server/db/transaction');

let ownerId: string;
let adminId: string;
let bookkeeperId: string;
let orgId: string;
let orgSlug: string;
let customerId: string;

const suffix = randomUUID().slice(0, 8);

function image(name = 'logo.png', type = 'image/png', bytes = 4096): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

async function logoPath(): Promise<string | null> {
  const [row] = await admin`select logo_path from organizations where id = ${orgId}`;
  return (row.logo_path as string | null) ?? null;
}

const BASE_SETTINGS = {
  name: 'Profile Co',
  timezone: 'Asia/Kuala_Lumpur',
  fiscalYearStartMonth: '1',
};

beforeAll(async () => {
  await resetTestData();
  ownerId = await createTestUser(`owner-prof-${suffix}@example.com`, 'Owner');
  adminId = await createTestUser(`admin-prof-${suffix}@example.com`, 'Admin');
  bookkeeperId = await createTestUser(`book-prof-${suffix}@example.com`, 'Bookkeeper');

  const org = await createTestOrgWithSeed(ownerId, 'Profile Co', `profile-co-${suffix}`, 'MYR');
  orgId = org.id;
  orgSlug = org.slug;
  await joinOrg(adminId, orgId, 'admin');
  await joinOrg(bookkeeperId, orgId, 'bookkeeper');

  const [contact] = await admin`
    insert into contacts (organization_id, type, name, address)
    values (${orgId}, 'customer', 'Customer Sdn Bhd', ${'Lot 1\nJalan Dua'})
    returning id
  `;
  customerId = contact.id as string;
});

beforeEach(() => {
  signedUrlFails = false;
});

afterAll(async () => {
  await resetTestData();
  await admin.end();
});

describe('updateOrganization: seller details for invoices', () => {
  it('saves every invoice field the form sends', async () => {
    currentUserId = ownerId;
    await updateOrganization(orgSlug, {
      ...BASE_SETTINGS,
      address: 'Lot 5, Jalan Tiga\n50000 Kuala Lumpur',
      registrationNumber: '202401012345 (1234567-X)',
      taxNumber: 'W10-1808-32000123',
      phone: '+60 3-1234 5678',
      email: 'billing@profile.example',
      paymentDetails: 'Maybank\nProfile Co Sdn Bhd\n5123 4567 8901',
    });

    const [row] = await admin`
      select address, registration_number, tax_number, phone, email, payment_details
      from organizations where id = ${orgId}
    `;
    expect(row).toEqual({
      address: 'Lot 5, Jalan Tiga\n50000 Kuala Lumpur',
      registration_number: '202401012345 (1234567-X)',
      tax_number: 'W10-1808-32000123',
      phone: '+60 3-1234 5678',
      email: 'billing@profile.example',
      payment_details: 'Maybank\nProfile Co Sdn Bhd\n5123 4567 8901',
    });
  });

  it('clears a field the form leaves blank', async () => {
    currentUserId = ownerId;
    await updateOrganization(orgSlug, { ...BASE_SETTINGS, taxNumber: 'SST-1' });
    await updateOrganization(orgSlug, { ...BASE_SETTINGS });

    const [row] = await admin`select tax_number, phone from organizations where id = ${orgId}`;
    expect(row.tax_number).toBeNull();
    expect(row.phone).toBeNull();
  });

  it('rejects an email that is not an email address', async () => {
    currentUserId = ownerId;
    await expect(
      updateOrganization(orgSlug, { ...BASE_SETTINGS, email: 'not an email' }),
    ).rejects.toThrow(/email address/);
  });

  it('accepts an address the browser’s email field accepts', async () => {
    // type="email" 放行没有点的域名；服务端更严的话，用户会撞上一张报错页。
    currentUserId = ownerId;
    await updateOrganization(orgSlug, { ...BASE_SETTINGS, email: 'billing@intranet' });
    const [row] = await admin`select email from organizations where id = ${orgId}`;
    expect(row.email).toBe('billing@intranet');
  });

  it('counts a textarea line break as one character, as the browser does', async () => {
    // 浏览器提交 textarea 时换行是 \r\n，而 maxLength 把它算成一个字符。
    // 6 行、正好 300 字的地址在页面上合法，到服务端不能变成 305 字被拒。
    currentUserId = ownerId;
    const lines = Array.from({ length: 6 }, (_, i) => String(i).repeat(49));
    const address = lines.join('\r\n');
    expect(lines.join('\n')).toHaveLength(299);
    await updateOrganization(orgSlug, { ...BASE_SETTINGS, address: `${address}x` });

    const [row] = await admin`select address from organizations where id = ${orgId}`;
    expect(row.address).toBe(`${lines.join('\n')}x`);
  });

  it('stores a field of only spaces as empty, not as blank text', async () => {
    currentUserId = ownerId;
    await updateOrganization(orgSlug, { ...BASE_SETTINGS, phone: '   ', email: '  ' });
    const [row] = await admin`select phone, email from organizations where id = ${orgId}`;
    expect(row.phone).toBeNull();
    expect(row.email).toBeNull();
  });

  it('puts the seller details on the printable invoice data', async () => {
    currentUserId = ownerId;
    await updateOrganization(orgSlug, {
      ...BASE_SETTINGS,
      registrationNumber: 'REG-42',
      taxNumber: 'TAX-42',
      paymentDetails: 'Bank: Test Bank',
    });
    const { id } = await createInvoice(orgSlug, {
      contactId: customerId,
      issueDate: '2033-04-01',
      dueDate: '2033-05-01',
      currency: 'MYR',
      taxRatePercent: '0',
      items: [{ description: 'Design work', quantity: '1', unitPrice: '500.00' }],
    });

    const data = await withTransaction(ownerId, (tx) => getInvoicePdfData(tx, orgId, id));
    expect(data?.organization).toMatchObject({
      name: 'Profile Co',
      registrationNumber: 'REG-42',
      taxNumber: 'TAX-42',
      paymentDetails: 'Bank: Test Bank',
      logoPath: null,
    });
  });
});

describe('updateOrganization: invoice layout', () => {
  it('saves the invoice language, sign-off, tax name and footer', async () => {
    currentUserId = ownerId;
    await updateOrganization(orgSlug, {
      ...BASE_SETTINGS,
      invoiceLocale: 'bilingual',
      invoiceSignoff: 'signature',
      invoiceTaxLabel: 'SST',
      invoiceFooter: 'Payment within 30 days.\r\nThank you!',
    });

    const [row] = await admin`
      select invoice_locale, invoice_signoff, invoice_tax_label, invoice_footer
      from organizations where id = ${orgId}
    `;
    expect(row).toEqual({
      invoice_locale: 'bilingual',
      invoice_signoff: 'signature',
      invoice_tax_label: 'SST',
      invoice_footer: 'Payment within 30 days.\nThank you!',
    });
  });

  it('keeps the language and sign-off when a caller leaves them out', async () => {
    // 两个枚举没有「空」这个值：省略只可能是调用方没带上，不能悄悄改回默认。
    currentUserId = ownerId;
    await updateOrganization(orgSlug, {
      ...BASE_SETTINGS,
      invoiceLocale: 'zh',
      invoiceSignoff: 'none',
    });
    await updateOrganization(orgSlug, { ...BASE_SETTINGS });

    const [row] = await admin`
      select invoice_locale, invoice_signoff, invoice_tax_label, invoice_footer
      from organizations where id = ${orgId}
    `;
    expect(row.invoice_locale).toBe('zh');
    expect(row.invoice_signoff).toBe('none');
    // 文字项与卖方资料一样：省略即清空。
    expect(row.invoice_tax_label).toBeNull();
    expect(row.invoice_footer).toBeNull();
  });

  it('rejects a language it does not know', async () => {
    currentUserId = ownerId;
    await expect(
      updateOrganization(orgSlug, { ...BASE_SETTINGS, invoiceLocale: 'fr' }),
    ).rejects.toThrow();
  });

  it('defaults a new company to English with the computer-generated line', async () => {
    const other = await createTestOrgWithSeed(ownerId, 'Fresh Co', `fresh-co-${suffix}`, 'MYR');
    const [row] = await admin`
      select invoice_locale, invoice_signoff from organizations where id = ${other.id}
    `;
    expect(row).toEqual({ invoice_locale: 'en', invoice_signoff: 'computer_generated' });
  });
});

describe('invoice reference and the printable invoice data', () => {
  const ITEMS = [{ description: 'Design work', quantity: '2', unitPrice: '250.00' }];

  async function newInvoice(reference?: string) {
    currentUserId = ownerId;
    const { id } = await createInvoice(orgSlug, {
      contactId: customerId,
      issueDate: '2033-04-02',
      dueDate: '2033-05-02',
      currency: 'MYR',
      taxRatePercent: '0',
      reference,
      items: ITEMS,
      issue: true,
    });
    return id;
  }

  it('saves the customer reference, trimmed', async () => {
    const id = await newInvoice('  PO-2033-17  ');
    const [row] = await admin`select reference from invoices where id = ${id}`;
    expect(row.reference).toBe('PO-2033-17');
  });

  it('stores a blank reference as empty', async () => {
    const id = await newInvoice('   ');
    const [row] = await admin`select reference from invoices where id = ${id}`;
    expect(row.reference).toBeNull();
  });

  it('changes and clears the reference on edit', async () => {
    const id = await newInvoice('PO-1');
    const edit = {
      contactId: customerId,
      issueDate: '2033-04-02',
      dueDate: '2033-05-02',
      currency: 'MYR',
      taxRatePercent: '0',
      items: ITEMS,
    };
    await updateInvoice(orgSlug, id, { ...edit, reference: 'PO-2' });
    expect((await admin`select reference from invoices where id = ${id}`)[0].reference).toBe('PO-2');
    await updateInvoice(orgSlug, id, edit);
    expect((await admin`select reference from invoices where id = ${id}`)[0].reference).toBeNull();
  });

  it('rejects a reference over 60 characters and saves nothing', async () => {
    currentUserId = ownerId;
    const [{ count: before }] = await admin`
      select count(*)::int as count from invoices where organization_id = ${orgId}
    `;
    await expect(newInvoice('x'.repeat(61))).rejects.toThrow(/60 characters/);
    const [{ count: after }] = await admin`
      select count(*)::int as count from invoices where organization_id = ${orgId}
    `;
    expect(after).toBe(before);
  });

  it('gives the print page the reference, customer phone and terms, and what is paid', async () => {
    await admin`
      update contacts set phone = '+60 12-345 6789', payment_terms = '30 days'
      where id = ${customerId}
    `;
    await updateOrganization(orgSlug, {
      ...BASE_SETTINGS,
      invoiceLocale: 'zh',
      invoiceSignoff: 'signature',
      invoiceTaxLabel: 'SST',
      invoiceFooter: 'Thank you',
    });
    const id = await newInvoice('PO-PRINT');
    await createPayment(orgSlug, {
      contactId: customerId,
      type: 'received',
      amount: '120.00',
      currency: 'MYR',
      paymentDate: '2033-04-05',
      method: 'bank_transfer',
      items: [{ invoiceId: id, amount: '120.00' }],
    });

    const data = await withTransaction(ownerId, (tx) => getInvoicePdfData(tx, orgId, id));
    expect(data?.invoice).toMatchObject({
      reference: 'PO-PRINT',
      totalMinor: 50000n,
      deductedMinor: 12000n,
    });
    expect(data?.contact).toMatchObject({ phone: '+60 12-345 6789', paymentTerms: '30 days' });
    expect(data?.organization).toMatchObject({
      invoiceLocale: 'zh',
      invoiceSignoff: 'signature',
      invoiceTaxLabel: 'SST',
      invoiceFooter: 'Thank you',
    });
  });
});

describe('uploadOrganizationLogo', () => {
  it('stores the logo in the branding bucket under the company folder', async () => {
    currentUserId = ownerId;
    await uploadOrganizationLogo(orgSlug, image());

    const path = await logoPath();
    expect(path).not.toBeNull();
    expect(path!.startsWith(`${orgId}/logo-`)).toBe(true);
    expect(path).toMatch(/\.png$/);
    expect(objects.get(path!)?.bucket).toBe('branding');
  });

  it('replaces the previous logo and removes the old object', async () => {
    currentUserId = ownerId;
    await uploadOrganizationLogo(orgSlug, image('first.png'));
    const first = await logoPath();

    await uploadOrganizationLogo(orgSlug, image('second.webp', 'image/webp'));
    const second = await logoPath();

    expect(second).not.toBe(first);
    expect(second).toMatch(/\.webp$/);
    expect(objects.has(first!)).toBe(false);
    expect(objects.has(second!)).toBe(true);
  });

  it('writes the change to the audit log', async () => {
    currentUserId = ownerId;
    const before = await logoPath();
    await uploadOrganizationLogo(orgSlug, image('audited.jpg', 'image/jpeg'));
    const after = await logoPath();

    const [log] = await admin`
      select action, before, after from audit_logs
      where organization_id = ${orgId} and action = 'organization.update'
        and after ->> 'logoPath' = ${after}
    `;
    expect(log.before).toEqual({ logoPath: before });
    expect(log.after).toMatchObject({ logoPath: after, fileName: 'audited.jpg' });
  });

  it('lets an admin change the logo', async () => {
    currentUserId = adminId;
    await expect(uploadOrganizationLogo(orgSlug, image('by-admin.png'))).resolves.toBeUndefined();
  });

  it('does not let a bookkeeper change the logo', async () => {
    currentUserId = bookkeeperId;
    const before = await logoPath();
    await expect(uploadOrganizationLogo(orgSlug, image())).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(await logoPath()).toBe(before);
  });

  it('rejects an SVG, which can carry script', async () => {
    currentUserId = ownerId;
    const before = objects.size;
    await expect(
      uploadOrganizationLogo(orgSlug, image('logo.svg', 'image/svg+xml')),
    ).rejects.toThrow(/PNG, JPG or WebP/);
    expect(objects.size).toBe(before);
  });

  it('rejects a logo over 1 MB', async () => {
    currentUserId = ownerId;
    await expect(
      uploadOrganizationLogo(orgSlug, image('huge.png', 'image/png', 1024 * 1024 + 1)),
    ).rejects.toThrow(/1 MB/);
  });
});

describe('removeOrganizationLogo', () => {
  it('clears the logo and deletes the stored object', async () => {
    currentUserId = ownerId;
    await uploadOrganizationLogo(orgSlug, image('to-remove.png'));
    const path = await logoPath();

    await removeOrganizationLogo(orgSlug);

    expect(await logoPath()).toBeNull();
    expect(objects.has(path!)).toBe(false);
  });

  it('is a no-op when there is no logo', async () => {
    currentUserId = ownerId;
    await removeOrganizationLogo(orgSlug);
    await expect(removeOrganizationLogo(orgSlug)).resolves.toBeUndefined();
    expect(await logoPath()).toBeNull();
  });
});

describe('getLogoSignedUrl', () => {
  it('returns null when there is no logo', async () => {
    await expect(getLogoSignedUrl(null)).resolves.toBeNull();
  });

  it('signs a branding-bucket url with the logo ttl', async () => {
    currentUserId = ownerId;
    await uploadOrganizationLogo(orgSlug, image('signed.png'));
    const url = await getLogoSignedUrl(await logoPath());
    expect(url).toContain('/branding/');
    expect(url).toContain(`expires=${LOGO_SIGNED_URL_TTL_SECONDS}`);
  });

  it('degrades to no logo instead of breaking the invoice when storage fails', async () => {
    currentUserId = ownerId;
    await uploadOrganizationLogo(orgSlug, image('flaky.png'));
    signedUrlFails = true;
    await expect(getLogoSignedUrl(await logoPath())).resolves.toBeNull();
  });
});
