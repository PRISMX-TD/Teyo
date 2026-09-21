'use client';

import { useState } from 'react';
import { uploadAttachment, deleteAttachment, getAttachmentSignedUrl } from '@/server/actions/attachments';
import { interpolate, type Messages } from '@/lib/i18n';

type Attachment = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentPanel({
  orgSlug,
  transactionId,
  attachments: initial,
  t,
}: {
  orgSlug: string;
  transactionId: string;
  attachments: Attachment[];
  t: Messages;
}) {
  const [items, setItems] = useState(initial);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewedItem = items.find((item) => item.id === previewId) ?? null;

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setError(null);
    try {
      const result = await uploadAttachment(orgSlug, transactionId, file);
      setItems((prev) => [
        ...prev,
        { id: result.id, fileName: file.name, mimeType: file.type, sizeBytes: file.size },
      ]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      if (e.target) e.target.value = '';
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

  async function handleDelete(attachmentId: string) {
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
      <h2>{t.transaction.receipt}</h2>

      {items.length > 0 ? (
        <ul className="attachment-list">
          {items.map((item) => (
            <li key={item.id}>
              <span className="attachment-name">{item.fileName}</span>
              <span className="attachment-size">{fmtSize(item.sizeBytes)}</span>
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
              <button
                type="button"
                className="attachment-delete-btn"
                aria-label={interpolate(t.transaction.deleteAttachment, { name: item.fileName })}
                onClick={() => handleDelete(item.id)}
              >
                <span aria-hidden="true">&times;</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">{t.transaction.empty}</p>
      )}

      {previewUrl ? (
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

      <label className="attachment-upload-label">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
          onChange={handleUpload}
          disabled={uploading}
          style={{ display: 'none' }}
        />
        {uploading ? t.common.loading : `+ ${t.transaction.receipt}`}
      </label>

      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
