#!/usr/bin/env node
/**
 * 用一份真实会话把应用里每一条页面路由请求一遍，报告状态码。
 *
 * 这个仓库没有 UI 测试框架（无 jsdom / Playwright），于是「这一页打得开
 * 吗」从来没有被自动验证过。而本轮排查里这一类恰恰是重灾区：
 *   - /invoices/[id] 与 /bills/[id] 的路由**根本不存在**，列表一直链过去，
 *     点单号得到 404；
 *   - /offline 被中间件重定向到登录页；
 *   - 收付款页面因为不传待核销单据，勾选区永远不渲染。
 * 这三条全都通过了 tsc、eslint、全部单元测试与 next build。
 *
 * 这个脚本不替代 E2E，它只回答一个问题——**每一页都打得开吗**。但那个
 * 问题此前一次都没被自动问过，而它的答案曾经是「有几页打不开」。
 *
 * 路由清单从 app/ 目录扫出来，不手写：手写的清单会在下一次加页面时悄悄
 * 漏掉，而漏掉的那一页正是没人验证过的那一页。
 *
 * 用法：
 *   node scripts/dev-route-sweep.mjs --base http://localhost:3000 \
 *        --slug ui-check-xxx --cookie-file ._sess.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const base = arg('base', 'http://localhost:3000');
const slug = arg('slug');
const cookieFile = arg('cookie-file', '._sess.json');
if (!slug) {
  console.error('--slug 必填（那家测试公司的 slug）。');
  process.exit(1);
}

const session = JSON.parse(fs.readFileSync(path.join(rootDir, cookieFile), 'utf8').trim());
const cookieHeader = session.cookies.map(([n, v]) => `${n}=${v}`).join('; ');

/** 从 app/ 目录扫出所有 page.tsx，转成可请求的路径。 */
function discoverRoutes(dir, segments = []) {
  const routes = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const name = entry.name;
      // (auth) / (app) 这类 route group 不出现在 URL 里。
      const next = /^\(.+\)$/.test(name) ? segments : [...segments, name];
      routes.push(...discoverRoutes(path.join(dir, name), next));
    } else if (entry.name === 'page.tsx') {
      routes.push('/' + segments.join('/'));
    }
  }
  return routes;
}

/**
 * 动态段填什么。
 *
 * [orgSlug] 填那家测试公司；其余动态段（[id]、[token]）没有可用的真实值，
 * 跳过——它们要么需要先造一张单据，要么本来就该 404。这个脚本要回答的是
 * 「静态路由打得开吗」，不是「每个 id 都存在吗」。
 */
const routes = discoverRoutes(path.join(rootDir, 'app'))
  .map((route) => route.replace('[orgSlug]', slug))
  .filter((route) => !/\[/.test(route))
  .sort();

/**
 * 「这一页打得开」之外还要问「这一页上确实有那个功能」。
 *
 * 收付款页此前正是 200 却不可用：`payments/new/page.tsx` 从不传
 * outstandingInvoices，于是勾选区永远不渲染——那个页面事实上记不出任何
 * 一笔款，而任何只看状态码的检查都会说它是好的。
 *
 * 所以这里给几条新功能的路由各挂一个标志串。它们都取自 i18n 的中文文案
 * 或稳定的 class 名，不是随手抓的实现细节：文案改了这个检查会红，而那
 * 正是应该有人看一眼的时刻。
 */
const CONTENT_CHECKS = {
  '/{slug}/settings/year-end': ['年度结转'],
  '/{slug}/payments/new': ['汇率', '核销'],
  '/{slug}/bills/new': ['税率'],
  '/{slug}/credit-notes/new': ['汇率'],
  '/{slug}/purchase-orders/new': ['汇率'],
  '/{slug}/bank-import': ['日期顺序'],
  '/{slug}/settings/general': ['财年'],
  '/{slug}/settings/members': ['邀请'],
  '/{slug}/reports': ['试算平衡表'],
};

const results = [];
for (const route of routes) {
  const url = `${base}${route === '' ? '/' : route}`;
  try {
    const response = await fetch(url, {
      headers: { cookie: cookieHeader, 'accept-language': 'zh-CN,zh;q=0.9' },
      redirect: 'manual',
    });

    const template = route.replace(slug, '{slug}');
    const expected = CONTENT_CHECKS[template];
    let missing;
    if (expected && response.status === 200) {
      const html = await response.text();
      missing = expected.filter((needle) => !html.includes(needle));
    }

    results.push({
      route,
      status: response.status,
      location: response.headers.get('location'),
      missing: missing && missing.length > 0 ? missing : undefined,
    });
  } catch (error) {
    results.push({ route, status: 0, error: error.message });
  }
}

const bad = results.filter((r) => r.status >= 400 || r.status === 0 || r.missing);
const redirects = results.filter((r) => r.status >= 300 && r.status < 400);
const ok = results.filter((r) => r.status >= 200 && r.status < 300);

for (const r of results) {
  const mark = r.status >= 400 || r.status === 0 || r.missing ? '✗' : r.status >= 300 ? '→' : '✓';
  const extra = r.error
    ? ` ${r.error}`
    : r.missing
      ? `  ← 页面打得开，但找不到：${r.missing.join('、')}`
      : r.location
        ? ` -> ${r.location}`
        : '';
  console.log(`${mark} ${String(r.status).padStart(3)} ${r.route}${extra}`);
}

console.log(`\n共 ${results.length} 条：${ok.length} 正常 / ${redirects.length} 跳转 / ${bad.length} 失败`);
if (bad.length > 0) process.exitCode = 1;
