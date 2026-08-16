'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Messages } from '@/lib/i18n';
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

      <div className="form-actions">
        <button
          type="button"
          className="btn-danger"
          disabled={pending}
          onClick={() => setVoidDialog(true)}
        >
          {t.transaction.void}
        </button>
      </div>

      {voidDialog ? (
        <dialog open className="void-dialog">
          <p>{t.transaction.voidReason}</p>
          <input
            value={voidReason}
            onChange={(e) => setVoidReason(e.target.value)}
            placeholder={t.transaction.voidReason}
            autoFocus
          />
          <div className="void-dialog-actions">
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
        </dialog>
      ) : null}
    </>
  );
}
