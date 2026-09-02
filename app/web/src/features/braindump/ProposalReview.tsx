import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  PRIORITIES,
  PRIORITY_LABEL,
  type ApprovedTask,
  type Braindump,
  type Confidence,
  type Priority,
  type ProposedTask,
  type Task,
} from '@outcome/shared';
import { api, ApiError } from '../../lib/api.js';
import { useEpics, useLabels, useMembers, useProjects, useTaskInvalidation } from '../../lib/queries.js';
import { Button, Pill, useToast } from '../../ui/index.js';

interface Draft extends ApprovedTask {
  included: boolean;
  /** Fields the model was unsure about, so the UI can keep marking them. */
  lowConfidence: Set<string>;
  unresolvedQuestions: string[];
  possibleDuplicateOf: string[];
  suggestedGroup: string | null;
  sourceQuote: string;
}

const CONFIDENCE_TONE: Record<Confidence, 'good' | 'warn' | 'danger'> = {
  high: 'good',
  medium: 'warn',
  low: 'danger',
};

/** Resolve a name the model saw ("priya", "Marco") to a real member, or null. */
function matchMember(
  hint: string | null | undefined,
  members: Array<{ userId: string; name: string; email: string }>,
): string | null {
  if (!hint) return null;
  const needle = hint.trim().toLowerCase();
  if (!needle) return null;
  const exact = members.find(
    (m) =>
      m.name.toLowerCase() === needle ||
      m.email.toLowerCase() === needle ||
      m.email.split('@')[0]?.toLowerCase() === needle,
  );
  if (exact) return exact.userId;
  const firstName = members.filter((m) => m.name.split(' ')[0]?.toLowerCase() === needle);
  // Only auto-fill when the first name is unambiguous.
  return firstName.length === 1 ? firstName[0]!.userId : null;
}

export function ProposalReview({
  orgSlug,
  dump,
  defaultProjectKey,
  onDone,
  onDiscard,
}: {
  orgSlug: string;
  dump: Braindump;
  defaultProjectKey: string;
  onDone: (createdCount: number, projectKey: string) => void;
  onDiscard: () => void;
}): JSX.Element {
  const toast = useToast();
  const projects = useProjects(orgSlug);
  const members = useMembers(orgSlug);
  const invalidate = useTaskInvalidation(orgSlug);
  const [projectKey, setProjectKey] = useState(defaultProjectKey);
  const epics = useEpics(orgSlug, projectKey);
  const labels = useLabels(orgSlug);
  const proposal = dump.proposal!;

  const [drafts, setDrafts] = useState<Draft[]>(() =>
    proposal.tasks.map((task) => toDraft(task, proposal.questions, members.data ?? [])),
  );
  // Members may load after the first render; fill in owners once they arrive.
  // Only unambiguous name matches are applied, and never over a user's edit.
  const memberList = members.data ?? [];
  const memberCount = memberList.length;
  useEffect(() => {
    if (memberCount === 0) return;
    setDrafts((current) =>
      current.map((draft, index) => {
        if (draft.assigneeId) return draft;
        const hint = proposal.tasks[index]?.assigneeHint?.value ?? null;
        const matched = matchMember(hint, memberList);
        return matched ? { ...draft, assigneeId: matched } : draft;
      }),
    );
    // memberList is derived from query data; its length is the real trigger.
  }, [memberCount, proposal.tasks, memberList]);

  const approve = useMutation({
    mutationFn: (payload: { projectId: string; tasks: ApprovedTask[] }) =>
      api.post<{ created: Task[] }>(`/orgs/${orgSlug}/braindumps/${dump.id}/approve`, payload),
    onSuccess: (result) => {
      invalidate();
      onDone(result.created.length, projectKey);
    },
    onError: (err) =>
      toast.push(
        err instanceof ApiError ? (err.body.detail ?? err.body.title) : 'Could not create the tasks',
        'error',
      ),
  });

  const discard = useMutation({
    mutationFn: () => api.post(`/orgs/${orgSlug}/braindumps/${dump.id}/discard`),
    onSuccess: onDiscard,
  });

  const included = drafts.filter((d) => d.included);
  const needsAnswer = included.filter((d) => d.unresolvedQuestions.length > 0);
  const update = (key: string, patch: Partial<Draft>): void =>
    setDrafts((current) => current.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Review before creating</h1>
          <div className="page-sub">
            {proposal.summary} Nothing has been created yet — edit anything that looks wrong.
          </div>
        </div>
        <Button variant="ghost" onClick={() => discard.mutate()} loading={discard.isPending}>
          Discard this dump
        </Button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px', gap: 20, alignItems: 'start' }}>
        <div className="stack">
          {drafts.map((draft) => (
            <article
              key={draft.key}
              className="card card-pad"
              style={{ opacity: draft.included ? 1 : 0.55 }}
            >
              <div className="row" style={{ alignItems: 'flex-start', marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={draft.included}
                  onChange={(e) => update(draft.key, { included: e.target.checked })}
                  aria-label={`Include "${draft.title}"`}
                  style={{ marginTop: 4 }}
                />
                <input
                  className="input"
                  value={draft.title}
                  onChange={(e) => update(draft.key, { title: e.target.value })}
                  aria-label={`Title for ${draft.key}`}
                  style={{ fontWeight: 600 }}
                />
              </div>

              {draft.possibleDuplicateOf.length > 0 && (
                <div className="alert alert-warn" style={{ marginBottom: 10 }}>
                  Looks like existing {draft.possibleDuplicateOf.join(', ')}. Uncheck it if this is
                  the same work.
                </div>
              )}

              {draft.unresolvedQuestions.length > 0 && (
                <div className="alert alert-warn" style={{ marginBottom: 10 }}>
                  <strong>Needs your answer:</strong>
                  <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                    {draft.unresolvedQuestions.map((q) => (
                      <li key={q}>{q}</li>
                    ))}
                  </ul>
                  <Button
                    size="sm"
                    style={{ marginTop: 8 }}
                    onClick={() => update(draft.key, { unresolvedQuestions: [], lowConfidence: new Set() })}
                  >
                    Values look right
                  </Button>
                </div>
              )}

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                  gap: 10,
                }}
              >
                <FieldCell label="Priority" flagged={draft.lowConfidence.has('priority')}>
                  <select
                    className="select"
                    value={draft.priority}
                    onChange={(e) => update(draft.key, { priority: e.target.value as Priority })}
                    aria-label={`Priority for ${draft.key}`}
                  >
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {PRIORITY_LABEL[p]}
                      </option>
                    ))}
                  </select>
                </FieldCell>

                <FieldCell label="Owner" flagged={draft.lowConfidence.has('assignee')}>
                  <select
                    className="select"
                    value={draft.assigneeId ?? ''}
                    onChange={(e) => update(draft.key, { assigneeId: e.target.value || null })}
                    aria-label={`Owner for ${draft.key}`}
                  >
                    <option value="">Unassigned</option>
                    {memberList.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </FieldCell>

                <FieldCell label="Due date" flagged={draft.lowConfidence.has('dueDate')}>
                  <input
                    className="input"
                    type="date"
                    value={draft.dueDate ?? ''}
                    onChange={(e) => update(draft.key, { dueDate: e.target.value || null })}
                    aria-label={`Due date for ${draft.key}`}
                  />
                </FieldCell>

                <FieldCell label="Epic">
                  <select
                    className="select"
                    value={draft.epicId ?? ''}
                    onChange={(e) => update(draft.key, { epicId: e.target.value || null })}
                    aria-label={`Epic for ${draft.key}`}
                  >
                    <option value="">No epic</option>
                    {epics.data?.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </FieldCell>
              </div>

              {draft.blockerReason && (
                <div className="alert alert-error" style={{ marginTop: 10 }}>
                  <strong>Blocked:</strong> {draft.blockerReason}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => update(draft.key, { blockerReason: null })}
                    style={{ marginLeft: 8 }}
                  >
                    Not blocked
                  </Button>
                </div>
              )}

              <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                {draft.suggestedGroup && <span className="chip">group: {draft.suggestedGroup}</span>}
                {draft.dependsOnKeys.length > 0 && (
                  <span className="chip">
                    after: {draft.dependsOnKeys.map((k) => titleOf(drafts, k)).join(', ')}
                  </span>
                )}
                {labels.data
                  ?.filter((l) => draft.labelIds.includes(l.id))
                  .map((l) => (
                    <span className="chip" key={l.id}>
                      {l.name}
                    </span>
                  ))}
                <span className="spacer" />
                <span className="page-sub" title={draft.sourceQuote} style={{ fontSize: 11 }}>
                  “{draft.sourceQuote.slice(0, 70)}
                  {draft.sourceQuote.length > 70 ? '…' : ''}”
                </span>
              </div>
            </article>
          ))}

          {proposal.notes.length > 0 && (
            <div className="card card-pad">
              <h3 style={{ marginBottom: 6 }}>Not turned into tasks</h3>
              <div className="page-sub" style={{ marginBottom: 8 }}>
                Kept here so nothing looks silently dropped.
              </div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {proposal.notes.map((n) => (
                  <li key={n} className="page-sub">
                    {n}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <aside className="card card-pad" style={{ position: 'sticky', top: 76 }}>
          <h3 style={{ marginBottom: 8 }}>Create tasks</h3>
          <label className="field-label" htmlFor="review-project">
            Project
          </label>
          <select
            id="review-project"
            className="select"
            value={projectKey}
            onChange={(e) => setProjectKey(e.target.value)}
            style={{ marginBottom: 12 }}
          >
            {projects.data?.map((p) => (
              <option key={p.id} value={p.key}>
                {p.key} — {p.name}
              </option>
            ))}
          </select>

          <div className="stack" style={{ gap: 4, marginBottom: 12 }}>
            <div className="row">
              <span style={{ flex: 1 }}>Selected</span>
              <strong>{included.length}</strong>
            </div>
            <div className="row">
              <span style={{ flex: 1 }}>Need an answer</span>
              <strong>{needsAnswer.length}</strong>
            </div>
            <div className="row">
              <span style={{ flex: 1 }}>Dependencies</span>
              <strong>
                {included.reduce(
                  (sum, d) => sum + d.dependsOnKeys.filter((k) => included.some((i) => i.key === k)).length,
                  0,
                )}
              </strong>
            </div>
          </div>

          {needsAnswer.length > 0 && (
            <div className="alert alert-warn" style={{ marginBottom: 10 }}>
              {needsAnswer.length} selected task{needsAnswer.length === 1 ? '' : 's'} still{' '}
              {needsAnswer.length === 1 ? 'has' : 'have'} an unanswered question. Confirm or edit
              those fields first.
            </div>
          )}

          <Button
            variant="primary"
            className="btn-block"
            loading={approve.isPending}
            disabled={included.length === 0 || needsAnswer.length > 0 || !projectKey}
            onClick={() =>
              approve.mutate({
                projectId: projectKey,
                tasks: included.map(toPayload),
              })
            }
          >
            Create {included.length} task{included.length === 1 ? '' : 's'}
          </Button>
          <Button
            variant="ghost"
            className="btn-block"
            style={{ marginTop: 6 }}
            onClick={() => setDrafts((c) => c.map((d) => ({ ...d, included: true })))}
          >
            Select all
          </Button>

          <div className="page-sub" style={{ marginTop: 12, fontSize: 11 }}>
            Extracted by {dump.model} using prompt {dump.promptVersion}. Every created task keeps a
            link back to this dump.
          </div>
        </aside>
      </div>
    </>
  );
}

function FieldCell({
  label,
  flagged,
  children,
}: {
  label: string;
  flagged?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div>
      <div className="row" style={{ gap: 4, marginBottom: 2 }}>
        <span className="field-label">{label}</span>
        {flagged && <Pill tone="danger">unsure</Pill>}
      </div>
      {children}
    </div>
  );
}

function titleOf(drafts: Draft[], key: string): string {
  const found = drafts.find((d) => d.key === key);
  return found ? found.title.slice(0, 28) : key;
}

function toDraft(
  task: ProposedTask,
  questions: Braindump['proposal'] extends null ? never : NonNullable<Braindump['proposal']>['questions'],
  members: Array<{ userId: string; name: string; email: string }>,
): Draft {
  const low = new Set<string>();
  if (task.priority?.confidence === 'low') low.add('priority');
  if (task.dueDate?.confidence === 'low') low.add('dueDate');
  if (task.assigneeHint?.confidence === 'low') low.add('assignee');

  return {
    key: task.key,
    title: task.title,
    description: task.description,
    priority: task.priority?.value ?? 'none',
    assigneeId: matchMember(task.assigneeHint?.value ?? null, members),
    // A low-confidence date is offered but flagged, never applied silently.
    dueDate: task.dueDate?.value ?? null,
    estimateDays: task.estimateDays?.value ?? null,
    epicId: null,
    labelIds: [],
    dependsOnKeys: task.dependsOnKeys,
    blockerReason: task.blocker?.reason ?? null,
    included: task.possibleDuplicateOf.length === 0,
    lowConfidence: low,
    unresolvedQuestions: questions.filter((q) => q.taskKey === task.key).map((q) => q.question),
    possibleDuplicateOf: task.possibleDuplicateOf,
    suggestedGroup: task.suggestedGroup,
    sourceQuote: task.sourceQuote,
  };
}

function toPayload(draft: Draft): ApprovedTask {
  return {
    key: draft.key,
    title: draft.title,
    description: draft.description,
    priority: draft.priority,
    assigneeId: draft.assigneeId ?? null,
    dueDate: draft.dueDate ?? null,
    estimateDays: draft.estimateDays ?? null,
    epicId: draft.epicId ?? null,
    labelIds: draft.labelIds,
    dependsOnKeys: draft.dependsOnKeys,
    blockerReason: draft.blockerReason ?? null,
  };
}

export { CONFIDENCE_TONE };
