import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { PRIORITIES, PRIORITY_LABEL, type TaskDetail } from '@outcome/shared';
import { api, ApiError } from '../../lib/api.js';
import { useScrollLock } from '../../lib/useScrollLock.js';
import {
  useComments,
  useLabels,
  useMembers,
  useProject,
  useTaskActivity,
  useTaskByRef,
  useTaskInvalidation,
  useUpdateTask,
} from '../../lib/queries.js';
import {
  Avatar,
  Button,
  EmptyState,
  ErrorState,
  Field,
  LoadingBlock,
  Pill,
  formatDate,
  isOverdue,
  relativeTime,
  useToast,
} from '../../ui/index.js';

/** Right-side task detail. Deep-linkable: /o/:org/p/:key/t/:number */
export function TaskDrawer(): JSX.Element | null {
  const { orgSlug = '', projectKey = '', number } = useParams();
  const navigate = useNavigate();
  const parsed = number ? Number(number) : null;
  useScrollLock();
  const task = useTaskByRef(orgSlug, projectKey, Number.isFinite(parsed) ? parsed : null);
  const close = (): void => navigate(`/o/${orgSlug}/p/${projectKey}/board`);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  return (
    <>
      <div className="drawer-overlay" onClick={close} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Task detail">
        {task.isLoading && (
          <div style={{ padding: 20 }}>
            <LoadingBlock label="Loading task" />
          </div>
        )}
        {task.error && (
          <div style={{ padding: 20 }}>
            <ErrorState
              title={task.error instanceof ApiError && task.error.isNotFound ? 'Task not found' : 'Could not load task'}
              message={
                task.error instanceof ApiError
                  ? (task.error.body.detail ?? task.error.body.title)
                  : 'Unexpected error.'
              }
              onRetry={() => void task.refetch()}
            />
            <Button onClick={close}>Back to board</Button>
          </div>
        )}
        {task.data && <TaskBody task={task.data} orgSlug={orgSlug} onClose={close} />}
      </aside>
    </>
  );
}

function TaskBody({
  task,
  orgSlug,
  onClose,
}: {
  task: TaskDetail;
  orgSlug: string;
  onClose: () => void;
}): JSX.Element {
  const toast = useToast();
  const update = useUpdateTask(orgSlug);
  const invalidate = useTaskInvalidation(orgSlug);
  const project = useProject(orgSlug, task.projectKey);
  const members = useMembers(orgSlug);
  const labels = useLabels(orgSlug);
  const comments = useComments(orgSlug, task.id);
  const activity = useTaskActivity(orgSlug, task.id);

  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [editingDescription, setEditingDescription] = useState(false);
  const [commentBody, setCommentBody] = useState('');
  const [blockerReason, setBlockerReason] = useState('');
  const [showBlockerForm, setShowBlockerForm] = useState(false);
  const [tab, setTab] = useState<'comments' | 'activity'>('comments');

  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description);
  }, [task.id, task.title, task.description]);

  const patch = (fields: Record<string, unknown>, label: string): void => {
    update.mutate(
      { id: task.id, patch: fields },
      {
        onError: (err) =>
          toast.push(
            err instanceof ApiError ? (err.body.detail ?? err.body.title) : `Could not update ${label}`,
            'error',
          ),
      },
    );
  };

  const addComment = useMutation({
    mutationFn: (body: string) => api.post(`/orgs/${orgSlug}/tasks/${task.id}/comments`, { body }),
    onSuccess: () => {
      setCommentBody('');
      invalidate(task.id);
    },
    onError: (err) =>
      toast.push(err instanceof ApiError ? (err.body.detail ?? err.body.title) : 'Could not post comment', 'error'),
  });

  const addBlocker = useMutation({
    mutationFn: (reason: string) => api.post(`/orgs/${orgSlug}/tasks/${task.id}/blockers`, { reason }),
    onSuccess: () => {
      setBlockerReason('');
      setShowBlockerForm(false);
      invalidate(task.id);
      toast.push('Blocker recorded — the task moved to Blocked', 'info');
    },
    onError: (err) =>
      toast.push(err instanceof ApiError ? (err.body.detail ?? err.body.title) : 'Could not add blocker', 'error'),
  });

  const resolveBlocker = useMutation({
    mutationFn: (id: string) => api.post(`/orgs/${orgSlug}/blockers/${id}/resolve`),
    onSuccess: () => {
      invalidate(task.id);
      toast.push('Blocker resolved', 'success');
    },
  });

  const openBlockers = task.blockers.filter((b) => b.resolvedAt === null);

  return (
    <>
      <div className="drawer-head">
        <span className="ref">{task.ref}</span>
        <Pill tone={task.statusCategory === 'done' ? 'good' : task.statusCategory === 'blocked' ? 'danger' : 'default'}>
          {task.statusName}
        </Pill>
        <span className="spacer" />
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close task">
          ✕
        </Button>
      </div>

      <div className="drawer-body">
        <div>
          <input
            className="input"
            style={{ fontSize: 17, fontWeight: 650, border: '1px solid transparent', padding: '4px 6px', marginBottom: 10 }}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              const trimmed = title.trim();
              if (trimmed && trimmed !== task.title) patch({ title: trimmed }, 'title');
              else setTitle(task.title);
            }}
            aria-label="Task title"
          />

          {openBlockers.length > 0 && (
            <div className="alert alert-error" style={{ marginBottom: 14 }}>
              <strong>Blocked.</strong>
              {openBlockers.map((b) => (
                <div key={b.id} style={{ marginTop: 6 }} className="row">
                  <span style={{ flex: 1 }}>{b.reason}</span>
                  <span className="page-sub">{relativeTime(b.createdAt)}</span>
                  <Button size="sm" onClick={() => resolveBlocker.mutate(b.id)} loading={resolveBlocker.isPending}>
                    Resolve
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="meta-label" style={{ marginBottom: 4 }}>
            Description
          </div>
          {editingDescription ? (
            <>
              <textarea
                className="textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                aria-label="Description"
              />
              <div className="row" style={{ marginTop: 6 }}>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    patch({ description }, 'description');
                    setEditingDescription(false);
                  }}
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDescription(task.description);
                    setEditingDescription(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <div
              onClick={() => setEditingDescription(true)}
              style={{ whiteSpace: 'pre-wrap', cursor: 'text', minHeight: 24, color: task.description ? 'inherit' : 'var(--ink-3)' }}
            >
              {task.description || 'Add a description…'}
            </div>
          )}

          {task.subtasks.length > 0 && (
            <>
              <div className="meta-label" style={{ margin: '18px 0 4px' }}>
                Subtasks ({task.subtaskDoneCount}/{task.subtaskCount})
              </div>
              <div className="card">
                {task.subtasks.map((s) => (
                  <div key={s.id} className="list-row">
                    <input
                      type="checkbox"
                      checked={s.statusCategory === 'done'}
                      aria-label={`Mark ${s.title} done`}
                      onChange={(e) => {
                        const target = project.data?.statuses.find(
                          (st) => st.category === (e.target.checked ? 'done' : 'todo'),
                        );
                        if (target) update.mutate({ id: s.id, patch: { statusId: target.id } });
                      }}
                    />
                    <span className="ref">{s.ref}</span>
                    <span style={{ flex: 1, textDecoration: s.statusCategory === 'done' ? 'line-through' : undefined }}>
                      {s.title}
                    </span>
                    <Avatar name={s.assigneeName} />
                  </div>
                ))}
              </div>
            </>
          )}

          {(task.blockedBy.length > 0 || task.blocks.length > 0) && (
            <>
              <div className="meta-label" style={{ margin: '18px 0 4px' }}>
                Dependencies
              </div>
              <div className="stack">
                {task.blockedBy.length > 0 && (
                  <div>
                    <span className="page-sub">Blocked by</span>
                    <div className="row" style={{ flexWrap: 'wrap', marginTop: 4 }}>
                      {task.blockedBy.map((d) => (
                        <span key={d.id} className="chip">
                          {d.statusCategory === 'done' ? '✓' : '⏳'} {d.ref} {d.title}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {task.blocks.length > 0 && (
                  <div>
                    <span className="page-sub">Blocks</span>
                    <div className="row" style={{ flexWrap: 'wrap', marginTop: 4 }}>
                      {task.blocks.map((d) => (
                        <span key={d.id} className="chip">
                          {d.ref} {d.title}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {!showBlockerForm && openBlockers.length === 0 && (
            <Button size="sm" variant="ghost" style={{ marginTop: 14 }} onClick={() => setShowBlockerForm(true)}>
              + Mark as blocked
            </Button>
          )}
          {showBlockerForm && (
            <form
              style={{ marginTop: 14 }}
              onSubmit={(e) => {
                e.preventDefault();
                if (blockerReason.trim()) addBlocker.mutate(blockerReason.trim());
              }}
            >
              <Field label="What is blocking this?" required>
                {(props) => (
                  <textarea
                    {...props}
                    className="textarea"
                    value={blockerReason}
                    onChange={(e) => setBlockerReason(e.target.value)}
                    placeholder="Waiting on API credentials from the platform team"
                    required
                  />
                )}
              </Field>
              <div className="row">
                <Button type="submit" size="sm" variant="primary" loading={addBlocker.isPending}>
                  Record blocker
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setShowBlockerForm(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}

          <div className="tabs" role="tablist" aria-label="Task detail sections" style={{ marginTop: 22 }}>
            <button
              role="tab"
              id="tab-comments"
              aria-selected={tab === 'comments'}
              aria-controls="panel-comments"
              className={`tab ${tab === 'comments' ? 'active' : ''}`}
              style={{ background: 'none', border: 0, borderBottom: '2px solid transparent', cursor: 'pointer' }}
              onClick={() => setTab('comments')}
            >
              Comments ({task.commentCount})
            </button>
            <button
              role="tab"
              id="tab-activity"
              aria-selected={tab === 'activity'}
              aria-controls="panel-activity"
              className={`tab ${tab === 'activity' ? 'active' : ''}`}
              style={{ background: 'none', border: 0, borderBottom: '2px solid transparent', cursor: 'pointer' }}
              onClick={() => setTab('activity')}
            >
              Activity
            </button>
          </div>

          {tab === 'comments' ? (
            <div role="tabpanel" id="panel-comments" aria-labelledby="tab-comments">
              {comments.isLoading && <LoadingBlock label="Loading comments" />}
              {comments.data?.length === 0 && (
                <EmptyState title="No comments yet" body="Use @name to notify a teammate." />
              )}
              {comments.data?.map((c) => (
                <div className="comment" key={c.id}>
                  <div className="comment-head">
                    <Avatar name={c.authorName} />
                    <span className="comment-author">{c.authorName}</span>
                    <span className="comment-time">{relativeTime(c.createdAt)}</span>
                  </div>
                  <div className="comment-body">{c.body}</div>
                </div>
              ))}
              <form
                style={{ marginTop: 12 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (commentBody.trim()) addComment.mutate(commentBody.trim());
                }}
              >
                <textarea
                  className="textarea"
                  value={commentBody}
                  onChange={(e) => setCommentBody(e.target.value)}
                  placeholder="Add a comment… use @name to notify someone"
                  aria-label="New comment"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="primary"
                  style={{ marginTop: 6 }}
                  loading={addComment.isPending}
                  disabled={!commentBody.trim()}
                >
                  Post comment
                </Button>
              </form>
            </div>
          ) : (
            <div role="tabpanel" id="panel-activity" aria-labelledby="tab-activity">
              {activity.isLoading && <LoadingBlock label="Loading activity" />}
              {activity.data?.items.map((e) => (
                <div className="activity-row" key={e.id}>
                  <span className="activity-time">{relativeTime(e.createdAt)}</span>
                  <span>
                    {e.actorType === 'ai' ? 'AI' : (e.actorName ?? 'System')} {describeAction(e.action, e.data)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="meta-rail">
          <div className="meta-item">
            <span className="meta-label">Status</span>
            <select
              className="select"
              value={task.statusId}
              onChange={(e) => patch({ statusId: e.target.value }, 'status')}
              aria-label="Status"
            >
              {project.data?.statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <div className="meta-item">
            <span className="meta-label">Priority</span>
            <select
              className="select"
              value={task.priority}
              onChange={(e) => patch({ priority: e.target.value }, 'priority')}
              aria-label="Priority"
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </div>

          <div className="meta-item">
            <span className="meta-label">Assignee</span>
            <select
              className="select"
              value={task.assigneeId ?? ''}
              onChange={(e) => patch({ assigneeId: e.target.value || null }, 'assignee')}
              aria-label="Assignee"
            >
              <option value="">Unassigned</option>
              {members.data?.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>

          <div className="meta-item">
            <span className="meta-label">Due date</span>
            <input
              className="input"
              type="date"
              value={task.dueDate ?? ''}
              onChange={(e) => patch({ dueDate: e.target.value || null }, 'due date')}
              aria-label="Due date"
            />
            {isOverdue(task.dueDate, task.statusCategory) && <span className="field-error">Overdue</span>}
          </div>

          <div className="meta-item">
            <span className="meta-label">Estimate (days)</span>
            <input
              className="input"
              type="number"
              min={0}
              step={0.5}
              value={task.estimateDays ?? ''}
              onChange={(e) =>
                patch({ estimateDays: e.target.value === '' ? null : Number(e.target.value) }, 'estimate')
              }
              aria-label="Estimate in days"
            />
          </div>

          <div className="meta-item">
            <span className="meta-label">Labels</span>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {labels.data?.map((l) => {
                const on = task.labels.some((tl) => tl.id === l.id);
                return (
                  <button
                    key={l.id}
                    type="button"
                    className="chip"
                    style={{ cursor: 'pointer', opacity: on ? 1 : 0.5, fontWeight: on ? 600 : 400 }}
                    aria-pressed={on}
                    onClick={() =>
                      patch(
                        {
                          labelIds: on
                            ? task.labels.filter((tl) => tl.id !== l.id).map((tl) => tl.id)
                            : [...task.labels.map((tl) => tl.id), l.id],
                        },
                        'labels',
                      )
                    }
                  >
                    <span className="chip-swatch" style={{ background: l.color }} />
                    {l.name}
                  </button>
                );
              })}
              {labels.data?.length === 0 && <span className="page-sub">No labels yet</span>}
            </div>
          </div>

          <div className="meta-item">
            <span className="meta-label">Created</span>
            <span className="page-sub">{formatDate(task.createdAt)}</span>
          </div>
          {task.source !== 'manual' && (
            <div className="meta-item">
              <span className="meta-label">Source</span>
              <Pill tone="accent">{task.source === 'ai' ? 'Created by AI' : 'Imported'}</Pill>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** Renders only primitive audit values; objects never leak as [object Object]. */
function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function describeAction(action: string, data: Record<string, unknown>): string {
  if (action === 'created') return 'created this task';
  if (action === 'deleted') return 'deleted this task';
  if (action === 'dependency_added') return `added a dependency on ${asText(data['blockingRef']) ?? 'another task'}`;
  if (action === 'dependency_removed') return 'removed a dependency';
  if (action === 'resolved') return 'resolved a blocker';
  if (action === 'updated') {
    const changes = (data['changes'] as Array<{ field: string; new: unknown }> | undefined) ?? [];
    const summary = changes
      .map((c) => `${c.field.replace(/_/g, ' ')} → ${asText(c.new) ?? 'none'}`)
      .join(', ');
    return `changed ${summary || 'this task'}`;
  }
  return action.replace(/_/g, ' ');
}
