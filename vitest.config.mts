import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

// 集成测试需要 DATABASE_URL，Next.js 会自动读 .env.local 但 vitest 不会。
loadEnv({ path: '.env.local' });

// 用 .mts 扩展名让 Vite 以 ESM 加载本文件，因此这里可以用 import.meta.url。
// 若改回 .ts，Vite 会当 CommonJS 解析并告警（package.json 没有 "type": "module"，
// 而加上它会影响 Next.js 对项目其余部分的处理，所以用扩展名解决）。
const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    // 全部是集成测试，每个测试文件各开一个进程、各自持有连接池
    // （server/db/client.ts 的 max:10 加 tests/helpers/db.ts 的 max:4）。
    // 不限并发时会按 CPU 核数一起开，撞上 Postgres 的连接上限，
    // 报 EMAXCONNSESSION，且失败的文件每轮都不一样，看起来像数据污染。
    // 4 个进程 × 14 条连接留有余量。
    maxWorkers: 4,
    minWorkers: 1,
  },
  resolve: {
    alias: { '@': rootDir },
  },
});
