'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale } from '@/lib/i18n';
import { getMessages, interpolate } from '@/lib/i18n';
import { setProjectStatusAction } from '@/server/actions/projects';

type Status = 'active' | 'completed' | 'cancelled';

type Props = {
  orgSlug: string;
  projectId: string;
  projectName: string;
  status: Status;
  locale: Locale;
  /** 列表页自己持有一份项目状态，改完要同步；不给就刷新服务端渲染（详情页）。 */
  onChanged?: (status: Status) => void;
};

/**
 * 改项目状态的几个按钮，列表与详情页共用。
 *
 * 按钮上写动词（「标记完成」「取消项目」「重新打开」）。原来写的是目标状态的
 * 名词「已完成」「已取消」，和旁边的状态徽章一模一样，读起来像标签而不是
 * 按钮；「已取消」一点就取消了项目，也不问一句。
 */
export function ProjectStatusActions({ orgSlug, projectId, projectName, status, locale, onChanged }: Props) {
  const t = getMessages(locale);
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: Status) {
    if (next === 'cancelled' && !window.confirm(interpolate(t.projects.cancelConfirm, { name: projectName }))) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      await setProjectStatusAction(orgSlug, projectId, next);
      if (onChanged) onChanged(next);
      else router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      {status === 'active' ? (
        <>
          <button type="button" className="btn-small" onClick={() => change('completed')} disabled={pending}>
            {t.projects.markCompleted}
          </button>
          <button type="button" className="btn-small btn-danger" onClick={() => change('cancelled')} disabled={pending}>
            {t.projects.cancelProject}
          </button>
        </>
      ) : (
        <button type="button" className="btn-small" onClick={() => change('active')} disabled={pending}>
          {t.projects.reopen}
        </button>
      )}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
    </>
  );
}
