'use client';

import { useState, type InputHTMLAttributes } from 'react';
import { Eye, EyeSlash } from '@/components/ui/icons';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  showLabel: string;
  hideLabel: string;
};

/**
 * 密码框 + 右侧一颗「显示 / 隐藏」。
 *
 * 手机上输密码最常见的失败是打错一个字却看不见——尤其是改密码时只输一次、
 * 没有「再输一遍」。按一下就能核对，比再加一个确认框更省事。
 * 按钮的名字跟着动作走（「显示密码」/「隐藏密码」），不再叠一个
 * aria-pressed：两个都变，读屏器会念成「隐藏密码，已按下」，意思反了。
 */
export function PasswordInput({ showLabel, hideLabel, className, ...inputProps }: Props) {
  const [visible, setVisible] = useState(false);

  return (
    <span className={className ? `password-field ${className}` : 'password-field'}>
      <input {...inputProps} type={visible ? 'text' : 'password'} />
      <button
        type="button"
        aria-label={visible ? hideLabel : showLabel}
        aria-controls={inputProps.id}
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? (
          <EyeSlash size={20} aria-hidden="true" />
        ) : (
          <Eye size={20} aria-hidden="true" />
        )}
      </button>
    </span>
  );
}
