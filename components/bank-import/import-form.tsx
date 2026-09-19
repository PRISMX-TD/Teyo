'use client';

import { useState, useRef, useId } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { interpolate, localizedName } from '@/lib/i18n';
import { uploadBankStatement } from '@/server/actions/bank_import';

type MoneyAccountOption = {
  id: string;
  name_en: string | null;
  name_zh: string | null;
};

type Props = {
  orgSlug: string;
  locale: Locale;
  i18n: Messages;
  moneyAccounts: MoneyAccountOption[];
};

/**
 * 日期顺序。默认 ''（自动）而不是 'dmy'。
 *
 * 解析器已经会先从文件本身推：只要某一列里出现过大于 12 的首段，整份文件
 * 必然是日在前，这时不需要问用户。推不出来的唯一情形是整份对账单里每个
 * 日子都不超过 12 —— 那时 31/03 和 03/31 长得一模一样，猜错会把整份账的
 * 月和日对调，而金额全对，界面上没有任何地方看得出不对。
 *
 * 所以默认值只能是「自动」：预选 dmy 等于替马来西亚以外的用户做了一个
 * 他不知道自己做过的选择。自动推不出来时服务端会明确报错，用户回到这个
 * 下拉里挑一个——这是「能不猜就不猜，不能推导时明确阻塞」的意思。
 */
const DATE_FORMATS = ['', 'iso', 'dmy', 'mdy'] as const;

export function ImportForm({ orgSlug, locale, i18n, moneyAccounts }: Props) {
  const [moneyAccountId, setMoneyAccountId] = useState('');
  const [dateFormat, setDateFormat] = useState<(typeof DATE_FORMATS)[number]>('');
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dateFormatId = useId();
  const dateFormatHintId = useId();

  const dateFormatLabels: Record<(typeof DATE_FORMATS)[number], string> = {
    '': i18n.bankImport.dateFormatAuto,
    iso: i18n.bankImport.dateFormatIso,
    dmy: i18n.bankImport.dateFormatDmy,
    mdy: i18n.bankImport.dateFormatMdy,
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);

    const file = fileRef.current?.files?.[0];
    if (!file) {
      setMessage({ type: 'error', text: i18n.bankImport.selectFilePrompt });
      return;
    }
    if (!moneyAccountId) {
      setMessage({ type: 'error', text: i18n.bankImport.selectAccountPrompt });
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.set('file', file);
      formData.set('moneyAccountId', moneyAccountId);
      // 空串不发：服务端只在收到非空值时才覆盖自动推导（见
      // server/actions/bank_import.ts 里读 dateFormat 的那一段）。
      if (dateFormat) formData.set('dateFormat', dateFormat);

      const result = await uploadBankStatement(orgSlug, formData);
      setMessage({
        type: 'success',
        text: interpolate(i18n.bankImport.importedCount, { count: result.count }),
      });

      if (fileRef.current) fileRef.current.value = '';
      setMoneyAccountId('');
    } catch (err) {
      setMessage({
        type: 'error',
        text: err instanceof Error ? err.message : i18n.bankImport.uploadFailed,
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <form className="import-form" onSubmit={handleSubmit}>
      <h2>{i18n.bankImport.upload}</h2>

      <label>
        {i18n.bankImport.selectAccount}
        <select
          value={moneyAccountId}
          onChange={(e) => setMoneyAccountId(e.target.value)}
        >
          <option value="">--</option>
          {moneyAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {localizedName({ name_en: a.name_en, name_zh: a.name_zh }, locale)}
            </option>
          ))}
        </select>
      </label>

      <label>
        {i18n.bankImport.selectFile}
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.ofx,.qif,.qfx"
        />
      </label>

      <small>{i18n.bankImport.fileFormat}</small>

      {/* 这个下拉不在 <label> 里包着，因为它要配一段说明文字：
          aria-describedby 指过去，读屏在念完标签后会接着念说明，
          用户才知道「保持自动」是安全的，不是漏填了一项。 */}
      <div className="form-field">
        <label htmlFor={dateFormatId}>{i18n.bankImport.dateFormat}</label>
        <select
          id={dateFormatId}
          aria-describedby={dateFormatHintId}
          value={dateFormat}
          onChange={(e) => setDateFormat(e.target.value as (typeof DATE_FORMATS)[number])}
        >
          {DATE_FORMATS.map((value) => (
            <option key={value || 'auto'} value={value}>
              {dateFormatLabels[value]}
            </option>
          ))}
        </select>
        <small id={dateFormatHintId} className="field-hint">
          {i18n.bankImport.dateFormatHint}
        </small>
      </div>

      <button type="submit" disabled={uploading}>
        {uploading ? i18n.common.loading : i18n.bankImport.upload}
      </button>

      {message && (
        <p
          // 成功用 status（礼貌播报），失败用 alert（打断当前朗读）——
          // 导入失败时用户多半已经把注意力移开了，必须主动告诉他。
          role={message.type === 'success' ? 'status' : 'alert'}
          className={`import-message ${message.type === 'success' ? 'message-success' : 'message-error'}`}
        >
          {message.text}
        </p>
      )}
    </form>
  );
}
