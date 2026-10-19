import type { Messages } from '@/lib/i18n';

/** 注册表单在客户端真正用到的那几条文案。 */
export type SignupCopy = {
  auth: Pick<
    Messages['auth'],
    'signUp' | 'signIn' | 'haveAccountPrompt' | 'displayName' | 'email' | 'password' | 'showPassword' | 'hidePassword'
  >;
  account: Pick<Messages['account'], 'language' | 'english' | 'chinese'>;
};

export function pickSignupCopy(t: Messages): SignupCopy {
  return {
    auth: {
      signUp: t.auth.signUp,
      signIn: t.auth.signIn,
      haveAccountPrompt: t.auth.haveAccountPrompt,
      displayName: t.auth.displayName,
      email: t.auth.email,
      password: t.auth.password,
      showPassword: t.auth.showPassword,
      hidePassword: t.auth.hidePassword,
    },
    account: {
      language: t.account.language,
      english: t.account.english,
      chinese: t.account.chinese,
    },
  };
}
