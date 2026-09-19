import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'teyo-offline';
/**
 * v1 -> v2：队列项多了 attempts / failedAt / failureMessage 三个字段。
 *
 * 不需要迁移既有记录：它们读出来时这三个字段是 undefined，而下面所有
 * 判断都写成「undefined 视为 0 / 未失败」。一条 v1 时代排在队里的交易
 * 升级后照样会被补发——这一点很重要，因为 v1 的队列里躺着的正是用户
 * 在没网的地方录下、还没同步上去的账。
 */
const DB_VERSION = 2;
const STORE = 'pending-transactions';

/**
 * 同一条记录最多尝试几次之后停止自动重试。
 *
 * 这个上限存在的理由是「队列不能被一条永远同步不上去的记录堵死」，
 * 不是「超过次数就可以把它删掉」——见 markFailed 的注释。
 */
export const MAX_SYNC_ATTEMPTS = 5;

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
  /** 已经尝试同步过多少次。undefined 等同于 0（v1 时代写入的记录）。 */
  attempts?: number;
  /** 被判定为「自动同步已放弃」的时刻。有值即不再参与 flush。 */
  failedAt?: number;
  /** 放弃时那一次的错误信息，原样展示给用户，供他判断该怎么补录。 */
  failureMessage?: string;
  /**
   * 还在重试的记录上，最近一次失败说了什么。
   *
   * 与 failureMessage 分成两个字段而不是复用一个：failureMessage 的含义是
   * 「这条记录为什么被放弃」，是给用户看的最终结论；这个字段是过程信息，
   * 一条正在重试的记录不该显示得像是已经失败了。
   */
  lastFailureMessage?: string;
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
    attempts: 0,
  } satisfies QueuedTransaction);
}

async function readAll(): Promise<QueuedTransaction[]> {
  const db = await getDb();
  const all = (await db.getAllFromIndex(STORE, 'queuedAt')) as QueuedTransaction[];
  // queuedAt 是毫秒级时间戳，连续调用可能撞到同一毫秒，此时
  // clientUuid 的字典序是稳定的后备排法。
  all.sort((a, b) => a.queuedAt - b.queuedAt || a.clientUuid.localeCompare(b.clientUuid));
  return all;
}

/** 仍在等待自动同步的记录。已放弃的不在其中——它们由 listFailedTransactions 单列。 */
export async function listQueuedTransactions(): Promise<QueuedTransaction[]> {
  return (await readAll()).filter((item) => item.failedAt === undefined);
}

/**
 * 自动同步已放弃、等着用户处理的记录。
 *
 * 这个列表是本次改动的核心。在它存在之前，一条同步不上去的记录会被
 * removeQueuedTransaction **直接从 IndexedDB 删掉**，用户只得到一个
 * 「N 条失败」的数字——他在店里站着录下的那笔账，金额、日期、对方、
 * 备注，全部没了，只能凭记忆重录。那是用户的数据，不是缓存。
 */
export async function listFailedTransactions(): Promise<QueuedTransaction[]> {
  return (await readAll()).filter((item) => item.failedAt !== undefined);
}

export async function removeQueuedTransaction(clientUuid: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE, clientUuid);
}

/**
 * 用户看过之后主动丢弃一条已放弃的记录。
 *
 * 只有这个函数会因为「同步失败」而真的删除数据，而它必须由用户点出来。
 * 自动流程一律不删——见 listFailedTransactions 的注释。
 */
export async function discardFailedTransaction(clientUuid: string): Promise<void> {
  await removeQueuedTransaction(clientUuid);
}

/** 用户改完问题后把一条已放弃的记录放回队列重试。 */
export async function retryFailedTransaction(clientUuid: string): Promise<void> {
  const db = await getDb();
  const item = (await db.get(STORE, clientUuid)) as QueuedTransaction | undefined;
  if (!item) return;
  await db.put(STORE, {
    ...item,
    attempts: 0,
    failedAt: undefined,
    failureMessage: undefined,
  } satisfies QueuedTransaction);
}

async function saveAttempt(
  item: QueuedTransaction,
  patch: Partial<QueuedTransaction>,
): Promise<void> {
  const db = await getDb();
  await db.put(STORE, { ...item, ...patch } satisfies QueuedTransaction);
}

/**
 * 这次失败是「请求根本没到服务端」吗。
 *
 * 这里原来是一个按错误文案分类的函数 isRetriable：匹配 network/fetch/
 * timeout/502/503 的算可重试，**其余一律当成校验失败并把记录删掉**。
 * 那个设计有两个问题，第二个是致命的：
 *
 *   1. 文案是会变的。领域层实际会说出口的话有几十种（「records need a
 *      category」「A bill needs at least one item」「This date falls in a
 *      locked period」…），每加一个单据模块就多几句。一份靠正则去猜的
 *      清单永远追不上，而追不上的后果不是少提示一句，是删数据。
 *   2. 生产构建下根本没有文案可匹配。Next.js 会把 Server Action 里未捕获
 *      的异常替换成一条对所有服务端错误都一样的脱敏摘要加一个 digest，
 *      客户端拿不到 LedgerError 的原文。于是线上每一个服务端错误都落进
 *      「其余」那一支——包括会话过期。真实场景：离线录了三笔，会话在这
 *      期间过期，重新联网时 OfflineBanner（挂在 root layout 上，登录页
 *      也会挂载）把三笔全提交一遍，三次权限错误，三条记录被永久删除。
 *
 * 换成一个结构性的判断，不依赖任何文案，且在开发与生产环境行为一致：
 * fetch 在请求发不出去时抛的是 TypeError（DNS 失败、离线、连接被拒、
 * CORS 被挡），而服务端**回了**一个错误时，抛出来的是普通 Error。
 * 前者说明「这次没连上」，重试完全可能成功，不该记一次尝试；后者说明
 * 服务端确实处理了并且拒绝了，记一次。
 *
 * 判不准的余量由 MAX_SYNC_ATTEMPTS 兜住，而不是靠删除。
 *
 * 导出是因为录入表单要回答同一个问题：这次保存失败该不该转入离线队列。
 * 答案必须和 flushQueue 用的是同一条判断——表单那边原来调的是已删除的
 * isRetriable，两处各有一份「什么算网络错误」的定义，而它们本来就该是
 * 同一个定义。服务端明确回了一个错误（金额非法、期间已封账）时不该悄悄
 * 排进队列：那会让用户看到「已离线保存」，然后这笔账在后台反复失败。
 */
export function neverReachedServer(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  // 浏览器离线时有些实现会抛 DOMException 'NetworkError'，一并算上。
  return error instanceof DOMException && error.name === 'NetworkError';
}

/**
 * sent：成功同步并已出队。
 * failed：自动同步已放弃，**记录仍在本地**，等用户处理（见 listFailedTransactions）。
 * retrying：这次没成，仍在队列里等下次 flush；pendingCount 已经如实反映这部分。
 */
export async function flushQueue(
  submit: (orgSlug: string, payload: QueuedPayload) => Promise<unknown>,
): Promise<{ sent: number; failed: number; retrying: number }> {
  const queued = await listQueuedTransactions();
  let sent = 0;
  let failed = 0;
  let retrying = 0;

  for (const item of queued) {
    try {
      await submit(item.orgSlug, item.payload);
      await removeQueuedTransaction(item.clientUuid);
      sent += 1;
      continue;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (neverReachedServer(error)) {
        // 没连上。原样留在队列里，不计次数——否则在信号不好的仓库里
        // 待一会儿，就足以把所有待同步的记录推到放弃线上。
        retrying += 1;
        continue;
      }

      // 服务端回了一个错误。可能是这条记录本身不合法（期间已封账、
      // 缺分类），也可能是会话过期这类会自己好转的状况——这两者在生产
      // 环境下长得一模一样，所以这里不去区分，只数次数。
      const attempts = (item.attempts ?? 0) + 1;
      if (attempts >= MAX_SYNC_ATTEMPTS) {
        await saveAttempt(item, { attempts, failedAt: Date.now(), failureMessage: message });
        failed += 1;
      } else {
        await saveAttempt(item, { attempts, lastFailureMessage: message });
        retrying += 1;
      }
    }
  }

  return { sent, failed, retrying };
}
