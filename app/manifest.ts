import type { MetadataRoute } from 'next';

/**
 * 用 TS 而不是静态 .webmanifest：图标交给 app/icon.tsx 动态生成，
 * 路径由 Next.js 注入（带内容哈希），写死 /icon-192.png 会 404。
 *
 * ── 品牌色 ──
 * theme_color 原来是 #0f7a5f（绿），而 globals.css 的 --accent 是蓝，
 * app/layout.tsx 的 themeColor 又是另外两个灰。用户把 Teyo 装成 PWA 时，
 * 桌面上是一个绿图标，点开启动画面是绿的，界面却是蓝的，地址栏还是第三种
 * 颜色——四套色值互相不认识。
 *
 * 全部收敛到 --accent。取亮色模式的那一档 #2563eb 而不是暗色的 #3b82f6：
 * 这两个色值都会被白字压在上面（图标里的 T、启动画面的文字），#3b82f6 配
 * 白字只有 3.68:1，#2563eb 是 5.17:1（实测，算法见 globals.css 亮色 token
 * 块的注释）。图标不可能跟着系统主题换色，所以取两者中达标的那个。
 *
 * background_color 取 --bg-primary 的暗色值：:root 的默认主题就是暗色
 * （globals.css 第一个 token 块），启动画面也该是它。原来的 #f7f9f8 会让
 * 亮色启动画面紧接着闪成暗色的应用界面——正是 theme-script 修掉的那种闪烁，
 * 换了个地方重演。
 */
const BRAND = '#2563eb';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Teyo',
    short_name: 'Teyo',
    description: 'The easy way to own your business.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0b0e14',
    theme_color: BRAND,
    icons: [
      // 原来只声明了一档 192×192。app/icon.tsx 顶上的注释写着「PWA manifest
      // 需要 192 与 512 两种尺寸」，但 manifest 里从来只有一条——Android 装
      // 应用时拿 192 放大到启动画面的尺寸，边缘糊成一片。
      //
      // 现在 icon.tsx 直接渲染 512（见那个文件），这里如实声明 512。
      // 不再单列一条 192：浏览器把 512 缩到 192 是干净的，而声明一个并不
      // 存在的 192 资源只会让系统拿到一张尺寸对不上的图。
      { src: '/icon', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // maskable：Android 会把图标裁成系统当前的形状（圆、方圆、水滴）。
      // 一条 maskable 都没有时，系统会给整张图外面套一圈白底再裁——深色
      // 主屏上就是一个白方块里嵌着我们的图标。
      // 复用同一张图是安全的，因为 icon.tsx 已经按 maskable 要求把字形收在
      // 中间 80% 的安全区内（见那个文件的注释）。
      { src: '/icon', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    // 刻意没有 shortcuts。长按图标的快捷入口要指向具体页面，而这个应用的
    // 每个功能页都带 orgSlug（/:orgSlug/transactions），manifest 是构建期
    // 生成的静态文件，那时还不知道用户属于哪家公司。全部指向 '/' 的话，
    // 两条快捷方式和直接点图标是同一个动作，只是把菜单撑长了。
    // 要做得有意义，得先有一条不带 orgSlug 的中转路由（例如 /new 自行
    // 分流到当前公司），那是另一件事。
  };
}
