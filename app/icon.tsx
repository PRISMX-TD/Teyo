import { ImageResponse } from 'next/og';

// PWA manifest 需要 192 与 512 两种尺寸，这里用同一份矢量渲染，
// 省掉往仓库塞二进制文件。
export const size = { width: 192, height: 192 };
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
          background: '#0f7a5f',
          color: '#ffffff',
          fontSize: 120,
          fontWeight: 700,
          borderRadius: 32,
        }}
      >
        T
      </div>
    ),
    size,
  );
}
