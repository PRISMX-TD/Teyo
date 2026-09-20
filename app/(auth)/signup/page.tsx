import { SignupForm } from '@/components/auth/signup-form';
import { resolveAnonymousLocale } from '@/lib/i18n/server';

export default async function SignupPage() {
  /**
   * 语言选择器的**初始值**取自浏览器的 Accept-Language。
   *
   * 选择器本身必须留着（见 SignupForm 的注释：这一步选的值会写进
   * app_users.locale，是此后整个产品解析语言的唯一依据）。要改的只是它
   * 的默认值：原来硬写 'en'，于是一个浏览器设成中文的用户打开注册页，
   * 看到的是一整页英文加一个他得先找到的下拉框。
   *
   * 登录、忘记密码、重设密码三页已经按 Accept-Language 协商了，注册页
   * 不跟上的话，同一个未登录用户在四个页面之间会看到语言来回跳。
   */
  return <SignupForm initialLocale={await resolveAnonymousLocale()} />;
}
