'use client';

import { NavIcon } from './nav-icons';
import { useTheme } from './use-theme';

type Props = {
  label: string;
};

/**
 * 移动端主题切换的唯一入口——侧栏在 768px 以下 display:none。这个按钮活在
 * /more 页面里，走 .settings-index 的行样式（52px）：左边行图标、中间文案、
 * 右边一个 iOS 开关。开关只是外观，状态在按钮自己的 aria-pressed 上。
 */
export function ThemeToggleButton({ label }: Props) {
  const { theme, toggle } = useTheme();

  return (
    <button type="button" aria-pressed={theme === 'dark'} onClick={toggle}>
      <span className="row-icon">
        <NavIcon name="theme" size={18} />
      </span>
      <span className="row-label">{label}</span>
      <span className="theme-switch" aria-hidden="true" />
    </button>
  );
}
