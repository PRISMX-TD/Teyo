import type { MetadataRoute } from 'next';

/**
 * 用 TS 而不是静态 .webmanifest：图标交给 app/icon.tsx 动态生成，
 * 路径由 Next.js 注入（带内容哈希），写死 /icon-192.png 会 404。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Teyo',
    short_name: 'Teyo',
    description: 'The easy way to own your business.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f7f9f8',
    theme_color: '#0f7a5f',
    icons: [
      {
        src: '/icon',
        sizes: '192x192',
        type: 'image/png',
      },
    ],
  };
}
