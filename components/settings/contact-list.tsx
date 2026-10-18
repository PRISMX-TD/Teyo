'use client';

import { useId, useState, type ReactNode } from 'react';
import type { Locale } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { CaretDown } from '@/components/ui/icons';

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

/** 标签 + 输入框一组。原来每个框只有 placeholder，一开始输入就看不出这是哪一栏。 */
function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

export function ContactList({ orgSlug, items, locale, onCreate, onUpdate, onToggle }: Props) {
  const t = getMessages(locale);
  const uid = useId();
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

  // 停用 / 启用原来是裸调用：失败时没有任何提示（Promise 被丢掉，变成一条
  // 未处理的 rejection），用户只看到按钮点了没反应。
  async function handleToggle(id: string, active: boolean) {
    setPending(true);
    setError(null);
    try {
      await onToggle(orgSlug, id, active);
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

  const hasDetails = (item: ContactItem) =>
    Boolean(item.address || item.taxId || item.paymentTerms || item.notes);

  const inactive = items.filter((item) => !item.isActive);

  return (
    <>
      {/* 每一类自成一张卡、类名作卡外小标题，与科目表同一个样子。原来行直接
          落在 .named-list 里，而 .named-list:has(> .coa-section) 把外层卡片
          去掉了，行和分隔线就散在灰底上。 */}
      <div className="named-list">
        {CONTACT_TYPES.map((contactType) => {
          const subset = items.filter((item) => item.type === contactType && item.isActive);
          if (subset.length === 0) return null;
          return (
            <div key={contactType} className="coa-section">
              <h2 className="coa-section-title">{t.settings[TYPE_LABEL_KEYS[contactType]]}</h2>
              <div className="coa-group">
                {subset.map((item) => (
                  <div key={item.id} className="list-item">
                    {editing === item.id ? (
                      <form
                        className="row-form"
                        noValidate
                        onSubmit={(e) => {
                          e.preventDefault();
                          void handleUpdate(item.id);
                        }}
                      >
                        <Field id={`${uid}-e-name`} label={t.settings.name}>
                          <input
                            id={`${uid}-e-name`}
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                          />
                        </Field>
                        <Field id={`${uid}-e-email`} label={t.auth.email}>
                          <input
                            id={`${uid}-e-email`}
                            type="email"
                            value={editEmail}
                            onChange={(e) => setEditEmail(e.target.value)}
                          />
                        </Field>
                        <Field id={`${uid}-e-phone`} label={t.settings.phone}>
                          <input
                            id={`${uid}-e-phone`}
                            type="tel"
                            value={editPhone}
                            onChange={(e) => setEditPhone(e.target.value)}
                          />
                        </Field>
                        <Field id={`${uid}-e-address`} label={t.settings.address}>
                          <input
                            id={`${uid}-e-address`}
                            value={editAddress}
                            onChange={(e) => setEditAddress(e.target.value)}
                          />
                        </Field>
                        <Field id={`${uid}-e-tax`} label={t.settings.taxId}>
                          <input
                            id={`${uid}-e-tax`}
                            value={editTaxId}
                            onChange={(e) => setEditTaxId(e.target.value)}
                          />
                        </Field>
                        <Field id={`${uid}-e-terms`} label={t.settings.paymentTerms}>
                          <input
                            id={`${uid}-e-terms`}
                            value={editPaymentTerms}
                            onChange={(e) => setEditPaymentTerms(e.target.value)}
                          />
                        </Field>
                        <Field id={`${uid}-e-notes`} label={t.settings.notes}>
                          <input
                            id={`${uid}-e-notes`}
                            value={editNotes}
                            onChange={(e) => setEditNotes(e.target.value)}
                          />
                        </Field>
                        <div className="add-form-actions">
                          <button type="submit" disabled={pending || !editName.trim()}>
                            {t.settings.save}
                          </button>
                          <button type="button" onClick={() => setEditing(null)}>
                            {t.common.cancel}
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div className="contact-row">
                        {/* 不再给每一行挂类型徽章：这一组的小标题已经写着是哪一类。 */}
                        <span className="contact-name">{item.name}</span>
                        {item.email || item.phone ? (
                          <span className="contact-meta">
                            {item.email ? <span className="contact-email">{item.email}</span> : null}
                            {item.phone ? <span className="contact-phone">{item.phone}</span> : null}
                          </span>
                        ) : null}
                        <span className="row-actions">
                          <button type="button" onClick={() => startEdit(item)} className="btn-small">
                            {t.common.edit}
                          </button>
                          {/* 原来是一个只写着「+」的窄按钮，读起来像「新增」。只有真有
                              地址、税号这些可看时才出现。 */}
                          {hasDetails(item) ? (
                            <button
                              type="button"
                              onClick={() => setExpanded(expanded === item.id ? null : item.id)}
                              className="btn-small disclosure-button"
                              aria-expanded={expanded === item.id}
                              aria-controls={`${uid}-d-${item.id}`}
                            >
                              {t.settings.showDetails}
                              <CaretDown size={12} weight="bold" aria-hidden="true" />
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => handleToggle(item.id, !item.isActive)}
                            disabled={pending}
                            className="btn-small"
                          >
                            {t.settings.deactivate}
                          </button>
                        </span>
                        {expanded === item.id ? (
                          <dl id={`${uid}-d-${item.id}`} className="contact-detail-list">
                            {item.address ? (
                              <>
                                <dt>{t.settings.address}</dt>
                                <dd>{item.address}</dd>
                              </>
                            ) : null}
                            {item.taxId ? (
                              <>
                                <dt>{t.settings.taxId}</dt>
                                <dd>{item.taxId}</dd>
                              </>
                            ) : null}
                            {item.paymentTerms ? (
                              <>
                                <dt>{t.settings.paymentTerms}</dt>
                                <dd>{item.paymentTerms}</dd>
                              </>
                            ) : null}
                            {item.notes ? (
                              <>
                                <dt>{t.settings.notes}</dt>
                                <dd>{item.notes}</dd>
                              </>
                            ) : null}
                          </dl>
                        ) : null}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}

        {inactive.length > 0 ? (
          <div className="coa-section">
            <h2 className="coa-section-title">{t.settings.inactive}</h2>
            <div className="coa-group">
              {inactive.map((item) => (
                <div key={item.id} className="list-item inactive">
                  <div className="list-item-line">
                    <span className="contact-name">{item.name}</span>
                    {/* 隐藏的这一组混着客户和供应商，类型徽章在这里才有用。 */}
                    <span className="badge">{t.settings[TYPE_LABEL_KEYS[item.type]]}</span>
                    <span className="row-actions">
                      <button type="button" onClick={() => handleToggle(item.id, true)} disabled={pending}>
                        {t.settings.reactivate}
                      </button>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {error ? <p role="alert" className="form-error">{error}</p> : null}

      <form
        id="add-contact"
        className="add-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void handleCreate();
        }}
      >
        <h3>{t.settings.addContact}</h3>
        <Field id={`${uid}-type`} label={t.settings.contactType}>
          <select id={`${uid}-type`} value={type} onChange={(e) => setType(e.target.value as ContactType)}>
            {CONTACT_TYPES.map((ct) => (
              <option key={ct} value={ct}>
                {t.settings[TYPE_LABEL_KEYS[ct]]}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${uid}-name`} label={`${t.settings.name}*`}>
          <input
            id={`${uid}-name`}
            aria-required="true"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field id={`${uid}-email`} label={t.auth.email}>
          <input id={`${uid}-email`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field id={`${uid}-phone`} label={t.settings.phone}>
          <input id={`${uid}-phone`} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field id={`${uid}-address`} label={t.settings.address}>
          <input id={`${uid}-address`} value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        <Field id={`${uid}-tax`} label={t.settings.taxId}>
          <input id={`${uid}-tax`} value={taxId} onChange={(e) => setTaxId(e.target.value)} />
        </Field>
        <Field id={`${uid}-terms`} label={t.settings.paymentTerms}>
          <input id={`${uid}-terms`} value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} />
        </Field>
        <Field id={`${uid}-notes`} label={t.settings.notes}>
          <input id={`${uid}-notes`} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="add-form-actions">
          <button type="submit" disabled={pending || !name.trim()}>
            {t.settings.addContact}
          </button>
        </div>
      </form>
    </>
  );
}
