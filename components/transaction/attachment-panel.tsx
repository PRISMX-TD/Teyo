'use client';

import { useState } from 'react';
import { uploadAttachment, deleteAttachment, getAttachmentSignedUrl } from '@/server/actions/attachments';
import type { Messages } from '@/lib/i18n';

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
      setError('Could not load preview.');
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
              <button
                type="button"
                className="attachment-preview-btn"
                onClick={() => handlePreview(item.id)}
              >
                {previewId === item.id ? '\u2715' : '\u25b6'}
              </button>
              <button
                type="button"
                className="attachment-delete-btn"
                onClick={() => handleDelete(item.id)}
              >
                &times;
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">{t.transaction.empty}</p>
      )}

      {previewUrl ? (
        <div className="attachment-preview">
          <img src={previewUrl} alt="" />
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
