import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * 记账写入边界的**执行**测试。
 *
 * 边界本身（postJournal / repostJournal 是唯一入口，server/posting/insert.ts
 * 里的底层写入函数在 server/posting/ 之外不可达）由 eslint.config.mjs 里的两条
 * 规则来强制。问题在于那两条规则之前没有任何东西会去跑：
 *
 *   - 仓库里没有 CI；
 *   - 大家当门禁用的 `npx next lint` 只扫 app/ components/ lib/ 三个目录，
 *     server/ 一个文件都不看。真的在 server/actions/transactions.ts 顶上加一行
 *     `import { insertJournalLines } from '../posting/insert'`，`next lint`
 *     照样 exit 0、0 errors——它测量的范围恰好把这两条规则保护的每个文件都排除了。
 *
 * 所以把这条保证搬进 `npx vitest run`——这个项目里唯一每次都会跑的门禁。
 *
 * 用 ESLint 的 Node API 加载项目**真实的** eslint.config.mjs，而不是在测试里
 * 重写一遍规则：重写一遍的话，真实配置坏掉时测试照样绿。
 *
 * 断言一律按 ruleId 过滤。ESLint 因为别的原因报错（写错的夹具、无关的既有错误）
 * 不算数——一个"因为别的错误而通过"的边界测试比没有更糟。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 两条规则各挡一半：字面别名 vs 解析后的文件身份。见 eslint.config.mjs 的注释。 */
const BOUNDARY_RULES = ['no-restricted-imports', 'import/no-restricted-paths'] as const;

let eslint: ESLint;

beforeAll(() => {
  // cwd 决定 ESLint 去哪里找扁平配置，这里锁死到仓库根，不依赖 vitest 的进程 cwd。
  eslint = new ESLint({ cwd: repoRoot });
});

/**
 * 按给定路径 lint 一段源码，只返回来自边界规则的**错误**。
 *
 * 文件不必真的存在：import 解析是相对 filePath 所在目录做的，
 * 而被禁的那个目标 server/posting/insert.ts 是真实文件。
 */
async function boundaryErrors(relativeFilePath: string, code: string) {
  const results = await eslint.lintText(code, {
    filePath: path.join(repoRoot, relativeFilePath),
  });
  return results
    .flatMap((result) => result.messages)
    .filter((m) => m.severity === 2 && BOUNDARY_RULES.includes(m.ruleId as never));
}

const IMPORTING_FILE = 'server/actions/__boundary_fixture__.ts';

describe('记账写入边界的 ESLint 规则', () => {
  it('挡下 @/ 别名写法，并带上解释性的 message', async () => {
    const errors = await boundaryErrors(
      IMPORTING_FILE,
      "import { insertJournalLines } from '@/server/posting/insert';\nvoid insertJournalLines;\n",
    );

    expect(errors.map((e) => e.ruleId)).toContain('no-restricted-imports');
    // 第一层规则存在的理由就是这句自定义文案，丢了它这层就没有价值了。
    expect(
      errors.some((e) => e.message.includes('postJournal / repostJournal')),
    ).toBe(true);
  }, 30_000);

  it('挡下相对路径写法——上一轮正是只挡住了别名那一种', async () => {
    const errors = await boundaryErrors(
      IMPORTING_FILE,
      "import { insertJournalLines } from '../posting/insert';\nvoid insertJournalLines;\n",
    );

    // 相对路径字面上不等于 '@/server/posting/insert'，第一层看不见它，
    // 必须由按解析后文件身份匹配的第二层挡下来。
    expect(errors.map((e) => e.ruleId)).toContain('import/no-restricted-paths');
  }, 30_000);

  it('挡下再深一层的相对路径', async () => {
    const errors = await boundaryErrors(
      'server/repositories/nested/__boundary_fixture__.ts',
      "import { insertJournalLines } from '../../posting/insert';\nvoid insertJournalLines;\n",
    );

    expect(errors.map((e) => e.ruleId)).toContain('import/no-restricted-paths');
  }, 30_000);

  it('也挡下 deleteJournalLines / insertTransaction——禁的是模块，不是某个名字', async () => {
    const errors = await boundaryErrors(
      IMPORTING_FILE,
      "import { insertTransaction, deleteJournalLines } from '../posting/insert';\n" +
        'void insertTransaction;\nvoid deleteJournalLines;\n',
    );

    expect(errors.map((e) => e.ruleId)).toContain('import/no-restricted-paths');
  }, 30_000);

  it('边界内部（server/posting/ 之下）不受限制——两种写法都不报', async () => {
    // 反向断言：豁免必须**只**开给 server/posting/。如果哪天有人把豁免放宽到
    // 全仓，上面几条会跟着一起变绿，这条则拦不住任何回归——所以它要盯的是
    // 豁免仍然存在，而上面几条盯的是豁免没有被放宽。
    const relative = await boundaryErrors(
      'server/posting/__boundary_fixture__.ts',
      "import { insertJournalLines } from './insert';\nvoid insertJournalLines;\n",
    );
    const aliased = await boundaryErrors(
      'server/posting/__boundary_fixture__.ts',
      "import { insertJournalLines } from '@/server/posting/insert';\nvoid insertJournalLines;\n",
    );

    expect(relative).toEqual([]);
    expect(aliased).toEqual([]);
  }, 30_000);

  it('全仓现状：没有任何地方越过边界直接导入底层写入函数', async () => {
    // 上面几条证明规则本身有效，这条才是真的在扫仓库。
    // 只按 ruleId 过滤边界规则：仓库里另有 4 个与本分支无关的既有 ESLint 错误
    // （server/repositories/bank_import.ts、server/services/bank_import_parser.ts
    // 与生成物 public/sw.js），本测试不该因为它们变红，也不该替它们遮掩。
    const results = await eslint.lintFiles([
      'app',
      'components',
      'lib',
      'server',
      'tests',
      'middleware.ts',
    ]);

    const violations = results.flatMap((result) =>
      result.messages
        .filter((m) => m.severity === 2 && BOUNDARY_RULES.includes(m.ruleId as never))
        .map((m) => `${path.relative(repoRoot, result.filePath)}:${m.line} ${m.ruleId}`),
    );

    expect(violations).toEqual([]);
  }, 120_000);
});
