'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { currencyExponent, parseDecimalToMinor } from '@/server/domain/money';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  getProject,
  insertProject,
  updateProject,
  setProjectStatus,
} from '@/server/repositories/projects';

const DATE_ONLY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format YYYY-MM-DD.');

/**
 * 预算有两种写法，故意都收：
 *
 *   budget      —— 十进制字符串（'1200.50'），**推荐**。按本位币的小数位解析。
 *   budgetMinor —— 已经是最小货币单位的整数字符串（'120050'），过渡期保留。
 *
 * 今天界面传的是后者，而且是自己在客户端算的：
 * `String(Math.round(parseFloat(budget) * 100))`（见 components/projects/
 * project-form.tsx 与 project-list.tsx）。那一句有两个问题，都不在本次改动
 * 范围内的文件里：
 *   - 硬编码两位小数。一家本位币为 JPY / VND / KRW 的公司（money.ts 的
 *     ZERO_DECIMAL_CURRENCIES）会把 150000 日元的预算记成 15,000,000 日元，
 *     整整一百倍，而账面上没有任何地方看得出来。
 *   - parseFloat + Math.round 是浮点，项目其余地方一律禁止。
 *
 * 所以这里加上 budget 这条路：小数位由 currencyExponent(baseCurrency) 决定，
 * 解析走 parseDecimalToMinor（多余的小数位抛错而不是截断）。前端迁过来之后
 * budgetMinor 就可以删掉。已在交付报告中列给前端。
 *
 * budgetMinor 这条路也不再是裸 BigInt()：原来的 `BigInt(input.budgetMinor)`
 * 遇到 '1200.50' 直接抛 SyntaxError，用户看到的是一句 JS 报错。
 */
const MINOR = z.string().regex(/^\d+$/, 'Enter the budget as a plain amount.');
const DECIMAL = z.string().min(1);

const projectFieldsSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  contactId: z.string().uuid().optional(),
  budget: DECIMAL.optional(),
  budgetMinor: MINOR.optional(),
  startDate: DATE_ONLY.optional(),
  endDate: DATE_ONLY.optional(),
});

const createProjectSchema = projectFieldsSchema.refine(
  (value) => !(value.startDate && value.endDate) || value.startDate <= value.endDate,
  { message: 'The start date must be on or before the end date.' },
);

const updateProjectSchema = projectFieldsSchema.partial().refine(
  (value) => !(value.startDate && value.endDate) || value.startDate <= value.endDate,
  { message: 'The start date must be on or before the end date.' },
);

const PROJECT_STATUSES = ['active', 'completed', 'cancelled'] as const;

/** 两种写法解析成同一个 bigint；两个都给就以十进制那个为准（它是要留下的那条路）。 */
function budgetToMinor(
  fields: { budget?: string; budgetMinor?: string },
  baseCurrency: string,
): bigint | undefined {
  if (fields.budget !== undefined && fields.budget !== '') {
    return parseDecimalToMinor(fields.budget, currencyExponent(baseCurrency));
  }
  if (fields.budgetMinor !== undefined && fields.budgetMinor !== '') {
    return BigInt(fields.budgetMinor);
  }
  return undefined;
}

export async function createProject(
  orgSlug: string,
  input: z.input<typeof createProjectSchema>,
): Promise<{ id: string }> {
  const context = await requirePermission(orgSlug, 'account:manage');
  const parsed = createProjectSchema.parse(input);
  const budgetMinor = budgetToMinor(parsed, context.baseCurrency);

  const result = await withTransaction(context.userId, async (tx) => {
    const { id } = await insertProject(tx, {
      organizationId: context.organizationId,
      name: parsed.name,
      description: parsed.description,
      contactId: parsed.contactId,
      budgetMinor,
      startDate: parsed.startDate,
      endDate: parsed.endDate,
    });

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'project.created',
      entityType: 'project',
      entityId: id,
      after: {
        name: parsed.name,
        contactId: parsed.contactId ?? null,
        // bigint 不能直接进 JSON，统一转字符串（同 postJournal）。原来这里
        // 直接把 input 整个塞进去，里面的 budgetMinor 还是用户传来的原始字符串
        // ——审计留下的不是落库的那个数。
        budgetMinor: budgetMinor?.toString() ?? null,
        startDate: parsed.startDate ?? null,
        endDate: parsed.endDate ?? null,
      },
    });

    return { id };
  });

  revalidatePath(`/${orgSlug}/projects`);
  return result;
}

export async function updateProjectAction(
  orgSlug: string,
  id: string,
  input: z.input<typeof updateProjectSchema>,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');
  const parsed = updateProjectSchema.parse(input);
  const budgetMinor = budgetToMinor(parsed, context.baseCurrency);

  await withTransaction(context.userId, async (tx) => {
    const before = await getProject(tx, context.organizationId, id);
    if (!before) throw new Error('Project not found.');

    await updateProject(tx, context.organizationId, id, {
      name: parsed.name,
      description: parsed.description,
      contactId: parsed.contactId,
      budgetMinor,
      startDate: parsed.startDate,
      endDate: parsed.endDate,
    });

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'project.updated',
      entityType: 'project',
      entityId: id,
      before: {
        name: before.name,
        contactId: before.contactId,
        budgetMinor: before.budgetMinor?.toString() ?? null,
        startDate: before.startDate,
        endDate: before.endDate,
      },
      after: {
        name: parsed.name ?? before.name,
        contactId: parsed.contactId ?? null,
        budgetMinor: budgetMinor?.toString() ?? null,
        startDate: parsed.startDate ?? null,
        endDate: parsed.endDate ?? null,
      },
    });
  });

  revalidatePath(`/${orgSlug}/projects`);
  revalidatePath(`/${orgSlug}/projects/${id}`);
}

export async function setProjectStatusAction(
  orgSlug: string,
  id: string,
  status: (typeof PROJECT_STATUSES)[number],
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');
  const parsedStatus = z.enum(PROJECT_STATUSES).parse(status);

  await withTransaction(context.userId, async (tx) => {
    const before = await getProject(tx, context.organizationId, id);
    if (!before) throw new Error('Project not found.');

    await setProjectStatus(tx, context.organizationId, id, parsedStatus);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'project.status_changed',
      entityType: 'project',
      entityId: id,
      before: { status: before.status },
      after: { status: parsedStatus },
    });
  });

  revalidatePath(`/${orgSlug}/projects`);
  revalidatePath(`/${orgSlug}/projects/${id}`);
}
