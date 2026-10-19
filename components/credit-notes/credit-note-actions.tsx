'use client';

import { useState } from 'react';
import { useRefreshAfter } from '@/components/ui/use-refresh-after';
import type { Locale } from '@/lib/i18n';
import { getMessages, interpolate } from '@/lib/i18n';
import { applyCreditNote, voidCreditNote } from '@/server/actions/credit-notes';
import { DocumentVoidDialog } from '@/components/invoices/document-void-dialog';

/**
 * 详情页上的「应用」与「作废」。原来只在列表卡片上有，做法照
 * credit-note-list.tsx：同一组 Server Action、同一个作废对话框。权限由页面判。
 * 草稿的「发出」不在这里：它得先存下面那张表单，见 components/invoices/header-issue.tsx。
 */

/** 已发出 → 应用。只给已发出的单：它没有表单，没有没存的改动可丢。 */
export function CreditNoteApplyButton({
  orgSlug,
  locale,
  creditNoteId,
}: {
  orgSlug: string;
  locale: Locale;
  creditNoteId: string;
}) {
  const t = getMessages(locale);
  const { refresh, refreshing } = useRefreshAfter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleApply() {
    setPending(true);
    setError(null);
    try {
      await applyCreditNote(orgSlug, creditNoteId);
      refresh();
    } catch (e) {
      // 这张单在别处刚被作废之类，服务端会拒绝：必须说出来，不能「点了没反应」。
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button type="button" className="primary-button" disabled={pending || refreshing} onClick={handleApply}>
        {pending || refreshing ? t.common.loading : t.creditNotes.apply}
      </button>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** 作废：页面最底下一整行红字。已应用的也能作废——服务端一直允许。 */
export function CreditNoteVoidButton({
  orgSlug,
  locale,
  creditNoteId,
  cnNumber,
}: {
  orgSlug: string;
  locale: Locale;
  creditNoteId: string;
  cnNumber: string;
}) {
  const t = getMessages(locale);
  const { refresh, refreshing } = useRefreshAfter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleVoid(reason: string) {
    setPending(true);
    setError(null);
    try {
      await voidCreditNote(orgSlug, creditNoteId, reason);
      setOpen(false);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="doc-void-action">
      <button
        type="button"
        className="row-button is-destructive"
        disabled={pending || refreshing}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {t.creditNotes.voidCreditNote}
      </button>

      <DocumentVoidDialog
        open={open}
        title={interpolate(t.creditNotes.voidTitle, { number: cnNumber })}
        reasonLabel={t.invoices.voidReason}
        reasonHint={t.invoices.voidReasonHint}
        requiredMessage={t.creditNotes.voidReasonRequired}
        confirmLabel={t.creditNotes.voidConfirm}
        cancelLabel={t.common.cancel}
        pending={pending}
        error={error}
        onCancel={() => {
          setOpen(false);
          setError(null);
        }}
        onConfirm={handleVoid}
      />
    </div>
  );
}
