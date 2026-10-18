import Link from 'next/link';
import type { ReactNode } from 'react';
import { CaretLeft } from './icons';

/**
 * 页面左上角的「‹ 返回」。原来是 15 处各写一遍 `&larr; {文案}`：一个
 * 文字箭头，粗细跟着字体走，中英文下高低还不一样。现在是一个图标 +
 * 文案，iOS 导航栏左上角的样子。
 */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="back-link">
      <CaretLeft size={18} weight="bold" aria-hidden="true" />
      <span>{children}</span>
    </Link>
  );
}
