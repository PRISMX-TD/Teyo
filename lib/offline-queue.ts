import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'teyo-offline';
const DB_VERSION = 1;
const STORE = 'pending-transactions';

export type QueuedPayload = {
  kind: 'income' | 'expense' | 'transfer';
  occurredOn: string;
  amount: string;
  currency: string;
  moneyAccountId: string;
  counterAccountId?: string;
  categoryId?: string;
  description: string;
  // 本币交易不带汇率字段（见 rate-field.tsx），留空让服务端按 source 'auto' 处理。
  exchangeRate?: string;
  rateSource?: 'auto' | 'manual';
  clientUuid: string;
};

export type QueuedTransaction = {
  clientUuid: string;
  orgSlug: string;
  payload: QueuedPayload;
  queuedAt: number;
};

export function isOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine;
}

async function getDb(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'clientUuid' });
        store.createIndex('queuedAt', 'queuedAt');
      }
    },
  });
}

export async function enqueueOfflineTransaction(
  orgSlug: string,
  payload: QueuedPayload,
): Promise<void> {
  const db = await getDb();
  // keyPath 是 clientUuid，put 天然幂等
  await db.put(STORE, {
    clientUuid: payload.clientUuid,
    orgSlug,
    payload,
    queuedAt: Date.now(),
  } satisfies QueuedTransaction);
}

export async function listQueuedTransactions(): Promise<QueuedTransaction[]> {
  const db = await getDb();
  const all = (await db.getAllFromIndex(STORE, 'queuedAt')) as QueuedTransaction[];
  // queuedAt 是毫秒级时间戳，连续调用可能撞到同一毫秒，此时
  // clientUuid 的字典序是稳定的后备排法。
  all.sort((a, b) => a.queuedAt - b.queuedAt || a.clientUuid.localeCompare(b.clientUuid));
  return all;
}

export async function removeQueuedTransaction(clientUuid: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE, clientUuid);
}

/**
 * 网络类错误保留在队列里等下次重试；
 * 校验类错误（期间锁定、分类不匹配等）无论重试多少次都不会成功，必须出队，
 * 否则队列会被一条坏记录永久堵住。
 */
export function isRetriable(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const message = (error as Error)?.message ?? '';
  return /network|fetch|timeout|econnreset|503|502/i.test(message);
}

export async function flushQueue(
  submit: (orgSlug: string, payload: QueuedPayload) => Promise<unknown>,
): Promise<{ sent: number; failed: number }> {
  const queued = await listQueuedTransactions();
  let sent = 0;
  let failed = 0;

  for (const item of queued) {
    try {
      await submit(item.orgSlug, item.payload);
      await removeQueuedTransaction(item.clientUuid);
      sent += 1;
    } catch (error) {
      failed += 1;
      if (!isRetriable(error)) {
        await removeQueuedTransaction(item.clientUuid);
      }
    }
  }

  return { sent, failed };
}
