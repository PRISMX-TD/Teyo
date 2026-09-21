'use client';

/**
 * 打开浏览器的打印对话框。
 *
 * 一个按钮单独成文件，是因为整张发票单据页是服务端组件——为了一个
 * onClick 把整页变成客户端组件，会把发票数据、联系人信息全部推到客户端
 * 包里去。
 */
export function PrintButton({ label }: { label: string }) {
  return (
    <button type="button" className="primary-button" onClick={() => window.print()}>
      {label}
    </button>
  );
}
