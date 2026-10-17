'use client';

import { useState } from 'react';
import { interpolate, type Messages } from '@/lib/i18n';
import { fitWithin, PAYMENT_IMAGE_MAX_EDGE } from '@/lib/payment-image';
import { ALLOWED_LOGO_TYPES, MAX_LOGO_BYTES, MAX_PAYMENT_IMAGES } from '@/lib/upload-rules';
import {
  removePaymentDetailsImage,
  uploadPaymentDetailsImage,
} from '@/server/actions/organizations';

type PaymentImage = { path: string; url: string | null };

/** 浏览器读不了、或缩到最小仍然超过 1MB。各自一句话，不把 canvas 的报错甩给用户。 */
class ImageNotUsable extends Error {}

/**
 * 把贴进来的图片变成 branding bucket 收得下的样子（规则见 lib/payment-image.ts）。
 *
 * 本来就是 PNG / JPG / WebP、又不超过 1MB 的原样上传。其余的在 canvas 上
 * 重画：先长边 1200 的 PNG（二维码是黑白方块，PNG 无损、边缘锐利），还大就
 * 换 JPEG，再大就缩到 800。GIF、BMP 这些 createImageBitmap 读得了的格式也
 * 顺带转成了 PNG；读不了的（多数浏览器里的 HEIC）说一句换格式。
 */
async function prepareImage(file: File): Promise<File> {
  if (ALLOWED_LOGO_TYPES.includes(file.type) && file.size <= MAX_LOGO_BYTES) return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImageNotUsable('wrong-type');
  }

  const attempts: Array<{ edge: number; type: 'image/png' | 'image/jpeg'; quality?: number }> = [
    { edge: PAYMENT_IMAGE_MAX_EDGE, type: 'image/png' },
    { edge: PAYMENT_IMAGE_MAX_EDGE, type: 'image/jpeg', quality: 0.9 },
    { edge: 800, type: 'image/jpeg', quality: 0.85 },
  ];
  try {
    for (const attempt of attempts) {
      const size = fitWithin(bitmap.width, bitmap.height, attempt.edge);
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext('2d');
      if (!context) break;
      if (attempt.type === 'image/jpeg') {
        // JPEG 没有透明通道，透明的地方会变黑——二维码就成了黑底黑块。
        context.fillStyle = '#fff';
        context.fillRect(0, 0, size.width, size.height);
      }
      context.drawImage(bitmap, 0, 0, size.width, size.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, attempt.type, attempt.quality),
      );
      if (blob && blob.size <= MAX_LOGO_BYTES) {
        const ext = attempt.type === 'image/png' ? 'png' : 'jpg';
        return new File([blob], `payment-image.${ext}`, { type: attempt.type });
      }
    }
  } finally {
    bitmap.close();
  }
  throw new ImageNotUsable('too-large');
}

/** 剪贴板或拖进来的东西里的图片文件。items 比 files 兼容面广（旧版 Safari 只给 items）。 */
function imageFilesOf(data: DataTransfer): File[] {
  const fromItems = Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  if (fromItems.length > 0) return fromItems;
  return Array.from(data.files ?? []).filter((file) => file.type.startsWith('image/'));
}

/**
 * 收款信息：一段文字，外加最多三张图（收款二维码、钱包地址截图）。
 *
 * 文字仍然是外面那张「公司资料」表单的一个字段（name="paymentDetails"），跟着
 * 表单一起保存。图片不是：贴进来、拖进来或选好文件的那一刻就上传，删除也是
 * 当场生效——与 logo 同一个做法，文件不跟着整张表单提交。
 */
export function PaymentDetailsField({
  orgSlug,
  defaultValue,
  images: initial,
  t,
}: {
  orgSlug: string;
  defaultValue: string;
  images: PaymentImage[];
  t: Messages;
}) {
  const [images, setImages] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);

  const full = images.length >= MAX_PAYMENT_IMAGES;

  /**
   * 一张一张传，不并发：哪一张出了问题说得清，也不会几张一起撞上 Server
   * Action 的请求体上限。超出张数的那几张直接说放不下，不偷偷丢掉。
   */
  async function addImages(files: File[]) {
    setError(null);
    const room = MAX_PAYMENT_IMAGES - images.length;
    const problems: string[] = [];
    if (files.length > room) {
      problems.push(interpolate(t.settings.paymentImagesFull, { max: MAX_PAYMENT_IMAGES }));
    }
    const batch = files.slice(0, Math.max(0, room));
    if (batch.length > 0) setPending(true);
    try {
      for (const file of batch) {
        try {
          const prepared = await prepareImage(file);
          const added = await uploadPaymentDetailsImage(orgSlug, prepared);
          setImages((prev) => [...prev, added]);
        } catch (err) {
          problems.push(
            err instanceof ImageNotUsable
              ? err.message === 'too-large'
                ? t.settings.paymentImageTooLarge
                : t.settings.paymentImageWrongType
              : (err as Error).message,
          );
        }
      }
    } finally {
      setPending(false);
      if (problems.length > 0) setError(problems.join('\n'));
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = imageFilesOf(event.clipboardData);
    if (files.length === 0) return; // 普通的文字粘贴，照常进输入框。
    // 上一张还在传：此刻数出来的剩余张数是旧的，再加就可能超过上限。
    if (pending) {
      event.preventDefault();
      return;
    }
    // 从网页上「复制图片」时，剪贴板里常常还带着一段文字。有文字就让它照常
    // 贴进去，图片另外上传；只有一张图时拦下默认行为——否则有的浏览器会把
    // 文件名当文字贴进来。
    if (!event.clipboardData.getData('text/plain')) event.preventDefault();
    void addImages(files);
  }

  function handleDragOver(event: React.DragEvent<HTMLTextAreaElement>) {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    setDropping(true);
  }

  function handleDrop(event: React.DragEvent<HTMLTextAreaElement>) {
    setDropping(false);
    const files = imageFilesOf(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    void addImages(files);
  }

  async function handlePick(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length > 0) await addImages(files);
  }

  async function handleRemove(image: PaymentImage) {
    if (!window.confirm(t.settings.paymentImageRemoveConfirm)) return;
    setPending(true);
    setError(null);
    try {
      await removePaymentDetailsImage(orgSlug, image.path);
      setImages((prev) => prev.filter((item) => item.path !== image.path));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="payment-details-field">
      <textarea
        id="paymentDetails"
        name="paymentDetails"
        rows={3}
        maxLength={500}
        aria-describedby="paymentDetailsHint"
        defaultValue={defaultValue}
        className={dropping ? 'is-drop-target' : undefined}
        onPaste={handlePaste}
        onDragOver={handleDragOver}
        onDragLeave={() => setDropping(false)}
        onDrop={handleDrop}
      />
      <p id="paymentDetailsHint" className="field-hint">
        {interpolate(t.settings.paymentDetailsHint, { max: MAX_PAYMENT_IMAGES })}
      </p>

      {images.length > 0 ? (
        <ul className="payment-details-images">
          {images.map((image, index) => (
            <li key={image.path}>
              {image.url ? (
                // 签名 URL 一小时后失效，理由同 logo-uploader.tsx。
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={image.url}
                  alt={interpolate(t.settings.paymentImageAlt, { n: index + 1 })}
                />
              ) : (
                <p className="text-muted">{t.settings.paymentImageUnavailable}</p>
              )}
              <button
                type="button"
                className="btn-small btn-danger"
                aria-label={interpolate(t.settings.paymentImageRemoveLabel, { n: index + 1 })}
                onClick={() => handleRemove(image)}
                disabled={pending}
              >
                {t.common.delete}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {!full ? (
        <div className="payment-details-actions">
          {/* 手机上没法往输入框里粘贴截图，给一个选文件的入口。文件框没有
              name，不会跟着外面那张表单提交。 */}
          <label className="attachment-upload-label">
            <input type="file" accept="image/*" multiple onChange={handlePick} disabled={pending} />
            {pending ? t.common.loading : `+ ${t.settings.paymentImageAdd}`}
          </label>
        </div>
      ) : pending ? (
        <p className="field-hint" role="status">
          {t.common.loading}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="form-error attachment-errors">
          {error}
        </p>
      ) : null}
    </div>
  );
}
