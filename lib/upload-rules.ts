/**
 * 上传文件的类型与大小上限，服务端与浏览器共用这一份。
 *
 * 放在 lib/ 而不是 server/：表单要在选完文件的那一刻就说「这个文件不行」，
 * 而 server/repositories/attachments.ts 引了 node:crypto，进不了客户端包。
 * 两边各写一份的话，迟早有一天前端说「行」、服务端说「不行」。
 *
 * 每一项都与对应 bucket 在迁移里的设置逐字一致（0006 的 receipts、
 * 0034 的 branding）——Storage 自己也会拒，应用层先判只是为了给一句能看懂的话。
 */

/** 收据与单据附件。 */
export const ALLOWED_ATTACHMENT_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
];

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** 公司 logo。不收 SVG：它能夹带脚本，理由见 0034。 */
export const ALLOWED_LOGO_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];

export const MAX_LOGO_BYTES = 1024 * 1024;

/**
 * 收款信息里的图片（收款二维码、钱包地址的截图）。和 logo 同在 branding
 * bucket，类型与大小沿用上面 logo 那两项；这里只多一个张数上限，与 0038 的
 * CHECK 一致。
 */
export const MAX_PAYMENT_IMAGES = 3;
