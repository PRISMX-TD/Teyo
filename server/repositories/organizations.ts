import { randomUUID } from 'node:crypto';
import { cache } from 'react';
import type { Tx } from '@/server/db/transaction';
import { sql } from '@/server/db/client';
import {
  isInvoiceLocale,
  isInvoiceSignoff,
  type InvoiceLocale,
  type InvoiceSignoff,
} from '@/lib/invoice-options';

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base.length >= 3 ? base : `co-${base}`.replace(/-+$/g, '').slice(0, 40);
}

/**
 * 与 app/ 下顶层路由同名的 slug。公司的页面挂在 /[orgSlug]/ 下，而静态
 * 路由段优先于动态段——一家叫「Login」的公司拿到 slug `login` 之后，
 * /login 永远是登录页，它的所有页面都打不开。这些名字一律当作已被占用，
 * 走与重名相同的「加随机后缀」路径。
 *
 * 新增顶层路由（app/ 或 app/(auth)/ 下的目录、icon 这类元数据路由）时要
 * 同步加在这里；tests/repositories/organizations-slug.test.ts 会对照 app/
 * 目录检查有没有漏。
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'account',
  'api',
  'auth',
  'offline',
  'onboarding',
  'forgot-password',
  'invite',
  'login',
  'reset-password',
  'signup',
  'icon',
  'manifest',
  'favicon',
  'sw',
]);

/**
 * 用 app_slug_taken 而不是直接 `select ... from organizations where slug = ?`：
 * organizations_read 策略是 app_is_member(id)，在 teyo_app 角色下查不到别人的公司，
 * 会把已被占用的 slug 判为可用，插入时才撞上 unique 约束抛裸错误。
 * app_slug_taken 是 SECURITY DEFINER，只回布尔值。见 0004_slug_availability.sql。
 */
async function isTaken(tx: Tx, candidate: string): Promise<boolean> {
  if (RESERVED_SLUGS.has(candidate)) return true;
  const [row] = await tx`select app_slug_taken(${candidate}) as taken`;
  return row.taken === true;
}

export async function generateUniqueSlug(tx: Tx, name: string): Promise<string> {
  const base = slugify(name);

  if (!(await isTaken(tx, base))) return base;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `${base}-${Math.random().toString(36).slice(2, 7)}`;
    if (!(await isTaken(tx, candidate))) return candidate;
  }

  throw new Error('Could not generate a unique slug.');
}

/**
 * 主键在应用侧生成，刻意不用 `insert ... returning id`。
 *
 * Postgres 对 RETURNING 的行会额外施加 SELECT 策略检查，而 organizations_read 是
 * app_is_member(id)：建公司这一刻 owner 的 membership 还没写入，读检查必然失败，
 * 插入会以 "new row violates row-level security policy" 被拒。
 * 自己生成 uuid 就不需要把新行读回来，也不必为此放宽读策略。
 */
export async function insertOrganization(
  tx: Tx,
  input: {
    name: string;
    slug: string;
    baseCurrency: string;
    timezone: string;
    industry: string | null;
    createdBy: string;
  },
): Promise<string> {
  const id = randomUUID();
  await tx`
    insert into organizations (id, name, slug, base_currency, timezone, industry, created_by)
    values (${id}, ${input.name}, ${input.slug}, ${input.baseCurrency}, ${input.timezone},
            ${input.industry}, ${input.createdBy})
  `;
  return id;
}

export type OrganizationSettings = {
  name: string;
  timezone: string;
  industry: string | null;
  /** 开票方地址，印在发票单据上（0026 迁移加的列）。 */
  address: string | null;
  /**
   * 发票上的其余卖方资料（0034 迁移加的列），全部可空。
   * 只在「公司资料」页编辑、只在可打印发票上展示。
   */
  registrationNumber: string | null;
  taxNumber: string | null;
  phone: string | null;
  email: string | null;
  paymentDetails: string | null;
  /**
   * branding bucket 里的对象路径，不是 URL。私有 bucket，展示时由调用方
   * 换成短时效签名 URL。只由 setOrganizationLogoPath 写，不经设置表单。
   */
  logoPath: string | null;
  /**
   * 收款信息里的图片（0038），branding bucket 里的对象路径，按添加顺序。
   * 同 logoPath：不经设置表单，只由 addOrganizationPaymentImage /
   * removeOrganizationPaymentImage 写。
   */
  paymentImagePaths: string[];
  /** 发票的版式选项（0036），见 lib/invoice-options.ts。 */
  invoiceLocale: InvoiceLocale;
  invoiceSignoff: InvoiceSignoff;
  /** 税那一行的名称。null 即按发票语言印默认的「Tax / 税」。 */
  invoiceTaxLabel: string | null;
  /** 印在每张发票底部的条款或说明。 */
  invoiceFooter: string | null;
  /**
   * 财年起始月（1–12）。0024 迁移加的列，默认 1（日历年）。
   *
   * 读它的唯一原因是：报表默认区间、总账默认区间与年结的期间全都由它决定，
   * 而 OrgContext 里还没有这一列（那个文件不在本次改动范围内）。用一次
   * 独立查询换一个正确的财年，比把日历年硬编码在三个页面里便宜得多。
   */
  fiscalYearStartMonth: number;
};

/**
 * 公司设置。设置页此前**不回填任何一个字段**——表单上 name 是空的、
 * timezone 永远默认吉隆坡、industry 是空的，于是「只想改个行业」的用户
 * 一保存就把公司名清空了（updateOrgSchema 要求 name 非空，实际表现是一句
 * 校验错误，但时区会被静默改回吉隆坡）。有了这个函数，表单可以回填。
 */
export async function getOrganizationSettings(
  tx: Tx,
  organizationId: string,
): Promise<OrganizationSettings> {
  const rows = await tx`
    select name, timezone, industry, address, fiscal_year_start_month,
           registration_number, tax_number, phone, email, payment_details, logo_path,
           payment_image_paths,
           invoice_locale, invoice_signoff, invoice_tax_label, invoice_footer
    from organizations
    where id = ${organizationId}
  `;
  const row = rows.at(0);
  if (!row) {
    throw new Error(`Organization ${organizationId} not found.`);
  }
  return {
    name: row.name as string,
    timezone: (row.timezone as string | null) ?? 'UTC',
    industry: (row.industry as string | null) ?? null,
    address: (row.address as string | null) ?? null,
    registrationNumber: (row.registration_number as string | null) ?? null,
    taxNumber: (row.tax_number as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    paymentDetails: (row.payment_details as string | null) ?? null,
    logoPath: (row.logo_path as string | null) ?? null,
    paymentImagePaths: (row.payment_image_paths as string[] | null) ?? [],
    // 两列都有 CHECK；这里仍然兜一下，免得哪天 CHECK 被放宽、打印页拿到一个
    // 不认识的值而整页报错。
    invoiceLocale: isInvoiceLocale(row.invoice_locale) ? row.invoice_locale : 'en',
    invoiceSignoff: isInvoiceSignoff(row.invoice_signoff)
      ? row.invoice_signoff
      : 'computer_generated',
    invoiceTaxLabel: (row.invoice_tax_label as string | null) ?? null,
    invoiceFooter: (row.invoice_footer as string | null) ?? null,
    // smallint 由驱动解析成 number；列上有 not null default 1 与
    // between 1 and 12 的 CHECK，所以这里不需要再兜底一次。
    fiscalYearStartMonth: row.fiscal_year_start_month as number,
  };
}

export async function updateOrganizationSettings(
  tx: Tx,
  organizationId: string,
  input: {
    name: string;
    timezone: string;
    industry: string | null;
    address: string | null;
    registrationNumber: string | null;
    taxNumber: string | null;
    phone: string | null;
    email: string | null;
    paymentDetails: string | null;
    invoiceTaxLabel: string | null;
    invoiceFooter: string | null;
    /**
     * 两个枚举项省略即保留原值，而不是像文字项那样「省略即清空」：文字项
     * 清空是合法的「不印」，枚举项没有「空」这个值，省略只可能是调用方
     * 没带上它，悄悄改回默认值才是错的。
     */
    invoiceLocale?: InvoiceLocale;
    invoiceSignoff?: InvoiceSignoff;
    fiscalYearStartMonth: number;
  },
): Promise<void> {
  await tx`
    update organizations
    set name = ${input.name},
        timezone = ${input.timezone},
        industry = ${input.industry},
        address = ${input.address},
        registration_number = ${input.registrationNumber},
        tax_number = ${input.taxNumber},
        phone = ${input.phone},
        email = ${input.email},
        payment_details = ${input.paymentDetails},
        invoice_tax_label = ${input.invoiceTaxLabel},
        invoice_footer = ${input.invoiceFooter},
        invoice_locale = coalesce(${input.invoiceLocale ?? null}::text, invoice_locale),
        invoice_signoff = coalesce(${input.invoiceSignoff ?? null}::text, invoice_signoff),
        fiscal_year_start_month = ${input.fiscalYearStartMonth}
    where id = ${organizationId}
  `;
}

/**
 * 换 logo 或清掉 logo（path 为 null）。返回旧路径，调用方在事务提交之后
 * 再去存储里删旧对象——顺序理由见 server/actions/organizations.ts。
 *
 * `for update` 锁住这一行：两个人同时换 logo 时，后到的那一个读到的旧路径
 * 是前一个刚写进去的，而不是两人都读到同一个最初的值、各删各的，最后留下
 * 一个谁都不再引用的孤儿对象。
 */
export async function setOrganizationLogoPath(
  tx: Tx,
  organizationId: string,
  logoPath: string | null,
): Promise<{ previousPath: string | null }> {
  const rows = await tx`
    select logo_path from organizations where id = ${organizationId} for update
  `;
  const row = rows.at(0);
  if (!row) {
    throw new Error(`Organization ${organizationId} not found.`);
  }
  await tx`
    update organizations set logo_path = ${logoPath} where id = ${organizationId}
  `;
  return { previousPath: (row.logo_path as string | null) ?? null };
}

/** 收款信息里已经放满了图片。 */
export class PaymentImageLimitError extends Error {
  constructor(max: number) {
    super(`The payment details can hold up to ${max} images. Remove one first.`);
    this.name = 'PaymentImageLimitError';
  }
}

/**
 * 往收款信息里加一张图。先锁这一行再数：两个人同时贴图，各自数到两张、
 * 各自加成第三张，就成了四张——0038 的 CHECK 会在第二个人那里拒掉，但那
 * 是一句裸的约束报错，这里先判才说得出人话。
 */
export async function addOrganizationPaymentImage(
  tx: Tx,
  organizationId: string,
  imagePath: string,
  max: number,
): Promise<void> {
  const rows = await tx`
    select cardinality(payment_image_paths) as count
    from organizations where id = ${organizationId} for update
  `;
  const row = rows.at(0);
  if (!row) {
    throw new Error(`Organization ${organizationId} not found.`);
  }
  if (Number(row.count) >= max) {
    throw new PaymentImageLimitError(max);
  }
  await tx`
    update organizations
    set payment_image_paths = array_append(payment_image_paths, ${imagePath}::text)
    where id = ${organizationId}
  `;
}

/**
 * 从收款信息里拿掉一张图。只认这家公司数组里确实有的路径：路径是客户端
 * 传回来的，不查这一步的话，任何能改公司资料的人都能借这个动作删掉
 * branding bucket 里别的对象（调用方只在 removed 为 true 时才删对象）。
 */
export async function removeOrganizationPaymentImage(
  tx: Tx,
  organizationId: string,
  imagePath: string,
): Promise<{ removed: boolean }> {
  const rows = await tx`
    select ${imagePath}::text = any(payment_image_paths) as present
    from organizations where id = ${organizationId} for update
  `;
  const row = rows.at(0);
  if (!row) {
    throw new Error(`Organization ${organizationId} not found.`);
  }
  if (!row.present) return { removed: false };
  await tx`
    update organizations
    set payment_image_paths = array_remove(payment_image_paths, ${imagePath}::text)
    where id = ${organizationId}
  `;
  return { removed: true };
}

/**
 * 只取财年起始月。报表页与总账页要的就这一个数字，没必要为它把整行设置
 * 读回来——更重要的是，这两个页面在 requirePermission 之后已经有
 * organizationId，不需要再解析一次公司上下文。
 */
export async function getFiscalYearStartMonth(
  tx: Tx,
  organizationId: string,
): Promise<number> {
  const rows = await tx`
    select fiscal_year_start_month from organizations where id = ${organizationId}
  `;
  const row = rows.at(0);
  if (!row) {
    throw new Error(`Organization ${organizationId} not found.`);
  }
  return row.fiscal_year_start_month as number;
}

export async function setPeriodLock(
  tx: Tx,
  organizationId: string,
  lockedUntil: string | null,
): Promise<void> {
  await tx`update organizations set locked_until = ${lockedUntil} where id = ${organizationId}`;
}

/** 公司切换器：列出用户所有活跃成员关系的公司，按名称排序保证 UI 稳定。
 * 用 React.cache() 去重：同一请求内 layout + page 各自调用也只查一次。 */
export const listUserOrganizations = cache(
  async (userId: string): Promise<Array<{ id: string; name: string; slug: string; role: string }>> => {
    const rows = await sql`
      select o.id, o.name, o.slug, m.role
      from organizations o
      join memberships m on m.organization_id = o.id
      where m.user_id = ${userId} and m.status = 'active'
      order by o.name
    `;
    return rows as unknown as Array<{ id: string; name: string; slug: string; role: string }>;
  },
);

/** 取用户语言设置，不存在或为 null 时回退到 en。
 * 用 React.cache() 去重：root layout、app layout、各页面各自调用，
 * 但同一请求内只查一次数据库。 */
export const getUserLocale = cache(async (userId: string): Promise<string> => {
  const [row] = await sql`select locale from app_users where id = ${userId}`;
  return (row?.locale as string) ?? 'en';
});
