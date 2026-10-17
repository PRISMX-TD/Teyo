import { describe, expect, it } from 'vitest';
import { fitWithin, PAYMENT_IMAGE_MAX_EDGE } from '@/lib/payment-image';

describe('fitWithin', () => {
  it('shrinks a large screenshot so its longest side fits, keeping the shape', () => {
    // 手机竖屏截图。
    expect(fitWithin(1170, 2532, PAYMENT_IMAGE_MAX_EDGE)).toEqual({ width: 555, height: 1200 });
    expect(fitWithin(2880, 1800, PAYMENT_IMAGE_MAX_EDGE)).toEqual({ width: 1200, height: 750 });
  });

  it('never enlarges a small image', () => {
    // 放大的二维码只会糊。
    expect(fitWithin(300, 300, PAYMENT_IMAGE_MAX_EDGE)).toEqual({ width: 300, height: 300 });
  });

  it('keeps at least one pixel on a very thin image', () => {
    expect(fitWithin(5000, 1, 800)).toEqual({ width: 800, height: 1 });
  });
});
