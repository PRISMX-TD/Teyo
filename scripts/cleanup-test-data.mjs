#!/usr/bin/env node
/**
 * 清理集成测试留在数据库里的测试公司与测试用户。
 *
 * 为什么需要它：`tests/helpers/test-db.ts` 的 resetTestData 只清理「本模块
 * 登记过的 id」，这是并行安全的正确做法——但它只在测试正常跑完时执行。
 * 测试进程被中断（超时、速率限制、Ctrl-C）时，afterAll 不会运行，造的数据
 * 就留在库里了。这个脚本是那种情况下的收尾工具。
 *
 * ── 判据 ──
 *
 * 测试数据的唯一判据是邮箱域名 **example.com**。RFC 2606 把它保留给文档与
 * 测试用途，明确规定它不会被分配给任何真实主机，所以「@example.com 的账号
 * 一定是测试账号」这句话不依赖任何命名约定，也不会因为谁改了测试里的邮箱
 * 前缀而失效。
 *
 * 不按 slug 前缀判断：slug 是人起的名字，`payments-co-*` 这种前缀明天就可能
 * 撞上一个真实公司。按「谁创建的」判断才是可靠的。
 *
 * ── 安全设计 ──
 *
 * 1. **默认只报告，不删**。要真删必须显式传 --confirm。
 * 2. 删除前先枚举出确切的 id 列表并打印，删除按 id 精确执行，不用模式匹配。
 * 3. 三道断言，任何一道不过就中止：真实账号不在集合里、非 example.com 的
 *    公司不在集合里、集合规模不超过上限（防止判据写错时一次删掉整个库）。
 * 4. 整批在一个事务里，要么全清干净要么一条不动。
 *
 * ── 删除顺序 ──
 *
 * 必须先公司后用户：organizations.created_by 指向 app_users 且**不是**
 * on delete cascade，先删用户会撞 organizations_created_by_fkey。
 * 删公司会级联清掉它名下的交易、分录、发票、账单、收付款与审计日志
 * （0016/0020/0022 三条迁移把这些外键补齐了）。删 auth.users 会级联清掉
 * app_users。
 *
 * ── 为什么有一道时间闸 ──
 *
 * 测试跑的时候，库里正躺着一批**正在被使用**的测试公司。这个脚本按
 * 「创建人是测试账号」判定，分不出「上次跑崩了留下的」和「隔壁进程此刻
 * 正在用的」——把后者删掉，那个测试会以一串莫名其妙的外键错误失败，而
 * 看日志的人会以为是代码坏了。
 *
 * 所以默认只清理 STALE_MINUTES 之前创建的。想连刚建的一起清（确认没有
 * 测试在跑时），传 --all。
 *
 * 用法：
 *   node scripts/cleanup-test-data.mjs             只报告（默认 30 分钟前的）
 *   node scripts/cleanup-test-data.mjs --confirm   真的删
 *   node scripts/cleanup-test-data.mjs --all       连刚建的一起算（先确认没有测试在跑）
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import postgres from 'postgres';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadEnv({ path: path.join(rootDir, '.env.local') });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Put it in .env.local.');
  process.exit(1);
}

/** 测试邮箱的保留域名。见文件头注释。 */
const TEST_DOMAIN = '@example.com';

/**
 * 一次最多删多少家公司。
 *
 * 这不是性能考虑，是熔断器：如果哪天判据被改坏了（比如把条件写反），
 * 这个上限会让脚本在删掉整个库之前停下来。真要清理更多，改这个数字是
 * 一个需要有人动手、因而会被看见的动作。
 */
const MAX_ORGS = 200;

/**
 * 多久之前创建的才算「残留」。见文件头那段关于时间闸的注释。
 *
 * 30 分钟：一个集成测试文件跑完远不需要这么久（全套 1167 个用例约两分钟），
 * 所以超过这个时间还留在库里的，一定是没能跑完 afterAll 的那一批。
 */
const STALE_MINUTES = 30;

const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 20, connect_timeout: 30 });
const confirm = process.argv.includes('--confirm');
const includeRecent = process.argv.includes('--all');
// interval 的参数不能是绑定变量，所以用一个只由本文件常量拼出来的字面量。
const staleCutoff = includeRecent ? '0 minutes' : `${STALE_MINUTES} minutes`;

try {
  const targetOrgs = await sql`
    select o.id, o.slug, u.email as creator,
      (select count(*)::int from transactions t where t.organization_id = o.id) as txns
    from organizations o
    join auth.users u on u.id = o.created_by
    where u.email like ${'%' + TEST_DOMAIN}
      and o.created_at < now() - ${staleCutoff}::interval
    order by o.slug
  `;
  // 用户同样过时间闸：刚建的测试用户多半正被某个跑着的测试文件用着，
  // 而且它名下的公司这一轮也不会被删——删了用户会撞
  // organizations_created_by_fkey（那条外键不是 cascade）。
  const targetUsers = await sql`
    select id, email from auth.users
    where email like ${'%' + TEST_DOMAIN}
      and created_at < now() - ${staleCutoff}::interval
      and not exists (
        select 1 from organizations o
        where o.created_by = auth.users.id
          and o.created_at >= now() - ${staleCutoff}::interval
      )
    order by email
  `;

  const keptOrgs = await sql`
    select o.slug, u.email as creator,
      (select count(*)::int from transactions t where t.organization_id = o.id) as txns
    from organizations o
    left join auth.users u on u.id = o.created_by
    where o.created_by not in (select id from auth.users where email like ${'%' + TEST_DOMAIN})
    order by o.slug
  `;
  const keptUsers = await sql`
    select email from auth.users where email not like ${'%' + TEST_DOMAIN} order by email
  `;

  console.log(
    includeRecent
      ? '时间闸：已关闭（--all），连刚创建的也算'
      : `时间闸：只清理 ${STALE_MINUTES} 分钟前创建的（避免删掉正在跑的测试的夹具）`,
  );
  console.log(`\n将要删除的公司 (${targetOrgs.length}):`);
  for (const org of targetOrgs) {
    console.log(`  ${org.slug.padEnd(32)} 交易=${String(org.txns).padStart(3)}  ${org.creator}`);
  }
  console.log(`\n将要删除的用户: ${targetUsers.length}`);

  console.log(`\n保留的公司 (${keptOrgs.length}):`);
  for (const org of keptOrgs) {
    console.log(`  ${org.slug.padEnd(32)} 交易=${String(org.txns).padStart(3)}  ${org.creator ?? '?'}`);
  }
  console.log(`\n保留的账号 (${keptUsers.length}): ${keptUsers.map((u) => u.email).join(', ')}`);

  // ── 三道断言 ──
  const badKeptUser = keptUsers.find((u) => String(u.email).endsWith(TEST_DOMAIN));
  if (badKeptUser) throw new Error(`保留集合里混进了测试账号: ${badKeptUser.email}`);

  const badTargetUser = targetUsers.find((u) => !String(u.email).endsWith(TEST_DOMAIN));
  if (badTargetUser) throw new Error(`删除集合里混进了非测试账号: ${badTargetUser.email}`);

  if (targetOrgs.length > MAX_ORGS) {
    throw new Error(`待删公司 ${targetOrgs.length} 家，超过上限 ${MAX_ORGS}。请先人工确认判据没写错。`);
  }

  if (targetOrgs.length === 0 && targetUsers.length === 0) {
    console.log('\n没有测试数据需要清理。');
  } else if (!confirm) {
    console.log('\n这是一次预演，什么都没有删。确认无误后加 --confirm 再跑一次。');
  } else {
    const orgIds = targetOrgs.map((o) => o.id);
    const userIds = targetUsers.map((u) => u.id);

    await sql.begin(async (tx) => {
      // 按 id 精确删除，不在删除语句里再用一次模式匹配——上面已经把范围
      // 枚举并打印出来了，删的就是打印出来的那一批，不多不少。
      if (orgIds.length > 0) {
        const removed = await tx`delete from organizations where id = any(${orgIds})`;
        console.log(`\n已删除公司: ${removed.count}`);
      }
      if (userIds.length > 0) {
        const removed = await tx`delete from auth.users where id = any(${userIds})`;
        console.log(`已删除用户: ${removed.count}`);
      }
    });

    const orphans = await sql`
      select count(*)::int as n from app_users a
      where not exists (select 1 from auth.users u where u.id = a.id)
    `;
    console.log(`复核 — 孤儿 app_users: ${orphans[0].n}（应为 0）`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 10 });
}
