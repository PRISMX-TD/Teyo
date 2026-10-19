// middleware 的 matcher 决定哪些请求会走会话刷新。漏掉一条页面路径，
// 那条路径上的用户就会在 access token 过期后被随机登出；多拦一条静态文件，
// 就是每次加载都白跑一趟 Supabase Auth。
import { describe, expect, it } from 'vitest';
// Next 自己编译 matcher 用的就是这份 path-to-regexp。预编译包不带类型声明。
// @ts-expect-error -- next/dist/compiled/path-to-regexp 没有 .d.ts
import { pathToRegexp } from 'next/dist/compiled/path-to-regexp';
import { config } from '@/middleware';

const matchers: RegExp[] = config.matcher.map((source) =>
  pathToRegexp(source, [], { delimiter: '/', sensitive: false, strict: true }),
);

function runsMiddleware(pathname: string): boolean {
  return matchers.some((re) => re.test(pathname));
}

describe('middleware matcher', () => {
  it.each([
    '/',
    '/login',
    '/acme/transactions',
    // slug 恰好以被排除的前缀开头：原来的裸前缀把它们整个放过了。
    '/api-solutions',
    '/api-solutions/invoices',
    '/icon-trading',
    '/icon-trading/settings',
    '/apple-icons-sdn-bhd',
    '/sw-tech',
  ])('runs on page %s', (pathname) => {
    expect(runsMiddleware(pathname)).toBe(true);
  });

  it.each([
    '/api/cron/exchange-rates',
    '/api/acme/statement',
    '/_next/static/chunks/main.js',
    '/_next/image',
    '/favicon.ico',
    '/manifest.webmanifest',
    '/sw.js',
    '/icon',
    '/apple-icon',
    '/robots.txt',
    '/logo.png',
    '/fonts/geist.woff2',
  ])('skips %s', (pathname) => {
    expect(runsMiddleware(pathname)).toBe(false);
  });
});
