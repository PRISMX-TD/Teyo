'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Messages } from '@/lib/i18n';
import { ModalDialog } from '@/components/ui/modal-dialog';
import { voidTransaction } from '@/server/actions/transactions';

type Props = {
  orgSlug: string;
  transactionId: string;
  t: Messages;
};

/**
 * 独立于 TransactionForm 的作废按钮，供不可编辑的只读详情页使用
 * （目前是「不确定」队列里的凭证分录，见 transactions/[id]/page.tsx）。
 * 与 TransactionForm 里的作废对话框逻辑一致，只是那份表单在这类记录
 * 上完全不会渲染——kind 为 journal 时，updateTransaction 会在
 * resolveCounterAccountId 里对任何分类都抛错，Save 必然失败，所以这
 * 里只提供确实能成功的操作。
 */
export function VoidButton({ orgSlug, transactionId, t }: Props) {
  const router = useRouter();
  const [voidDialog, setVoidDialog] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  const reasonRef = useRef<HTMLInputElement>(null);

  // 与 TransactionForm 同一个道理：触屏上不自动聚焦，免得键盘盖住弹层底部的按钮。
  useEffect(() => {
    if (!voidDialog) return;
    const input = reasonRef.current;
    if (!input) return;
    if (window.matchMedia('(pointer: fine)').matches) input.focus();
    else if (document.activeElement === input) input.blur();
  }, [voidDialog]);

  async function handleVoid() {
    if (!voidReason.trim()) return;
    setPending(true);
    setError(null);
    try {
      await voidTransaction(orgSlug, transactionId, voidReason);
      router.push(`/${orgSlug}/transactions`);
    } catch (e) {
      setError((e as Error).message);
      setVoidDialog(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}

      {/* 一整行红字，和编辑页底部的作废同一个样子。 */}
      <button
        type="button"
        className="row-button is-destructive tx-void-row"
        disabled={pending}
        onClick={() => setVoidDialog(true)}
      >
        {t.transaction.void}
      </button>

      <ModalDialog
        open={voidDialog}
        onClose={() => setVoidDialog(false)}
        title={t.transaction.void}
      >
        {/* 原来这里是一个裸 <p> 加一个只有 placeholder 的输入框——placeholder
            不是标签，一开始打字它就消失了，读屏也未必念。 */}
        <label htmlFor={reasonId}>{t.transaction.voidReason}</label>
        <input
          ref={reasonRef}
          id={reasonId}
          value={voidReason}
          onChange={(e) => setVoidReason(e.target.value)}
        />
        <div className="app-dialog-actions">
          <button type="button" onClick={() => setVoidDialog(false)}>
            {t.common.cancel}
          </button>
          <button
            type="button"
            className="btn-danger"
            disabled={!voidReason.trim() || pending}
            onClick={handleVoid}
          >
            {t.transaction.void}
          </button>
        </div>
      </ModalDialog>
    </>
  );
}
