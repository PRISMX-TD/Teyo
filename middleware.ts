import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { safeNextPath } from '@/lib/safe-next-path';

const PUBLIC_PATHS = [
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/auth/callback',
  // /offline 是 Service Worker 的导航兜底页（见 app/sw.ts 的 fallbacks.entries）。
  // 它此前不在这个列表里，于是「在线但未登录时打开它」会被重定向到 /login——
  // 一个专门用来在没有网络时显示的页面，却要求先通过一次需要网络的会话检查。
  // 真正离线时 SW 直接从缓存出这一页、根本不经过中间件，所以这个洞平时看不见，
  // 只在会话过期后第一次点开时暴露出来。
  '/offline',
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 按整段匹配，不按字符串前缀：公司 slug 由公司名生成，「Login Trading」
  // 就是 /login-trading，裸 startsWith 会把整家公司当成公开页、跳过会话刷新。
  const isPublic =
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    pathname.startsWith('/invite/');
  // 登录/注册页虽然公开，但要知道「是不是已经登录了」：已登录的人该直接去 next。
  // 之前它们和其余公开页一起在这里提前返回，下面那条已登录跳转分支永远走不到。
  const isAuthEntry = pathname === '/login' || pathname === '/signup';

  // 其余公开页面不需要鉴权：跳过 Supabase Auth API 调用，省一次网络往返。
  if (isPublic && !isAuthEntry) {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // 未登录访问登录/注册页：正常渲染，不能再重定向回 /login（那是死循环）。
    if (isAuthEntry) return response;
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('next', pathname + request.nextUrl.search);
    return NextResponse.redirect(url);
  }

  if (isAuthEntry) {
    // 已登录的人点开带 next 的登录链接（比如邀请）时，直接送去 next。
    const next = safeNextPath(request.nextUrl.searchParams.get('next'));
    return NextResponse.redirect(new URL(next, request.url));
  }

  return response;
}

export const config = {
  // icon/apple-icon 由 app/icon.tsx 动态生成，路径不带扩展名，
  // 必须显式排除，否则未登录时会被重定向到 /login，PWA 装不上图标。
  //
  // api 也必须排除：路由处理器自带鉴权（cron 用 CRON_SECRET 校验 Bearer），
  // 走这里的会话重定向会让 Vercel Cron 拿到 307 而不是执行任务。
  //
  // 每一项都锚定到整段路径（(?:/|$) 或 $）。原来写的是裸前缀 api|icon|…，
  // 于是 slug 以这些字开头的公司（「API Solutions」→ /api-solutions、
  // /icon-trading）整个绕过了 middleware：会话不在这里刷新，Server Component
  // 里又写不了 cookie，access token 过期后那家公司的用户会被随机登出。
  //
  // 带扩展名的静态文件（robots.txt、字体、source map、public/ 下的脚本）同样
  // 排除：middleware 每跑一次就是一趟 Supabase Auth 的 getUser() 网络往返，
  // 静态文件既不需要会话，也不该因为会话过期被 307 到 /login。
  matcher: [
    '/((?!api(?:/|$)|_next/static|_next/image|favicon\\.ico$|manifest\\.webmanifest$|sw\\.js$|swe-worker-.*|icon(?:/|$)|apple-icon(?:/|$)|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|txt|xml|js|css|map|woff2?)$).*)',
  ],
};
