'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Locale } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import {
  discardFailedTransaction,
  flushQueue,
  listFailedTransactions,
  listQueuedTransactions,
  retryFailedTransaction,
  type QueuedTransaction,
} from '@/lib/offline-queue';

/** 队列在 banner 之外被改动（录入表单离线存了一笔）时广播的事件名。 */
const QUEUE_CHANGED_EVENT = 'teyo:offline-queue-changed';

/**
 * 通知 banner 重新读一次队列。banner 挂在 root layout 上、客户端导航不会
 * 重新挂载它——不广播的话，离线时录下的那一笔要等到网络恢复才出现在
 * 「N 笔待同步」里，用户看到的是一个对不上的数。
 */
export function notifyOfflineQueueChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(QUEUE_CHANGED_EVENT));
}

/**
 * 离线状态与待同步队列的提示条。挂在 root layout 上，所以每个页面都有它。
 *
 * signedIn 是必填的，不是可选项：这个组件既然挂在 root layout，登录页、
 * 注册页、邀请页上同样会挂载。未登录时去补发队列，每一条都会撞权限错误——
 * 而在它自己的分类逻辑修好之前，那恰好是把用户离线录的账全部删掉的那条
 * 路径（见 lib/offline-queue.ts 里 isDomainRejection 的注释）。现在删除
 * 已经不会发生了，但「没登录还一直试」仍然是在白白消耗重试次数、并且
 * 把一条本来好好的记录推向「已放弃」。所以干脆不试。
 */
export function OfflineBanner({ locale, signedIn }: { locale: Locale; signedIn: boolean }) {
  const t = getMessages(locale);
  const [offline, setOffline] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  // 已放弃自动同步、等用户处理的记录。这里存的是记录本身而不是一个计数：
  // 用户需要看到他当初录的是哪一笔（金额、日期、备注）才谈得上补录，
  // 一个「N 条失败」的数字等于让他凭记忆重来。
  const [failed, setFailed] = useState<QueuedTransaction[]>([]);
  // 正在处理（重试/丢弃）的那一条，防连点：丢弃是唯一会真删数据的操作。
  const [busyUuid, setBusyUuid] = useState<string | null>(null);
  // 当前这次挂载的补发函数。「重试」要立即补发一次，而不是把记录放回队列后
  // 干等下一个 online 事件——root layout 不会因导航重挂，在线时那个事件
  // 可能整个会话都不会来。
  const flushRef = useRef<(() => Promise<void>) | null>(null);

  const refresh = useCallback(async () => {
    try {
      setPendingCount((await listQueuedTransactions()).length);
      setFailed(await listFailedTransactions());
    } catch {
      // IndexedDB 不可用（隐私窗口）时没有队列可言，banner 保持不显示。
    }
  }, []);

  useEffect(() => {
    let flushing = false;

    async function handleOnline() {
      setOffline(false);
      if (!signedIn) {
        // 仍然刷新一次计数：未登录时用户也该看得见「还有 N 笔没同步」。
        await refresh();
        return;
      }

      // flushQueue 内部先读一次队列快照，再逐条提交后出队；两次调用若
      // 交叠，会各自读到还没被对方删掉的记录，重复提交同一条。提交本身
      // 靠 clientUuid 幂等，多数情况下"重复一次"本就无害；但两个并发
      // 事务都读不到对方尚未提交的插入时，较晚提交的那个会撞 client_uuid
      // 唯一约束报错。用这个标志把挂载时的补发和事件监听器的补发互斥，
      // 从根上消掉这个交叠窗口，而不是依赖幂等去兜底。
      if (flushing) return;
      flushing = true;
      try {
        // 动态 import：这个 banner 挂在 root layout 上，静态引入会把
        // server action 的模块图（含 postgres 客户端）拉进每个页面的
        // 客户端 bundle，导致所有路由渲染失败。
        const { createTransaction, createJournal } = await import('@/server/actions/transactions');
        await flushQueue((orgSlug, payload) =>
          payload.kind === 'journal'
            ? createJournal(orgSlug, payload)
            : createTransaction(orgSlug, payload),
        );
        // 不再用一个累计计数器表示「失败过多少条」：失败的记录现在留在
        // IndexedDB 里，从那里读才是唯一的真相。计数器与实际记录会因为
        // 用户的重试/丢弃而对不上，而对不上的那一方一定是计数器。
        await refresh();
      } catch {
        // IndexedDB 不可用或动态 import 失败（离线时 chunk 没缓存）：下次
        // online 事件再试，这里不能变成一个未处理的 rejection。
      } finally {
        flushing = false;
      }
    }

    function handleOffline() {
      setOffline(true);
    }

    function handleQueueChanged() {
      void refresh();
    }

    flushRef.current = handleOnline;

    setOffline(!navigator.onLine);
    void refresh();
    // 开着 wifi 关掉 PWA、第二天再打开：这段时间里不会有任何 'online'
    // 事件触发（连接从未断过），队列会一直摆在那儿直到网络碰巧掉线又
    // 恢复。挂载时如果已经在线，直接补发一次。
    if (navigator.onLine) {
      void handleOnline();
    }

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener(QUEUE_CHANGED_EVENT, handleQueueChanged);
    return () => {
      flushRef.current = null;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener(QUEUE_CHANGED_EVENT, handleQueueChanged);
    };
  }, [signedIn, refresh]);

  async function onRetry(clientUuid: string) {
    if (busyUuid) return;
    setBusyUuid(clientUuid);
    try {
      await retryFailedTransaction(clientUuid);
      await refresh();
      if (navigator.onLine) await flushRef.current?.();
    } finally {
      setBusyUuid(null);
    }
  }

  async function onDiscard(clientUuid: string) {
    if (busyUuid) return;
    setBusyUuid(clientUuid);
    try {
      await discardFailedTransaction(clientUuid);
      await refresh();
    } finally {
      setBusyUuid(null);
    }
  }

  if (!offline && pendingCount === 0 && failed.length === 0) return null;

  return (
    <div className="offline-banner">
      <div role="status" className="offline-banner-line">
        {offline ? <span>{t.common.offline}</span> : null}
        {pendingCount > 0 ? (
          <span>{t.common.pendingSync.replace('{count}', String(pendingCount))}</span>
        ) : null}
        {offline ? <span>{t.errors.offlineEditBlocked}</span> : null}
      </div>

      {failed.length > 0 ? (
        <div role="alert" className="offline-failed">
          <p className="offline-failed-title">
            {t.common.syncFailed.replace('{count}', String(failed.length))}
          </p>
          <ul className="offline-failed-list">
            {failed.map((item) => (
              <li key={item.clientUuid} className="offline-failed-item">
                <span className="offline-failed-detail">
                  <span className="offline-failed-date">{item.payload.occurredOn}</span>
                  {' · '}
                  <span className="offline-failed-amount">
                    {item.payload.amount}
                    {'currency' in item.payload && item.payload.currency
                      ? ` ${item.payload.currency}`
                      : ''}
                  </span>
                  {item.payload.description ? ` · ${item.payload.description}` : ''}
                </span>
                {item.failureMessage ? (
                  <span className="offline-failed-reason">{item.failureMessage}</span>
                ) : null}
                <span className="offline-failed-actions">
                  <button
                    type="button"
                    className="text-button"
                    disabled={busyUuid !== null}
                    onClick={() => void onRetry(item.clientUuid)}
                  >
                    {t.common.retry}
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busyUuid !== null}
                    onClick={() => void onDiscard(item.clientUuid)}
                  >
                    {t.common.discard}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
