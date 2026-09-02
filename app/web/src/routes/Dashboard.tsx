import { Link, useParams } from 'react-router-dom';
import { useMyWork, useProjects } from '../lib/queries.js';
import { EmptyState, ErrorState, LoadingBlock, Pill, formatDate, isOverdue } from '../ui/index.js';
import { ApiError } from '../lib/api.js';

export function Dashboard(): JSX.Element {
  const { orgSlug = '' } = useParams();
  const projects = useProjects(orgSlug);
  const myWork = useMyWork(orgSlug);

  if (projects.isLoading) return <LoadingBlock label="Loading dashboard" />;
  if (projects.error) {
    return (
      <ErrorState
        message={
          projects.error instanceof ApiError
            ? (projects.error.body.detail ?? projects.error.body.title)
            : 'Could not load your projects.'
        }
        onRetry={() => void projects.refetch()}
      />
    );
  }

  const list = projects.data ?? [];
  const focus = myWork.data?.now ?? [];
  const totalBlockers = list.reduce((sum, p) => sum + p.openBlockerCount, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <div className="page-sub">
            {list.length} active project{list.length === 1 ? '' : 's'}
            {totalBlockers > 0 && ` · ${totalBlockers} open blocker${totalBlockers === 1 ? '' : 's'}`}
          </div>
        </div>
        <Link className="btn btn-primary" to={`/o/${orgSlug}/projects`}>
          New project
        </Link>
      </div>

      {list.length === 0 ? (
        <div className="card">
          <EmptyState
            title="No projects yet"
            body="Create a project to start tracking work, dependencies and blockers."
            action={
              <Link className="btn btn-primary" to={`/o/${orgSlug}/projects`}>
                Create a project
              </Link>
            }
          />
        </div>
      ) : (
        <>
          <h2 style={{ marginBottom: 10 }}>My focus</h2>
          <div className="card" style={{ marginBottom: 22 }}>
            {myWork.isLoading ? (
              <div className="card-pad">
                <LoadingBlock label="Ranking your work" />
              </div>
            ) : focus.length === 0 ? (
              <EmptyState title="Nothing assigned to you" body="Pick something up from a project board." />
            ) : (
              focus.map(({ task, reasons }) => (
                <Link
                  key={task.id}
                  className="list-row"
                  to={`/o/${orgSlug}/p/${task.projectKey}/t/${task.number}`}
                >
                  <span className="ref">{task.ref}</span>
                  <span className="list-title" style={{ flex: 1 }}>
                    {task.title}
                  </span>
                  {reasons.slice(0, 2).map((r) => (
                    <span className="chip" key={r}>
                      {r}
                    </span>
                  ))}
                  {isOverdue(task.dueDate, task.statusCategory) && (
                    <Pill tone="danger">Due {formatDate(task.dueDate)}</Pill>
                  )}
                </Link>
              ))
            )}
          </div>

          <h2 style={{ marginBottom: 10 }}>Projects</h2>
          <div className="grid-cards">
            {list.map((p) => {
              const total = p.openCount + p.doneCount;
              const pct = total === 0 ? 0 : Math.round((100 * p.doneCount) / total);
              return (
                <Link key={p.id} to={`/o/${orgSlug}/p/${p.key}/board`} className="card card-pad" style={{ color: 'inherit' }}>
                  <div className="row" style={{ marginBottom: 6 }}>
                    <span className="ref">{p.key}</span>
                    <span className="spacer" />
                    {p.openBlockerCount > 0 ? (
                      <Pill tone="danger">
                        {p.openBlockerCount} blocked
                      </Pill>
                    ) : p.overdueCount > 0 ? (
                      <Pill tone="warn">{p.overdueCount} overdue</Pill>
                    ) : (
                      <Pill tone="good">On track</Pill>
                    )}
                  </div>
                  <h3>{p.name}</h3>
                  <div className="page-sub" style={{ marginBottom: 8 }}>
                    {p.doneCount} of {total} done · {pct}%
                    {p.targetDate && ` · target ${formatDate(p.targetDate)}`}
                  </div>
                  <div
                    style={{
                      height: 4,
                      borderRadius: 999,
                      background: 'var(--surface-3)',
                      overflow: 'hidden',
                    }}
                  >
                    <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)' }} />
                  </div>
                </Link>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
