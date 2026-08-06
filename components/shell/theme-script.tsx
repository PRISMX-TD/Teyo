'use client';

import { useEffect } from 'react';

/**
 * 在客户端挂载后立即从 localStorage 读取主题偏好并应用到 <html>。
 * 同时监听系统主题变化（当用户未手动设置时）。
 */
export function ThemeScript() {
  useEffect(() => {
    const stored = localStorage.getItem('teyo-theme');
    if (stored === 'dark' || stored === 'light') {
      document.documentElement.setAttribute('data-theme', stored);
    } else {
      const preferred = window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark';
      document.documentElement.setAttribute('data-theme', preferred);
    }
  }, []);

  return null;
}
