import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { ensureAppUser } from '@/server/auth/ensure-app-user';
import type { Locale } from '@/lib/i18n';

/**
 * 把 ?next= 收窄成「本站内的一条路径」。
 *
 * 不能指望 `new URL(next, request.url)` 帮忙挡住任何东西——它不是防护，
 * 而恰恰是漏洞本身。URL 构造器的第二个参数只是 base，当第一个参数本身
 * 就是绝对 URL 时 base 会被整个丢弃：
 *
 *   new URL('https://evil.example/x', 'https://teyo.app/auth/callback')
 *     -> https://evil.example/x
 *
 * 协议相对写法同理，'//evil.example' 会继承 https 而换掉主机；反斜杠变体
 * '/\evil.example' 也一样，WHATWG 的 URL 解析器（以及所有浏览器）把反斜杠
 * 与斜杠等同看待，于是它解析出来的主机是 evil.example，而不是 teyo.app 下
 * 的一条路径。
 *
 * 这条链路格外危险：用户是刚点完确认邮件过来的，session cookie 就在这一刻
 * 写好，此时把他甩到钓鱼站，他正处在「我已经登录了」的心理状态下。
 *
 * 所以这里不做任何「清洗」，只做白名单判断：必须是单斜杠开头的站内路径，
 * 其余一律退回首页。清洗（比如剥掉开头的 //）是个无底洞，判断则是有限的。
 */
function safeNextPath(raw: string | null): string {
  if (!raw) return '/';

  // 控制字符（tab、换行、回车、DEL 等）会被浏览器在解析 URL 之前剥掉，
  // 留着它们等于给下面那几条规则开后门：'/<tab>/evil.example' 剥完就是
  // '//evil.example'，可它逐字符看确实是以单个斜杠开头的，规则会放行。
  // 先剥、再判，判的才是浏览器真正会看到的那个串。
  //
  // 按码位过滤而不是写一条含控制字符的正则：那种正则里的字符在源文件里
  // 是真实的不可见字节，git 会因此把整个文件当成二进制，review 时看不见
  // 这一行改了什么——而这一行正是整个函数的要害。
  const next = Array.from(raw)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join('');

  if (!next.startsWith('/')) return '/';
  // '//host' 与 '/\host' 都是「换个主机」，不是站内路径。
  if (next.startsWith('//') || next.startsWith('/\\')) return '/';

  return next;
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const next = safeNextPath(request.nextUrl.searchParams.get('next'));

  if (!code) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const supabase = await createServerClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(new URL('/login?error=callback', request.url));
  }

  if (data.user) {
    const metadata = data.user.user_metadata as { display_name?: string; locale?: Locale };
    await ensureAppUser(
      data.user.id,
      data.user.email ?? '',
      metadata.display_name ?? '',
      metadata.locale ?? 'en',
    );
  }

  return NextResponse.redirect(new URL(next, request.url));
}
