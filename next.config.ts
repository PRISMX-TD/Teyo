import withSerwistInit from '@serwist/next';
import type { NextConfig } from 'next';

const withSerwist = withSerwistInit({
  swSrc: 'app/sw.ts',
  swDest: 'public/sw.js',
  // 开发时关掉，避免缓存干扰调试
  disable: process.env.NODE_ENV === 'development',
});

const nextConfig: NextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: '12mb' },
  },
};

export default withSerwist(nextConfig);
