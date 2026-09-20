// 部署配置层面的三件事，都是「不看配置文件就永远发现不了」的那一类：
//   1. 'use server' 模块里的再导出，会把仓库函数变成零鉴权的远程端点；
//   2. 一个从未被调度过的 cron；
//   3. 一个安全响应头都没有的应用。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rootDir = path.resolve(__dirname, '..', '..');

describe("no 'use server' module re-exports repository functions", () => {
  /**
   * Next.js 会把 `'use server'` 模块的**每一个**导出注册成可远程调用的端点。
   * 所以 `export { getDashboardKpis } from '@/server/repositories/dashboard'`
   * 这一行的真实含义是「把这个仓库函数公开给整个互联网」——没有
   * requireUserId、没有 requirePermission、没有 resolveOrgContext。
   *
   * server/actions/dashboard.ts 与 server/actions/aging.ts 曾经就是这样的
   * 两个文件，一共 8 个函数。它们当时打不通只是因为第一个参数 tx 过不了
   * React 的序列化协议——那是巧合，不是设计：任何一次把 tx 挪到第二个参数
   * 或者改成从上下文取的重构，都会在无人察觉的情况下把它们接通。
   *
   * 这条用例扫的是整个 server/actions/，不是那两个文件名——重点是这一类
   * 写法不能再出现，而不是那两个文件不能再回来。
   */
  const actionFiles = readdirSync(path.join(rootDir, 'server', 'actions')).filter((name) =>
    name.endsWith('.ts'),
  );

  it('has action modules to check at all', () => {
    expect(actionFiles.length).toBeGreaterThan(5);
  });

  it.each(actionFiles)('%s exports only its own async functions', (name) => {
    const source = readFileSync(path.join(rootDir, 'server', 'actions', name), 'utf8');

    // `export * from '...'` —— 无法逐个审视，一律禁止。
    expect(source, `${name} uses "export * from"`).not.toMatch(/^\s*export\s+\*\s+from/m);

    // `export { a, b } from '...'` —— 只有纯类型的再导出是安全的
    // （类型在编译后就没了，不会变成端点）。
    const reExports = source.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g);
    for (const match of reExports) {
      const specifiers = match[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const values = specifiers.filter((s) => !s.startsWith('type '));
      expect(values, `${name} re-exports values from ${match[2]}`).toEqual([]);
    }
  });

  it('no longer ships the two modules that did exactly that', () => {
    expect(existsSync(path.join(rootDir, 'server', 'actions', 'dashboard.ts'))).toBe(false);
    expect(existsSync(path.join(rootDir, 'server', 'actions', 'aging.ts'))).toBe(false);
  });
});

describe('vercel.json', () => {
  const vercel = JSON.parse(readFileSync(path.join(rootDir, 'vercel.json'), 'utf8')) as {
    crons?: { path: string; schedule: string }[];
    functions?: Record<string, unknown>;
  };

  /**
   * app/api/cron/exchange-rates/route.ts 写得很完整——timingSafeEqual 比对
   * 密钥、未配置密钥时返回 500 拒绝而不是放行、六个测试——但 vercel.json
   * 里从来没有 crons 字段，所以它一次都没有被调度过。
   *
   * 后果是连锁的：exchange_rates 表永远是空的 → findRate 查不到任何汇率
   * → 每一笔外币交易都要用户手填汇率 → 而定期规则与折旧这两条路径**没有**
   * 填汇率的地方（manualRateEntry: 'unavailable'），于是它们的外币分录必然
   * 失败。一个没接上的 cron，表现出来是「定期规则不工作」。
   */
  it('schedules the exchange-rate cron', () => {
    expect(vercel.crons).toBeDefined();
    const cron = vercel.crons?.find((c) => c.path === '/api/cron/exchange-rates');
    expect(cron, 'no cron entry for /api/cron/exchange-rates').toBeDefined();
  });

  /**
   * 为什么是 16:30 UTC（马来西亚时间次日 00:30）。
   *
   * 汇率来自 Frankfurter，而 Frankfurter 转的是欧洲央行的每日参考汇率，
   * 后者在中欧时间下午 16:00 前后发布，也就是 UTC 的 14:00–15:00。
   *
   * 于是有两个可选时刻：
   *   ECB 发布之前（比如 01:00 UTC / 09:00 马来西亚时间）——请求「今天」
   *     会拿回最近一个工作日的数据，等于每天都落后一天。
   *   ECB 发布之后（这里选的 16:30 UTC）——「今天」就是今天，而且换算成
   *     马来西亚时间是次日凌晨 00:30：商户早上九点开门时，昨天与今天的
   *     汇率都已经在库里了。
   *
   * 留 30 分钟余量是因为 ECB 的发布时间并不精确到分钟，而 Vercel 的 cron
   * 本身也只保证「大约在那个时间」。
   */
  it('runs once a day, after the ECB publishes and before the Malaysian business day', () => {
    const cron = vercel.crons?.find((c) => c.path === '/api/cron/exchange-rates');
    const [minute, hour, dom, month, dow] = (cron?.schedule ?? '').split(' ');

    // 每天一次：日、月、星期都是通配。Vercel 的 Hobby 方案也只允许每日。
    expect([dom, month, dow]).toEqual(['*', '*', '*']);

    const utcMinutes = Number(hour) * 60 + Number(minute);
    // 15:00 UTC 之后（ECB 已发布），20:00 UTC 之前（换算成马来西亚时间
    // 仍在深夜，不与白天的使用高峰重叠）。
    expect(utcMinutes).toBeGreaterThanOrEqual(15 * 60);
    expect(utcMinutes).toBeLessThan(20 * 60);
  });

  it('keeps the existing function settings', () => {
    // crons 是加上去的，不是替换。区域与超时不能被顺手弄丢。
    expect(vercel.functions).toMatchObject({
      'app/**/*': { regions: ['sin1'], maxDuration: 30 },
    });
  });
});

describe('security response headers', () => {
  // next.config.ts 之前只有 experimental.serverActions.bodySizeLimit，
  // vercel.json 也没有 headers 段——也就是说线上一个安全响应头都没有。
  async function headerMap(): Promise<Record<string, string>> {
    const config = (await import('@/next.config')).default as {
      headers?: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]>;
    };
    expect(config.headers, 'next.config.ts has no headers()').toBeTypeOf('function');

    const rules = await config.headers!();
    const all = rules.flatMap((rule) => rule.headers);
    return Object.fromEntries(all.map((h) => [h.key, h.value]));
  }

  /**
   * 点击劫持在这个应用里不是纸上谈兵：transferOwnership 是一次点击就完成、
   * 且不可逆的操作（整家公司连同全部账目转给别人）。把它套进一个透明
   * iframe，上面叠一个「领取优惠券」的按钮，代价就是一家公司。
   *
   * 两个头都要：现代浏览器在 CSP 带 frame-ancestors 时会忽略
   * X-Frame-Options，而老浏览器不认 frame-ancestors。
   */
  it('blocks framing two ways', async () => {
    const headers = await headerMap();
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Content-Security-Policy']).toMatch(/frame-ancestors\s+'none'/);
  });

  /**
   * URL 里带着 orgSlug，而 slug 往往就是公司的真名。默认的 referrer 行为
   * 会把整条 URL 交给任何一个被点开的外链，等于对外广播「这家公司在用
   * Teyo，这是他们的一笔交易」。
   */
  it('never leaks the org slug through the Referer header', async () => {
    const headers = await headerMap();
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
  });

  it('sets the rest of the baseline', async () => {
    const headers = await headerMap();
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Strict-Transport-Security']).toMatch(/max-age=\d{7,}/);
    expect(headers['Permissions-Policy']).toMatch(/camera=\(\)/);
  });

  /**
   * 完整的那条策略先以 Report-Only 上线：它必须写 script-src
   * 'unsafe-inline'（App Router 的 Flight 数据与 hydration 脚本都是内联的
   * 且不带 nonce），而带了 'unsafe-inline' 的 script-src 挡不住 XSS，却
   * 足以在某个细节写错时把整个应用打白。强制版本要等 middleware 那边加上
   * 逐请求 nonce，理由写在 next.config.ts 里。
   */
  it('ships the full policy as report-only, with the pieces the app actually needs', async () => {
    const headers = await headerMap();
    const reportOnly = headers['Content-Security-Policy-Report-Only'];
    expect(reportOnly).toBeDefined();
    expect(reportOnly).toMatch(/default-src 'self'/);
    // supabase-js 在浏览器里直接发 XHR 与 WebSocket，connect-src 必须放行，
    // 否则切成强制的那天所有人都登不进来。
    expect(reportOnly).toMatch(/connect-src[^;]*supabase/);
    // next/font 自托管字体走 'self'，导出预览与附件缩略图用 blob:。
    expect(reportOnly).toMatch(/font-src[^;]*'self'/);
    expect(reportOnly).toMatch(/img-src[^;]*blob:/);
    // Serwist 生成的 service worker。
    expect(reportOnly).toMatch(/worker-src[^;]*'self'/);
  });
});
