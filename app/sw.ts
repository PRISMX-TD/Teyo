import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import { Serwist, CacheFirst, StaleWhileRevalidate, ExpirationPlugin } from 'serwist';

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: WorkerGlobalScope & typeof globalThis;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,

  // 只用 CacheFirst / StaleWhileRevalidate 处理字体/图片/静态 JS/CSS，
  // 绝不碰 HTML 导航和 RSC payload。HTML 让服务端正常渲染，
  // RSC 由 Next.js router 自行管理，SW 拦截只会引入延迟和缓存不一致。
  runtimeCaching: [
    // 字体（Google Fonts / 自托管）
    {
      matcher: /^https:\/\/fonts\.(?:gstatic)\.com\/.*/i,
      handler: new CacheFirst({
        cacheName: 'google-fonts-webfonts',
        plugins: [new ExpirationPlugin({ maxEntries: 4, maxAgeSeconds: 31536000, maxAgeFrom: 'last-used' })],
      }),
    },
    {
      matcher: /^https:\/\/fonts\.(?:googleapis)\.com\/.*/i,
      handler: new StaleWhileRevalidate({
        cacheName: 'google-fonts-stylesheets',
        plugins: [new ExpirationPlugin({ maxEntries: 4, maxAgeSeconds: 604800, maxAgeFrom: 'last-used' })],
      }),
    },
    // 自托管字体
    {
      matcher: /\.(?:eot|otf|ttc|ttf|woff|woff2|font\.css)$/i,
      handler: new StaleWhileRevalidate({
        cacheName: 'static-font-assets',
        plugins: [new ExpirationPlugin({ maxEntries: 8, maxAgeSeconds: 604800, maxAgeFrom: 'last-used' })],
      }),
    },
    // 图片
    {
      matcher: /\.(?:jpg|jpeg|gif|png|svg|ico|webp)$/i,
      handler: new StaleWhileRevalidate({
        cacheName: 'static-image-assets',
        plugins: [new ExpirationPlugin({ maxEntries: 64, maxAgeSeconds: 2592000, maxAgeFrom: 'last-used' })],
      }),
    },
    // Next.js 静态 JS / CSS 构建产物（带哈希，永不变）
    {
      matcher: /\/_next\/static\/.+\.js$/i,
      handler: new CacheFirst({
        cacheName: 'next-static-js-assets',
        plugins: [new ExpirationPlugin({ maxEntries: 64, maxAgeSeconds: 86400, maxAgeFrom: 'last-used' })],
      }),
    },
    {
      matcher: /\.(?:js)$/i,
      handler: new StaleWhileRevalidate({
        cacheName: 'static-js-assets',
        plugins: [new ExpirationPlugin({ maxEntries: 48, maxAgeSeconds: 86400, maxAgeFrom: 'last-used' })],
      }),
    },
    {
      matcher: /\.(?:css|less)$/i,
      handler: new StaleWhileRevalidate({
        cacheName: 'static-style-assets',
        plugins: [new ExpirationPlugin({ maxEntries: 32, maxAgeSeconds: 86400, maxAgeFrom: 'last-used' })],
      }),
    },
  ],

  fallbacks: {
    entries: [
      {
        url: '/offline',
        matcher: ({ request }) => request.destination === 'document',
      },
    ],
  },
});

serwist.addEventListeners();
