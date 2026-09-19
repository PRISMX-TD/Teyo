// /auth/callback 的开放重定向。
//
// 这条链路格外要紧：用户是刚点完确认邮件过来的，session cookie 就在这一刻
// 写好，此时把他甩到钓鱼站，他正处在「我已经登录了」的心理状态下。
//
// 旧代码是 `NextResponse.redirect(new URL(next, request.url))`，并且以为
// 第二个参数是防护。它不是——第一个参数是绝对 URL 时 base 会被整个丢弃。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const exchangeCodeForSession = vi.hoisted(() => vi.fn());
const ensureAppUser = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: () => Promise.resolve({ auth: { exchangeCodeForSession } }),
}));

vi.mock('@/server/auth/ensure-app-user', () => ({ ensureAppUser }));

const { GET } = await import('@/app/auth/callback/route');

beforeEach(() => {
  exchangeCodeForSession.mockReset();
  ensureAppUser.mockReset();
  // 换码成功，但没有 user——省掉 ensureAppUser 那条路，这些用例只关心跳去哪。
  exchangeCodeForSession.mockResolvedValue({ data: { user: null }, error: null });
});

function callbackWith(next: string): Promise<Response> {
  const url = `https://teyo.app/auth/callback?code=abc&next=${encodeURIComponent(next)}`;
  return GET(new NextRequest(url));
}

describe('/auth/callback ?next= redirect target', () => {
  it('sends the user to an in-app path unchanged', async () => {
    for (const path of [
      '/',
      '/acme-trading',
      '/acme-trading/transactions?page=2',
      '/onboarding#step-2',
    ]) {
      const response = await callbackWith(path);
      expect(response.headers.get('location'), path).toBe(`https://teyo.app${path}`);
    }
  });

  it('refuses an absolute URL to another site', async () => {
    // new URL('https://evil.example/x', 'https://teyo.app/...') === 'https://evil.example/x'
    // —— base 被完全忽略。这一条就是漏洞本身。
    for (const attack of [
      'https://evil.example/steal',
      'http://evil.example',
      'HTTPS://EVIL.EXAMPLE/x',
    ]) {
      const response = await callbackWith(attack);
      expect(response.headers.get('location'), attack).toBe('https://teyo.app/');
    }
  });

  it('refuses a protocol-relative URL', async () => {
    // '//evil.example' 继承 https，主机变成 evil.example。
    for (const attack of ['//evil.example', '//evil.example/login', '///evil.example']) {
      const response = await callbackWith(attack);
      expect(response.headers.get('location'), attack).toBe('https://teyo.app/');
    }
  });

  it('refuses the backslash variants', async () => {
    // WHATWG 的 URL 解析器把 '\' 与 '/' 等同看待，所以 '/\evil.example'
    // 解析出来的主机是 evil.example，而它长得像一条站内路径。
    for (const attack of ['/\\evil.example', '/\\/evil.example', '\\\\evil.example']) {
      const response = await callbackWith(attack);
      expect(response.headers.get('location'), attack).toBe('https://teyo.app/');
    }
  });

  it('refuses a target hidden behind control characters', async () => {
    // 浏览器在解析前会剥掉 tab / 换行，'/\tevil.example' 剥完是
    // '//evil.example'。先剥再判，判的才是浏览器真正会看到的那个串。
    for (const attack of ['/\t/evil.example', '/\n/evil.example', '/\r/evil.example']) {
      const response = await callbackWith(attack);
      expect(response.headers.get('location'), JSON.stringify(attack)).toBe('https://teyo.app/');
    }
  });

  it('refuses anything that is not a path at all', async () => {
    for (const attack of ['javascript:alert(1)', 'data:text/html,<script>', 'evil.example']) {
      const response = await callbackWith(attack);
      expect(response.headers.get('location'), attack).toBe('https://teyo.app/');
    }
  });

  it('still falls back to the login page when the code is missing', async () => {
    const response = await GET(new NextRequest('https://teyo.app/auth/callback?next=/somewhere'));
    expect(response.headers.get('location')).toBe('https://teyo.app/login');
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });
});
