import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ActivityEvent } from '@outcome/shared';
import { useProjectActivity } from '../lib/queries.js';
import { api, ApiError } from '../lib/api.js';
import { EmptyState, ErrorState, LoadingBlock, Pill, relativeTime } from '../ui/index.js';

function describe(e: ActivityEvent): string {
  const changes = (e.data['changes'] as Array<{ field: string; new: unknown }> | undefined) ?? [];
  const what = `${e.entityType}${e.taskRef ? ` ${e.taskRef}` : ''}`;
  if (e.action === 'updated' && changes.length > 0) {
    return `changed ${changes.map((c) => c.field.replace(/_/g, ' ')).join(', ')} on ${what}`;
  }
  return `${e.action.replace(/_/g, ' ')} ${what}`;
}

function Feed({ events }: { events: ActivityEvent[] }): JSX.Element {
  if (events.length === 0) return <EmptyState title="No activity yet" />;
  return (
    <div className="card card-pad">
      {events.map((e) => (
        <div className="activity-row" key={e.id}>
          <span className="activity-time" style={{ width: 72 }}>
            {relativeTime(e.createdAt)}
          </span>
          {e.actorType === 'ai' && <Pill tone="accent">AI</Pill>}
          <span>
            <strong>{e.actorName ?? (e.actorType === 'ai' ? 'AI' : 'System')}</strong> {describe(e)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ProjectActivity(): JSX.Element {
  const { orgSlug = '', projectKey = '' } = useParams();
  const activity = useProjectActivity(orgSlug, projectKey);
  if (activity.isLoading) return <LoadingBlock label="Loading activity" />;
  if (activity.error) {
    return (
      <ErrorState
        message={activity.error instanceof ApiError ? (activity.error.body.detail ?? '') : 'Could not load activity.'}
        onRetry={() => void activity.refetch()}
      />
    );
  }
  return <Feed events={activity.data?.items ?? []} />;
}

export function OrgActivity(): JSX.Element {
  const { orgSlug = '' } = useParams();
  const audit = useQuery({
    queryKey: ['activity', orgSlug, 'org'],
    queryFn: () => api.get<{ items: ActivityEvent[] }>(`/orgs/${orgSlug}/audit`),
    retry: false,
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Activity</h1>
          <div className="page-sub">
            Every change, including AI actions. Admins see the full organization audit log.
          </div>
        </div>
      </div>
      {audit.isLoading && <LoadingBlock label="Loading audit log" />}
      {audit.error instanceof ApiError && audit.error.isForbidden && (
        <ErrorState title="Admins only" message="The organization audit log is restricted to admins and owners." />
      )}
      {audit.data && <Feed events={audit.data.items} />}
    </>
  );
}
