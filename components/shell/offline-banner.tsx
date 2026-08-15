'use client';

import { useEffect, useState } from 'react';
import type { Locale } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { flushQueue, listQueuedTransactions } from '@/lib/offline-queue';

export function OfflineBanner({ locale }: { locale: Locale }) {
  const t = getMessages(locale);
  const [offline, setOffline] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  // 只统计 dropped（校验失败、永久丢失）的记录，不含仍在队列里等重试的。
  // 累计计数，不随后续（哪怕是空的）flush 而清零：一旦有记录被永久丢弃，
  // 用户必须持续看到提示直到重新记录，否则就是"已保存"的谎言换了个地方重演。
  const [droppedCount, setDroppedCount] = useState(0);

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
      // 只累计 dropped：那才是真的丢了。retrying 的记录还在队列里，
      // pendingCount 已经如实反映它们，重复计入这里会让用户看到两条
      // 互相矛盾的提示，还可能被误导去手动补录一笔本来会自动同步的
      // 交易，造成重复记账。
      if (result.dropped > 0) {
        setDroppedCount((prev) => prev + result.dropped);
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

  if (!offline && pendingCount === 0 && droppedCount === 0) return null;

  return (
    <div role="status" className="offline-banner">
      {offline ? <span>{t.common.offline}</span> : null}
      {pendingCount > 0 ? (
        <span>{t.common.pendingSync.replace('{count}', String(pendingCount))}</span>
      ) : null}
      {offline ? <span>{t.errors.offlineEditBlocked}</span> : null}
      {droppedCount > 0 ? (
        <span role="alert">{t.common.syncFailed.replace('{count}', String(droppedCount))}</span>
      ) : null}
    </div>
  );
}
