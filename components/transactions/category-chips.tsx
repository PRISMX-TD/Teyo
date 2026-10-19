'use client';

import type { Locale } from '@/lib/i18n';
import { localizedName } from '@/lib/i18n';

type Option = { id: string; name_en: string | null; name_zh: string | null };

type Props = {
  /** 最近 90 天用得最多的几个分类，已经按 kind 过滤好。 */
  categories: Option[];
  /** 当前表单的 categoryId 值——芯片与下拉共用同一份状态。 */
  selectedId: string;
  onSelect: (categoryId: string) => void;
  locale: Locale;
};

/**
 * 录入表单里的一键分类芯片：柜台前站着记账时，点一下比翻下拉快。
 * 只是下拉的快捷方式，不是替代——选中态与下拉共享同一个 categoryId，
 * 点芯片和在下拉里选是同一件事的两种做法。
 */
export function CategoryChips({ categories, selectedId, onSelect, locale }: Props) {
  if (categories.length === 0) return null;

  return (
    <div className="category-chips">
      {categories.map((category) => {
        const selected = category.id === selectedId;
        return (
          <button
            key={category.id}
            type="button"
            className={selected ? 'category-chip selected' : 'category-chip'}
            aria-pressed={selected}
            onClick={() => onSelect(category.id)}
          >
            {localizedName(category, locale)}
          </button>
        );
      })}
    </div>
  );
}
