import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  Comment,
  Epic,
  Label,
  Notification,
  ProjectDetail,
  ProjectSummary,
  Task,
  TaskDetail,
  ActivityEvent,
} from '@outcome/shared';
import { api } from './api.js';

/* Query keys are the API paths, so invalidation is obvious and typo-proof. */
export const keys = {
  projects: (org: string) => ['projects', org] as const,
  project: (org: string, key: string) => ['project', org, key] as const,
  board: (org: string, key: string) => ['board', org, key] as const,
  epics: (org: string, key: string) => ['epics', org, key] as const,
  tasks: (org: string, params: string) => ['tasks', org, params] as const,
  task: (org: string, id: string) => ['task', org, id] as const,
  taskByRef: (org: string, key: string, n: number) => ['taskRef', org, key, n] as const,
  comments: (org: string, id: string) => ['comments', org, id] as const,
  activity: (org: string, scope: string) => ['activity', org, scope] as const,
  notifications: (org: string) => ['notifications', org] as const,
  labels: (org: string) => ['labels', org] as const,
  members: (org: string) => ['members', org] as const,
  myWork: (org: string) => ['myWork', org] as const,
  blockers: (org: string, scope: string) => ['blockers', org, scope] as const,
};

export interface BoardData {
  project: ProjectDetail;
  columns: Array<{ statusId: string; tasks: Task[] }>;
}

export interface MyWorkData {
  now: Array<{ task: Task; score: number; reasons: string[] }>;
  dueSoon: Task[];
  blockedByMe: Task[];
  waitingOnOthers: Task[];
  mentioned: Task[];
}

export interface BlockerRow {
  id: string;
  taskId: string;
  taskRef: string;
  taskTitle: string;
  reason: string;
  expectedResolutionDate: string | null;
  createdAt: string;
  ageDays: number;
  createdByName: string;
  assigneeName: string | null;
  downstreamCount: number;
}

export interface OrgMemberRow {
  userId: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  joinedAt: string;
}

export function useProjects(org: string): UseQueryResult<ProjectSummary[]> {
  return useQuery({
    queryKey: keys.projects(org),
    queryFn: () => api.get<ProjectSummary[]>(`/orgs/${org}/projects`),
  });
}

export function useProject(org: string, key: string): UseQueryResult<ProjectDetail> {
  return useQuery({
    queryKey: keys.project(org, key),
    queryFn: () => api.get<ProjectDetail>(`/orgs/${org}/projects/${key}`),
  });
}

export function useBoard(org: string, key: string): UseQueryResult<BoardData> {
  return useQuery({
    queryKey: keys.board(org, key),
    queryFn: () => api.get<BoardData>(`/orgs/${org}/projects/${key}/board`),
  });
}

export function useEpics(org: string, key: string): UseQueryResult<Epic[]> {
  return useQuery({
    queryKey: keys.epics(org, key),
    queryFn: () => api.get<Epic[]>(`/orgs/${org}/projects/${key}/epics`),
  });
}

export function useTaskList(
  org: string,
  params: Record<string, string | undefined>,
): UseQueryResult<{ items: Task[]; nextCursor: string | null }> {
  const search = new URLSearchParams(
    Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1])),
  ).toString();
  return useQuery({
    queryKey: keys.tasks(org, search),
    queryFn: () => api.get<{ items: Task[]; nextCursor: string | null }>(`/orgs/${org}/tasks?${search}`),
  });
}

export function useTaskByRef(
  org: string,
  projectKey: string,
  number: number | null,
): UseQueryResult<TaskDetail> {
  return useQuery({
    queryKey: keys.taskByRef(org, projectKey, number ?? -1),
    queryFn: () => api.get<TaskDetail>(`/orgs/${org}/projects/${projectKey}/tasks/${number}`),
    enabled: number !== null,
  });
}

export function useComments(org: string, taskId: string | null): UseQueryResult<Comment[]> {
  return useQuery({
    queryKey: keys.comments(org, taskId ?? ''),
    queryFn: () => api.get<Comment[]>(`/orgs/${org}/tasks/${taskId}/comments`),
    enabled: Boolean(taskId),
  });
}

export function useTaskActivity(
  org: string,
  taskId: string | null,
): UseQueryResult<{ items: ActivityEvent[] }> {
  return useQuery({
    queryKey: keys.activity(org, `task:${taskId}`),
    queryFn: () => api.get<{ items: ActivityEvent[] }>(`/orgs/${org}/tasks/${taskId}/activity`),
    enabled: Boolean(taskId),
  });
}

export function useProjectActivity(
  org: string,
  projectKey: string,
): UseQueryResult<{ items: ActivityEvent[] }> {
  return useQuery({
    queryKey: keys.activity(org, `project:${projectKey}`),
    queryFn: () =>
      api.get<{ items: ActivityEvent[] }>(`/orgs/${org}/projects/${projectKey}/activity`),
  });
}

export function useNotifications(
  org: string,
): UseQueryResult<{ items: Notification[]; unreadCount: number }> {
  return useQuery({
    queryKey: keys.notifications(org),
    queryFn: () =>
      api.get<{ items: Notification[]; unreadCount: number }>(`/orgs/${org}/notifications`),
    refetchInterval: 60_000,
  });
}

export function useLabels(org: string): UseQueryResult<Label[]> {
  return useQuery({ queryKey: keys.labels(org), queryFn: () => api.get<Label[]>(`/orgs/${org}/labels`) });
}

export function useMembers(org: string): UseQueryResult<OrgMemberRow[]> {
  return useQuery({
    queryKey: keys.members(org),
    queryFn: () => api.get<OrgMemberRow[]>(`/orgs/${org}/members`),
  });
}

export function useMyWork(org: string): UseQueryResult<MyWorkData> {
  return useQuery({ queryKey: keys.myWork(org), queryFn: () => api.get<MyWorkData>(`/orgs/${org}/my-work`) });
}

export function useProjectBlockers(org: string, projectKey: string): UseQueryResult<BlockerRow[]> {
  return useQuery({
    queryKey: keys.blockers(org, projectKey),
    queryFn: () => api.get<BlockerRow[]>(`/orgs/${org}/projects/${projectKey}/blockers`),
  });
}

/** Invalidate everything a task change can affect. */
export function useTaskInvalidation(org: string): (taskId?: string) => void {
  const queryClient = useQueryClient();
  return (taskId?: string) => {
    void queryClient.invalidateQueries({ queryKey: ['board', org] });
    void queryClient.invalidateQueries({ queryKey: ['tasks', org] });
    void queryClient.invalidateQueries({ queryKey: ['myWork', org] });
    void queryClient.invalidateQueries({ queryKey: ['blockers', org] });
    void queryClient.invalidateQueries({ queryKey: ['projects', org] });
    void queryClient.invalidateQueries({ queryKey: ['epics', org] });
    void queryClient.invalidateQueries({ queryKey: ['taskRef', org] });
    if (taskId) {
      void queryClient.invalidateQueries({ queryKey: keys.task(org, taskId) });
      void queryClient.invalidateQueries({ queryKey: keys.comments(org, taskId) });
      void queryClient.invalidateQueries({ queryKey: keys.activity(org, `task:${taskId}`) });
    }
  };
}

export function useUpdateTask(org: string) {
  const invalidate = useTaskInvalidation(org);
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      api.patch<TaskDetail>(`/orgs/${org}/tasks/${id}`, patch),
    onSuccess: (task) => invalidate(task.id),
  });
}

export function useMoveTask(org: string) {
  const invalidate = useTaskInvalidation(org);
  return useMutation({
    mutationFn: ({
      id,
      statusId,
      beforeTaskId,
      afterTaskId,
    }: {
      id: string;
      statusId: string;
      beforeTaskId?: string | null;
      afterTaskId?: string | null;
    }) =>
      api.post<TaskDetail>(`/orgs/${org}/tasks/${id}/move`, {
        statusId,
        beforeTaskId: beforeTaskId ?? null,
        afterTaskId: afterTaskId ?? null,
      }),
    onSuccess: (task) => invalidate(task.id),
  });
}

export function useCreateTask(org: string, projectKey: string) {
  const invalidate = useTaskInvalidation(org);
  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      api.post<TaskDetail>(`/orgs/${org}/projects/${projectKey}/tasks`, input),
    onSuccess: (task) => invalidate(task.id),
  });
}
