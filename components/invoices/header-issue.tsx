'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { MutableRefObject, ReactNode } from 'react';

/**
 * 详情页页头的「开具 / 发出」与下面那张可编辑草稿表单之间的一根线。
 *
 * 那颗按钮原来自己调 issueInvoice / issueCreditNote，过账的是上一次存下的
 * 草稿：用户刚改的单价还没存，账上记的是旧数，表单上看着却是新的（贷项
 * 通知单开具后表单直接换成只读视图，改动连痕迹都没有）。现在它只是让表单
 * 「先存、再开具」，存、开具、报错都归表单。
 *
 * 不用 <button type="submit" form="…">：排在表单前面的外部提交按钮会成为
 * 表单的默认按钮，在任何输入框里按回车（手机键盘上的「前往」）都等于点它
 * ——改个参考号按一下回车，发票就开出去了。
 */

type HeaderIssue = {
  pending: boolean;
  error: string | null;
  setPending: (pending: boolean) => void;
  setError: (error: string | null) => void;
  /** 表单挂上来的「先存再开具」。表单不在页上时为 null。 */
  trigger: MutableRefObject<(() => void) | null>;
};

const HeaderIssueContext = createContext<HeaderIssue | null>(null);

export function HeaderIssueProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<(() => void) | null>(null);
  return (
    <HeaderIssueContext.Provider value={{ pending, error, setPending, setError, trigger }}>
      {children}
    </HeaderIssueContext.Provider>
  );
}

/** 页头那颗主按钮。表单在存（不论是哪颗按钮触发的）时它也不可点。 */
export function HeaderIssueButton({ label, loadingLabel }: { label: string; loadingLabel: string }) {
  const ctx = useContext(HeaderIssueContext);
  if (!ctx) return null;
  return (
    <>
      <button
        type="button"
        className="primary-button"
        disabled={ctx.pending}
        onClick={() => ctx.trigger.current?.()}
      >
        {ctx.pending ? loadingLabel : label}
      </button>
      {/* 报在页头：手机上表单底部的报错在屏幕外，等于「点了没反应」。 */}
      {ctx.error ? (
        <p role="alert" className="form-error">
          {ctx.error}
        </p>
      ) : null}
    </>
  );
}

/** 表单用：把 onIssue 挂到页头按钮上。返回 null 表示这一页没有页头按钮（新建页）。 */
export function useHeaderIssue(onIssue: () => void): HeaderIssue | null {
  const ctx = useContext(HeaderIssueContext);
  const latest = useRef(onIssue);
  useEffect(() => {
    latest.current = onIssue;
  });
  const trigger = ctx?.trigger;
  useEffect(() => {
    if (!trigger) return;
    trigger.current = () => latest.current();
    return () => {
      trigger.current = null;
    };
  }, [trigger]);
  return ctx;
}
