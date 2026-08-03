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
  },
  resolve: {
    alias: { '@': rootDir },
  },
});
