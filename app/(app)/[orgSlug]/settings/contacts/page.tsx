import { ContactList } from '@/components/settings/contact-list';
import { getMessages } from '@/lib/i18n';
import { createContact, updateContactAction, toggleContactActive } from '@/server/actions/contacts';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listContacts } from '@/server/repositories/contacts';

export default async function ContactsSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'account:manage');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const contacts = await withTransaction(context.userId, (tx) =>
    listContacts(tx, context.organizationId),
  );

  const items = contacts.map((c) => ({
    id: c.id,
    type: c.type,
    name: c.name,
    email: c.email,
    phone: c.phone,
    address: c.address,
    taxId: c.taxId,
    paymentTerms: c.paymentTerms,
    notes: c.notes,
    isActive: c.isActive,
  }));

  return (
    <>
      <h1>{t.settings.contacts}</h1>
      <ContactList
        orgSlug={orgSlug}
        items={items}
        locale={locale}
        onCreate={createContact as unknown as (orgSlug: string, payload: Record<string, unknown>) => Promise<unknown>}
        onUpdate={updateContactAction as unknown as (orgSlug: string, id: string, fields: Record<string, string>) => Promise<unknown>}
        onToggle={toggleContactActive as unknown as (orgSlug: string, id: string, active: boolean) => Promise<unknown>}
      />
    </>
  );
}
