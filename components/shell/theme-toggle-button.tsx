'use client';

import { useTheme } from './use-theme';

type Props = {
  label: string;
};

/**
 * 移动端主题切换的唯一入口——桌面侧栏的 .theme-toggle 高度只有 auto（远低于
 * 44px），且侧栏在 768px 以下 display:none。这个按钮活在 /more 页面里，走
 * .settings-index 的行样式（52px），不是 dock 上原来那个纯图标按钮：
 * 8 格 dock 在 375px 都放不下（见该功能的第二版 375px 测量），把它挪到这里
 * 之后连按钮本身带的文字标签都能显示全，不用再省成一个图标。
 */
export function ThemeToggleButton({ label }: Props) {
  const { theme, toggle } = useTheme();

  return (
    <button type="button" onClick={toggle}>
      <span>{label}</span>
      <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
    </button>
  );
}
