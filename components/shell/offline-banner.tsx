'use client';

import { useEffect, useState } from 'react';
import type { Locale } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { flushQueue, listQueuedTransactions } from '@/lib/offline-queue';

export function OfflineBanner({ locale }: { locale: Locale }) {
  const t = getMessages(locale);
  const [offline, setOffline] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  // 累计计数，不随后续（哪怕是空的）flush 而清零：一旦有记录同步失败，
  // 用户必须持续看到提示直到重新记录，否则就是"已保存"的谎言换了个地方重演。
  const [failedCount, setFailedCount] = useState(0);

  useEffect(() => {
    async function refreshCount() {
      setPendingCount((await listQueuedTransactions()).length);
    }

    async function handleOnline() {
      setOffline(false);
      // 动态 import：这个 banner 挂在 root layout 上，静态引入会把
      // server action 的模块图（含 postgres 客户端）拉进每个页面的
      // 客户端 bundle，导致所有路由渲染失败。
      const { createTransaction } = await import('@/server/actions/transactions');
      const result = await flushQueue((orgSlug, payload) => createTransaction(orgSlug, payload));
      if (result.failed > 0) {
        setFailedCount((prev) => prev + result.failed);
      }
      await refreshCount();
    }

    function handleOffline() {
      setOffline(true);
    }

    setOffline(!navigator.onLine);
    void refreshCount();

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (!offline && pendingCount === 0 && failedCount === 0) return null;

  return (
    <div role="status" className="offline-banner">
      {offline ? <span>{t.common.offline}</span> : null}
      {pendingCount > 0 ? (
        <span>{t.common.pendingSync.replace('{count}', String(pendingCount))}</span>
      ) : null}
      {offline ? <span>{t.errors.offlineEditBlocked}</span> : null}
      {failedCount > 0 ? (
        <span role="alert">{t.common.syncFailed.replace('{count}', String(failedCount))}</span>
      ) : null}
    </div>
  );
}
