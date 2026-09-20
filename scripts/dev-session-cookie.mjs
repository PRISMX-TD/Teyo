#!/usr/bin/env node
/**
 * 给一个一次性测试账号换出一份可用的浏览器会话 cookie。
 *
 * 用途与 scripts/dev-login-link.mjs 相同——在本地跑起来的应用上做界面
 * 验收——但走的是另一条路：那个脚本给出的 magic link 指向 Supabase 的
 * 域名，而验收用的浏览器面板只允许访问 localhost。
 *
 * 这个脚本在**服务端**把一次性 token 换成 session，然后把它编码成
 * @supabase/ssr 在浏览器里用的那个 cookie，打印出来由调用方 set 进去。
 * 全程没有任何密码经过任何输入框。
 *
 * cookie 格式不是猜的，逐项对着 node_modules/@supabase/ssr 读出来的：
 *   名字     sb-<supabase 主机名第一段>-auth-token
 *            （@supabase/supabase-js 的 defaultStorageKey）
 *   值       "base64-" + base64url(JSON.stringify(session))
 *            （@supabase/ssr/dist/main/cookies.js 的 BASE64_PREFIX）
 *   分块     超过 3180 字节切成 .0 / .1 …
 *            （@supabase/ssr/dist/main/utils/chunker.js 的 MAX_CHUNK_SIZE）
 * 版本升级把这三样中的任何一样改掉，这个脚本就会失效——它是验收工具，
 * 不是产品代码，失效时表现为「登不进去」，不会影响任何线上行为。
 *
 * 安全边界与 dev-login-link.mjs 相同：拒绝 production、拒绝非
 * @example.com 的邮箱。
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadEnv({ path: path.join(rootDir, '.env.local') });

if (process.env.NODE_ENV === 'production') {
  console.error('这个脚本只用于本地验收，拒绝在 NODE_ENV=production 下运行。');
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !serviceKey || !anonKey) {
  console.error('.env.local 里缺少 Supabase 的 URL / service role key / anon key。');
  process.exit(1);
}

const flagIndex = process.argv.indexOf('--email');
const email =
  flagIndex !== -1 && process.argv[flagIndex + 1]
    ? process.argv[flagIndex + 1]
    : `test-ui-${randomUUID().slice(0, 8)}@example.com`;

if (!email.endsWith('@example.com')) {
  // RFC 2606 保留域名。钉死这一条，这个脚本就不可能给一个真人账号换出会话。
  console.error(`拒绝为非 @example.com 的邮箱生成会话：${email}`);
  process.exit(1);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

const created = await admin.auth.admin.createUser({
  email,
  email_confirm: true,
  user_metadata: { display_name: 'UI Check' },
});
if (created.error && !/already/i.test(created.error.message)) {
  console.error(`建账号失败：${created.error.message}`);
  process.exit(1);
}

// 生成一次性 token，再用 anon 客户端把它换成 session。
// 用 anon key 而不是 service key 换：service key 换出来的 JWT 带的是
// service_role，那不是一个真实用户会话，RLS 会整个失效——验收就白做了。
const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
if (link.error) {
  console.error(`生成链接失败：${link.error.message}`);
  process.exit(1);
}

const anon = createClient(url, anonKey, { auth: { persistSession: false } });
const verified = await anon.auth.verifyOtp({
  token_hash: link.data.properties.hashed_token,
  type: 'magiclink',
});
if (verified.error || !verified.data.session) {
  console.error(`换 session 失败：${verified.error?.message ?? '没有 session'}`);
  process.exit(1);
}

const session = verified.data.session;

const projectRef = new URL(url).hostname.split('.')[0];
const cookieName = `sb-${projectRef}-auth-token`;
const encoded = `base64-${Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')}`;

const MAX_CHUNK_SIZE = 3180;
const cookies =
  encoded.length <= MAX_CHUNK_SIZE
    ? [[cookieName, encoded]]
    : Array.from({ length: Math.ceil(encoded.length / MAX_CHUNK_SIZE) }, (_, i) => [
        `${cookieName}.${i}`,
        encoded.slice(i * MAX_CHUNK_SIZE, (i + 1) * MAX_CHUNK_SIZE),
      ]);

console.log(JSON.stringify({ email, userId: session.user.id, cookies }));
