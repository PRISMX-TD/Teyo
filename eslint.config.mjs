import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

// 记账写入的边界规则见 server/posting/post-journal.ts 顶部注释：
// insertTransaction / insertJournalLines / deleteJournalLines（都在
// server/posting/insert.ts——三个底层写入函数已同属一个模块，deleteJournalLines
// 原来落在 server/repositories/transactions.ts，任务 7 复查时搬了过来）都是这条
// 边界内部的底层写入函数，只允许 postJournal / repostJournal 调用。之前这只是
// 约定——任务 4-6 把四处写入点都收编之后，仓库里已经没有别的地方直接导入它们
// 了，但没有任何东西拦着下一次新写入点再犯。
//
// 为什么不能只是"错了再改"：数据库的配平触发器（journal_lines 的延迟约束）
// 只核对一笔交易里借方合计是否等于贷方合计，不知道哪一行"应该"是多少。
// 一处写入 bug 如果两条腿（原分录与冲销/重建的分录）算错了同一个数，
// 借贷合计照样相等，触发器完全看不出来——这正是唯一入口存在的意义：
// 把不变量校验钉死在写入之前，而不是指望写完之后触发器替你把关。
//
// ============================================================
// 下面这两条规则由什么来跑——**不是** next lint
// ============================================================
// `next lint`（以及 `next build` 内置的那次 lint）只扫 next.config 里
// eslint.dirs 指定的目录，默认是 app / pages / components / lib / src
// （见 next/dist/lib/constants.js 的 ESLINT_DEFAULT_DIRS）。server/ 与
// tests/ 一个文件都不在里面。实测：在 server/actions/transactions.ts 顶上
// 加一行 `import { insertJournalLines } from '../posting/insert'`，
// `npx next lint` 照样 exit 0、0 errors——它测量的范围恰好把这两条规则
// 保护的每个文件都排除了。所以 next lint 的绿色对这条边界毫无信息量。
//
// 也没有把 server/ 加进 eslint.dirs：那会让 `next build` 一并去 lint
// server/，而仓库里现有 3 个与记账边界无关的既有错误就在那儿
// （server/repositories/bank_import.ts、server/services/bank_import_parser.ts），
// 构建会因此永久变红——用一个永远红的门禁换一个永远绿的门禁，还是没人看。
//
// 真正跑这两条规则的是两处：
//   1. `npm run lint` —— 已显式列出 server 与 tests。它今天是红的：上面那
//      3 个既有错误不属于本分支，没有一并修，也没有用 disable 注释盖掉。
//   2. tests/posting/boundary-lint.test.ts —— 在 `npx vitest run`（这个项目
//      里唯一每次都会跑的门禁）里用 ESLint 的 Node API 加载**本文件**，
//      既证明规则本身有效，也扫一遍全仓。它只按 ruleId 过滤边界规则，
//      因此不会被那 3 个既有错误染红，也不替它们遮掩。
//      改动本文件时那个测试会跟着红——那是它该有的样子。
const boundaryMessage =
  "记账写入必须经过 server/posting/post-journal.ts 里的 postJournal / repostJournal，" +
  "不能直接调用底层写入函数。原因见本文件顶部注释：数据库的配平触发器只核对" +
  "借贷合计是否相等，两边同时错了同一个数它看不出来，这条边界就是为了在写入" +
  "之前把校验做完，而不是事后指望触发器兜底。";

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      // 第一层：按 import 说明符的字面文本匹配，只认 @/ 别名这一种写法。
      // 挡得住的场景是最常见的那种，而且挡下来的诊断信息最好读——
      // no-restricted-imports 允许每条限制自带一句 message，import/no-restricted-paths
      // 不支持按具体名字定制文案，只能给整个 zone 一句。留着这条规则，是为了不把
      // 这句解释"该怎么办、为什么"的话弄丢。
      //
      // 但它只匹配字符串本身：'../posting/insert' 这种相对路径写法，字面上不等于
      // '@/server/posting/insert'，这条规则完全看不见，是真正的漏洞——见下面第二层。
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/server/posting/insert",
              message: boundaryMessage,
            },
          ],
        },
      ],
      // 第二层：按 import 解析后的真实文件路径匹配（用的是项目里已经装好的
      // eslint-import-resolver-typescript，同一个 resolver 也在解 @/ 别名），
      // 不管调用方写的是 '@/server/posting/insert' 还是 '../posting/insert'
      // 还是再深几层的 '../../../posting/insert'，解析出来都是同一个文件，
      // 这条规则按文件身份认，不按拼写认，堵住了第一层唯一漏的那个口子。
      // target 是整个项目根目录——包括 server/posting/ 自己在内，它的例外
      // 由下面那条覆盖规则单独处理，两层规则用的是同一套"先全禁、后局部
      // 放开"的结构。
      "import/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: ".",
              from: "./server/posting/insert.ts",
              message: boundaryMessage,
            },
          ],
        },
      ],
    },
  },
  {
    // 边界内部本来就是唯一允许直接调用这三个底层写入函数的地方，
    // 上面两条限制对它自己都不适用。这条必须排在上面那条之后——
    // flat config 按数组顺序合并同名规则，后面的才能盖掉前面的。
    files: ["server/posting/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": "off",
      "import/no-restricted-paths": "off",
    },
  },
];

export default eslintConfig;
