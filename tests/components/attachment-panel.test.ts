import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/server/actions/attachments', () => ({
  deleteAttachment: async () => {},
  getAttachmentSignedUrl: async () => '',
  uploadAttachment: async () => ({ id: 'x' }),
  uploadBillAttachment: async () => ({ id: 'x' }),
}));

const { AttachmentPanel } = await import('@/components/transaction/attachment-panel');
const { getMessages } = await import('@/lib/i18n');

const zh = getMessages('zh');
const RECEIPT = { id: 'att-1', fileName: 'Claude-OCT.pdf', mimeType: 'application/pdf', sizeBytes: 34_509 };

function render(readOnly = false) {
  return renderToStaticMarkup(
    createElement(AttachmentPanel, {
      orgSlug: 'acme',
      owner: { type: 'transaction', id: 'txn-1' },
      attachments: [RECEIPT],
      t: zh,
      readOnly,
    }),
  );
}

describe('AttachmentPanel', () => {
  it('says on each button what it does, not just a symbol', () => {
    // 原来是 ▶ / ✕ 与 ×：预览打开时一行里两个几乎一样的叉，其中一个会删掉凭证。
    const html = render();
    expect(html).toMatch(
      /<button[^>]*aria-label="预览 Claude-OCT.pdf"[^>]*>预览<\/button>/,
    );
    expect(html).toMatch(
      /<button[^>]*class="btn-small btn-danger attachment-delete-btn"[^>]*aria-label="删除 Claude-OCT.pdf"[^>]*>删除<\/button>/,
    );
    expect(html).not.toMatch(/[×✕▶]/);
  });

  it('leaves out the delete button for someone who may only look', () => {
    const html = render(true);
    expect(html).toContain('>预览</button>');
    expect(html).not.toContain('>删除</button>');
  });
});
