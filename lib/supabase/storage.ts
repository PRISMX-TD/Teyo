import { createClient } from '@supabase/supabase-js';

export const RECEIPTS_BUCKET = 'receipts';

export type StorageClient = {
  upload(path: string, file: File): Promise<{ path: string }>;
  /**
   * expiresIn 没有默认值，必须由调用方传入。
   * 默认值藏在这里的话，测试一旦替换掉本模块就再也量不到实际用的 TTL。
   * 真正的值是 SIGNED_URL_TTL_SECONDS，定义在 server/repositories/attachments.ts。
   */
  createSignedUrl(path: string, expiresIn: number): Promise<string>;
  remove(path: string): Promise<void>;
};

/**
 * 服务端专用，使用 service role 密钥绕过 Storage RLS。
 * 路径层面的访问控制由 uploadAttachment / getAttachmentSignedUrl / deleteAttachment
 * 在调用前自行校验，这里只负责执行 Storage 操作。
 * service role 密钥绝不能出现在客户端 bundle 里。
 */
export function getStorageClient(): StorageClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error('Supabase storage credentials are not configured.');
  }

  const client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const bucket = client.storage.from(RECEIPTS_BUCKET);

  return {
    async upload(path, file) {
      const { data, error } = await bucket.upload(path, file, {
        contentType: file.type,
        upsert: false,
      });
      if (error) throw error;
      return { path: data.path };
    },

    async createSignedUrl(path, expiresIn) {
      const { data, error } = await bucket.createSignedUrl(path, expiresIn);
      if (error) throw error;
      return data.signedUrl;
    },

    async remove(path) {
      const { error } = await bucket.remove([path]);
      if (error) throw error;
    },
  };
}
