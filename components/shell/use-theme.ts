'use client';

import { useCallback, useSyncExternalStore } from 'react';

type Theme = 'dark' | 'light';

/**
 * 订阅 <html data-theme>。theme-script 在首帧之前写好它，切换时也只改它——
 * 它是唯一的真相。原来 Sidebar、FloatingDock、ThemeToggleButton 各持一份
 * useState：在一处切换后，另一处的 state 还停在旧值，下次在那里点「切换」
 * 算出来的 next 正好等于当前主题，看上去按了没反应。
 */
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

function readTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

// 服务端不知道用户的主题，与原来的 useState 初值一致取 dark；水合后
// useSyncExternalStore 会自动换成真实值，不产生水合不匹配。
const serverTheme = (): Theme => 'dark';

/**
 * 主题读写集中在这里，Sidebar（桌面端）和 FloatingDock（移动端）共用，
 * 避免两处各自维护一份 localStorage/matchMedia 逻辑而慢慢跑偏。
 *
 * 直接读 theme-script 已经写好的 data-theme，而不是把 localStorage/
 * matchMedia 的判定再做一遍：原来这里不校验 localStorage 里的值（存了
 * 个坏值就把它原样塞进 state），也不 try（隐私模式下 localStorage 会抛，
 * 整个侧栏跟着崩），与 theme-script 的判定逐渐跑偏。
 */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, readTheme, serverTheme);

  // 副作用不再放在 setState 的 updater 里：updater 必须是纯函数，
  // StrictMode 下会被调用两次。
  const toggle = useCallback(() => {
    const next: Theme = readTheme() === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem('teyo-theme', next);
    } catch {
      // 存不住只是下次打开时不记得，这一次照样切换。
    }
    document.documentElement.setAttribute('data-theme', next);
  }, []);

  return { theme, toggle };
}
