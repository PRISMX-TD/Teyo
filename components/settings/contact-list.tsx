'use client';

import { useState } from 'react';
import type { Locale } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';

type ContactItem = {
  id: string;
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

const CONTACT_TYPES = ['customer', 'vendor', 'both'] as const;
type ContactType = (typeof CONTACT_TYPES)[number];

type CreatePayload = {
  type: ContactType;
  name: string;
  email?: string;
  phone?: string;
  address?: string;
  taxId?: string;
  paymentTerms?: string;
  notes?: string;
};

type UpdatePayload = Partial<{
  type: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  taxId: string;
  paymentTerms: string;
  notes: string;
}>;

type Props = {
  orgSlug: string;
  items: ContactItem[];
  locale: Locale;
  onCreate: (orgSlug: string, payload: CreatePayload) => Promise<{ id: string }>;
  onUpdate: (orgSlug: string, id: string, fields: UpdatePayload) => Promise<void>;
  onToggle: (orgSlug: string, id: string, active: boolean) => Promise<void>;
};

const TYPE_LABEL_KEYS: Record<ContactType, keyof ReturnType<typeof getMessages>['settings']> = {
  customer: 'typeCustomer',
  vendor: 'typeVendor',
  both: 'typeBoth',
};

export function ContactList({ orgSlug, items, locale, onCreate, onUpdate, onToggle }: Props) {
  const t = getMessages(locale);
  const [type, setType] = useState<ContactType>('customer');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [taxId, setTaxId] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Edit state
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editAddress, setEditAddress] = useState('');
  const [editTaxId, setEditTaxId] = useState('');
  const [editPaymentTerms, setEditPaymentTerms] = useState('');
  const [editNotes, setEditNotes] = useState('');

  // Show details state
  const [expanded, setExpanded] = useState<string | null>(null);

  async function handleCreate() {
    setPending(true);
    setError(null);
    try {
      await onCreate(orgSlug, {
        type,
        name: name.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        address: address.trim() || undefined,
        taxId: taxId.trim() || undefined,
        paymentTerms: paymentTerms.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      setName('');
      setEmail('');
      setPhone('');
      setAddress('');
      setTaxId('');
      setPaymentTerms('');
      setNotes('');
      setType('customer');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function handleUpdate(id: string) {
    setPending(true);
    setError(null);
    try {
      await onUpdate(orgSlug, id, {
        name: editName.trim(),
        email: editEmail.trim(),
        phone: editPhone.trim(),
        address: editAddress.trim(),
        taxId: editTaxId.trim(),
        paymentTerms: editPaymentTerms.trim(),
        notes: editNotes.trim(),
      });
      setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  function startEdit(item: ContactItem) {
    setEditing(item.id);
    setEditName(item.name);
    setEditEmail(item.email ?? '');
    setEditPhone(item.phone ?? '');
    setEditAddress(item.address ?? '');
    setEditTaxId(item.taxId ?? '');
    setEditPaymentTerms(item.paymentTerms ?? '');
    setEditNotes(item.notes ?? '');
  }

  return (
    <div className="named-list">
      {CONTACT_TYPES.map((contactType) => {
        const subset = items.filter((item) => item.type === contactType && item.isActive);
        if (subset.length === 0) return null;
        return (
          <div key={contactType} className="coa-section">
            <h2 className="coa-section-title">{t.settings[TYPE_LABEL_KEYS[contactType]]}</h2>
            {subset.map((item) => (
              <div key={item.id} className="list-item">
                {editing === item.id ? (
                  <div className="inline-edit">
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder={t.settings.name}
                    />
                    <input
                      value={editEmail}
                      onChange={(e) => setEditEmail(e.target.value)}
                      placeholder={t.auth.email}
                    />
                    <input
                      value={editPhone}
                      onChange={(e) => setEditPhone(e.target.value)}
                      placeholder={t.settings.phone}
                    />
                    <input
                      value={editAddress}
                      onChange={(e) => setEditAddress(e.target.value)}
                      placeholder={t.settings.address}
                    />
                    <div className="inline-edit-row">
                      <input
                        value={editTaxId}
                        onChange={(e) => setEditTaxId(e.target.value)}
                        placeholder={t.settings.taxId}
                      />
                      <input
                        value={editPaymentTerms}
                        onChange={(e) => setEditPaymentTerms(e.target.value)}
                        placeholder={t.settings.paymentTerms}
                      />
                    </div>
                    <input
                      value={editNotes}
                      onChange={(e) => setEditNotes(e.target.value)}
                      placeholder={t.settings.notes}
                    />
                    <button onClick={() => handleUpdate(item.id)} disabled={pending}>
                      {t.settings.save}
                    </button>
                    <button onClick={() => setEditing(null)}>{t.common.cancel}</button>
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', padding: 'var(--space-3) var(--space-4)' }}>
                      {/* 第一层：名称 + 类型 */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                        <span className="contact-name" style={{ flex: '1 1 auto', minWidth: 0 }}>{item.name}</span>
                        <span className="badge badge-info">{t.settings[TYPE_LABEL_KEYS[item.type]]}</span>
                      </div>
                      {/* 第二层：联系信息 */}
                      {(item.email || item.phone) ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
                          {item.email ? <span className="contact-email">{item.email}</span> : null}
                          {item.phone ? <span className="contact-phone">{item.phone}</span> : null}
                        </div>
                      ) : null}
                      {/* 第三层：操作按钮 */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-1)' }}>
                        <button onClick={() => startEdit(item)} style={{ minHeight: 36, fontSize: 'var(--text-xs)' }}>
                          {t.settings.rename ?? 'Edit'}
                        </button>
                        <button onClick={() => setExpanded(expanded === item.id ? null : item.id)} style={{ minHeight: 36, fontSize: 'var(--text-xs)' }}>
                          {expanded === item.id ? '−' : '+'}
                        </button>
                        <button onClick={() => onToggle(orgSlug, item.id, !item.isActive)} style={{ minHeight: 36, fontSize: 'var(--text-xs)' }}>
                          {t.settings.deactivate}
                        </button>
                      </div>
                    </div>
                    {expanded === item.id ? (
                      <div className="contact-details">
                        {item.address ? <p>{t.settings.address}: {item.address}</p> : null}
                        {item.taxId ? <p>{t.settings.taxId}: {item.taxId}</p> : null}
                        {item.paymentTerms ? <p>{t.settings.paymentTerms}: {item.paymentTerms}</p> : null}
                        {item.notes ? <p>{t.settings.notes}: {item.notes}</p> : null}
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            ))}
          </div>
        );
      })}

      {/* Inactive contacts */}
      {(() => {
        const inactive = items.filter((item) => !item.isActive);
        if (inactive.length === 0) return null;
        return (
          <div className="coa-section">
            <h2 className="coa-section-title">{t.settings.inactive}</h2>
            {inactive.map((item) => (
              <div key={item.id} className="list-item inactive">
                <div className="list-item-line">
                  <span className="contact-name">{item.name}</span>
                  <span className="badge">{t.settings.inactive}</span>
                  <span className="badge">{t.settings[TYPE_LABEL_KEYS[item.type]]}</span>
                  <button onClick={() => onToggle(orgSlug, item.id, true)}>
                    {t.settings.reactivate}
                  </button>
                </div>
              </div>
            ))}
          </div>
        );
      })()}

      {error ? <p role="alert" className="form-error">{error}</p> : null}

      <div className="add-form">
        <h3>{t.settings.addContact}</h3>
        <select value={type} onChange={(e) => setType(e.target.value as ContactType)}>
          {CONTACT_TYPES.map((ct) => (
            <option key={ct} value={ct}>
              {t.settings[TYPE_LABEL_KEYS[ct]]}
            </option>
          ))}
        </select>
        <input
          placeholder={`${t.settings.name}*`}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          placeholder={t.auth.email}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          placeholder={t.settings.phone}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <input
          placeholder={t.settings.address}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <input
          placeholder={t.settings.taxId}
          value={taxId}
          onChange={(e) => setTaxId(e.target.value)}
        />
        <input
          placeholder={t.settings.paymentTerms}
          value={paymentTerms}
          onChange={(e) => setPaymentTerms(e.target.value)}
        />
        <input
          placeholder={t.settings.notes}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <button onClick={handleCreate} disabled={pending || !name.trim()}>
          {t.settings.addContact}
        </button>
      </div>
    </div>
  );
}
