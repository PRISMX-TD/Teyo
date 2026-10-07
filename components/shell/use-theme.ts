'use client';

import { useState, useEffect, useCallback } from 'react';

/**
 * 主题读写集中在这里，Sidebar（桌面端）和 FloatingDock（移动端）共用，
 * 避免两处各自维护一份 localStorage/matchMedia 逻辑而慢慢跑偏。
 */
export function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    // 直接读 theme-script 已经写好的 data-theme，而不是把 localStorage/
    // matchMedia 的判定再做一遍：原来这里不校验 localStorage 里的值（存了
    // 个坏值就把它原样塞进 state），也不 try（隐私模式下 localStorage 会抛，
    // 整个侧栏跟着崩），与 theme-script 的判定逐渐跑偏。
    const current = document.documentElement.getAttribute('data-theme');
    setTheme(current === 'light' ? 'light' : 'dark');
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem('teyo-theme', next);
      } catch {
        // 存不住只是下次打开时不记得，这一次照样切换。
      }
      document.documentElement.setAttribute('data-theme', next);
      return next;
    });
  }, []);

  return { theme, toggle };
}
