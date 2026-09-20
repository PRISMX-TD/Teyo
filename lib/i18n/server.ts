// 没有 import 'server-only'：那是一个额外的依赖，而这个项目刻意只钉了
// 13 个生产依赖。next/headers 本身就是服务端专用的——在客户端组件里
// 引用它会在构建期直接报错，效果相同，不用多装一个包。
import { headers } from 'next/headers';
import { DEFAULT_LOCALE, LOCALES, type Locale } from '@/lib/i18n';

/**
 * 还没有用户身份时，用什么语言。
 *
 * 语言平时取自 app_users.locale。但登录页、忘记密码、重置密码与邀请页
 * 的外壳是在「还没有用户」的时刻渲染的——那四个文件此前一律写死
 * `getMessages('en')`。后果是：一个在注册时选了中文的用户，只要退出登录，
 * 整条回归路径（登录 / 忘记密码 / 重置密码）就全变成英文。
 *
 * PRODUCT.md 写的是「双语平权，不是把中文当翻译补丁」。一个永远说英文的
 * 登录页，正好是那句话要避免的形状。
 *
 * 用 Accept-Language 而不是别的：
 *   - cookie 更准，但要在登录/注册/改语言三处写入，那三个文件此刻由别的
 *     改动占着；而且新用户第一次来也没有 cookie，仍然要有这一层兜底。
 *   - URL 前缀（/zh/login）要改动整套路由，而这个产品只有两种语言、
 *     且语言是账号属性不是站点分区。
 * Accept-Language 是浏览器本来就在每个请求上带着的、用户在系统里设过的
 * 偏好，零额外状态。
 *
 * 匹配只看主语言子标签：zh-CN / zh-TW / zh-Hans 一律算 zh。产品只有简体
 * 中文一种中文目录，把 zh-TW 判成英文对一个台湾用户毫无道理。
 */
export async function resolveAnonymousLocale(): Promise<Locale> {
  try {
    const header = (await headers()).get('accept-language');
    if (!header) return DEFAULT_LOCALE;
    return pickLocale(header);
  } catch {
    // headers() 在某些渲染上下文里会抛（静态预渲染）。语言只影响文案，
    // 读不到就退回默认——这一层绝不能让登录页渲染失败。
    return DEFAULT_LOCALE;
  }
}

/**
 * 按 q 值排序后取第一个我们支持的语言。
 *
 * 导出是为了能直接对这个纯函数写测试——resolveAnonymousLocale 依赖
 * next/headers，测它要连带把整个请求上下文搭起来，而真正会出错的是
 * 这段解析。
 */
export function pickLocale(acceptLanguage: string): Locale {
  const ranked = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params
        .map((p) => /^\s*q=(.*)$/i.exec(p))
        .find((m): m is RegExpExecArray => m !== null);

      return {
        // 只取主子标签：zh-CN -> zh。大小写不敏感（BCP 47 允许 ZH-cn）。
        primary: tag.trim().toLowerCase().split('-')[0],
        quality: parseQuality(q?.[1]),
      };
    })
    // 稳定排序：q 相同时保持出现顺序，这正是 Accept-Language 的语义。
    .sort((a, b) => b.quality - a.quality);

  for (const entry of ranked) {
    if (entry.quality <= 0) continue;
    if ((LOCALES as readonly string[]).includes(entry.primary)) {
      return entry.primary as Locale;
    }
  }

  return DEFAULT_LOCALE;
}

/**
 * q 参数的值。缺省与**无法解析**都按 1 处理，只有明确写出的合法 0 才算拒绝。
 *
 * 「无法解析按 1」是一个刻意的选择，且要和「缺省按 1」保持一致。第一版
 * 写成两条不同的路径：正则只接受 [\d.]+，于是 `q=1.5.2` 匹配上再 Number
 * 出 NaN、被归成 0（拒绝），而 `q=abc` 压根匹配不上、被当成没写 q、
 * 归成 1（最高优先级）。两个同样畸形的值，一个被判死刑一个被抬到最前面。
 *
 * 统一成宽松的那一侧：语言标签本身是用户明确说出的偏好，一个坏掉的 q
 * 参数不该让这句话作废。RFC 9110 里 q 必须在 [0,1]，超出范围同样视为
 * 没写。
 */
function parseQuality(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0 || value > 1) return 1;
  return value;
}
