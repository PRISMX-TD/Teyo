'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { interpolate, type Messages } from '@/lib/i18n';
import { ALLOWED_LOGO_TYPES, MAX_LOGO_BYTES } from '@/lib/upload-rules';
import { removeOrganizationLogo, uploadOrganizationLogo } from '@/server/actions/organizations';

/**
 * 公司 logo 的上传、替换与移除。
 *
 * 不放进下面那张「公司资料」表单：那是一个原生 <form> + Server Action，
 * 文件要跟着整张表单一起提交，换个 logo 就得把时区、财年这些字段一起再存
 * 一遍。logo 自己一个动作，选完即传。
 */
export function LogoUploader({
  orgSlug,
  orgName,
  hasLogo,
  logoUrl,
  t,
}: {
  orgSlug: string;
  orgName: string;
  /** 库里有 logo_path。与 logoUrl 分开传：有 logo 但签名 URL 取不到时要说清楚。 */
  hasLogo: boolean;
  logoUrl: string | null;
  t: Messages;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;

    setError(null);
    // 这里先拦一次只是为了当场说清楚，服务端那一道才是准的。
    if (!ALLOWED_LOGO_TYPES.includes(file.type)) {
      setError(t.settings.logoWrongType);
      input.value = '';
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setError(t.settings.logoTooLarge);
      input.value = '';
      return;
    }

    setPending(true);
    try {
      await uploadOrganizationLogo(orgSlug, file);
      // 新图的签名 URL 由服务端组件生成，刷新一次才拿得到。
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
      input.value = '';
    }
  }

  async function handleRemove() {
    if (!window.confirm(t.settings.logoRemoveConfirm)) return;
    setPending(true);
    setError(null);
    try {
      await removeOrganizationLogo(orgSlug);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="logo-uploader">
      <div className="logo-uploader-preview">
        {logoUrl ? (
          // 签名 URL 每次都不一样、一小时后失效，next/image 的优化缓存在这里
          // 只会存下一堆过期的副本；而它还要求在 next.config.ts 里登记远端域名。
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt={interpolate(t.settings.logoAlt, { name: orgName })} />
        ) : (
          <p className="text-muted">{hasLogo ? t.settings.logoUnavailable : t.settings.logoNone}</p>
        )}
      </div>

      <div className="logo-uploader-actions">
        {/* 文件框用视觉隐藏而不是 display:none：后者会把它从 Tab 顺序里拿掉，
            键盘用户就再也够不到这个按钮。 */}
        <label className="attachment-upload-label">
          <input
            type="file"
            accept={ALLOWED_LOGO_TYPES.join(',')}
            onChange={handleChange}
            disabled={pending}
          />
          {pending ? t.common.loading : hasLogo ? t.settings.logoReplace : t.settings.logoUpload}
        </label>
        {hasLogo ? (
          <button type="button" onClick={handleRemove} disabled={pending}>
            {t.settings.logoRemove}
          </button>
        ) : null}
      </div>

      <p className="field-hint">{t.settings.logoHint}</p>

      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
