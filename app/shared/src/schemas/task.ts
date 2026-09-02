import { z } from 'zod';
import { PRIORITIES, STATUS_CATEGORIES, TASK_SOURCES } from '../enums.js';
import { isoDate } from './common.js';

export const createTaskInput = z.object({
  title: z.string().trim().min(1, 'Title is required').max(300),
  description: z.string().max(50_000).default(''),
  statusId: z.string().uuid().optional(),
  priority: z.enum(PRIORITIES).default('none'),
  assigneeId: z.string().uuid().nullish(),
  epicId: z.string().uuid().nullish(),
  parentId: z.string().uuid().nullish(),
  dueDate: isoDate.nullish(),
  estimateDays: z.number().min(0).max(1000).nullish(),
  labelIds: z.array(z.string().uuid()).default([]),
});
export type CreateTaskInput = z.infer<typeof createTaskInput>;

export const updateTaskInput = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: z.string().max(50_000),
    statusId: z.string().uuid(),
    priority: z.enum(PRIORITIES),
    assigneeId: z.string().uuid().nullable(),
    epicId: z.string().uuid().nullable(),
    dueDate: isoDate.nullable(),
    estimateDays: z.number().min(0).max(1000).nullable(),
    position: z.number(),
    labelIds: z.array(z.string().uuid()),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });
export type UpdateTaskInput = z.infer<typeof updateTaskInput>;

export const moveTaskInput = z.object({
  statusId: z.string().uuid(),
  /** Neighbours in the destination column; server derives the position. */
  beforeTaskId: z.string().uuid().nullish(),
  afterTaskId: z.string().uuid().nullish(),
});
export type MoveTaskInput = z.infer<typeof moveTaskInput>;

export const label = z.object({
  id: z.string().uuid(),
  name: z.string(),
  color: z.string(),
});
export type Label = z.infer<typeof label>;

export const createLabelInput = z.object({
  name: z.string().trim().min(1).max(40),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #2a78d6')
    .default('#6b7280'),
});

export const blocker = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  reason: z.string(),
  expectedResolutionDate: z.string().nullable(),
  createdBy: z.string().uuid(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type Blocker = z.infer<typeof blocker>;

export const createBlockerInput = z.object({
  reason: z.string().trim().min(1, 'Say what is blocking this').max(2000),
  expectedResolutionDate: isoDate.nullish(),
});
export type CreateBlockerInput = z.infer<typeof createBlockerInput>;

export const taskRef = z.object({
  id: z.string().uuid(),
  ref: z.string(),
  title: z.string(),
  statusCategory: z.enum(STATUS_CATEGORIES),
});
export type TaskRef = z.infer<typeof taskRef>;

export const task = z.object({
  id: z.string().uuid(),
  ref: z.string(),
  number: z.number(),
  projectId: z.string().uuid(),
  projectKey: z.string(),
  epicId: z.string().uuid().nullable(),
  parentId: z.string().uuid().nullable(),
  title: z.string(),
  description: z.string(),
  statusId: z.string().uuid(),
  statusName: z.string(),
  statusCategory: z.enum(STATUS_CATEGORIES),
  priority: z.enum(PRIORITIES),
  assigneeId: z.string().uuid().nullable(),
  assigneeName: z.string().nullable(),
  dueDate: z.string().nullable(),
  estimateDays: z.number().nullable(),
  position: z.number(),
  source: z.enum(TASK_SOURCES),
  braindumpId: z.string().uuid().nullable(),
  labels: z.array(label),
  subtaskCount: z.number(),
  subtaskDoneCount: z.number(),
  commentCount: z.number(),
  openBlockerCount: z.number(),
  blockedByOpenCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
});
export type Task = z.infer<typeof task>;

export const taskDetail = task.extend({
  subtasks: z.array(task),
  blockers: z.array(blocker),
  blockedBy: z.array(taskRef),
  blocks: z.array(taskRef),
  watcherIds: z.array(z.string().uuid()),
});
export type TaskDetail = z.infer<typeof taskDetail>;

export const taskListQuery = z.object({
  projectId: z.string().uuid().optional(),
  statusId: z.string().uuid().optional(),
  statusCategory: z.enum(STATUS_CATEGORIES).optional(),
  assigneeId: z.string().optional(), // uuid | 'me' | 'none'
  epicId: z.string().optional(), // uuid | 'none'
  priority: z.enum(PRIORITIES).optional(),
  labelId: z.string().uuid().optional(),
  parent: z.enum(['roots', 'all']).default('roots'),
  blocked: z.coerce.boolean().optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().optional(),
});
export type TaskListQuery = z.infer<typeof taskListQuery>;

export const createDependencyInput = z.object({
  /** The task that must finish first. */
  blockingTaskId: z.string().uuid(),
});
export type CreateDependencyInput = z.infer<typeof createDependencyInput>;
