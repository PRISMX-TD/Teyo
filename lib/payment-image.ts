/**
 * 贴进收款信息的图片在上传前怎么缩。
 *
 * 粘贴来的多半是截图：手机或高分屏截的一整屏 PNG 动辄两三 MB，而 branding
 * bucket 只收 1MB（0034）。原样传上去只会换来一句「太大了」，用户也不知道
 * 该怎么办。所以在浏览器里先缩到长边 PAYMENT_IMAGE_MAX_EDGE 再传——对一张
 * 收款二维码来说这个尺寸印出来仍然扫得出，而文件小了一个数量级。
 */
export const PAYMENT_IMAGE_MAX_EDGE = 1200;

/**
 * 按比例缩到长边不超过 maxEdge。只缩不放：一张本来就小的二维码放大了只会糊。
 * 宽高至少 1 像素，canvas 不接受 0。
 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
