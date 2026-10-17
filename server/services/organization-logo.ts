import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { BRANDING_BUCKET, getStorageClient } from '@/lib/supabase/storage';

/**
 * 公司 logo：路径与取图。类型与大小上限在 lib/upload-rules.ts，
 * 设置页的上传框也用那一份。
 */

/**
 * 签名 URL 有效期（秒）。比收据的 300 秒长：logo 不是凭证，而打印页常常
 * 开着放一会儿才按打印——浏览器打印时会重新取一次图片，链接过期的话
 * 纸上那一格就是空的。
 */
export const LOGO_SIGNED_URL_TTL_SECONDS = 3600;

/**
 * 路径形如 `<orgId>/logo-<uuid>.<ext>`。
 *
 * 首段必须是 organization_id，branding 的 Storage 策略靠它判成员关系。
 * 每次上传换一个新文件名而不是覆盖同一个 `logo.png`：覆盖意味着旧图要先删
 * 或要 upsert，而新图上传成功、库里那一行却没写成时，那张旧图已经没了。
 * 原始文件名不进路径，只取扩展名，理由同 buildStoragePath（附件）。
 */
export function buildLogoPath(organizationId: string, fileName: string): string {
  const ext = path.extname(path.basename(fileName)).toLowerCase().replace(/[^.a-z0-9]/g, '');
  return `${organizationId}/logo-${randomUUID()}${ext}`;
}

/**
 * 收款信息里的图片，路径形如 `<orgId>/payment-<uuid>.<ext>`（0038）。
 * 与 logo 同一个 bucket、同一个首段，理由同 buildLogoPath。
 */
export function buildPaymentImagePath(organizationId: string, fileName: string): string {
  const ext = path.extname(path.basename(fileName)).toLowerCase().replace(/[^.a-z0-9]/g, '');
  return `${organizationId}/payment-${randomUUID()}${ext}`;
}

/**
 * 收款信息里每张图的地址，与路径一一对应；某一张取不到就是 null。
 * 吞错的理由同 getLogoSignedUrl：图片取不到不该让发票整页报错。
 */
export async function getPaymentImageUrls(
  paths: readonly string[],
): Promise<Array<{ path: string; url: string | null }>> {
  return Promise.all(paths.map(async (p) => ({ path: p, url: await getLogoSignedUrl(p) })));
}

/**
 * 给页面用的 logo 地址，取不到就返回 null。
 *
 * 这里吞掉错误是刻意的：logo 是装饰，发票是正事。Storage 暂时不可用、
 * SUPABASE_SERVICE_ROLE_KEY 没配、对象被人从控制台删了——这些都不该让
 * 打印发票这一页整个报错，没有 logo 的发票照样是一张发票。
 */
export async function getLogoSignedUrl(logoPath: string | null): Promise<string | null> {
  if (!logoPath) return null;
  try {
    return await getStorageClient(BRANDING_BUCKET).createSignedUrl(
      logoPath,
      LOGO_SIGNED_URL_TTL_SECONDS,
    );
  } catch {
    return null;
  }
}
