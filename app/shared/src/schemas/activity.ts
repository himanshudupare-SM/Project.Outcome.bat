import { z } from 'zod';
import { NOTIFICATION_TYPES } from '../enums.js';

export const activityEvent = z.object({
  id: z.string(),
  actorType: z.enum(['user', 'ai', 'system']),
  actorId: z.string().uuid().nullable(),
  actorName: z.string().nullable(),
  entityType: z.string(),
  entityId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  taskId: z.string().uuid().nullable(),
  taskRef: z.string().nullable(),
  action: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type ActivityEvent = z.infer<typeof activityEvent>;

export const notification = z.object({
  id: z.string().uuid(),
  type: z.enum(NOTIFICATION_TYPES),
  actorId: z.string().uuid().nullable(),
  actorName: z.string().nullable(),
  projectId: z.string().uuid().nullable(),
  taskId: z.string().uuid().nullable(),
  taskRef: z.string().nullable(),
  taskTitle: z.string().nullable(),
  projectKey: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Notification = z.infer<typeof notification>;
