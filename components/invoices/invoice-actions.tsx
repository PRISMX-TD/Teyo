'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Locale } from '@/lib/i18n';
import { getMessages, interpolate } from '@/lib/i18n';
import { voidInvoice } from '@/server/actions/invoices';
import { DocumentVoidDialog } from '@/components/invoices/document-void-dialog';

/**
 * 详情页上的「作废」。
 *
 * 原来只在列表卡片上有。处理方式与 invoice-list.tsx 一致——同一个 Server
 * Action、同一个作废对话框、失败时把服务端的话说出来。权限由页面判好再决定
 * 渲染不渲染，这里不再判。页头的「开具」见 header-issue.tsx：它得先存下面
 * 那张表单，不能独立成一个按钮。
 */

/** 作废：页面最底下一整行红字，iOS 详情页「删除」的位置，离主操作最远。 */
export function InvoiceVoidButton({
  orgSlug,
  locale,
  invoiceId,
  invoiceNumber,
}: {
  orgSlug: string;
  locale: Locale;
  invoiceId: string;
  invoiceNumber: string;
}) {
  const t = getMessages(locale);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleVoid(reason: string) {
    setPending(true);
    setError(null);
    try {
      await voidInvoice(orgSlug, invoiceId, reason);
      setOpen(false);
      router.refresh();
    } catch (e) {
      // 错误留在对话框里，对话框不关：关掉的话用户刚打的理由就没了。
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
        disabled={pending}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {t.invoices.voidInvoice}
      </button>

      <DocumentVoidDialog
        open={open}
        title={interpolate(t.invoices.voidTitle, { number: invoiceNumber })}
        reasonLabel={t.invoices.voidReason}
        reasonHint={t.invoices.voidReasonHint}
        requiredMessage={t.invoices.voidReasonRequired}
        confirmLabel={t.invoices.voidConfirm}
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
