import { useState } from 'react';
import { Link, Outlet, useParams } from 'react-router-dom';
import type { Task } from '@outcome/shared';
import { useBoard, useCreateTask, useMoveTask } from '../../lib/queries.js';
import { ApiError } from '../../lib/api.js';
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
} from '../../ui/index.js';

const PRIORITY_MARK: Record<string, { label: string; tone: 'danger' | 'warn' | 'default' }> = {
  urgent: { label: 'Urgent', tone: 'danger' },
  high: { label: 'High', tone: 'warn' },
  medium: { label: 'Med', tone: 'default' },
  low: { label: 'Low', tone: 'default' },
};

export function Board(): JSX.Element {
  const { orgSlug = '', projectKey = '' } = useParams();
  const board = useBoard(orgSlug, projectKey);
  const move = useMoveTask(orgSlug);
  const create = useCreateTask(orgSlug, projectKey);
  const toast = useToast();
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [quickAdd, setQuickAdd] = useState<{ statusId: string; title: string } | null>(null);

  if (board.isLoading) return <LoadingBlock label="Loading board" />;
  if (board.error) {
    return (
      <ErrorState
        message={
          board.error instanceof ApiError
            ? (board.error.body.detail ?? board.error.body.title)
            : 'Could not load the board.'
        }
        onRetry={() => void board.refetch()}
      />
    );
  }

  const data = board.data!;
  const statuses = data.project.statuses;
  const isEmpty = data.columns.every((c) => c.tasks.length === 0);

  function drop(statusId: string, taskId: string, tasks: Task[]): void {
    setDragOver(null);
    setDragging(null);
    // Dropped on the column body: append to the end of that column.
    const last = tasks.filter((t) => t.id !== taskId).at(-1);
    move.mutate(
      { id: taskId, statusId, beforeTaskId: last?.id ?? null },
      {
        onError: (err) =>
          toast.push(
            err instanceof ApiError ? (err.body.detail ?? err.body.title) : 'Could not move that task',
            'error',
          ),
      },
    );
  }

  return (
    <>
      {isEmpty ? (
        <div className="card">
          <EmptyState
            title="No tasks yet"
            body="Add your first task, or capture a whole plan at once from the backlog."
            action={
              <Button
                variant="primary"
                onClick={() => setQuickAdd({ statusId: statuses[0]?.id ?? '', title: '' })}
              >
                Add a task
              </Button>
            }
          />
        </div>
      ) : null}

      <div className="board">
        {statuses.map((status) => {
          const column = data.columns.find((c) => c.statusId === status.id);
          const tasks = column?.tasks ?? [];
          return (
            <section
              key={status.id}
              className={`board-col ${dragOver === status.id ? 'drag-over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(status.id);
              }}
              onDragLeave={() => setDragOver((cur) => (cur === status.id ? null : cur))}
              onDrop={(e) => {
                e.preventDefault();
                // dataTransfer can be absent (synthetic events, some AT);
                // fall back to the id captured on drag start.
                const taskId = e.dataTransfer?.getData('text/task-id') || dragging;
                if (taskId) drop(status.id, taskId, tasks);
              }}
              aria-label={`${status.name} column`}
            >
              <header className="board-col-head">
                <span>{status.name}</span>
                <span className="board-count">{tasks.length}</span>
                <span className="spacer" />
                <button
                  className="btn btn-ghost btn-sm"
                  aria-label={`Add task to ${status.name}`}
                  onClick={() => setQuickAdd({ statusId: status.id, title: '' })}
                >
                  +
                </button>
              </header>

              {quickAdd?.statusId === status.id && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const title = quickAdd.title.trim();
                    if (!title) return;
                    create.mutate(
                      { title, statusId: status.id },
                      {
                        onSuccess: () => setQuickAdd({ statusId: status.id, title: '' }),
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
                    autoFocus
                    placeholder="Task title, then Enter"
                    value={quickAdd.title}
                    onChange={(e) => setQuickAdd({ statusId: status.id, title: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setQuickAdd(null);
                    }}
                    aria-label={`New task in ${status.name}`}
                  />
                  <div className="row" style={{ margin: '6px 0 8px' }}>
                    <Button type="submit" size="sm" variant="primary" loading={create.isPending}>
                      Add
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setQuickAdd(null)}>
                      Done
                    </Button>
                  </div>
                </form>
              )}

              {tasks.map((task) => (
                <Link
                  key={task.id}
                  to={`/o/${orgSlug}/p/${projectKey}/t/${task.number}`}
                  className={`board-card ${dragging === task.id ? 'dragging' : ''}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer?.setData('text/task-id', task.id);
                    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                    setDragging(task.id);
                  }}
                  onDragEnd={() => setDragging(null)}
                >
                  <span className="ref">{task.ref}</span>
                  <div className="board-card-title">{task.title}</div>
                  <div className="board-card-meta">
                    {PRIORITY_MARK[task.priority] && (
                      <Pill tone={PRIORITY_MARK[task.priority]!.tone}>{PRIORITY_MARK[task.priority]!.label}</Pill>
                    )}
                    {task.openBlockerCount > 0 && <Pill tone="danger">Blocked</Pill>}
                    {task.openBlockerCount === 0 && task.blockedByOpenCount > 0 && (
                      <Pill tone="warn">Waiting on {task.blockedByOpenCount}</Pill>
                    )}
                    {task.dueDate && (
                      <Pill tone={isOverdue(task.dueDate, task.statusCategory) ? 'danger' : 'default'}>
                        {formatDate(task.dueDate)}
                      </Pill>
                    )}
                    {task.subtaskCount > 0 && (
                      <span className="chip">
                        {task.subtaskDoneCount}/{task.subtaskCount}
                      </span>
                    )}
                    {task.labels.map((l) => (
                      <span className="chip" key={l.id}>
                        <span className="chip-swatch" style={{ background: l.color }} />
                        {l.name}
                      </span>
                    ))}
                    <span className="spacer" />
                    <Avatar name={task.assigneeName} />
                  </div>
                </Link>
              ))}
            </section>
          );
        })}
      </div>
      <Outlet />
    </>
  );
}
