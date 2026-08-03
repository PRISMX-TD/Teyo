import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 用 import.meta.url 而不是 __dirname，避免 Vite 原生 config loader 把本文件当 CommonJS 解析
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
