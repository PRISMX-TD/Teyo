import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  discardFailedTransaction,
  enqueueOfflineTransaction,
  flushQueue,
  listFailedTransactions,
  listQueuedTransactions,
  MAX_SYNC_ATTEMPTS,
  removeQueuedTransaction,
  retryFailedTransaction,
} from '@/lib/offline-queue';

function payload(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'expense' as const,
    occurredOn: '2026-08-01',
    amount: '25.00',
    currency: 'MYR',
    moneyAccountId: '00000000-0000-4000-8000-000000000001',
    categoryId: '00000000-0000-4000-8000-000000000002',
    description: 'Offline coffee',
    exchangeRate: '1',
    clientUuid: crypto.randomUUID(),
    ...overrides,
  };
}

// The "not sure" scenario posts through createJournal, not createTransaction:
// no moneyAccountId/categoryId, a debit/credit pair instead. It needs the
// same offline safety net as the other three kinds — this shape is what
// lets it actually fit in the queue.
function journalPayload(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'journal' as const,
    occurredOn: '2026-08-01',
    amount: '150.00',
    currency: 'MYR',
    debitAccountId: '00000000-0000-4000-8000-000000000003',
    creditAccountId: '00000000-0000-4000-8000-000000000004',
    description: 'Offline unsorted deposit',
    clientUuid: crypto.randomUUID(),
    ...overrides,
  };
}

/** 跑完一整轮直到这条记录被放弃。用来验证 MAX_SYNC_ATTEMPTS 真的是上限。 */
async function flushUntilGivenUp(
  submit: (orgSlug: string, p: unknown) => Promise<unknown>,
  rounds: number,
) {
  for (let i = 0; i < rounds; i += 1) {
    await flushQueue(submit as Parameters<typeof flushQueue>[0]);
  }
}

beforeEach(async () => {
  // 两个列表都要清：已放弃的记录不再出现在 listQueuedTransactions 里，
  // 只清前者会让上一个用例放弃掉的记录漏到下一个用例。
  for (const item of [...(await listQueuedTransactions()), ...(await listFailedTransactions())]) {
    await removeQueuedTransaction(item.clientUuid);
  }
});

describe('enqueueOfflineTransaction', () => {
  it('stores a record that can be read back', async () => {
    const data = payload();
    await enqueueOfflineTransaction('acme', data);

    const queued = await listQueuedTransactions();
    expect(queued).toHaveLength(1);
    expect(queued[0].orgSlug).toBe('acme');
    expect(queued[0].payload.description).toBe('Offline coffee');
    expect(queued[0].clientUuid).toBe(data.clientUuid);
  });

  it('does not duplicate an entry with the same clientUuid', async () => {
    const data = payload();
    await enqueueOfflineTransaction('acme', data);
    await enqueueOfflineTransaction('acme', data);

    expect(await listQueuedTransactions()).toHaveLength(1);
  });

  it('keeps entries in the order they were queued', async () => {
    const first = payload({ description: 'First' });
    const second = payload({ description: 'Second' });
    await enqueueOfflineTransaction('acme', first);
    // 确保时间戳不撞在同一毫秒
    await new Promise((r) => setTimeout(r, 1));
    await enqueueOfflineTransaction('acme', second);

    const queued = await listQueuedTransactions();
    expect(queued.map((q) => q.payload.description)).toEqual(['First', 'Second']);
  });
});

describe('flushQueue', () => {
  it('submits every queued record and empties the queue', async () => {
    await enqueueOfflineTransaction('acme', payload({ description: 'One' }));
    await enqueueOfflineTransaction('acme', payload({ description: 'Two' }));

    const submit = vi.fn().mockResolvedValue({ id: 'x', deduplicated: false });
    const result = await flushQueue(submit);

    expect(submit).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ sent: 2, failed: 0, retrying: 0 });
    expect(await listQueuedTransactions()).toHaveLength(0);
  });

  it('passes the same clientUuid so the server can deduplicate', async () => {
    const data = payload();
    await enqueueOfflineTransaction('acme', data);

    const submit = vi.fn().mockResolvedValue({ id: 'x', deduplicated: true });
    await flushQueue(submit);

    expect(submit).toHaveBeenCalledWith(
      'acme',
      expect.objectContaining({ clientUuid: data.clientUuid }),
    );
  });

  it('keeps a network failure queued and reports it as retrying', async () => {
    await enqueueOfflineTransaction('acme', payload());

    const submit = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await flushQueue(submit);

    expect(result).toEqual({ sent: 0, failed: 0, retrying: 1 });
    expect(await listQueuedTransactions()).toHaveLength(1);
  });

  it('returns zeroes when the queue is empty', async () => {
    const submit = vi.fn();
    expect(await flushQueue(submit)).toEqual({ sent: 0, failed: 0, retrying: 0 });
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('a record is never destroyed by a failed sync', () => {
  /**
   * 这一组是这个模块存在的理由。
   *
   * 它原来的行为是：认不出是网络错误就判为「校验失败」，**把记录从
   * IndexedDB 删掉**，只留给用户一个「N 条失败」的数字。用户在店里站着
   * 录下的那笔账——金额、日期、对方、备注——全部没了，只能凭记忆重录。
   */
  it('keeps the record and its details after it is given up on', async () => {
    await enqueueOfflineTransaction('acme', payload({ description: 'Locked period entry' }));

    const submit = vi.fn().mockRejectedValue(new Error('This date falls in a locked period.'));
    await flushUntilGivenUp(submit, MAX_SYNC_ATTEMPTS);

    // 不在待同步队列里了（不会无限重试），但数据还在。
    expect(await listQueuedTransactions()).toHaveLength(0);

    const failed = await listFailedTransactions();
    expect(failed).toHaveLength(1);
    expect(failed[0].payload.description).toBe('Locked period entry');
    expect(failed[0].payload.amount).toBe('25.00');
    expect(failed[0].payload.occurredOn).toBe('2026-08-01');
    expect(failed[0].failureMessage).toMatch(/locked period/i);
  });

  it('does not give up on the very first server error', async () => {
    // 会话过期与「这笔账不合法」在生产环境下长得一模一样（Next.js 把两者
    // 都换成同一条脱敏摘要）。第一次就放弃，等于把前者也判了死刑。
    await enqueueOfflineTransaction('acme', payload());

    const submit = vi.fn().mockRejectedValue(
      new Error('An error occurred in the Server Components render. Digest: 1234567890'),
    );
    const result = await flushQueue(submit);

    expect(result).toEqual({ sent: 0, failed: 0, retrying: 1 });
    const queued = await listQueuedTransactions();
    expect(queued).toHaveLength(1);
    expect(queued[0].attempts).toBe(1);
    expect(await listFailedTransactions()).toHaveLength(0);
  });

  it('never counts an attempt when the request did not reach the server', async () => {
    // 在信号不好的仓库里待一会儿，不该把所有待同步的记录推到放弃线上。
    // fetch 连不上时抛的是 TypeError——这个判断是结构性的，不依赖文案，
    // 在生产构建下同样成立。
    await enqueueOfflineTransaction('acme', payload({ description: 'A' }));
    await enqueueOfflineTransaction('acme', payload({ description: 'B' }));

    const submit = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await flushUntilGivenUp(submit, MAX_SYNC_ATTEMPTS + 3);

    const queued = await listQueuedTransactions();
    expect(queued).toHaveLength(2);
    expect(queued.every((item) => (item.attempts ?? 0) === 0)).toBe(true);
    expect(await listFailedTransactions()).toHaveLength(0);
  });

  it('gives up only after MAX_SYNC_ATTEMPTS server errors', async () => {
    await enqueueOfflineTransaction('acme', payload({ description: 'Stuck' }));

    const submit = vi.fn().mockRejectedValue(new Error('rejected by the server'));

    // 最后一次之前都还在队列里。
    await flushUntilGivenUp(submit, MAX_SYNC_ATTEMPTS - 1);
    expect(await listQueuedTransactions()).toHaveLength(1);
    expect(await listFailedTransactions()).toHaveLength(0);

    await flushQueue(submit);
    expect(await listQueuedTransactions()).toHaveLength(0);
    const failed = await listFailedTransactions();
    expect(failed).toHaveLength(1);
    // 即便放弃了，数据仍然在。
    expect(failed[0].payload.amount).toBe('25.00');
  });

  it('continues with the remaining records after one fails', async () => {
    await enqueueOfflineTransaction('acme', payload({ description: 'Bad' }));
    await new Promise((r) => setTimeout(r, 1));
    await enqueueOfflineTransaction('acme', payload({ description: 'Good' }));

    const submit = vi
      .fn()
      .mockRejectedValueOnce(new Error('Income and expense records need a category.'))
      .mockResolvedValueOnce({ id: 'x', deduplicated: false });

    const result = await flushQueue(submit);

    expect(result).toEqual({ sent: 1, failed: 0, retrying: 1 });
    // 失败的那条还在队列里等下一轮，成功的那条走了。
    const queued = await listQueuedTransactions();
    expect(queued).toHaveLength(1);
    expect(queued[0].payload.description).toBe('Bad');
  });
});

describe('user-driven recovery', () => {
  async function oneRejectedRecord() {
    const data = payload({ description: 'Needs fixing' });
    await enqueueOfflineTransaction('acme', data);
    await flushUntilGivenUp(
      vi.fn().mockRejectedValue(new Error('This date falls in a locked period.')),
      MAX_SYNC_ATTEMPTS,
    );
    return data;
  }

  it('puts a failed record back in the queue on retry', async () => {
    const data = await oneRejectedRecord();

    await retryFailedTransaction(data.clientUuid);

    expect(await listFailedTransactions()).toHaveLength(0);
    const queued = await listQueuedTransactions();
    expect(queued).toHaveLength(1);
    // 次数归零，否则一次重试就直接撞上限。
    expect(queued[0].attempts).toBe(0);
    expect(queued[0].failureMessage).toBeUndefined();

    const submit = vi.fn().mockResolvedValue({ id: 'x' });
    expect(await flushQueue(submit)).toEqual({ sent: 1, failed: 0, retrying: 0 });
  });

  it('removes a failed record only when the user discards it', async () => {
    const data = await oneRejectedRecord();

    await discardFailedTransaction(data.clientUuid);

    expect(await listFailedTransactions()).toHaveLength(0);
    expect(await listQueuedTransactions()).toHaveLength(0);
  });
});

describe('journal payloads (the "not sure" scenario)', () => {
  it('can be queued and read back with their debit/credit shape intact', async () => {
    const data = journalPayload();
    await enqueueOfflineTransaction('acme', data);

    const queued = await listQueuedTransactions();
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toMatchObject({
      kind: 'journal',
      debitAccountId: data.debitAccountId,
      creditAccountId: data.creditAccountId,
    });
    // Never had a money/category split to begin with — confirms this isn't
    // a transaction payload wearing a 'journal' kind.
    expect(queued[0].payload).not.toHaveProperty('moneyAccountId');
    expect(queued[0].payload).not.toHaveProperty('categoryId');
  });

  it('flushes alongside ordinary transaction payloads in one queue', async () => {
    await enqueueOfflineTransaction('acme', payload({ description: 'Expense' }));
    await enqueueOfflineTransaction('acme', journalPayload({ description: 'Journal' }));

    const submit = vi.fn().mockResolvedValue({ id: 'x', deduplicated: false });
    const result = await flushQueue(submit);

    expect(result).toEqual({ sent: 2, failed: 0, retrying: 0 });
    expect(submit).toHaveBeenCalledWith('acme', expect.objectContaining({ kind: 'expense' }));
    expect(submit).toHaveBeenCalledWith('acme', expect.objectContaining({ kind: 'journal' }));
  });

  it('dedupes a replayed journal entry on its clientUuid like any other kind', async () => {
    const data = journalPayload();
    await enqueueOfflineTransaction('acme', data);

    const submit = vi.fn().mockResolvedValue({ id: 'x', deduplicated: true });
    await flushQueue(submit);

    expect(submit).toHaveBeenCalledWith(
      'acme',
      expect.objectContaining({ clientUuid: data.clientUuid }),
    );
  });
});
