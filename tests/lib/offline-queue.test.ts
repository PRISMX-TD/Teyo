import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enqueueOfflineTransaction,
  flushQueue,
  listQueuedTransactions,
  removeQueuedTransaction,
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

beforeEach(async () => {
  for (const item of await listQueuedTransactions()) {
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
    expect(result).toEqual({ sent: 2, failed: 0 });
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

  it('keeps a record queued when the failure looks like a network problem', async () => {
    await enqueueOfflineTransaction('acme', payload());

    const submit = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await flushQueue(submit);

    expect(result).toEqual({ sent: 0, failed: 1 });
    // 网络问题要保留，等下次联网重试
    expect(await listQueuedTransactions()).toHaveLength(1);
  });

  it('drops a record that the server rejects as invalid', async () => {
    await enqueueOfflineTransaction('acme', payload());

    const submit = vi.fn().mockRejectedValue(new Error('The books are locked for that date.'));
    const result = await flushQueue(submit);

    expect(result).toEqual({ sent: 0, failed: 1 });
    // 校验类错误重试多少次都不会成功，必须出队，否则永远卡住
    expect(await listQueuedTransactions()).toHaveLength(0);
  });

  it('continues with the remaining records after one fails', async () => {
    await enqueueOfflineTransaction('acme', payload({ description: 'Bad' }));
    await enqueueOfflineTransaction('acme', payload({ description: 'Good' }));

    const submit = vi
      .fn()
      .mockRejectedValueOnce(new Error('validation failed'))
      .mockResolvedValueOnce({ id: 'x', deduplicated: false });

    const result = await flushQueue(submit);

    expect(result).toEqual({ sent: 1, failed: 1 });
    expect(await listQueuedTransactions()).toHaveLength(0);
  });

  it('returns zeroes when the queue is empty', async () => {
    const submit = vi.fn();
    expect(await flushQueue(submit)).toEqual({ sent: 0, failed: 0 });
    expect(submit).not.toHaveBeenCalled();
  });
});
