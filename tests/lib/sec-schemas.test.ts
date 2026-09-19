// lib/schemas.ts 里新增/改动的部分。
//
// 背景：createTransactionSchema / updateTransactionSchema /
// voidTransactionSchema / transactionFilterSchema / accountSchema 这五条
// schema 定义了十个月、被 tests/lib/schemas.test.ts 的 20 个用例证明「金额
// 不能为负」「科目编码只能含字母数字横线」，而生产路径上一条都不执行——
// 没有任何 action 调用过它们。这个文件测的是「接上去之后它们还得对」。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  accountSchema,
  createTransactionSchema,
  firstIssueMessage,
  parseOrThrow,
  recurringEditSchema,
  updateTransactionSchema,
} from '@/lib/schemas';

const UUID_A = '00000000-0000-4000-8000-000000000001';
const UUID_B = '00000000-0000-4000-8000-000000000002';

describe('accountSchema now matches what the actions actually receive', () => {
  /**
   * code 以前是必填，而 createAccount / createMoneyAccount 从来不收编码——
   * 编码由 nextAvailableCode 从名字派生。也就是说，这条 schema 当初就写成
   * 了「任何真实调用都过不了」的形状，这正是它十个月没被接上的原因之一。
   */
  it('accepts the shape createAccount really gets', () => {
    const result = accountSchema.safeParse({
      nameEn: 'Petty Cash',
      nameZh: '零用金',
      type: 'asset',
      isMoneyAccount: true,
    });
    expect(result.success).toBe(true);
  });

  it('still refuses a code with unsupported characters when one is supplied', () => {
    // 放宽的只是「必须给」，不是「给了也不查」。编码会进
    // (organization_id, code) 唯一索引，也会出现在导出的报表里。
    expect(accountSchema.safeParse({ nameEn: 'Cash', type: 'asset', code: '10 00' }).success).toBe(
      false,
    );
    expect(accountSchema.safeParse({ nameEn: 'Cash', type: 'asset', code: '1000' }).success).toBe(
      true,
    );
  });

  it('still refuses a nameless account and an invented account type', () => {
    expect(accountSchema.safeParse({ type: 'asset', isMoneyAccount: false }).success).toBe(false);
    expect(accountSchema.safeParse({ nameEn: 'X', type: 'Asset' }).success).toBe(false);
    expect(accountSchema.safeParse({ nameEn: 'X', type: 'contra' }).success).toBe(false);
  });
});

describe('the amount rule no longer runs a float', () => {
  const base = {
    kind: 'expense' as const,
    occurredOn: '2026-08-01',
    currency: 'MYR',
    moneyAccountId: UUID_A,
    categoryId: UUID_B,
    clientUuid: '00000000-0000-4000-8000-000000000003',
  };

  it('rejects zero and negative amounts, in the words the form shows', () => {
    for (const amount of ['0', '0.00', '0.000', '-5']) {
      const result = createTransactionSchema.safeParse({ ...base, amount });
      expect(result.success, amount).toBe(false);
    }
    const zero = createTransactionSchema.safeParse({ ...base, amount: '0.00' });
    expect(zero.success).toBe(false);
    if (!zero.success) {
      // 这句文案与 server/domain/ledger.ts 的那句一模一样，所以补上 schema
      // 校验之后，用户在记账表单上看到的话没有变——变的只是它现在更早出现。
      expect(firstIssueMessage(zero.error)).toMatch(/transaction amount must be greater than zero/i);
    }
  });

  it('accepts an amount with more digits than a double can hold', () => {
    // 旧实现是 Number(value.replace(/,/g, '')) > 0，本仓库唯一一处拿浮点
    // 碰金额的地方。这个数在 double 里已经不是它自己了。
    const result = createTransactionSchema.safeParse({ ...base, amount: '99999999999999.99' });
    expect(result.success).toBe(true);
  });
});

describe('updateTransactionSchema matches the shape updateTransaction builds', () => {
  const base = {
    id: UUID_A,
    kind: 'expense' as const,
    occurredOn: '2026-08-01',
    amount: '450.00',
    currency: 'MYR',
    moneyAccountId: UUID_B,
    categoryId: '00000000-0000-4000-8000-000000000003',
  };

  it('accepts an ordinary edit', () => {
    expect(updateTransactionSchema.safeParse(base).success).toBe(true);
  });

  it('drops the extra keys the form sends without complaining', () => {
    // 编辑表单复用新建表单的 payload，里面带着 clientUuid。多余的键该被
    // 剥掉而不是报错——报错的话每一次编辑都会失败。
    const parsed = updateTransactionSchema.parse({ ...base, clientUuid: UUID_A, junk: 1 });
    expect(parsed).not.toHaveProperty('clientUuid');
    expect(parsed).not.toHaveProperty('junk');
  });

  it('still enforces the income/expense/transfer shape rules', () => {
    // 收支必须有分类、不能有对方账户；转账相反。这些规则以前只有
    // resolveCounterAccountId 挡住一半（它不管转账是不是同时带了分类）。
    expect(updateTransactionSchema.safeParse({ ...base, categoryId: undefined }).success).toBe(
      false,
    );
    expect(
      updateTransactionSchema.safeParse({ ...base, kind: 'transfer', counterAccountId: UUID_A })
        .success,
    ).toBe(false); // transfer 不该带 categoryId
    expect(
      updateTransactionSchema.safeParse({
        ...base,
        kind: 'transfer',
        categoryId: undefined,
        counterAccountId: base.moneyAccountId,
      }).success,
    ).toBe(false); // 转给自己
  });
});

describe('recurringEditSchema is the mass-assignment gate', () => {
  /**
   * editRecurring 过去把整个网络 payload `...fields` 展开给 updateRecurring，
   * 而那个函数用 Object.entries(fields) 把任意 key 驼峰转下划线当列名写入。
   * RecurringEditFields 是 TypeScript 类型，运行时不存在。
   */
  it('refuses the next-due-date rewrite outright', () => {
    // 这一个是里面最贵的：到期日推回很早的日期，下一次补记就按每期一笔
    // 生成几十上百笔分录。每笔一个新 clientUuid（幂等拦不住），借贷完全
    // 配平（数据库的配平触发器也拦不住）。
    const result = recurringEditSchema.safeParse({ nextDueDate: '2020-01-01' });
    expect(result.success).toBe(false);
  });

  it('refuses every other column that is not the user to change', () => {
    for (const payload of [
      { organizationId: UUID_A },
      { isActive: true },
      { createdAt: '2020-01-01' },
      { id: UUID_A },
      { next_due_date: '2020-01-01' },
    ]) {
      expect(recurringEditSchema.safeParse(payload).success, JSON.stringify(payload)).toBe(false);
    }
  });

  it('accepts the fields the settings form really edits', () => {
    const result = recurringEditSchema.safeParse({
      description: 'Shop rent',
      amount: '1,200.00',
      currency: 'myr',
      frequency: 'monthly',
      interval: 1,
      startDate: '2026-01-01',
      endDate: null,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.currency).toBe('MYR');
  });

  it('refuses an interval of zero, which is the rule that never moves forward', () => {
    expect(recurringEditSchema.safeParse({ interval: 0 }).success).toBe(false);
    expect(recurringEditSchema.safeParse({ interval: -1 }).success).toBe(false);
    expect(recurringEditSchema.safeParse({ interval: 1.5 }).success).toBe(false);
  });
});

describe('parseOrThrow / firstIssueMessage', () => {
  class Boom extends Error {}

  it('throws the caller error type, carrying a sentence a shopkeeper can read', () => {
    // 裸 .parse() 抛出的 ZodError，message 是 issues 数组的 JSON——而组件会
    // 把它原样贴到表单上。让人对着一坨 JSON 猜哪儿填错了，等于没有校验。
    expect(() => parseOrThrow(z.object({ a: z.string() }), {}, (m) => new Boom(m))).toThrow(Boom);

    try {
      parseOrThrow(accountSchema, { type: 'asset' }, (m) => new Boom(m));
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as Error).message).toBe('Provide a name in at least one language');
      expect((error as Error).message).not.toMatch(/[[{]/);
    }
  });

  it('names the field only when the sentence alone would not identify it', () => {
    // 三个 uuid 字段共用同一句话，不点名等于没说。
    const missingAccount = createTransactionSchema.safeParse({
      kind: 'expense',
      occurredOn: '2026-08-01',
      amount: '10.00',
      currency: 'MYR',
      moneyAccountId: 'not-a-uuid',
      categoryId: UUID_B,
      clientUuid: UUID_A,
    });
    expect(missingAccount.success).toBe(false);
    if (!missingAccount.success) {
      expect(firstIssueMessage(missingAccount.error)).toBe(
        'Pick one of the options in the list. (account)',
      );
    }
  });
});
