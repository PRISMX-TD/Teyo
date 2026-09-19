import withSerwistInit from '@serwist/next';
import type { NextConfig } from 'next';

const withSerwist = withSerwistInit({
  swSrc: 'app/sw.ts',
  swDest: 'public/sw.js',
  // 开发时关掉，避免缓存干扰调试
  disable: process.env.NODE_ENV === 'development',
});

const isDev = process.env.NODE_ENV === 'development';

/**
 * Supabase 项目的来源，用于 CSP 的 connect-src。
 *
 * 浏览器里的 supabase-js 会直接向这个域发 XHR（登录、刷新 token、对象存储
 * 的签名 URL），realtime 还会开 WebSocket。写死 *.supabase.co 也能跑，但
 * 那等于允许连向任何人的 Supabase 项目；拿得到确切地址时就用确切的。
 *
 * next.config.ts 在构建期求值，而 NEXT_PUBLIC_ 开头的变量在构建期一定注入
 * （客户端包里要内联它们），所以这里读得到。读不到时退回通配，宁可宽一点，
 * 也不要生成一条会把登录打挂的策略。
 */
function supabaseOrigins(): string[] {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return ['https://*.supabase.co', 'wss://*.supabase.co'];
  try {
    const { origin, host } = new URL(url);
    return [origin, `wss://${host}`];
  } catch {
    return ['https://*.supabase.co', 'wss://*.supabase.co'];
  }
}

/**
 * 真正强制生效的那一条 CSP。
 *
 * 只放四条指令，因为这四条在 Next.js 15 + React 19 下不会误伤任何东西，
 * 而它们各自堵住的都是具体的攻击：
 *
 *   frame-ancestors 'none' —— 点击劫持。这条在本应用里不是纸上谈兵：
 *     transferOwnership 是一次点击就完成、且不可逆的操作（把整家公司连同
 *     全部账目转给别人），把它套进一个透明 iframe 再叠一层「领取优惠券」
 *     的按钮，代价就是一家公司。现代浏览器在 CSP 有 frame-ancestors 时会
 *     忽略 X-Frame-Options，所以两个都发：CSP 管新浏览器，XFO 管老的。
 *   base-uri 'self' —— 挡住注入 <base href="//evil"> 把所有相对 URL
 *     （包括 Server Action 的 POST 目标）改道。
 *   form-action 'self' —— 表单只能提交回本站。
 *   object-src 'none' —— <object>/<embed> 这个应用一个都不用。
 *
 * 剩下的 script-src / style-src / connect-src 放在下面的 Report-Only 里，
 * 理由见那里。
 */
const ENFORCED_CSP = [
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/**
 * 想要但还不能强制的那条 CSP，先以 Report-Only 上线。
 *
 * 为什么不直接强制：这条策略里必须写 script-src 'unsafe-inline'，而带了
 * 'unsafe-inline' 的 script-src 基本上等于没有 script-src——它挡不住 XSS，
 * 却足以在某个细节写错时把整个应用打白。Next.js App Router 的每个页面都
 * 内联一段 self.__next_f.push(...) 的 Flight 数据和一段 hydration 脚本，
 * 而且**不带 nonce**，除非在 middleware 里逐请求生成 nonce 并通过
 * `unstable_noStore` 之类的机制透传下去。middleware.ts 不在本次改动范围内，
 * 所以这一步留给后续：加上 nonce 之后，把 'unsafe-inline' 换成
 * 'nonce-...' 'strict-dynamic'，再把这条 header 从 Report-Only 改成强制。
 *
 * 在那之前 Report-Only 也不是摆设——它会把真实流量里的违规上报出来，
 * 让「切成强制会打挂哪些东西」变成一份清单，而不是一次线上事故。
 *
 * 其余几条的来由：
 *   style-src 'unsafe-inline'：组件里大量使用 style={{...}} 内联样式，
 *     next/font 也会注入 <style>。
 *   font-src 'self' data:：next/font 自托管字体，不走 Google 的 CDN。
 *   img-src data: blob:：导出预览与附件缩略图用的是 blob URL。
 *   worker-src 'self' blob:：Serwist 生成的 /sw.js。
 *   script-src 'unsafe-eval' 只在开发时加：React Refresh 需要它，
 *     生产构建不需要。
 */
function reportOnlyCsp(): string {
  const [supabaseHttp, supabaseWs] = supabaseOrigins();

  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    `img-src 'self' data: blob: ${supabaseHttp}`,
    `connect-src 'self' ${supabaseHttp} ${supabaseWs}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

const nextConfig: NextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: '12mb' },
  },

  /**
   * 安全响应头。在这之前一个都没有：没有 CSP、没有 X-Frame-Options、
   * 没有 Referrer-Policy、没有 nosniff、没有 HSTS，vercel.json 里也没有
   * headers 段。
   */
  async headers() {
    return [
      {
        // 所有路径，包括 /api 与静态资源。
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: ENFORCED_CSP },
          { key: 'Content-Security-Policy-Report-Only', value: reportOnlyCsp() },
          // 老浏览器不认 frame-ancestors，靠这条。
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          /**
           * URL 里带着 orgSlug（/acme-trading/transactions/<id>），而 slug 往往
           * 就是公司的真名。默认的 referrer 行为会把整条 URL 发给任何一个
           * 被点开的外链或被加载的第三方资源，等于对外广播「这家公司在用
           * Teyo，而且这是他们的一笔交易」。
           *
           * strict-origin-when-cross-origin 的效果：同源请求照发完整 URL
           * （应用内部的相对跳转需要它），跨源只发 origin（https://teyo.app），
           * 路径与 id 都不出门；降级到 http 时一个字都不发。
           */
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          /**
           * 两年，含子域。不加 preload：preload 是提交给浏览器厂商的一份
           * 名单，进去容易出来极慢，一旦将来有哪个子域必须走 http 就没有
           * 退路。这个应用现在也没有这个必要——它只在 Vercel 上跑，
           * 本来就全程 https。
           */
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains',
          },
          /**
           * 这个应用不用摄像头、麦克风、定位、支付。明确关掉，免得将来某个
           * 第三方脚本（或一个被注入的 iframe）替用户弹出授权框。
           */
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          },
        ],
      },
    ];
  },
};

export default withSerwist(nextConfig);
