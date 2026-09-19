#!/usr/bin/env node
/**
 * 迁移执行器。
 *
 * 在这之前，supabase/migrations/ 下的文件是靠人按批次手工执行的——0017 的
 * 注释里写着「这两个索引已经在开发库里存在，但没有对应记录，它们是在某次
 * 手工执行 SQL 时先建起来的」，0018 干脆标注「未应用：这里只是把索引定义
 * 留档」。也就是说：开发库与生产库的 schema 漂移状态不可知，而没有任何
 * 东西会报告这件事。
 *
 * 这个脚本把「哪些迁移跑过」变成库里的一张表。
 *
 * 用法：
 *   node scripts/migrate.mjs status            列出已应用/待应用
 *   node scripts/migrate.mjs baseline 0020     把 <= 0020 的文件标记为已应用
 *                                              （不执行；用于接管一个已经手工
 *                                              建好的库）
 *   node scripts/migrate.mjs unbaseline 0019   撤销一条 baseline 记录，让它重新
 *                                              变成待应用（只能撤 baseline 的，
 *                                              撤不了真正执行过的——见该命令）
 *   node scripts/migrate.mjs up                按序执行所有待应用的迁移
 *   node scripts/migrate.mjs verify            只校验文件与记录是否一致，
 *                                              有任何待应用项即以非零码退出
 *                                              （给 CI 用）
 *
 * 以 DATABASE_URL 的身份（postgres）执行，不切 teyo_app：迁移要建表、改
 * 策略、授权限，teyo_app 做不到这些，这是刻意的破例而不是疏忽。
 */
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import postgres from 'postgres';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadEnv({ path: path.join(rootDir, '.env.local') });

const MIGRATIONS_DIR = path.join(rootDir, 'supabase', 'migrations');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Put it in .env.local.');
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 20, connect_timeout: 30 });

/** 文件名形如 0007_add_journal_kind.sql —— 前四位是序号，全局唯一且单调。 */
async function loadMigrationFiles() {
  const entries = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();

  const files = [];
  for (const name of entries) {
    const match = /^(\d{4})_/.exec(name);
    if (!match) {
      throw new Error(`Migration file does not start with a 4-digit version: ${name}`);
    }
    const body = await readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
    files.push({
      version: match[1],
      name,
      body,
      // 记下校验和，好让「已应用的迁移被事后改过」这件事可以被发现。
      // 改一条已经跑过的迁移，本地重跑不会有任何动静，而生产库上是另一个
      // schema——这正是最难查的那种漂移。
      checksum: createHash('sha256').update(body).digest('hex'),
    });
  }

  if (files.length === 0) throw new Error(`No migrations found in ${MIGRATIONS_DIR}`);

  const seen = new Set();
  for (const file of files) {
    if (seen.has(file.version)) throw new Error(`Duplicate migration version: ${file.version}`);
    seen.add(file.version);
  }

  return files;
}

async function ensureRegistry() {
  await sql`
    create table if not exists schema_migrations (
      version text primary key,
      name text not null,
      checksum text not null,
      applied_at timestamptz not null default now(),
      /* baseline 的行表示「这条迁移的效果已经在库里，但不是这个脚本跑的」。
         留着这个标记，以后排查 schema 与迁移对不上时才知道该从哪一条查起。 */
      baselined boolean not null default false
    )
  `;
}

async function appliedRows() {
  return await sql`select version, name, checksum, baselined from schema_migrations order by version`;
}

function report(files, applied) {
  const byVersion = new Map(applied.map((row) => [row.version, row]));
  const pending = [];
  const drifted = [];

  for (const file of files) {
    const row = byVersion.get(file.version);
    if (!row) {
      pending.push(file);
    } else if (row.checksum !== file.checksum && !row.baselined) {
      drifted.push({ file, row });
    }
  }

  const orphans = applied.filter((row) => !files.some((f) => f.version === row.version));
  return { pending, drifted, orphans };
}

async function cmdStatus() {
  const files = await loadMigrationFiles();
  const applied = await appliedRows();
  const { pending, drifted, orphans } = report(files, applied);

  console.log(`migrations on disk : ${files.length}`);
  console.log(`recorded as applied: ${applied.length}`);
  console.log('');

  for (const file of files) {
    const row = applied.find((r) => r.version === file.version);
    const state = !row ? 'PENDING' : row.baselined ? 'baseline' : 'applied';
    console.log(`  ${state.padEnd(9)} ${file.name}`);
  }

  if (drifted.length > 0) {
    console.log('\nCHECKSUM DRIFT — these files changed after they were applied:');
    for (const d of drifted) console.log(`  ${d.file.name}`);
  }
  if (orphans.length > 0) {
    console.log('\nORPHAN RECORDS — recorded as applied but no file on disk:');
    for (const o of orphans) console.log(`  ${o.version} ${o.name}`);
  }

  return { pending, drifted, orphans };
}

async function cmdBaseline(upTo) {
  if (!/^\d{4}$/.test(upTo ?? '')) {
    throw new Error('baseline needs a 4-digit version, e.g. `baseline 0020`');
  }
  const files = await loadMigrationFiles();
  const target = files.filter((file) => file.version <= upTo);
  if (target.length === 0) throw new Error(`No migrations at or below ${upTo}`);

  for (const file of target) {
    await sql`
      insert into schema_migrations (version, name, checksum, baselined)
      values (${file.version}, ${file.name}, ${file.checksum}, true)
      on conflict (version) do nothing
    `;
  }
  console.log(`Baselined ${target.length} migration(s) up to ${upTo} (not executed).`);
}

/**
 * 撤销一条 baseline 记录。
 *
 * baseline 是一句断言：「这条迁移的效果已经在库里了」。断言可能划错范围——
 * 本项目就真的划错过一次：接管这个库时按 `baseline 0020` 一刀切，而线上
 * 实际只到 0017，0018/0019/0020 从未生效。0019 是那条「定期规则的间隔必须
 * ≥ 1」的约束（间隔为 0 时补记循环会把一笔 1200 的月租记成 72000，且借贷
 * 完全配平，配平触发器看不出问题），它以为自己在库里，实际不在。
 *
 * 只允许撤 `baselined = true` 的行：真正被这个脚本执行过的迁移不该有
 * 「当作没跑过」这个选项——那会让它被再跑一遍，而绝大多数迁移不是幂等的。
 */
async function cmdUnbaseline(version) {
  if (!/^\d{4}$/.test(version ?? '')) {
    throw new Error('unbaseline needs a 4-digit version, e.g. `unbaseline 0019`');
  }

  const rows = await sql`select version, name, baselined from schema_migrations where version = ${version}`;
  const row = rows.at(0);
  if (!row) {
    console.log(`${version} is not recorded — nothing to undo.`);
    return;
  }
  if (!row.baselined) {
    throw new Error(
      `${row.name} was actually executed by this tool, not baselined. ` +
        'Refusing to mark it pending: re-running an applied migration is not generally safe.',
    );
  }

  await sql`delete from schema_migrations where version = ${version} and baselined = true`;
  console.log(`${row.name} is pending again. Run \`up\` to apply it.`);
}

async function cmdUp() {
  const files = await loadMigrationFiles();
  const applied = await appliedRows();
  const { pending, drifted } = report(files, applied);

  if (drifted.length > 0) {
    // 不自动「修正」校验和：一条已经跑过的迁移被改了，意味着库里的 schema
    // 与文件描述的不是同一个东西，静默更新记录只会把这个事实抹掉。
    console.error('Refusing to run: these applied migrations were modified on disk.');
    for (const d of drifted) console.error(`  ${d.file.name}`);
    console.error('Write a new migration instead of editing an applied one.');
    process.exitCode = 1;
    return;
  }

  if (pending.length === 0) {
    console.log('Nothing to do — every migration on disk is recorded as applied.');
    return;
  }

  for (const file of pending) {
    process.stdout.write(`applying ${file.name} ... `);
    // 每条迁移一个事务：一条迁移要么整条生效要么整条不生效，不会留下
    // 「前半段建了表、后半段的策略没建」这种半截状态。
    await sql.begin(async (tx) => {
      await tx.unsafe(file.body);
      await tx`
        insert into schema_migrations (version, name, checksum, baselined)
        values (${file.version}, ${file.name}, ${file.checksum}, false)
      `;
    });
    console.log('ok');
  }

  console.log(`\nApplied ${pending.length} migration(s).`);
}

async function cmdVerify() {
  const { pending, drifted, orphans } = await cmdStatus();
  if (pending.length > 0 || drifted.length > 0 || orphans.length > 0) {
    console.error('\nSchema is not in sync with supabase/migrations/.');
    process.exitCode = 1;
  } else {
    console.log('\nSchema is in sync with supabase/migrations/.');
  }
}

const [command, argument] = process.argv.slice(2);

try {
  await ensureRegistry();
  switch (command) {
    case 'status':
      await cmdStatus();
      break;
    case 'baseline':
      await cmdBaseline(argument);
      break;
    case 'unbaseline':
      await cmdUnbaseline(argument);
      break;
    case 'up':
      await cmdUp();
      break;
    case 'verify':
      await cmdVerify();
      break;
    default:
      console.error(
        'Usage: node scripts/migrate.mjs <status|baseline NNNN|unbaseline NNNN|up|verify>',
      );
      process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 10 });
}
