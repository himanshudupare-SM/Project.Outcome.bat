import { Link, Outlet, useParams } from 'react-router-dom';
import { useProjectBlockers } from '../lib/queries.js';
import { Button, EmptyState, ErrorState, LoadingBlock, Pill, formatDate, useToast } from '../ui/index.js';
import { api, ApiError } from '../lib/api.js';
import { useMutation } from '@tanstack/react-query';
import { useTaskInvalidation } from '../lib/queries.js';

/** Blockers with age and downstream impact — the "why is this stuck" view. */
export function Blockers(): JSX.Element {
  const { orgSlug = '', projectKey = '' } = useParams();
  const blockers = useProjectBlockers(orgSlug, projectKey);
  const invalidate = useTaskInvalidation(orgSlug);
  const toast = useToast();

  const resolve = useMutation({
    mutationFn: (id: string) => api.post(`/orgs/${orgSlug}/blockers/${id}/resolve`),
    onSuccess: () => {
      invalidate();
      toast.push('Blocker resolved', 'success');
    },
    onError: (err) =>
      toast.push(err instanceof ApiError ? (err.body.detail ?? err.body.title) : 'Could not resolve', 'error'),
  });

  if (blockers.isLoading) return <LoadingBlock label="Loading blockers" />;
  if (blockers.error) {
    return (
      <ErrorState
        message={
          blockers.error instanceof ApiError
            ? (blockers.error.body.detail ?? blockers.error.body.title)
            : 'Could not load blockers.'
        }
        onRetry={() => void blockers.refetch()}
      />
    );
  }

  const rows = blockers.data ?? [];
  return (
    <>
      <div className="card">
        {rows.length === 0 ? (
          <EmptyState
            title="Nothing is blocked"
            body="When work stalls, record a blocker on the task so the reason and its downstream impact are visible."
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 88 }}>Task</th>
                <th>Reason</th>
                <th style={{ width: 74 }}>Age</th>
                <th style={{ width: 120 }}>Blocks</th>
                <th style={{ width: 110 }}>Expected</th>
                <th style={{ width: 86 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Link className="ref" to={`/o/${orgSlug}/p/${projectKey}/t/${b.taskRef.split('-').pop()}`}>
                      {b.taskRef}
                    </Link>
                  </td>
                  <td>
                    <div className="list-title">{b.taskTitle}</div>
                    <div className="page-sub">{b.reason}</div>
                  </td>
                  <td className="num">
                    <Pill tone={b.ageDays >= 5 ? 'danger' : b.ageDays >= 2 ? 'warn' : 'default'}>
                      {b.ageDays}d
                    </Pill>
                  </td>
                  <td className="page-sub num">
                    {b.downstreamCount === 0
                      ? 'nothing downstream'
                      : `${b.downstreamCount} task${b.downstreamCount === 1 ? '' : 's'}`}
                  </td>
                  <td className="num page-sub">{formatDate(b.expectedResolutionDate)}</td>
                  <td>
                    <Button size="sm" onClick={() => resolve.mutate(b.id)} loading={resolve.isPending}>
                      Resolve
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <Outlet />
    </>
  );
}
