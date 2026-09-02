import { Link, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Notification, NotificationType } from '@outcome/shared';
import { useNotifications } from '../lib/queries.js';
import { api } from '../lib/api.js';
import { Button, EmptyState, LoadingBlock, relativeTime } from '../ui/index.js';

const SENTENCE: Record<NotificationType, string> = {
  'task.assigned': 'assigned you',
  'task.status_changed': 'changed the status of',
  'comment.created': 'commented on',
  'comment.mentioned': 'mentioned you on',
  'blocker.created': 'flagged a blocker on',
  'blocker.resolved': 'resolved a blocker on',
  'dependency.cleared': 'cleared a dependency for',
  'braindump.ready': 'finished extracting tasks from your brain dump',
  'import.finished': 'finished a Jira import',
};

export function Inbox(): JSX.Element {
  const { orgSlug = '' } = useParams();
  const notifications = useNotifications(orgSlug);
  const queryClient = useQueryClient();

  const markRead = useMutation({
    mutationFn: (ids: string[] | 'all') => api.post(`/orgs/${orgSlug}/notifications/read`, { ids }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['notifications', orgSlug] }),
  });

  if (notifications.isLoading) return <LoadingBlock label="Loading inbox" />;
  const items = notifications.data?.items ?? [];
  const unread = notifications.data?.unreadCount ?? 0;

  const target = (n: Notification): string =>
    n.projectKey && n.taskRef
      ? `/o/${orgSlug}/p/${n.projectKey}/t/${n.taskRef.split('-').pop()}`
      : `/o/${orgSlug}`;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Inbox</h1>
          <div className="page-sub">{unread} unread</div>
        </div>
        {unread > 0 && (
          <Button onClick={() => markRead.mutate('all')} loading={markRead.isPending}>
            Mark all read
          </Button>
        )}
      </div>

      <div className="card">
        {items.length === 0 ? (
          <EmptyState title="Inbox zero" body="Assignments, mentions and blockers land here." />
        ) : (
          items.map((n) => (
            <Link
              key={n.id}
              className="list-row"
              to={target(n)}
              onClick={() => {
                if (!n.readAt) markRead.mutate([n.id]);
              }}
              style={{ background: n.readAt ? undefined : 'var(--accent-soft)' }}
            >
              <span style={{ flex: 1 }}>
                <strong>{n.actorName ?? 'Someone'}</strong> {SENTENCE[n.type]}{' '}
                {n.taskRef && <span className="ref">{n.taskRef}</span>} {n.taskTitle}
              </span>
              <span className="page-sub">{relativeTime(n.createdAt)}</span>
            </Link>
          ))
        )}
      </div>
    </>
  );
}
