import { readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { admin } from '@/tests/helpers/db';
import { withoutUserContext } from '@/server/db/transaction';
import { RESERVED_SLUGS, generateUniqueSlug } from '@/server/repositories/organizations';

afterAll(async () => {
  await admin.end();
});

/** app/ 与 app/(group)/ 下的静态顶层路由段（不含 [动态段]、_私有、文件）。 */
function topLevelRouteSegments(): string[] {
  const appDir = path.join(process.cwd(), 'app');
  const segments: string[] = [];
  for (const entry of readdirSync(appDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('(') && entry.name.endsWith(')')) {
      for (const inner of readdirSync(path.join(appDir, entry.name), { withFileTypes: true })) {
        if (inner.isDirectory() && !/^[[_(]/.test(inner.name)) segments.push(inner.name);
      }
      continue;
    }
    if (!/^[[_]/.test(entry.name)) segments.push(entry.name);
  }
  return segments;
}

describe('generateUniqueSlug - reserved route names', () => {
  it('reserves every static top-level route segment under app/', () => {
    const missing = topLevelRouteSegments().filter((s) => !RESERVED_SLUGS.has(s));
    expect(missing).toEqual([]);
  });

  it.each(['Login', 'Account', 'Onboarding', 'API', 'Offline', 'Forgot Password'])(
    'never hands out a slug that shadows a route (%s)',
    async (name) => {
      const slug = await withoutUserContext((tx) => generateUniqueSlug(tx, name));
      expect(RESERVED_SLUGS.has(slug)).toBe(false);
      // 仍然以名字为前缀，只是多了随机后缀——与重名时的处理一致。
      const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      expect(slug.startsWith(`${base}-`)).toBe(true);
    },
  );
});
