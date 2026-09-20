'use client';

import { useEffect, useId, useRef, useState } from 'react';

type Props = {
  /** 打开状态由调用方持有：对话框要知道自己是为哪一行开的。 */
  open: boolean;
  /** 标题，已经插好单据号，例如「作废发票 INV-0007」。 */
  title: string;
  reasonLabel: string;
  reasonHint: string;
  /** 理由为空时那句话。服务端也会拒，但那时用户已经等了一个来回。 */
  requiredMessage: string;
  confirmLabel: string;
  cancelLabel: string;
  pending: boolean;
  /** 上一次提交失败时服务端说的话。留在对话框里，别关掉——关掉用户就得重打一遍理由。 */
  error: string | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
};

/**
 * 作废对话框：要求填写理由，填不出就不让提交。
 *
 * **为什么不照抄 components/transaction/void-button.tsx。**
 * 那个组件写的是 `<dialog open>`。HTML 的 `open` 属性打开的是**非模态**
 * 对话框，它与 `showModal()` 完全不是一回事：
 *
 *   1. 没有焦点陷阱。键盘用户 Tab 一下就跑到对话框后面那张表格里去了，
 *      屏幕上却还盖着一个「你确定要作废吗」——他在操作一个自己看不见的界面。
 *   2. Esc 不关闭。非模态对话框根本不参与「关闭请求」那一套。
 *   3. `::backdrop` 永远不渲染。globals.css 里 `.void-dialog::backdrop`
 *      那两条规则（含 light 主题那条）一天都没有生效过——因为只有
 *      showModal() 打开的对话框才进 top layer，才有 backdrop 这个伪元素。
 *   4. 不进 top layer，于是 z-index 完全受祖先层叠上下文摆布。放进
 *      `<table>` 单元格里尤其危险：表格行上有 `transition`/`background`，
 *      任何一个祖先建立层叠上下文，对话框就会被后面的行盖住。
 *
 * 作废是不可逆的，正是最需要「用户在确认之前不能误触别的东西」的那一类操作。
 * 所以这里用 `ref.showModal()`，并显式写上 `aria-modal="true"` 与
 * `aria-labelledby`——原生 modal dialog 在多数浏览器里已经隐含 aria-modal，
 * 但仍有读屏器组合依赖显式属性，而这个属性写错的代价是零。
 *
 * `onClose` 必须往回同步状态：用户按 Esc 时对话框自己关了，React 那边的
 * `open` 还是 true，下次再点「作废」就什么也不会发生——一个「按钮坏了」
 * 的 bug，而原因在三十行以外。
 */
export function DocumentVoidDialog({
  open,
  title,
  reasonLabel,
  reasonHint,
  requiredMessage,
  confirmLabel,
  cancelLabel,
  pending,
  error,
  onCancel,
  onConfirm,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState('');
  // 只在用户真的按过一次「确认作废」之后才标红。一打开就红着的表单
  // 是在为用户还没犯的错误责备他。
  const [touched, setTouched] = useState(false);
  const titleId = useId();
  const hintId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      // 每次打开都从空白理由开始。留着上一张单据的理由，最可能的结果是
      // 它被原样提交到另一张单据上。
      setReason('');
      setTouched(false);
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  if (!open) return null;

  const blank = reason.trim() === '';

  function handleConfirm() {
    setTouched(true);
    if (blank) return;
    onConfirm(reason.trim());
  }

  return (
    <dialog
      ref={dialogRef}
      className="doc-dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      // Esc 关闭时浏览器自己 close()，状态得跟着回去，否则按钮下次点不动。
      onClose={onCancel}
      // 点遮罩关闭。`event.target === dialog` 只有点在 backdrop 上才成立
      // ——对话框内容是它的子元素，点内容不会冒泡成这个相等判断。
      onClick={(event) => {
        if (event.target === dialogRef.current && !pending) onCancel();
      }}
    >
      <h2 id={titleId} className="doc-dialog__title">
        {title}
      </h2>

      <label htmlFor="voidReason">{reasonLabel}</label>
      <input
        id="voidReason"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        // 空着提交过一次才算无效。aria-invalid 让读屏器在用户回到这个框时
        // 就说出「无效」，而不是只有看得见红框的人知道。
        aria-invalid={touched && blank ? true : undefined}
        aria-describedby={hintId}
        autoFocus
      />
      <p id={hintId} className="field-hint">
        {touched && blank ? requiredMessage : reasonHint}
      </p>

      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}

      <div className="doc-dialog__actions">
        <button type="button" onClick={onCancel} disabled={pending}>
          {cancelLabel}
        </button>
        <button type="button" className="btn-danger" onClick={handleConfirm} disabled={pending}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
