import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'teyo-offline';
const DB_VERSION = 1;
const STORE = 'pending-transactions';

export type QueuedTransactionPayload = {
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

/**
 * "不确定" 场景走 createJournal，不是 createTransaction：借贷两个科目，
 * 不带分类、不带资金账户/对方账户的区分。离线时它和其余三种场景享有
 * 同一个队列与同一套幂等保护，不应该是唯一一个悄悄丢单的入口。
 */
export type QueuedJournalPayload = {
  kind: 'journal';
  occurredOn: string;
  amount: string;
  currency?: string;
  debitAccountId: string;
  creditAccountId: string;
  description: string;
  clientUuid: string;
};

export type QueuedPayload = QueuedTransactionPayload | QueuedJournalPayload;

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

/**
 * sent：成功同步并已出队。
 * dropped：校验类错误，已出队，这条记录真的丢了——调用方必须单独告知用户，
 *   不能和 retrying 合并成一个数字，否则会把"稍后自动重试"和"永久丢失，
 *   需要手动补录"混为一谈，害用户重复录入。
 * retrying：网络类错误，仍在队列里等下次 flush；pendingCount 已经如实
 *   反映这部分，调用方不需要为它再单独提示。
 */
export async function flushQueue(
  submit: (orgSlug: string, payload: QueuedPayload) => Promise<unknown>,
): Promise<{ sent: number; dropped: number; retrying: number }> {
  const queued = await listQueuedTransactions();
  let sent = 0;
  let dropped = 0;
  let retrying = 0;

  for (const item of queued) {
    try {
      await submit(item.orgSlug, item.payload);
      await removeQueuedTransaction(item.clientUuid);
      sent += 1;
    } catch (error) {
      if (isRetriable(error)) {
        retrying += 1;
      } else {
        dropped += 1;
        await removeQueuedTransaction(item.clientUuid);
      }
    }
  }

  return { sent, dropped, retrying };
}
