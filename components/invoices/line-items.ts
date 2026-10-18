/**
 * 数量 numeric(12,4) 回填到输入框之前去掉小数尾巴的零：'12.0000' -> '12'，
 * '2.5000' -> '2.5'。
 *
 * 不用 lib/format 的 formatQuantity：它会加千分位，而 type=number 的输入框
 * 认不得 '1,200'，会直接清空。只动字符串，不经 Number()，理由同那个函数。
 */
export function trimQuantity(quantity: string): string {
  if (!quantity.includes('.')) return quantity;
  return quantity.replace(/0+$/, '').replace(/\.$/, '');
}
