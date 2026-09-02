import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import type { AssistantReply, ProposedAction } from '@outcome/shared';
import { api, ApiError } from '../../lib/api.js';
import { useProjects, useTaskInvalidation } from '../../lib/queries.js';
import { Button, EmptyState, Pill, useToast } from '../../ui/index.js';

interface Turn {
  question: string;
  reply: AssistantReply | null;
  error: string | null;
}

const SUGGESTIONS = [
  'What should I work on today?',
  'What is blocking us right now?',
  'Which tasks are overdue?',
  'Who is overloaded?',
  'Which projects are at risk?',
];

/**
 * Assistant chat. Facts and recommendations are visually separated, every
 * cited task is a link, and any change the assistant proposes is a card the
 * user must confirm — the assistant cannot act by replying.
 */
export function Assistant(): JSX.Element {
  const { orgSlug = '' } = useParams();
  const toast = useToast();
  const projects = useProjects(orgSlug);
  const invalidate = useTaskInvalidation(orgSlug);
  const [question, setQuestion] = useState('');
  const [projectKey, setProjectKey] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [applied, setApplied] = useState<Record<string, 'executed' | 'rejected'>>({});

  const askMutation = useMutation({
    mutationFn: (text: string) =>
      api.post<AssistantReply>(`/orgs/${orgSlug}/assistant/ask`, {
        question: text,
        projectId: projectKey || null,
        conversationId,
      }),
    onSuccess: (reply, text) => {
      setConversationId(reply.conversationId);
      setTurns((current) => [...current, { question: text, reply, error: null }]);
    },
    onError: (err, text) => {
      setTurns((current) => [
        ...current,
        {
          question: text,
          reply: null,
          error:
            err instanceof ApiError
              ? (err.body.detail ?? err.body.title)
              : 'The assistant could not answer. Try again.',
        },
      ]);
    },
  });

  const confirm = useMutation({
    mutationFn: (actionId: string) =>
      api.post<{ status: string; result: Record<string, unknown> }>(
        `/orgs/${orgSlug}/assistant/actions/confirm`,
        { actionId, confirm: true },
      ),
    onSuccess: (_result, actionId) => {
      setApplied((current) => ({ ...current, [actionId]: 'executed' }));
      invalidate();
      toast.push('Applied', 'success');
    },
    onError: (err) =>
      toast.push(
        err instanceof ApiError ? (err.body.detail ?? err.body.title) : 'Could not apply that',
        'error',
      ),
  });

  const reject = useMutation({
    mutationFn: (actionId: string) =>
      api.post(`/orgs/${orgSlug}/assistant/actions/${actionId}/reject`),
    onSuccess: (_r, actionId) =>
      setApplied((current) => ({ ...current, [actionId]: 'rejected' })),
  });

  const submit = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setQuestion('');
    askMutation.mutate(trimmed);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Assistant</h1>
          <div className="page-sub">
            Answers come from work you have access to, with links to the tasks they came from.
            Anything that would change data is proposed for your confirmation.
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 820 }}>
        <div className="row" style={{ marginBottom: 12 }}>
          <select
            className="select"
            style={{ width: 'auto' }}
            value={projectKey}
            onChange={(e) => setProjectKey(e.target.value)}
            aria-label="Scope"
          >
            <option value="">All projects I can see</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.key}>
                {p.key} — {p.name}
              </option>
            ))}
          </select>
          {conversationId && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setConversationId(null);
                setTurns([]);
              }}
            >
              New conversation
            </Button>
          )}
        </div>

        {turns.length === 0 && (
          <div className="card">
            <EmptyState
              title="Ask about your projects"
              body="Try one of these:"
              action={
                <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'center' }}>
                  {SUGGESTIONS.map((s) => (
                    <Button key={s} size="sm" onClick={() => submit(s)}>
                      {s}
                    </Button>
                  ))}
                </div>
              }
            />
          </div>
        )}

        <div className="stack">
          {turns.map((turn, index) => (
            <div key={index} className="stack">
              <div className="card card-pad" style={{ background: 'var(--surface-2)' }}>
                <strong>{turn.question}</strong>
              </div>

              {turn.error && (
                <div className="alert alert-error" role="alert">
                  {turn.error}
                </div>
              )}

              {turn.reply && (
                <div className="card card-pad">
                  {turn.reply.answer.cannotAnswer ? (
                    <div className="alert alert-warn">{turn.reply.answer.cannotAnswer}</div>
                  ) : (
                    <>
                      {turn.reply.answer.facts.length > 0 && (
                        <>
                          <div className="meta-label" style={{ marginBottom: 6 }}>
                            What the data shows
                          </div>
                          <ul style={{ margin: '0 0 14px', paddingLeft: 18 }}>
                            {turn.reply.answer.facts.map((fact, i) => (
                              <li key={i} style={{ marginBottom: 4 }}>
                                {fact.text}{' '}
                                {fact.refs.map((ref) => {
                                  const citation = turn.reply!.citations.find((c) => c.ref === ref);
                                  return citation ? (
                                    <Link
                                      key={ref}
                                      className="ref"
                                      to={`/o/${orgSlug}/p/${citation.projectKey}/t/${citation.number}`}
                                      title={citation.title}
                                      style={{ marginRight: 4 }}
                                    >
                                      {ref}
                                    </Link>
                                  ) : null;
                                })}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}

                      {turn.reply.answer.recommendations.length > 0 && (
                        <>
                          <div className="meta-label" style={{ marginBottom: 6 }}>
                            Recommendation
                          </div>
                          <ul style={{ margin: 0, paddingLeft: 18 }}>
                            {turn.reply.answer.recommendations.map((r, i) => (
                              <li key={i} className="page-sub" style={{ color: 'var(--ink-2)' }}>
                                {r}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </>
                  )}

                  {turn.reply.actions.length > 0 && (
                    <div style={{ marginTop: 14 }}>
                      <div className="meta-label" style={{ marginBottom: 6 }}>
                        Proposed changes — nothing is applied until you confirm
                      </div>
                      {turn.reply.actions.map(({ id, action }) => (
                        <ActionCard
                          key={id}
                          action={action}
                          state={applied[id]}
                          busy={confirm.isPending || reject.isPending}
                          onConfirm={() => confirm.mutate(id)}
                          onReject={() => reject.mutate(id)}
                        />
                      ))}
                    </div>
                  )}

                  <div className="page-sub" style={{ marginTop: 12, fontSize: 11 }}>
                    {turn.reply.model} · prompt {turn.reply.promptVersion}
                  </div>
                </div>
              )}
            </div>
          ))}

          {askMutation.isPending && (
            <div className="alert" role="status">
              Reading your projects…
            </div>
          )}
        </div>

        <form
          className="row"
          style={{ marginTop: 14 }}
          onSubmit={(e) => {
            e.preventDefault();
            submit(question);
          }}
        >
          <input
            className="input"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask about blockers, deadlines, dependencies or workload…"
            aria-label="Question"
            disabled={askMutation.isPending}
          />
          <Button type="submit" variant="primary" loading={askMutation.isPending} disabled={!question.trim()}>
            Ask
          </Button>
        </form>
      </div>
    </>
  );
}

function ActionCard({
  action,
  state,
  busy,
  onConfirm,
  onReject,
}: {
  action: ProposedAction;
  state: 'executed' | 'rejected' | undefined;
  busy: boolean;
  onConfirm: () => void;
  onReject: () => void;
}): JSX.Element {
  return (
    <div
      className="card card-pad"
      style={{ marginBottom: 8, borderColor: state ? 'var(--border)' : 'var(--accent)' }}
    >
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="chip">{action.tool.replace(/_/g, ' ')}</span>
        {action.highImpact && <Pill tone="warn">High impact</Pill>}
        {state === 'executed' && <Pill tone="good">Applied</Pill>}
        {state === 'rejected' && <Pill>Dismissed</Pill>}
      </div>
      <div>{action.description}</div>
      <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
        {action.targetRef && <span className="chip">on {action.targetRef}</span>}
        {action.assigneeName && <span className="chip">to {action.assigneeName}</span>}
        {action.priority && <span className="chip">priority {action.priority}</span>}
        {action.dueDate && <span className="chip">due {action.dueDate}</span>}
        {action.blockingRef && <span className="chip">after {action.blockingRef}</span>}
      </div>
      {!state && (
        <div className="row" style={{ marginTop: 10 }}>
          <Button size="sm" variant="primary" onClick={onConfirm} loading={busy}>
            {action.highImpact ? 'Confirm this change' : 'Apply'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onReject} disabled={busy}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}
