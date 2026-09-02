import { useState } from 'react';
import { Link, Outlet, useParams } from 'react-router-dom';
import { PRIORITIES, PRIORITY_LABEL } from '@outcome/shared';
import { useCreateTask, useEpics, useMembers, useProject, useTaskList } from '../lib/queries.js';
import { ApiError } from '../lib/api.js';
import {
  Avatar,
  Button,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Pill,
  formatDate,
  isOverdue,
  useToast,
} from '../ui/index.js';

export function Backlog(): JSX.Element {
  const { orgSlug = '', projectKey = '' } = useParams();
  const project = useProject(orgSlug, projectKey);
  const epics = useEpics(orgSlug, projectKey);
  const members = useMembers(orgSlug);
  const toast = useToast();
  const create = useCreateTask(orgSlug, projectKey);

  const [filters, setFilters] = useState<{ assigneeId?: string; priority?: string; statusCategory?: string }>({});
  const [newTitle, setNewTitle] = useState('');

  const tasks = useTaskList(orgSlug, {
    projectId: projectKey,
    parent: 'all',
    ...filters,
  });

  if (tasks.isLoading || project.isLoading) return <LoadingBlock label="Loading backlog" />;
  if (tasks.error) {
    return (
      <ErrorState
        message={
          tasks.error instanceof ApiError ? (tasks.error.body.detail ?? tasks.error.body.title) : 'Could not load tasks.'
        }
        onRetry={() => void tasks.refetch()}
      />
    );
  }

  const items = tasks.data?.items ?? [];
  const epicName = (id: string | null): string =>
    id ? (epics.data?.find((e) => e.id === id)?.name ?? '—') : 'No epic';

  return (
    <>
      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <select
          className="select"
          style={{ width: 'auto' }}
          value={filters.assigneeId ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, assigneeId: e.target.value || undefined }))}
          aria-label="Filter by assignee"
        >
          <option value="">All assignees</option>
          <option value="me">Assigned to me</option>
          <option value="none">Unassigned</option>
          {members.data?.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name}
            </option>
          ))}
        </select>
        <select
          className="select"
          style={{ width: 'auto' }}
          value={filters.priority ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value || undefined }))}
          aria-label="Filter by priority"
        >
          <option value="">Any priority</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]}
            </option>
          ))}
        </select>
        <select
          className="select"
          style={{ width: 'auto' }}
          value={filters.statusCategory ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, statusCategory: e.target.value || undefined }))}
          aria-label="Filter by status"
        >
          <option value="">Any status</option>
          {project.data?.statuses.map((s) => (
            <option key={s.id} value={s.category}>
              {s.name}
            </option>
          ))}
        </select>
        {Object.values(filters).some(Boolean) && (
          <Button size="sm" variant="ghost" onClick={() => setFilters({})}>
            Clear filters
          </Button>
        )}
        <span className="spacer" />
        <span className="page-sub">
          {items.length} task{items.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="card">
        {items.length === 0 ? (
          <EmptyState
            title={Object.values(filters).some(Boolean) ? 'Nothing matches those filters' : 'Backlog is empty'}
            body={
              Object.values(filters).some(Boolean)
                ? 'Try clearing a filter.'
                : 'Add tasks below — only a title is required.'
            }
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 88 }}>Ref</th>
                <th>Title</th>
                <th style={{ width: 130 }}>Epic</th>
                <th style={{ width: 110 }}>Status</th>
                <th style={{ width: 90 }}>Priority</th>
                <th style={{ width: 100 }}>Due</th>
                <th style={{ width: 46 }}>Owner</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td className="num">
                    <Link to={`/o/${orgSlug}/p/${projectKey}/t/${t.number}`} className="ref">
                      {t.ref}
                    </Link>
                  </td>
                  <td>
                    <Link to={`/o/${orgSlug}/p/${projectKey}/t/${t.number}`} style={{ color: 'inherit' }}>
                      {t.parentId && <span className="page-sub">↳ </span>}
                      {t.title}
                    </Link>
                    {t.openBlockerCount > 0 && (
                      <>
                        {' '}
                        <Pill tone="danger">Blocked</Pill>
                      </>
                    )}
                  </td>
                  <td className="page-sub">{epicName(t.epicId)}</td>
                  <td>
                    <Pill tone={t.statusCategory === 'done' ? 'good' : t.statusCategory === 'blocked' ? 'danger' : 'default'}>
                      {t.statusName}
                    </Pill>
                  </td>
                  <td className="page-sub">{PRIORITY_LABEL[t.priority]}</td>
                  <td className="num">
                    {t.dueDate ? (
                      isOverdue(t.dueDate, t.statusCategory) ? (
                        <Pill tone="danger">{formatDate(t.dueDate)}</Pill>
                      ) : (
                        formatDate(t.dueDate)
                      )
                    ) : (
                      <span className="page-sub">—</span>
                    )}
                  </td>
                  <td>
                    <Avatar name={t.assigneeName} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <form
          className="row"
          style={{ padding: 10, borderTop: '1px solid var(--border)' }}
          onSubmit={(e) => {
            e.preventDefault();
            const title = newTitle.trim();
            if (!title) return;
            create.mutate(
              { title },
              {
                onSuccess: () => setNewTitle(''),
                onError: (err) =>
                  toast.push(
                    err instanceof ApiError ? (err.body.detail ?? err.body.title) : 'Could not create task',
                    'error',
                  ),
              },
            );
          }}
        >
          <input
            className="input"
            placeholder="+ Add a task (title only)"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            aria-label="New task title"
          />
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!newTitle.trim()}>
            Add
          </Button>
        </form>
      </div>
      <Outlet />
    </>
  );
}
