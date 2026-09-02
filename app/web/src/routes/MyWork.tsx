import { Link, useParams } from 'react-router-dom';
import type { Task } from '@outcome/shared';
import { useMyWork } from '../lib/queries.js';
import { EmptyState, ErrorState, LoadingBlock, Pill, formatDate, isOverdue } from '../ui/index.js';
import { ApiError } from '../lib/api.js';

export function MyWork(): JSX.Element {
  const { orgSlug = '' } = useParams();
  const work = useMyWork(orgSlug);

  if (work.isLoading) return <LoadingBlock label="Loading your work" />;
  if (work.error) {
    return (
      <ErrorState
        message={work.error instanceof ApiError ? (work.error.body.detail ?? work.error.body.title) : 'Could not load.'}
        onRetry={() => void work.refetch()}
      />
    );
  }
  const data = work.data!;

  const TaskRow = ({ task, extra }: { task: Task; extra?: string[] }): JSX.Element => (
    <Link className="list-row" to={`/o/${orgSlug}/p/${task.projectKey}/t/${task.number}`}>
      <span className="ref">{task.ref}</span>
      <span className="list-title" style={{ flex: 1 }}>
        {task.title}
      </span>
      {extra?.map((r) => (
        <span className="chip" key={r}>
          {r}
        </span>
      ))}
      {task.dueDate && (
        <Pill tone={isOverdue(task.dueDate, task.statusCategory) ? 'danger' : 'default'}>
          {formatDate(task.dueDate)}
        </Pill>
      )}
      <Pill tone={task.statusCategory === 'blocked' ? 'danger' : 'default'}>{task.statusName}</Pill>
    </Link>
  );

  const Section = ({
    title,
    hint,
    tasks,
    empty,
    reasons,
  }: {
    title: string;
    hint?: string;
    tasks: Task[];
    empty: string;
    reasons?: Map<string, string[]>;
  }): JSX.Element => (
    <section style={{ marginBottom: 22 }}>
      <h2>{title}</h2>
      {hint && <div className="page-sub" style={{ marginBottom: 8 }}>{hint}</div>}
      <div className="card">
        {tasks.length === 0 ? (
          <EmptyState title={empty} />
        ) : (
          tasks.map((t) => <TaskRow key={t.id} task={t} extra={reasons?.get(t.id)?.slice(0, 2)} />)
        )}
      </div>
    </section>
  );

  const nowReasons = new Map(data.now.map((r) => [r.task.id, r.reasons]));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My work</h1>
          <div className="page-sub">Ranked by due date, what it unblocks, and priority — with the reason shown.</div>
        </div>
      </div>

      <Section
        title="Now"
        hint="The five things that matter most today."
        tasks={data.now.map((r) => r.task)}
        reasons={nowReasons}
        empty="Nothing assigned to you"
      />
      <Section
        title="Blocking others"
        hint="Your tasks that other work is waiting on — highest leverage."
        tasks={data.blockedByMe}
        empty="Nothing of yours is blocking anyone"
      />
      <Section title="Due in the next week" tasks={data.dueSoon} empty="Nothing due soon" />
      <Section
        title="Waiting on others"
        hint="Blocked, or waiting for an upstream task."
        tasks={data.waitingOnOthers}
        empty="Nothing waiting"
      />
      <Section title="Mentioned you" tasks={data.mentioned} empty="No recent mentions" />
    </>
  );
}
