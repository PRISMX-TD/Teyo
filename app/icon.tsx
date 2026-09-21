import { ImageResponse } from 'next/og';

/**
 * 应用图标（favicon + PWA 图标，同一份矢量渲染，省掉往仓库塞二进制文件）。
 *
 * ── 尺寸 ──
 * 渲染 512 而不是原来的 192。app/manifest.ts 需要一张启动画面用得起的图，
 * 192 放大到 512 会糊；反过来把 512 缩到 192（主屏图标、浏览器标签页）是
 * 干净的。所以只保留最大的那一档，由使用方缩。
 *
 * ── 颜色 ──
 * #0f7a5f 现在就是 globals.css 的亮色档 --accent——界面的强调色向这个
 * 既成事实收敛，而不是反过来（理由见 app/manifest.ts 的注释）。
 * 取亮色档而不是暗色档 #34a882：图标里是白字压底色，白字在 #0f7a5f 上
 * 5.29:1，在 #34a882 上只有 2.55:1，而图标不会跟着系统主题换色。
 *
 * ── maskable 安全区 ──
 * manifest 里这张图同时标了 purpose: 'maskable'，Android 会把它裁成系统
 * 当前的形状，最多吃掉四周各 10%。所以字形必须收在中间 80% 里：字号取
 * 边长的 44%（512 × 0.44 ≈ 225），目视占中间约 45%，离安全区边界还有富余。
 * 圆角也相应放大到边长的 1/6——底色本身铺满整张画布，被裁掉多少都还是底色，
 * 圆角只在不裁的场景（浏览器标签页）里起作用。
 */
const SIZE = 512;
const BRAND = '#0f7a5f';

export const size = { width: SIZE, height: SIZE };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: BRAND,
          color: '#ffffff',
          fontSize: Math.round(SIZE * 0.44),
          fontWeight: 700,
          borderRadius: Math.round(SIZE / 6),
        }}
      >
        T
      </div>
    ),
    size,
  );
}
