'use client';

import { useState } from 'react';
import {
  deleteAttachment,
  getAttachmentSignedUrl,
  uploadAttachment,
  uploadBillAttachment,
} from '@/server/actions/attachments';
import { interpolate, type Messages } from '@/lib/i18n';
import { ALLOWED_ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES } from '@/lib/upload-rules';

type Attachment = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 选完文件当场判一次类型和大小，规则与服务端是同一份（lib/upload-rules.ts）。
 * 不过的返回一句说明，过的返回 null。新建交易的表单也用它。
 */
export function attachmentIssue(file: File, t: Messages): string | null {
  if (!ALLOWED_ATTACHMENT_TYPES.includes(file.type)) {
    return interpolate(t.transaction.receiptWrongType, { name: file.name });
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return interpolate(t.transaction.receiptTooLarge, { name: file.name });
  }
  return null;
}

export function AttachmentPanel({
  orgSlug,
  owner,
  attachments: initial,
  t,
  readOnly = false,
  labels,
}: {
  orgSlug: string;
  /** 附件挂在哪：一笔交易，或一张供应商账单。 */
  owner: { type: 'transaction' | 'bill'; id: string };
  attachments: Attachment[];
  t: Messages;
  /**
   * 无权改这笔交易的人（viewer、看别人记录的 bookkeeper）只能看凭证。
   * 上传与删除的按钮对他们只会换来一句服务端拒绝。
   */
  readOnly?: boolean;
  /** 标题、空状态与上传按钮的文案。缺省是交易那一套「收据」。 */
  labels?: { title: string; empty: string; add: string };
}) {
  const text = labels ?? {
    title: t.transaction.receipt,
    empty: t.transaction.noReceipts,
    add: t.transaction.receiptAdd,
  };
  const [items, setItems] = useState(initial);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewedItem = items.find((item) => item.id === previewId) ?? null;

  /**
   * 一次可以选好几个文件（一张收据拍了正反两面、一份账单分了几页），逐个上传。
   * 不并发：Server Action 的请求体上限是 12MB，几张照片一起发很容易撞上，
   * 而一个一个传时哪一张失败了也说得清。前面传成功的不会因为后面某一张
   * 失败而被撤回——它们已经是完整的凭证了。
   */
  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const files = Array.from(input.files ?? []);
    if (files.length === 0) return;

    setUploading(true);
    setError(null);
    const problems: string[] = [];
    try {
      for (const file of files) {
        const issue = attachmentIssue(file, t);
        if (issue) {
          problems.push(issue);
          continue;
        }
        try {
          const result =
            owner.type === 'transaction'
              ? await uploadAttachment(orgSlug, owner.id, file)
              : await uploadBillAttachment(orgSlug, owner.id, file);
          setItems((prev) => [
            ...prev,
            { id: result.id, fileName: file.name, mimeType: file.type, sizeBytes: file.size },
          ]);
        } catch (err) {
          problems.push(`${file.name}: ${(err as Error).message}`);
        }
      }
    } finally {
      setUploading(false);
      input.value = '';
      if (problems.length > 0) setError(problems.join('\n'));
    }
  }

  async function handlePreview(attachmentId: string) {
    if (previewId === attachmentId) {
      setPreviewId(null);
      setPreviewUrl(null);
      return;
    }
    try {
      const url = await getAttachmentSignedUrl(orgSlug, attachmentId);
      setPreviewUrl(url);
      setPreviewId(attachmentId);
    } catch {
      setError(t.transaction.previewFailed);
    }
  }

  async function handleDelete(attachmentId: string, fileName: string) {
    // 删掉的凭证找不回来（库里那一行和存储里的对象都会删），点一下就没了
    // 太轻了——两个按钮挨在一起，误点的是哪一个只有读屏用户分得清。
    if (!window.confirm(interpolate(t.transaction.deleteAttachmentConfirm, { name: fileName }))) {
      return;
    }
    try {
      await deleteAttachment(orgSlug, attachmentId);
      setItems((prev) => prev.filter((a) => a.id !== attachmentId));
      if (previewId === attachmentId) {
        setPreviewId(null);
        setPreviewUrl(null);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section className="attachment-panel">
      <h2>{text.title}</h2>

      {items.length > 0 ? (
        <ul className="attachment-list">
          {items.map((item) => (
            <li key={item.id}>
              <span className="attachment-name">{item.fileName}</span>
              <span className="attachment-size">{formatFileSize(item.sizeBytes)}</span>
              {/* \u8fd9\u4e24\u4e2a\u6309\u94ae\u7684\u53ef\u89c1\u5185\u5bb9\u53ea\u6709 \u2715 / \u25b6 / \u00d7 \u4e09\u4e2a\u7b26\u53f7\uff0c\u8bfb\u5c4f\u5ff5\u51fa\u6765
                  \u5c31\u662f\u300c\u6309\u94ae\u300d\u300c\u6309\u94ae\u300d\u2014\u2014\u4e00\u884c\u91cc\u6709\u4e24\u4e2a\u540c\u540d\u6309\u94ae\uff0c\u5176\u4e2d\u4e00\u4e2a\u4f1a
                  \u6c38\u4e45\u5220\u6389\u51ed\u8bc1\u3002aria-label \u5e26\u4e0a\u6587\u4ef6\u540d\uff0c\u624d\u5206\u5f97\u6e05\u5220\u7684\u662f\u54ea\u5f20\u3002
                  \u7b26\u53f7\u672c\u8eab aria-hidden\uff0c\u5426\u5219\u8bfb\u5c4f\u4f1a\u628a\u6807\u7b7e\u548c\u7b26\u53f7\u5ff5\u4e24\u904d\u3002 */}
              <button
                type="button"
                className="attachment-preview-btn"
                aria-expanded={previewId === item.id}
                aria-label={interpolate(
                  previewId === item.id
                    ? t.transaction.previewClose
                    : t.transaction.previewOpen,
                  { name: item.fileName },
                )}
                onClick={() => handlePreview(item.id)}
              >
                <span aria-hidden="true">{previewId === item.id ? '\u2715' : '\u25b6'}</span>
              </button>
              {!readOnly ? (
                <button
                  type="button"
                  className="attachment-delete-btn"
                  aria-label={interpolate(t.transaction.deleteAttachment, { name: item.fileName })}
                  onClick={() => handleDelete(item.id, item.fileName)}
                >
                  <span aria-hidden="true">&times;</span>
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        // 原来借用的是 t.transaction.empty（「没有符合筛选的记录」），
        // 这里没有任何筛选。
        <p className="text-muted">{text.empty}</p>
      )}

      {previewUrl && previewedItem?.mimeType === 'application/pdf' ? (
        // PDF 塞进 <img> 只会显示一个破图标。给一个新标签页打开的链接，
        // 签名 URL 本来就是短时效的，浏览器自带的 PDF 查看器接得住。
        <div className="attachment-preview">
          <a href={previewUrl} target="_blank" rel="noopener noreferrer">
            {previewedItem.fileName}
          </a>
        </div>
      ) : previewUrl ? (
        <div className="attachment-preview">
          {/* alt="" 是「这张图纯装饰，跳过它」的意思。凭证图片恰恰相反——
              它是这笔账的证据，读屏用户至少要知道自己打开的是哪一张。
              图片内容本身我们读不出来，所以退而给出文件名。 */}
          {/* 这里不能用 next/image：previewUrl 是一个 blob: URL（签名 URL
              取回后在浏览器里生成的），next/image 的优化管线只认得 http(s)
              与 public/ 下的静态文件，blob: 会直接报错。
              明确关掉这条规则，而不是让它作为一条常驻告警——常驻的告警
              等于没有告警。 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewUrl}
            alt={interpolate(t.transaction.receiptImageAlt, {
              name: previewedItem?.fileName ?? '',
            })}
          />
        </div>
      ) : null}

      {!readOnly ? (
        <div className="attachment-panel-actions">
          {/* 原来这个文件框带着 style={{ display: 'none' }}，把 globals.css 里
              给它写好的视觉隐藏规则盖掉了：display:none 的输入框不进 Tab 顺序，
              键盘用户根本够不到上传。 */}
          <label className="attachment-upload-label">
            <input
              type="file"
              multiple
              accept={ALLOWED_ATTACHMENT_TYPES.join(',')}
              onChange={handleUpload}
              disabled={uploading}
            />
            {uploading ? t.common.loading : `+ ${text.add}`}
          </label>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="form-error attachment-errors">
          {error}
        </p>
      ) : null}
    </section>
  );
}
