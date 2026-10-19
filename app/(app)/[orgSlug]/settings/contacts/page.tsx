import { BackLink } from '@/components/ui/back-link';
import { Plus } from '@/components/ui/icons';
import { ContactList } from '@/components/settings/contact-list';
import { getMessages } from '@/lib/i18n';
import { createContact, updateContactAction, toggleContactActive } from '@/server/actions/contacts';
import { requirePagePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listContacts } from '@/server/repositories/contacts';

export default async function ContactsSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePagePermission(orgSlug, 'account:manage');
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
      <BackLink href={`/${orgSlug}/settings`}>{t.nav.settings}</BackLink>
      {/* 新增表单在所有联系人下面；页头给一个跳过去的入口。 */}
      <div className="page-header">
        <h1>{t.settings.contacts}</h1>
        <div className="page-header-actions">
          <a href="#add-contact" className="add-button">
            <Plus size={16} weight="bold" aria-hidden="true" />
            {t.settings.addContact}
          </a>
        </div>
      </div>
      <ContactList
        orgSlug={orgSlug}
        items={items}
        locale={locale}
        onCreate={createContact}
        onUpdate={updateContactAction}
        onToggle={toggleContactActive}
      />
    </>
  );
}
