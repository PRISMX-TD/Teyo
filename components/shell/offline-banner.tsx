'use client';

import { useEffect, useState } from 'react';
import type { Locale } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { flushQueue, listQueuedTransactions } from '@/lib/offline-queue';
import { createTransaction } from '@/server/actions/transactions';

export function OfflineBanner({ locale }: { locale: Locale }) {
  const t = getMessages(locale);
  const [offline, setOffline] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    async function refreshCount() {
      setPendingCount((await listQueuedTransactions()).length);
    }

    async function handleOnline() {
      setOffline(false);
      await flushQueue((orgSlug, payload) => createTransaction(orgSlug, payload));
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

  if (!offline && pendingCount === 0) return null;

  return (
    <div role="status" className="offline-banner">
      {offline ? <span>{t.common.offline}</span> : null}
      {pendingCount > 0 ? (
        <span>{t.common.pendingSync.replace('{count}', String(pendingCount))}</span>
      ) : null}
      {offline ? <span>{t.errors.offlineEditBlocked}</span> : null}
    </div>
  );
}
