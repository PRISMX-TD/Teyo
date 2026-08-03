import { describe, expect, it } from 'vitest';

describe('test environment', () => {
  it('runs vitest with the @ alias configured', async () => {
    const mod = await import('@/package.json');
    expect(mod.default.name).toBeTruthy();
  });
});
