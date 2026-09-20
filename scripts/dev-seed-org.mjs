#!/usr/bin/env node
/**
 * 给一个测试账号建一家带完整科目表的公司，供本地界面验收用。
 *
 * 为什么不走产品自己的 createOrganization：那是一个 Server Action，从
 * Node 脚本里调不到（它需要 Next 的请求上下文与会话 cookie）。这里复用
 * 的是同一份数据——`server/services/account-seed.ts` 的 SEED_ACCOUNTS /
 * SEED_CATEGORIES 直接 import 进来（Node 的类型剥离能读 .ts），所以科目
 * 表与线上新建公司拿到的一模一样，不会出现「验收用的公司缺几个科目」
 * 这种只在验收环境成立的差异。
 *
 * 安全边界：只肯为 @example.com 的账号建公司（RFC 2606 保留域名），
 * 拒绝 production。建出来的公司由 scripts/cleanup-test-data.mjs 清理。
 *
 * 用法：node --experimental-strip-types scripts/dev-seed-org.mjs --email x@example.com
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import postgres from 'postgres';
import { SEED_ACCOUNTS, SEED_CATEGORIES } from '../server/services/account-seed.ts';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadEnv({ path: path.join(rootDir, '.env.local') });

if (process.env.NODE_ENV === 'production') {
  console.error('这个脚本只用于本地验收，拒绝在 NODE_ENV=production 下运行。');
  process.exit(1);
}

const flagIndex = process.argv.indexOf('--email');
const email = flagIndex !== -1 ? process.argv[flagIndex + 1] : undefined;
if (!email?.endsWith('@example.com')) {
  console.error('--email 必须是一个 @example.com 的测试账号。');
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 30 });

try {
  const [user] = await sql`select id from auth.users where email = ${email}`;
  if (!user) throw new Error(`找不到账号 ${email}，先跑 scripts/dev-session-cookie.mjs`);
  const userId = user.id;

  const slug = `ui-check-${randomUUID().slice(0, 8)}`;
  const orgId = randomUUID();

  await sql.begin(async (tx) => {
    // app_users 那一行通常由 /auth/callback 的 ensureAppUser 写入，但这个
    // 脚本可能在用户还没打开过应用时就跑，所以自己补一次（幂等）。
    await tx`
      insert into app_users (id, email, display_name, locale)
      values (${userId}, ${email}, 'UI Check', 'zh')
      on conflict (id) do nothing
    `;

    await tx`
      insert into organizations (id, slug, name, base_currency, timezone, created_by)
      values (${orgId}, ${slug}, 'UI Check Co', 'MYR', 'Asia/Kuala_Lumpur', ${userId})
    `;
    await tx`
      insert into memberships (organization_id, user_id, role, status)
      values (${orgId}, ${userId}, 'owner', 'active')
    `;

    // 科目 id 在应用侧生成，与 seedChartOfAccounts 同一个理由：分类要引用
    // 科目 id，自己生成就不必把新行读回来。
    const idByCode = new Map(SEED_ACCOUNTS.map((a) => [a.code, randomUUID()]));
    await tx`
      insert into accounts ${tx(
        SEED_ACCOUNTS.map((a) => ({
          id: idByCode.get(a.code),
          organization_id: orgId,
          code: a.code,
          name_en: a.nameEn,
          name_zh: a.nameZh,
          type: a.type,
          is_money_account: a.isMoneyAccount,
          is_system: true,
          sort_order: a.sortOrder,
          cash_flow_category: a.cashFlowCategory ?? null,
        })),
      )}
    `;
    await tx`
      insert into categories ${tx(
        SEED_CATEGORIES.map((c) => ({
          organization_id: orgId,
          name_en: c.nameEn,
          name_zh: c.nameZh,
          kind: c.kind,
          account_id: idByCode.get(c.accountCode),
          sort_order: c.sortOrder,
          is_system_only: c.isSystemOnly ?? false,
        })),
      )}
    `;

    // 一个客户，供发票与收款页面有东西可选。
    await tx`
      insert into contacts (organization_id, type, name)
      values (${orgId}, 'customer', 'UI Check Customer')
    `;
  });

  console.log(JSON.stringify({ orgId, slug, userId }));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 10 });
}
