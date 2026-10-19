import { getMessages, type Locale } from '@/lib/i18n';
import { pickSignupCopy } from '@/components/auth/signup-copy';
import { SignupFormClient } from '@/components/auth/signup-form-client';

/**
 * 注册表单的服务端外壳。
 *
 * 表单要能在中英文之间即时切换，所以两种语言的文案都得到客户端。原来客户端
 * 组件直接 getMessages(locale)，等于把 en.ts 与 zh.ts 两整本目录（一千多条）
 * 打进 /signup 的首屏 JS——比 /login 多出三十多 kB，只为了用其中十一条。
 * 这里在服务端把那十一条摘出来再传下去；页面的用法不变。
 */
export function SignupForm({ initialLocale = 'en', next }: { initialLocale?: Locale; next?: string }) {
  const copy = { en: pickSignupCopy(getMessages('en')), zh: pickSignupCopy(getMessages('zh')) };
  return <SignupFormClient copy={copy} initialLocale={initialLocale} next={next} />;
}
