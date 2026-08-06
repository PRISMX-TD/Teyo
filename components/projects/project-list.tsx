'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Locale } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
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
};

export function ProjectList({ orgSlug, locale, projects: initialProjects, profitabilityMap }: Props) {
  const t = getMessages(locale);
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
    setEditBudget(item.budgetMinor ? String(Number(item.budgetMinor) / 100) : '');
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
        budgetMinor: editBudget ? String(Math.round(parseFloat(editBudget) * 100)) : undefined,
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
                budgetMinor: editBudget ? BigInt(Math.round(parseFloat(editBudget) * 100)) : null,
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
            <div className="list-item-line">
              <span className="contact-name">
                <Link href={`/${orgSlug}/projects/${project.id}`}>{project.name}</Link>
              </span>
              {project.contactName ? (
                <span>{project.contactName}</span>
              ) : null}
              <span className={`badge ${project.status === 'active' ? 'badge-success' : project.status === 'completed' ? 'badge-info' : 'badge'}`}>
                {statusLabel[project.status] ?? project.status}
              </span>
              {project.budgetMinor ? (
                <span>{t.projects.budget}: {formatMoney(project.budgetMinor, 'USD')}</span>
              ) : null}
              {project.startDate ? <span>{project.startDate}</span> : null}
              {project.endDate ? <span>→ {project.endDate}</span> : null}

              <button onClick={() => startEdit(project)}>Edit</button>
              <button onClick={() => setExpanded(expanded === project.id ? null : project.id)}>
                {expanded === project.id ? '−' : '+'}
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

            {expanded === project.id && profit ? (
              <div style={{ marginTop: 8 }}>
                <ProjectProfitability
                  profitability={profit}
                  locale={locale}
                />
              </div>
            ) : null}

            {expanded === project.id && project.description ? (
              <p style={{ color: '#666', marginTop: 4 }}>{project.description}</p>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
