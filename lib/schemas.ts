import { z } from 'zod';

// 每个字段的失败文案都是写给一个不懂会计、也不知道 uuid 是什么的小店主看的。
// zod 的默认文案（'Invalid uuid'、'String must contain at least 1 character(s)'）
// 会原样出现在表单上——这些 schema 现在真的跑在生产路径上了，默认文案不再
// 只是测试里的字符串。
const uuid = z.string().uuid('Pick one of the options in the list.');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format YYYY-MM-DD.');
const currency = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z]{3}$/.test(value), 'Expected a 3-letter currency code');
const positiveAmount = z
  .string()
  .trim()
  .min(1, 'Enter an amount.')
  .refine(
    (value) => /^\d{1,3}(,\d{3})*(\.\d+)?$|^\d+(\.\d+)?$/.test(value),
    'Enter the amount as a plain number, for example 1200.50',
  )
  // 判「大于零」不经 Number()。上一版写的是 Number(value.replace(/,/g,'')) > 0，
  // 那是这份仓库里唯一一处拿浮点碰金额的地方；虽然只用来比大小、暂时看不出
  // 差错，但它给「金额可以先变成 number」开了个口子，而这正是本仓库反复付
  // 代价修掉的那类 bug 的起点。走到这一步时串里只剩数字、逗号和一个小数点，
  // 于是「大于零」等价于「存在一个 1-9 的数字」——纯字符串判断，位数再多也准。
  .refine((value) => /[1-9]/.test(value), 'Transaction amount must be greater than zero.');
const nonEmpty = z.string().trim().min(1, 'This cannot be left blank.');
const bilingualName = z
  .object({
    nameEn: z.string().trim().max(80).optional(),
    nameZh: z.string().trim().max(80).optional(),
  })
  .refine((value) => Boolean(value.nameEn || value.nameZh), {
    message: 'Provide a name in at least one language',
  });

export const localeSchema = z.enum(['en', 'zh']);
export const inviteRoleSchema = z.enum(['admin', 'bookkeeper', 'viewer']);

export const createOrgSchema = z.object({
  name: nonEmpty.max(120),
  baseCurrency: currency,
  timezone: nonEmpty.max(60),
  industry: z.string().trim().max(60).optional(),
});

/**
 * 财年起始月，1–12。
 *
 * 用 coerce 是因为它唯一的来源是 <select>，而表单里一切都是字符串。
 * 不接受小数、不接受 13：数据库上有同样的 CHECK
 * （organizations_fiscal_year_start_month_valid，见 0024 迁移），这里挡一遍
 * 是为了让用户读到一句人话而不是裸的约束报错。
 */
const fiscalYearStartMonth = z.coerce
  .number()
  .int('Pick one of the months in the list.')
  .min(1, 'Pick one of the months in the list.')
  .max(12, 'Pick one of the months in the list.');

export const updateOrgSchema = z.object({
  name: nonEmpty.max(120),
  timezone: nonEmpty.max(60),
  industry: z.string().trim().max(60).optional(),
  fiscalYearStartMonth,
});

/**
 * 年结与撤销年结。
 *
 * periodStart 是幂等键（fiscal_year_closings 的唯一约束建在它上面），
 * 由服务端按财年起始月算出来再交给表单，不是用户手填的——但它会经由表单
 * 回到服务端，所以仍然要校验格式。真正的防线是服务端拿到之后**重新**算
 * 一遍财年并比对：见 server/actions/year_end.ts。
 */
export const closeFiscalYearSchema = z.object({
  periodStart: isoDate,
});

export const undoFiscalYearCloseSchema = z.object({
  closingId: uuid,
  reason: nonEmpty.max(300, 'Keep the reason under 300 characters.'),
});

export const periodLockSchema = z.object({
  lockedUntil: isoDate.nullable(),
});

export const inviteMemberSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .transform((value) => value.toLowerCase()),
  role: inviteRoleSchema,
});

export const memberRoleSchema = z.object({
  membershipId: uuid,
  role: inviteRoleSchema,
});

/**
 * 新建科目。
 *
 * code 是 optional，而这**不是**放宽约束——是把 schema 对齐到它真正要守的
 * 那个入口。createAccount / createMoneyAccount 从来不收编码：编码由
 * nextAvailableCode 从名字派生（server/repositories/accounts.ts），派生出来的
 * 串按构造就只含小写字母、数字和横线。当初这里写成必填，正是这个 schema
 * 十个月来一次都没被调用过的原因之一——填上去就没有任何 action 能通过。
 *
 * 但只要有人真的传了 code（比如将来开放自定义编码，或者从别的系统导入
 * 科目表），那条正则一个字都没松：ISO 那种带空格或斜杠的编码照样被拒，
 * 因为编码会进 (organization_id, code) 唯一索引，也会出现在导出的报表里。
 */
export const accountSchema = bilingualName.and(
  z.object({
    type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
    isMoneyAccount: z.boolean().default(false),
    code: z
      .string()
      .trim()
      .regex(/^[0-9A-Za-z-]{1,20}$/, 'An account code can only use letters, digits or dashes.')
      .optional(),
  }),
);

export const categorySchema = bilingualName.and(
  z.object({
    kind: z.enum(['income', 'expense']),
    accountId: uuid,
  }),
);

/**
 * 改名只动名字，不动科目类型、编码或分类归属。
 * 与 accountSchema / categorySchema 区别：后者用于创建时的完整校验，
 * 此 schema 专门用于改名 Action。
 */
export const renameSchema = z
  .object({
    nameEn: z.string().trim().max(80).optional(),
    nameZh: z.string().trim().max(80).optional(),
  })
  .refine((v) => Boolean(v.nameEn?.length || v.nameZh?.length), {
    message: 'At least one name is required.',
    path: ['nameEn'],
  });

const transactionBase = z.object({
  occurredOn: isoDate,
  amount: positiveAmount,
  currency,
  moneyAccountId: uuid,
  categoryId: uuid.optional(),
  counterAccountId: uuid.optional(),
  /**
   * 交易归属的项目，可选。
   *
   * transactions.project_id 这一列 0009 就加了，projects 的盈亏分析一直在
   * 按它聚合——但在此之前**入参里根本没有这个字段**，没有任何地方给它写过
   * 值，所以那份报表算出来的恒定是零。查询侧写对了，写入侧从来没接上。
   *
   * 归属校验（这个项目属不属于本公司）在 server/posting/insert.ts 里，
   * 与科目走同一条规矩：外键只保证那一行存在，不保证属于哪家公司。
   */
  projectId: uuid.optional(),
  description: z.string().trim().max(500).default(''),
  exchangeRate: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,8})?$/, 'Expected a positive rate')
    .optional(),
});

/** 收支必须有分类且不能有对方账户；转账相反。 */
function refineKindShape<T extends z.ZodTypeAny>(schema: T) {
  return schema.superRefine((value: z.infer<T>, ctx) => {
    const data = value as {
      kind: 'income' | 'expense' | 'transfer';
      moneyAccountId: string;
      categoryId?: string;
      counterAccountId?: string;
    };

    if (data.kind === 'transfer') {
      if (!data.counterAccountId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['counterAccountId'],
          message: 'Choose the account to transfer into',
        });
      }
      if (data.categoryId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['categoryId'],
          message: 'A transfer does not take a category',
        });
      }
      if (data.counterAccountId && data.counterAccountId === data.moneyAccountId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['counterAccountId'],
          message: 'Pick two different accounts',
        });
      }
      return;
    }

    if (!data.categoryId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['categoryId'],
        message: 'Choose a category',
      });
    }
    if (data.counterAccountId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['counterAccountId'],
        message: 'Only transfers use a second account',
      });
    }
  });
}

export const createTransactionSchema = refineKindShape(
  transactionBase.extend({
    kind: z.enum(['income', 'expense', 'transfer']),
    clientUuid: uuid,
  }),
);

export const updateTransactionSchema = refineKindShape(
  transactionBase.extend({
    id: uuid,
    kind: z.enum(['income', 'expense', 'transfer']),
  }),
);

export const voidTransactionSchema = z.object({
  id: uuid,
  reason: z
    .string()
    .trim()
    .min(1, 'Voiding a record needs a reason.')
    .max(300, 'Keep the reason under 300 characters.'),
});

export const transactionFilterSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  kind: z.enum(['income', 'expense', 'transfer']).optional(),
  categoryId: uuid.optional(),
  moneyAccountId: uuid.optional(),
  createdBy: uuid.optional(),
  minAmount: positiveAmount.optional(),
  maxAmount: positiveAmount.optional(),
  keyword: z.string().trim().max(120).optional(),
  includeVoided: z.boolean().default(false),
  page: z.coerce.number().int().min(1).default(1),
});

export const exportSchema = z
  .object({
    kind: z.enum(['transaction-detail', 'account-summary']),
    format: z.enum(['csv', 'xlsx']),
    from: isoDate,
    to: isoDate,
    locale: localeSchema,
    includeVoided: z.boolean().default(false),
    categoryId: uuid.optional(),
    moneyAccountId: uuid.optional(),
    createdBy: uuid.optional(),
    keyword: z.string().trim().max(200).optional(),
  })
  .refine((v) => v.from <= v.to, {
    message: 'The start date must not be after the end date.',
    path: ['from'],
  });

export const profileSchema = z.object({
  displayName: nonEmpty.max(80),
  locale: localeSchema,
});

export const signUpSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(72),
  displayName: z.string().trim().min(1).max(80),
  locale: localeSchema,
});

export const signInSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(72),
});

/**
 * 改密码走的是另一条路：signUpSchema 只在注册表单上跑，
 * /reset-password 与 /account 的改密码框一个字都不经过它。
 * 长度上限 72 不是随便挑的——bcrypt 只看前 72 字节，Supabase 对更长的
 * 密码会直接报错，在这里先拦住比让用户猜 Supabase 的英文报错强。
 */
export const newPasswordSchema = z
  .string()
  .min(8, 'Your new password needs at least 8 characters.')
  .max(72, 'Your new password can be at most 72 characters.');

/** 找回密码只需要一个长得像邮箱的串。 */
export const resetRequestSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('That does not look like an email address.');

export const recurringFrequencySchema = z.enum([
  'daily',
  'weekly',
  'monthly',
  'quarterly',
  'yearly',
]);

/**
 * editRecurring 的入参白名单。
 *
 * `.strict()` 是这条 schema 存在的全部理由。updateRecurring 过去用
 * Object.entries(fields) 把**任意** key 驼峰转下划线当列名写进 SQL，而
 * RecurringEditFields 只是个 TypeScript 类型——运行时它不存在，Server Action
 * 收到的是网络上的任意 JSON。于是 `{ nextDueDate: '2020-01-01' }` 会把到期日
 * 推回六年前，下一次补记一口气生成几十上百笔分录（每期一个新 clientUuid，
 * 幂等拦不住，借贷还完全配平）；`{ organizationId: ... }` 更是直接把规则搬到
 * 别人公司名下。
 *
 * 所以这里不是「顺手校验一下类型」，而是「把能写的列穷举出来」。仓库层
 * （server/repositories/recurring.ts）另有一份显式白名单，两道都要：这一道
 * 给用户一句读得懂的话，那一道保证就算有人绕过这里也写不进未列出的列。
 *
 * nextDueDate 刻意不在列表里——它是补记游标，只能由 catchUpRule 推进。
 */
export const recurringEditSchema = z
  .object({
    description: z.string().trim().max(500).optional(),
    amount: positiveAmount.optional(),
    currency: currency.optional(),
    debitAccountId: uuid.optional(),
    creditAccountId: uuid.optional(),
    categoryId: uuid.optional(),
    frequency: recurringFrequencySchema.optional(),
    interval: z.number().int().min(1, 'How often this repeats must be at least 1.').optional(),
    startDate: isoDate.optional(),
    endDate: isoDate.nullable().optional(),
  })
  .strict();

/**
 * 字段名 -> 用户在界面上看到的那个词。
 *
 * 只收录「光看文案分不出说的是哪一格」的字段。amount、reason、nameEn 这些
 * 的文案本身已经点名了（'Transaction amount must be greater than zero.'），
 * 再缀一个 (amount) 只是噪音；而三个 uuid 字段共用同一句
 * 'Pick one of the options in the list.'，不点名就等于没说。
 *
 * id / clientUuid 故意不在表里：它们不是用户填的，出现在文案里只会让人
 * 以为自己哪儿填错了。
 */
const FIELD_LABELS: Record<string, string> = {
  occurredOn: 'date',
  moneyAccountId: 'account',
  counterAccountId: 'other account',
  categoryId: 'category',
  projectId: 'project',
  debitAccountId: 'debit account',
  creditAccountId: 'credit account',
  accountId: 'account',
  currency: 'currency',
  exchangeRate: 'exchange rate',
  startDate: 'start date',
  endDate: 'end date',
  frequency: 'how often it repeats',
  interval: 'how often it repeats',
  code: 'account code',
  type: 'account type',
  membershipId: 'member',
};

/**
 * 把一个 ZodError 压成一句话。
 *
 * 为什么不直接把 ZodError 抛出去：它的 message 是 issues 数组的 JSON
 * 字符串，长这样——
 *   [{"code":"invalid_string","validation":"uuid","path":["moneyAccountId"],...}]
 * 而 Server Action 抛出的错误，message 会被组件原样贴到表单上（见
 * components/transaction/transaction-form.tsx 的 catch）。让一个小店主对着
 * 一坨 JSON 猜自己哪儿填错了，等于没有校验。
 *
 * 只取第一条：一次说清一件事。表单是逐个字段改的，把五条堆在一起反而
 * 没人读。
 */
export function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Some of the details are not valid.';

  const field = issue.path.filter((part) => typeof part === 'string').join('.');
  const label = FIELD_LABELS[field];

  return label ? `${issue.message} (${label})` : issue.message;
}

/**
 * 校验入参，失败时抛出调用方自己的错误类型。
 *
 * 错误类型由调用方传进来而不是在这里硬编码，是因为 lib/ 不该 import
 * server/domain/：这个文件也会被客户端组件加载（表单在提交前用同一套
 * schema 先验一遍），把 LedgerError 拖进来就等于把整条 domain 依赖链
 * 打进浏览器包。
 */
export function parseOrThrow<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
  toError: (message: string) => Error,
): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw toError(firstIssueMessage(result.error));
  }
  return result.data;
}
