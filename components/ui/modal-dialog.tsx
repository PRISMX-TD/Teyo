'use client';

import { useEffect, useId, useRef } from 'react';

type Props = {
  open: boolean;
  /** Esc、取消按钮、以及浏览器自己关掉对话框时都会调用它。 */
  onClose: () => void;
  /** 可见标题，同时通过 aria-labelledby 作为对话框的无障碍名称。 */
  title: string;
  /** 额外的类名，用来给某一类对话框调宽度（见 .app-dialog--wide）。 */
  className?: string;
  children: React.ReactNode;
};

/**
 * 全站唯一的模态对话框。
 *
 * 为什么不直接写 `<dialog open>`：那是**非模态**对话框，浏览器只是把它显示
 * 出来，其余什么都不做。具体代价是四条，作废交易的确认框每一条都踩到了：
 *
 *   1. 没有焦点陷阱。Tab 会从对话框里跑到背后那张仍然可交互的表单上，用户
 *      在看不见光标的地方继续改金额和分类。
 *   2. Esc 不关闭。非模态对话框不参与「关闭请求」，按 Esc 没有任何反应。
 *   3. 背景不 inert。读屏用户可以一路念到对话框后面的内容，完全不知道自己
 *      正站在一个「确认作废」的问题前面。
 *   4. **不生成 ::backdrop**。`app/globals.css` 里那条 `::backdrop` 遮罩规则
 *      因此从来没有渲染过——屏幕上只有一个浮在正文上的方框，既没有变暗的
 *      背景，也就没有「这是个必须先回答的问题」这个视觉信号。
 *
 * `showModal()` 一次性解决这四条：它把元素提到 top layer、给背景加 inert、
 * 接管 Esc、并生成 ::backdrop。代价是必须用 ref 命令式调用，不能靠 JSX 属性，
 * 所以需要这个组件把命令式的部分收在一个地方。
 *
 * 两个容易漏的同步点：
 *
 *   - `close` 事件。用户按 Esc 时是**浏览器**关掉了对话框，React 的 open
 *     state 不会跟着变。不把 close 事件接回 onClose，state 就会停在 true，
 *     下次点「作废」时 `open` 没有发生 false→true 的变化，effect 不重跑，
 *     对话框再也打不开。
 *   - 焦点归位。原生 close 在多数浏览器会把焦点还给触发元素，但这依赖
 *     dialog 一直挂载且触发元素还在。这里自己记下 activeElement 再放回去，
 *     不然键盘用户关掉对话框后焦点落在 <body> 上，得从页面顶部重新 Tab。
 */
export function ModalDialog({ open, onClose, title, className, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      openerRef.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
      // 只在确实由我们关闭时归位，避免抢走用户已经移到别处的焦点。
      openerRef.current?.focus?.();
      openerRef.current = null;
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={className ? `app-dialog ${className}` : 'app-dialog'}
      aria-labelledby={titleId}
      onClose={onClose}
    >
      <h2 id={titleId} className="app-dialog-title">
        {title}
      </h2>
      {children}
    </dialog>
  );
}
