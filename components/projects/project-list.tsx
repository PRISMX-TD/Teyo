'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Locale } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import { currencyExponent, formatMinorToDecimal, parseDecimalToMinor } from '@/server/domain/money';
import type { ProjectRow } from '@/server/repositories/projects';
import { updateProjectAction, setProjectStatusAction } from '@/server/actions/projects';
import { ProjectProfitability } from '@/components/projects/project-profitability';

type ProjectProfit = {
  totalIncome: bigint;
  totalExpense: bigint;
  netProfit: bigint;
};

type Props = {
  orgSlug: string;
  locale: Locale;
  projects: ProjectRow[];
  profitabilityMap: Record<string, ProjectProfit>;
  /** 公司本位币。预算原来一律按 'USD' 显示、按两位小数解析。 */
  baseCurrency: string;
};

export function ProjectList({
  orgSlug,
  locale,
  projects: initialProjects,
  profitabilityMap,
  baseCurrency,
}: Props) {
  const t = getMessages(locale);
  const exponent = currencyExponent(baseCurrency);
  const [projects, setProjects] = useState(initialProjects);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Edit state
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editBudget, setEditBudget] = useState('');
  const [editStartDate, setEditStartDate] = useState('');
  const [editEndDate, setEditEndDate] = useState('');

  const statusLabel: Record<string, string> = {
    active: t.projects.statusActive,
    completed: t.projects.statusCompleted,
    cancelled: t.projects.statusCancelled,
  };

  const NEXT_STATUS: Record<string, string[]> = {
    active: ['completed', 'cancelled'],
    completed: ['active'],
    cancelled: ['active'],
  };

  function startEdit(item: ProjectRow) {
    setEditing(item.id);
    setEditName(item.name);
    setEditDescription(item.description ?? '');
    // 原来是 `String(Number(item.budgetMinor) / 100)`：既走了浮点，又把
    // 小数位写死成 2。日元公司的 1,500,000 会被显示成 15000.00。
    setEditBudget(item.budgetMinor ? formatMinorToDecimal(item.budgetMinor, exponent) : '');
    setEditStartDate(item.startDate ?? '');
    setEditEndDate(item.endDate ?? '');
  }

  async function handleUpdate(id: string) {
    setPending(true);
    setError(null);
    try {
      await updateProjectAction(orgSlug, id, {
        name: editName.trim(),
        description: editDescription.trim(),
        // 传十进制字符串，由服务端按本位币的小数位解析（见
        // server/actions/projects.ts 的 budgetToMinor）。前端不再自己
        // 算最小货币单位——原来那句 Math.round(parseFloat(x) * 100) 对
        // 零小数币种会放大 100 倍，而且是浮点。
        budget: editBudget || undefined,
        startDate: editStartDate || undefined,
        endDate: editEndDate || undefined,
      });
      setProjects((prev) =>
        prev.map((p) =>
          p.id === id
            ? {
                ...p,
                name: editName.trim(),
                description: editDescription.trim() || null,
                // 本地乐观更新要和服务端算出来的是同一个数，所以这里也走
                // parseDecimalToMinor，而不是另写一套换算。
                budgetMinor: editBudget ? parseDecimalToMinor(editBudget, exponent) : null,
                startDate: editStartDate || null,
                endDate: editEndDate || null,
              }
            : p,
        ),
      );
      setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function handleStatusChange(id: string, newStatus: string) {
    setPending(true);
    setError(null);
    try {
      await setProjectStatusAction(orgSlug, id, newStatus as 'active' | 'completed' | 'cancelled');
      setProjects((prev) =>
        prev.map((p) =>
          p.id === id ? { ...p, status: newStatus as ProjectRow['status'] } : p,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  if (projects.length === 0) {
    return <p className="empty-state">{t.projects.empty}</p>;
  }

  return (
    <>
      {error ? <p role="alert" className="form-error">{error}</p> : null}
      {projects.map((project) => {
        const profit = profitabilityMap[project.id];

        if (editing === project.id) {
          return (
            <div key={project.id} className="list-item">
              <div className="inline-edit">
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder={t.projects.name}
                />
                <input
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  placeholder={t.projects.description}
                />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={editBudget}
                  onChange={(e) => setEditBudget(e.target.value)}
                  placeholder={t.projects.budget}
                />
                <div className="inline-edit-row">
                  <input
                    type="date"
                    value={editStartDate}
                    onChange={(e) => setEditStartDate(e.target.value)}
                  />
                  <input
                    type="date"
                    value={editEndDate}
                    onChange={(e) => setEditEndDate(e.target.value)}
                  />
                </div>
                <div>
                  <button onClick={() => handleUpdate(project.id)} disabled={pending}>
                    {t.settings.save}
                  </button>
                  <button onClick={() => setEditing(null)}>{t.common.cancel}</button>
                </div>
              </div>
            </div>
          );
        }

        return (
          <div key={project.id} className="list-item">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', padding: 'var(--space-3) var(--space-4)' }}>
              {/* 第一层：名称 + 联系人 + 状态 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <span className="contact-name" style={{ flex: '1 1 auto', minWidth: 0 }}>
                  <Link href={`/${orgSlug}/projects/${project.id}`}>{project.name}</Link>
                </span>
                {project.contactName ? <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>{project.contactName}</span> : null}
                <span className={`badge ${project.status === 'active' ? 'badge-success' : project.status === 'completed' ? 'badge-info' : 'badge'}`}>
                  {statusLabel[project.status] ?? project.status}
                </span>
              </div>
              {/* 第二层：项目信息 badge */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                {project.budgetMinor ? (
                  <span className="badge badge-info">{t.projects.budget}: {formatMoney(project.budgetMinor, baseCurrency, locale)}</span>
                ) : null}
                {project.startDate ? <span className="badge badge-info">{project.startDate}</span> : null}
                {project.endDate ? <span className="badge badge-info">→ {project.endDate}</span> : null}
              </div>
              {/* 第三层：操作按钮组 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap', marginTop: 'var(--space-1)' }}>
                <button onClick={() => startEdit(project)} className="btn-small">{t.common.edit}</button>
                {/* 展开盈利分析。原来这颗按钮的全部内容就是一个 '+' 或 '−'，
                    没有 aria-label、没有 aria-expanded——读屏器念出来是
                    「加号，按钮」，既不知道它是干什么的，也不知道现在是开是关。
                    符号留着（视觉上够用），语义交给 aria。 */}
                <button
                  onClick={() => setExpanded(expanded === project.id ? null : project.id)}
                  className="btn-small"
                  aria-expanded={expanded === project.id}
                  aria-controls={`project-detail-${project.id}`}
                  aria-label={`${t.projects.profitability}: ${project.name}`}
                >
                  <span aria-hidden="true">{expanded === project.id ? '−' : '+'}</span>
                </button>
                {(NEXT_STATUS[project.status] ?? []).map((ns) => (
                  <button
                    key={ns}
                    onClick={() => handleStatusChange(project.id, ns)}
                    disabled={pending}
                    className="btn-small"
                  >
                    {statusLabel[ns] ?? ns}
                  </button>
                ))}
              </div>
            </div>

            {expanded === project.id && profit ? (
              <div id={`project-detail-${project.id}`} style={{ marginTop: 'var(--space-3)' }}>
                <ProjectProfitability
                  profitability={profit}
                  locale={locale}
                  baseCurrency={baseCurrency}
                />
              </div>
            ) : null}

            {/* 项目描述原来是写死的 style={{ color: '#666' }}：它既不跟主题走，
                在暗底（#0b0a09）上又只有 3.1:1，不到 WCAG AA 的 4.5。 */}
            {expanded === project.id && project.description ? (
              <p className="field-hint">{project.description}</p>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
