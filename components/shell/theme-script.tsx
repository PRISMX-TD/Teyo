/**
 * 在首屏 HTML 里同步执行的一小段脚本，负责在浏览器画第一帧之前就把
 * data-theme 写到 <html> 上。
 *
 * 为什么不能是 useEffect：这个文件原来叫 ThemeScript，写的却是
 * `'use client'` + `useEffect`。effect 要等到 React 在客户端挂载之后才跑，
 * 而首屏 HTML 是先到先画的——那一刻 <html> 上还没有 data-theme，样式落到
 * :root（也就是暗色默认值）。选了亮色的用户每打开一个页面都会先看到一整
 * 屏深色，然后闪成亮色。app/layout.tsx 上的 suppressHydrationWarning 正好
 * 把这件事的症状（属性不一致的警告）盖掉了，所以一直没人发现。
 *
 * 换成 dangerouslySetInnerHTML 的 <script> 之后，它作为文档的一部分被解析、
 * 立即同步执行，先于任何内容渲染——闪烁在源头上不存在了，而不是被缩短。
 *
 * dangerouslySetInnerHTML 在这里是必需的：React 不会执行 <script> 的
 * children（那会被当成文本节点），只有这条路能把脚本原样写进 HTML。
 * 脚本内容是下面这个写死的字符串常量，不拼接任何外部输入，所以没有注入面。
 *
 * localStorage 在隐私模式/被禁用时会抛异常，包在 try 里；真读不到就退回
 * 系统偏好，再不行退回暗色（与 :root 的默认值一致）。
 */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('teyo-theme');if(t!=='dark'&&t!=='light'){t=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />;
}
