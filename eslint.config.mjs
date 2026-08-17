import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

// 记账写入的边界规则见 server/posting/post-journal.ts 顶部注释：
// insertTransaction / insertJournalLines（server/posting/insert.ts）与
// deleteJournalLines（server/repositories/transactions.ts）都是这条边界
// 内部的底层写入函数，只允许 postJournal / repostJournal 调用。之前这只是
// 约定——任务 4-6 把四处写入点都收编之后，仓库里已经没有别的地方直接导入
// 它们了，但没有任何东西拦着下一次新写入点再犯。这两条 no-restricted-imports
// 规则把约定钉成结构：新的直接导入过不了 lint。
//
// 为什么不能只是"错了再改"：数据库的配平触发器（journal_lines 的延迟约束）
// 只核对一笔交易里借方合计是否等于贷方合计，不知道哪一行"应该"是多少。
// 一处写入 bug 如果两条腿（原分录与冲销/重建的分录）算错了同一个数，
// 借贷合计照样相等，触发器完全看不出来——这正是唯一入口存在的意义：
// 把不变量校验钉死在写入之前，而不是指望写完之后触发器替你把关。
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
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/server/posting/insert",
              message: boundaryMessage,
            },
            {
              name: "@/server/repositories/transactions",
              importNames: ["deleteJournalLines"],
              message: boundaryMessage,
            },
          ],
        },
      ],
    },
  },
  {
    // 边界内部本来就是唯一允许直接调用这三个底层写入函数的地方，
    // 上面那条限制对它自己不适用。这条必须排在上面那条之后——
    // flat config 按数组顺序合并同名规则，后面的才能盖掉前面的。
    files: ["server/posting/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
];

export default eslintConfig;
