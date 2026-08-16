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

    // 挂载时和 'online' 事件都可能触发它——见下面对 flushing 的说明，
    // 两处并发调用不会把同一条记录同步两次。
    let flushing = false;

    async function handleOnline() {
      setOffline(false);
      // flushQueue 内部先读一次队列快照，再逐条提交后出队；两次调用若
      // 交叠，会各自读到还没被对方删掉的记录，重复提交同一条。提交本身
      // 靠 clientUuid 幂等，多数情况下"重复一次"本就无害；但两个并发
      // 事务都读不到对方尚未提交的插入时，较晚提交的那个会撞 client_uuid
      // 唯一约束报错，而这类错误不匹配 isRetriable 的网络错误特征，会被
      // 判成 dropped 从本地队列删除——那条记录其实已经同步成功，却被
      // 报成"丢失"。用这个标志把挂载时的补发和事件监听器的补发互斥，
      // 从根上消掉这个交叠窗口，而不是依赖幂等去兜底。
      if (flushing) return;
      flushing = true;
      try {
        // 动态 import：这个 banner 挂在 root layout 上，静态引入会把
        // server action 的模块图（含 postgres 客户端）拉进每个页面的
        // 客户端 bundle，导致所有路由渲染失败。
        const { createTransaction, createJournal } = await import('@/server/actions/transactions');
        const result = await flushQueue((orgSlug, payload) =>
          payload.kind === 'journal'
            ? createJournal(orgSlug, payload)
            : createTransaction(orgSlug, payload),
        );
        // 只累计 dropped：那才是真的丢了。retrying 的记录还在队列里，
        // pendingCount 已经如实反映它们，重复计入这里会让用户看到两条
        // 互相矛盾的提示，还可能被误导去手动补录一笔本来会自动同步的
        // 交易，造成重复记账。
        if (result.dropped > 0) {
          setDroppedCount((prev) => prev + result.dropped);
        }
        await refreshCount();
      } finally {
        flushing = false;
      }
    }

    function handleOffline() {
      setOffline(true);
    }

    setOffline(!navigator.onLine);
    void refreshCount();
    // 开着 wifi 关掉 PWA、第二天再打开：这段时间里不会有任何 'online'
    // 事件触发（连接从未断过），队列会一直摆在那儿直到网络碰巧掉线又
    // 恢复。挂载时如果已经在线，直接补发一次。
    if (navigator.onLine) {
      void handleOnline();
    }

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
