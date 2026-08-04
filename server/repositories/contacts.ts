import type { Tx } from '@/server/db/transaction';

export type ContactRow = {
  id: string;
  organizationId: string;
  type: 'customer' | 'vendor' | 'both';
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  taxId: string | null;
  paymentTerms: string | null;
  notes: string | null;
  isActive: boolean;
};

export async function listContacts(tx: Tx, organizationId: string): Promise<ContactRow[]> {
  const rows = await tx`
    select id, organization_id, type, name, email, phone, address, tax_id, payment_terms, notes, is_active
    from contacts where organization_id = ${organizationId} order by name
  `;
  return rows.map(mapContact);
}

export async function getContact(tx: Tx, organizationId: string, id: string): Promise<ContactRow | null> {
  const rows = await tx`
    select id, organization_id, type, name, email, phone, address, tax_id, payment_terms, notes, is_active
    from contacts where id = ${id} and organization_id = ${organizationId}
  `;
  return rows.length ? mapContact(rows[0]) : null;
}

export async function insertContact(
  tx: Tx,
  row: {
    organizationId: string;
    type: 'customer' | 'vendor' | 'both';
    name: string;
    email: string | null;
    phone: string | null;
    address: string | null;
    taxId: string | null;
    paymentTerms: string | null;
    notes: string | null;
  },
): Promise<{ id: string }> {
  const r = await tx`
    insert into contacts (organization_id, type, name, email, phone, address, tax_id, payment_terms, notes)
    values (${row.organizationId}, ${row.type}, ${row.name}, ${row.email}, ${row.phone}, ${row.address}, ${row.taxId}, ${row.paymentTerms}, ${row.notes})
    returning id
  `;
  return { id: r[0].id as string };
}

export async function updateContact(
  tx: Tx,
  organizationId: string,
  id: string,
  fields: Partial<{
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
  await tx`
    update contacts set
      type = coalesce(${fields.type ?? null}::contact_type, type),
      name = coalesce(${fields.name ?? null}, name),
      email = ${fields.email ?? null},
      phone = ${fields.phone ?? null},
      address = ${fields.address ?? null},
      tax_id = ${fields.taxId ?? null},
      payment_terms = ${fields.paymentTerms ?? null},
      notes = ${fields.notes ?? null},
      updated_at = now()
    where id = ${id} and organization_id = ${organizationId}
  `;
}

export async function setContactActive(
  tx: Tx,
  organizationId: string,
  id: string,
  active: boolean,
): Promise<void> {
  await tx`
    update contacts set is_active = ${active}, updated_at = now()
    where id = ${id} and organization_id = ${organizationId}
  `;
}

function mapContact(row: Record<string, unknown>): ContactRow {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    type: row.type as ContactRow['type'],
    name: row.name as string,
    email: (row.email as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    address: (row.address as string | null) ?? null,
    taxId: (row.tax_id as string | null) ?? null,
    paymentTerms: (row.payment_terms as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    isActive: row.is_active as boolean,
  };
}
