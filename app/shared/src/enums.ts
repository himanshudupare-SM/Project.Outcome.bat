/** Domain enums shared by API, DB CHECK constraints and UI. */

export const ORG_ROLES = ['owner', 'admin', 'member'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const PROJECT_ROLES = ['lead', 'member', 'viewer'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'No priority',
};

/** Status categories are fixed; status *names* are per-project rows. */
export const STATUS_CATEGORIES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'blocked',
  'done',
] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

export const TASK_SOURCES = ['manual', 'ai', 'import'] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

/** Seeded into every new project (order = board column order). */
export const DEFAULT_STATUSES: ReadonlyArray<{ name: string; category: StatusCategory }> = [
  { name: 'Backlog', category: 'backlog' },
  { name: 'Todo', category: 'todo' },
  { name: 'In progress', category: 'in_progress' },
  { name: 'In review', category: 'in_review' },
  { name: 'Blocked', category: 'blocked' },
  { name: 'Done', category: 'done' },
];

export const NOTIFICATION_TYPES = [
  'task.assigned',
  'task.status_changed',
  'comment.created',
  'comment.mentioned',
  'blocker.created',
  'blocker.resolved',
  'dependency.cleared',
  'braindump.ready',
  'import.finished',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
