import { z } from 'zod';
import { PROJECT_ROLES, STATUS_CATEGORIES } from '../enums.js';
import { isoDate } from './common.js';

export const projectKey = z
  .string()
  .trim()
  .toUpperCase()
  .min(2)
  .max(10)
  .regex(/^[A-Z][A-Z0-9]*$/, 'Use 2-10 letters/numbers, starting with a letter');

export const createProjectInput = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  key: projectKey.optional(),
  description: z.string().max(10_000).default(''),
  teamId: z.string().uuid().nullish(),
  leadId: z.string().uuid().nullish(),
  targetDate: isoDate.nullish(),
});
export type CreateProjectInput = z.infer<typeof createProjectInput>;

export const updateProjectInput = createProjectInput
  .partial()
  .omit({ key: true })
  .extend({ state: z.enum(['active', 'archived']).optional() });
export type UpdateProjectInput = z.infer<typeof updateProjectInput>;

export const status = z.object({
  id: z.string().uuid(),
  name: z.string(),
  category: z.enum(STATUS_CATEGORIES),
  position: z.number(),
});
export type Status = z.infer<typeof status>;

export const project = z.object({
  id: z.string().uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  teamId: z.string().uuid().nullable(),
  leadId: z.string().uuid().nullable(),
  targetDate: z.string().nullable(),
  state: z.enum(['active', 'archived']),
  role: z.enum(PROJECT_ROLES).nullable(),
  createdAt: z.string(),
});
export type Project = z.infer<typeof project>;

export const projectSummary = project.extend({
  openCount: z.number(),
  doneCount: z.number(),
  openBlockerCount: z.number(),
  overdueCount: z.number(),
});
export type ProjectSummary = z.infer<typeof projectSummary>;

export const projectDetail = project.extend({
  statuses: z.array(status),
  members: z.array(
    z.object({
      userId: z.string().uuid(),
      name: z.string(),
      email: z.string(),
      role: z.enum(PROJECT_ROLES),
    }),
  ),
});
export type ProjectDetail = z.infer<typeof projectDetail>;

export const addProjectMemberInput = z.object({
  userId: z.string().uuid(),
  role: z.enum(PROJECT_ROLES),
});

export const createEpicInput = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(10_000).default(''),
  targetDate: isoDate.nullish(),
});
export type CreateEpicInput = z.infer<typeof createEpicInput>;

export const epic = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  targetDate: z.string().nullable(),
  taskCount: z.number(),
  doneCount: z.number(),
});
export type Epic = z.infer<typeof epic>;
