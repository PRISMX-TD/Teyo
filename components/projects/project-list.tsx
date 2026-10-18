'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import type { Locale } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import { currencyExponent, formatMinorToDecimal, parseDecimalToMinor } from '@/server/domain/money';
import type { ProjectRow } from '@/server/repositories/projects';
import { updateProjectAction } from '@/server/actions/projects';
import { ProjectProfitability } from '@/components/projects/project-profitability';
import { ProjectStatusActions } from '@/components/projects/project-status-actions';
import { CaretDown } from '@/components/ui/icons';

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
  /** 编辑与改状态要 account:manage；列表本身只要 transaction:read。 */
  canManage: boolean;
};

export function ProjectList({
  orgSlug,
  locale,
  projects: initialProjects,
  profitabilityMap,
  baseCurrency,
  canManage,
}: Props) {
  const t = getMessages(locale);
  const uid = useId();
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
      const current = projects.find((p) => p.id === id);
      await updateProjectAction(orgSlug, id, {
        name: editName.trim(),
        // 这张行内表单没有客户一栏，但 updateProject 对可空列是「不传就清空」，
        // 原来每改一次名字，项目挂的客户就被悄悄清掉。原样带回去。
        contactId: current?.contactId ?? undefined,
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

  function handleStatusChanged(id: string, newStatus: ProjectRow['status']) {
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, status: newStatus } : p)));
  }

  if (projects.length === 0) {
    return <p className="empty-state">{t.projects.empty}</p>;
  }

  return (
    <>
      {error ? <p role="alert" className="form-error">{error}</p> : null}
      {/* .named-list：行原来没有卡片，直接是灰底上的几条分隔线，文字还比
          标题多缩进 16px。兄弟页「固定资产」是白卡片。 */}
      <div className="named-list">
        {projects.map((project) => {
          const profit = profitabilityMap[project.id];
          const isOpen = expanded === project.id;
          const detailId = `${uid}-detail-${project.id}`;

          if (editing === project.id) {
            const f = (key: string) => `${uid}-${project.id}-${key}`;
            return (
              <div key={project.id} className="list-item">
                {/* 原来是一排只有 placeholder 的输入框：一填进内容，就看不出
                    哪一栏是名称、哪一栏是描述，两个日期框更是谁也认不出。 */}
                <form
                  className="row-form"
                  noValidate
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleUpdate(project.id);
                  }}
                >
                  <div className="form-field">
                    <label htmlFor={f('name')}>{t.projects.name}</label>
                    <input id={f('name')} value={editName} onChange={(e) => setEditName(e.target.value)} />
                  </div>
                  <div className="form-field">
                    <label htmlFor={f('description')}>{t.projects.description}</label>
                    <input
                      id={f('description')}
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                    />
                  </div>
                  <div className="form-field">
                    <label htmlFor={f('budget')}>
                      {t.projects.budget} ({baseCurrency})
                    </label>
                    <input
                      id={f('budget')}
                      type="text"
                      inputMode="decimal"
                      value={editBudget}
                      onChange={(e) => setEditBudget(e.target.value)}
                    />
                  </div>
                  <div className="form-field">
                    <label htmlFor={f('start')}>{t.projects.startDate}</label>
                    <input
                      id={f('start')}
                      type="date"
                      value={editStartDate}
                      onChange={(e) => setEditStartDate(e.target.value)}
                    />
                  </div>
                  <div className="form-field">
                    <label htmlFor={f('end')}>{t.projects.endDate}</label>
                    <input
                      id={f('end')}
                      type="date"
                      value={editEndDate}
                      onChange={(e) => setEditEndDate(e.target.value)}
                    />
                  </div>
                  <div className="add-form-actions">
                    <button type="submit" disabled={pending || !editName.trim()}>
                      {t.settings.save}
                    </button>
                    <button type="button" onClick={() => setEditing(null)}>
                      {t.common.cancel}
                    </button>
                  </div>
                </form>
              </div>
            );
          }

          // 预算、起止日期并成一行小字。原来是一串灰胶囊，结束日期常常
          // 单独掉到第三行，只剩一个「→ 2026-10-31」。
          const dates =
            project.startDate || project.endDate
              ? `${project.startDate ?? ''} – ${project.endDate ?? ''}`.trim()
              : null;

          return (
            <div key={project.id} className="list-item record-row">
              <div className="record-row-head">
                {/* 名字的链接撑满整张卡（.record-row-link）：原来能点的只有
                    那一行 19px 高的名字。 */}
                <Link href={`/${orgSlug}/projects/${project.id}`} className="record-row-link">
                  {project.name}
                </Link>
                <span
                  className={`badge ${
                    project.status === 'active'
                      ? 'badge-success'
                      : project.status === 'completed'
                        ? 'badge-info'
                        : 'badge-voided'
                  }`}
                >
                  {statusLabel[project.status] ?? project.status}
                </span>
              </div>
              {/* 客户名常常很长，自成一行；预算与起止日期并在下一行。 */}
              {project.contactName ? (
                <p className="record-row-meta">
                  <span>{project.contactName}</span>
                </p>
              ) : null}
              {project.budgetMinor || dates ? (
                <p className="record-row-meta">
                  {project.budgetMinor ? (
                    <span>
                      {t.projects.budget} {formatMoney(project.budgetMinor, baseCurrency, locale)}
                    </span>
                  ) : null}
                  {dates ? <span>{dates}</span> : null}
                </p>
              ) : null}
              <div className="doc-actions record-row-actions">
                {canManage ? (
                  <button type="button" onClick={() => startEdit(project)} className="btn-small">
                    {t.common.edit}
                  </button>
                ) : null}
                {/* 展开盈利分析。原来这颗按钮上只有一个「+」，看着像「新增」，
                    宽 33px。现在写明是什么，箭头表示展开 / 收起。 */}
                {profit ? (
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : project.id)}
                    className="btn-small disclosure-button"
                    aria-expanded={isOpen}
                    aria-controls={detailId}
                  >
                    {t.projects.profitability}
                    <CaretDown size={12} weight="bold" aria-hidden="true" />
                  </button>
                ) : null}
                {canManage ? (
                  <ProjectStatusActions
                    orgSlug={orgSlug}
                    projectId={project.id}
                    projectName={project.name}
                    status={project.status}
                    locale={locale}
                    onChanged={(next) => handleStatusChanged(project.id, next)}
                  />
                ) : null}
              </div>

              {isOpen && profit ? (
                <div id={detailId} className="record-row-extra">
                  <ProjectProfitability profitability={profit} locale={locale} baseCurrency={baseCurrency} />
                  {/* 项目描述原来是写死的 style={{ color: '#666' }}：它既不跟主题走，
                      在暗底（#0b0a09）上又只有 3.1:1，不到 WCAG AA 的 4.5。 */}
                  {project.description ? <p className="field-hint">{project.description}</p> : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </>
  );
}
