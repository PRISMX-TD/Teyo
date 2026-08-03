import { z } from 'zod';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const currency = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z]{3}$/.test(value), 'Expected a 3-letter currency code');
const positiveAmount = z
  .string()
  .trim()
  .min(1)
  .refine((value) => /^\d{1,3}(,\d{3})*(\.\d+)?$|^\d+(\.\d+)?$/.test(value), 'Expected a number')
  .refine((value) => Number(value.replace(/,/g, '')) > 0, 'Amount must be greater than zero');
const nonEmpty = z.string().trim().min(1);
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

export const updateOrgSchema = z.object({
  name: nonEmpty.max(120),
  timezone: nonEmpty.max(60),
  industry: z.string().trim().max(60).optional(),
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

export const accountSchema = bilingualName.and(
  z.object({
    type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
    isMoneyAccount: z.boolean().default(false),
    code: z
      .string()
      .trim()
      .regex(/^[0-9A-Za-z-]{1,20}$/, 'Use letters, digits or dashes'),
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
  reason: nonEmpty.max(300),
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
