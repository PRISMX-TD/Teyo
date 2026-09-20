import { describe, expect, it } from 'vitest';
import { pickLocale } from '@/lib/i18n/server';

/**
 * 登录页、忘记密码、重置密码与认证外壳此前一律写死 getMessages('en')。
 * 一个注册时选了中文的用户，只要退出登录，整条回归路径就全是英文——
 * 而 PRODUCT.md 写的是「双语平权，不是把中文当翻译补丁」。
 *
 * 这些用例钉的是那层协商：浏览器说什么，还没有账号的用户就该看到什么。
 */
describe('pickLocale', () => {
  it('picks zh for a simplified Chinese browser', () => {
    expect(pickLocale('zh-CN,zh;q=0.9,en;q=0.8')).toBe('zh');
  });

  it('treats every Chinese variant as zh', () => {
    // 产品只有一份简体中文目录。把 zh-TW 判成英文，对一个台湾用户毫无道理。
    for (const tag of ['zh-TW', 'zh-HK', 'zh-Hans', 'zh-Hant-TW', 'ZH-cn']) {
      expect(pickLocale(tag)).toBe('zh');
    }
  });

  it('respects q-values rather than source order', () => {
    // 英文排在前面，但用户把中文标成了更高的偏好。
    expect(pickLocale('en;q=0.5,zh;q=0.9')).toBe('zh');
  });

  it('keeps source order when q-values tie', () => {
    expect(pickLocale('en,zh')).toBe('en');
    expect(pickLocale('zh,en')).toBe('zh');
  });

  it('skips a language the user explicitly refused', () => {
    // q=0 在 RFC 9110 里的意思是「不接受」，不是「优先级最低」。
    expect(pickLocale('zh;q=0,en;q=0.1')).toBe('en');
  });

  it('falls back to en for unsupported languages', () => {
    expect(pickLocale('ms-MY,ms;q=0.9')).toBe('en');
    expect(pickLocale('*')).toBe('en');
  });

  it('survives malformed headers instead of throwing', () => {
    // 这个值来自请求头，也就是来自网络上的任意输入。登录页不能因为一个
    // 畸形的 Accept-Language 就渲染失败——那会让用户连重试的入口都没有。
    for (const header of ['', ',,,', 'zh;q=abc', 'zh;;q=', ';q=1', 'zh;q=1.5.2']) {
      expect(['en', 'zh']).toContain(pickLocale(header));
    }
  });

  it('treats a malformed quality the same way it treats an absent one', () => {
    // 两个同样畸形的值不该有不同命运。第一版里 `q=1.5.2` 被判成拒绝、
    // `q=abc` 被抬到最高优先级——纯粹因为一个匹配了正则、另一个没匹配上。
    // 现在都按「没写 q」处理：语言标签本身是用户说出口的偏好，一个坏掉的
    // 参数不该让这句话作废。
    expect(pickLocale('zh;q=abc,en;q=0.2')).toBe('zh');
    expect(pickLocale('zh;q=1.5.2,en;q=0.2')).toBe('zh');
    expect(pickLocale('zh;q=abc')).toBe('zh');
    // 超出 [0,1] 同样视为没写（RFC 9110）。
    expect(pickLocale('zh;q=7,en')).toBe('zh');
  });
});
