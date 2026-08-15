'use client';

import { useState, useEffect, useCallback } from 'react';

/**
 * 主题读写集中在这里，Sidebar（桌面端）和 FloatingDock（移动端）共用，
 * 避免两处各自维护一份 localStorage/matchMedia 逻辑而慢慢跑偏。
 */
export function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    const stored = localStorage.getItem('teyo-theme') as 'dark' | 'light' | null;
    if (stored) {
      setTheme(stored);
    } else {
      const preferred = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      setTheme(preferred);
    }
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem('teyo-theme', next);
      document.documentElement.setAttribute('data-theme', next);
      return next;
    });
  }, []);

  return { theme, toggle };
}
