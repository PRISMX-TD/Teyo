'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { createProject, updateProjectAction } from '@/server/actions/projects';
import { currencyExponent, formatMinorToDecimal } from '@/server/domain/money';
import type { ProjectRow } from '@/server/repositories/projects';

type Contact = {
  id: string;
  name: string;
};

type Props = {
  orgSlug: string;
  locale: Locale;
  contacts: Contact[];
  /** 有值即编辑模式（详情页的「编辑」）。 */
  project?: ProjectRow | null;
  /** 编辑时把预算还原成十进制要用本位币的小数位。 */
  baseCurrency?: string;
};

export function ProjectForm({ orgSlug, locale, contacts, project = null, baseCurrency }: Props) {
  const t = getMessages(locale);
  const router = useRouter();
  const isEdit = project !== null;

  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [contactId, setContactId] = useState(project?.contactId ?? '');
  const [budget, setBudget] = useState(
    project?.budgetMinor != null && baseCurrency
      ? formatMinorToDecimal(project.budgetMinor, currencyExponent(baseCurrency))
      : '',
  );
  const [startDate, setStartDate] = useState(project?.startDate ?? '');
  const [endDate, setEndDate] = useState(project?.endDate ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);

    try {
      // 十进制字符串交给服务端解析（server/actions/projects.ts 的
      // budgetToMinor 按本位币的小数位走 parseDecimalToMinor）。原来这里
      // 是 Math.round(parseFloat(budget) * 100)：浮点，而且两位小数写死
      // ——本位币是 JPY/VND/KRW 的公司预算会整整放大 100 倍。
      const payload = {
        name: name.trim(),
        description: description.trim() || undefined,
        contactId: contactId || undefined,
        budget: budget || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      };
      if (isEdit && project) {
        // updateProject 对可空列是「不传就清空」：这里每一栏都在表单上，
        // 清空了就是用户想清空。
        await updateProjectAction(orgSlug, project.id, payload);
        router.push(`/${orgSlug}/projects/${project.id}`);
        router.refresh();
        return;
      }
      await createProject(orgSlug, payload);
      router.push(`/${orgSlug}/projects`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="transaction-form">
      <label htmlFor="pn">{t.projects.name}</label>
      <input
        id="pn"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />

      <label htmlFor="pd">{t.projects.description}</label>
      <textarea
        id="pd"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
      />

      <label htmlFor="pc">{t.projects.client}</label>
      <select
        id="pc"
        value={contactId}
        onChange={(e) => setContactId(e.target.value)}
      >
        <option value="">{t.projects.noClient}</option>
        {contacts.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>

      <label htmlFor="pb">{t.projects.budget}</label>
      {/* 文本框 + 小数键盘，不用 type=number：后者在手机上给的是带正负号的
          全键盘，滚轮一碰还会悄悄改数。 */}
      <input
        id="pb"
        type="text"
        inputMode="decimal"
        value={budget}
        onChange={(e) => setBudget(e.target.value)}
      />

      <label htmlFor="psd">{t.projects.startDate}</label>
      <input
        id="psd"
        type="date"
        value={startDate}
        onChange={(e) => setStartDate(e.target.value)}
      />

      <label htmlFor="ped">{t.projects.endDate}</label>
      <input
        id="ped"
        type="date"
        value={endDate}
        onChange={(e) => setEndDate(e.target.value)}
      />

      {/* 这里原来有一个「状态」下拉框，选什么都没有传给 createProject——
          新项目一律是进行中，改状态在列表页与详情页上。 */}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}

      <div className="form-actions">
        <button type="submit" disabled={pending}>
          {pending ? t.common.loading : isEdit ? t.settings.save : t.projects.save}
        </button>
      </div>
    </form>
  );
}
