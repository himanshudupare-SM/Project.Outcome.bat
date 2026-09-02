import { z } from 'zod';
import { STATUS_CATEGORIES } from '../enums.js';

/** Jira import contracts. */

export const jiraCredentials = z.object({
  baseUrl: z
    .string()
    .trim()
    .url('Enter the full Jira URL, e.g. https://acme.atlassian.net')
    .max(300),
  email: z.string().trim().toLowerCase().email().max(320),
  apiToken: z.string().trim().min(8, 'Paste your Jira API token').max(500),
});
export type JiraCredentials = z.infer<typeof jiraCredentials>;

export const jiraProjectSummary = z.object({
  key: z.string(),
  name: z.string(),
  issueCount: z.number(),
});
export type JiraProjectSummary = z.infer<typeof jiraProjectSummary>;

export const importMapping = z.object({
  /** Jira project key -> target project (existing id, or 'new' to create). */
  projectKey: z.string().min(1).max(40),
  targetProjectId: z.string().min(1).max(64).nullable(),
  /** Jira status name -> our status category. */
  statuses: z.record(z.string(), z.enum(STATUS_CATEGORIES)),
  /** Jira priority name -> our priority. */
  priorities: z.record(z.string(), z.enum(['urgent', 'high', 'medium', 'low', 'none'])),
  /** Jira account id -> our user id, or null to leave unassigned. */
  users: z.record(z.string(), z.string().uuid().nullable()),
  includeComments: z.boolean().default(true),
  includeSubtasks: z.boolean().default(true),
});
export type ImportMapping = z.infer<typeof importMapping>;

export const IMPORT_STATUSES = [
  'mapping',
  'dry_run',
  'running',
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const IMPORT_ENTITY_TYPES = [
  'project',
  'epic',
  'task',
  'subtask',
  'comment',
  'user',
  'attachment',
] as const;
export type ImportEntityType = (typeof IMPORT_ENTITY_TYPES)[number];

export const importItem = z.object({
  id: z.string().uuid(),
  entityType: z.enum(IMPORT_ENTITY_TYPES),
  externalId: z.string(),
  status: z.enum(['pending', 'imported', 'skipped', 'failed']),
  targetId: z.string().uuid().nullable(),
  error: z.string().nullable(),
  attempts: z.number(),
  summary: z.string(),
});
export type ImportItem = z.infer<typeof importItem>;

export const importStats = z.object({
  imported: z.record(z.string(), z.number()),
  skipped: z.record(z.string(), z.number()),
  failed: z.record(z.string(), z.number()),
  /** Issues whose title already exists in the target project. */
  duplicates: z.number().default(0),
  unmappedStatuses: z.array(z.string()).default([]),
  unmappedUsers: z.array(z.string()).default([]),
});
export type ImportStats = z.infer<typeof importStats>;

export const importRun = z.object({
  id: z.string().uuid(),
  kind: z.literal('jira'),
  status: z.enum(IMPORT_STATUSES),
  mapping: importMapping.nullable(),
  stats: importStats,
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
  /** Progress for the UI. */
  totalItems: z.number(),
  processedItems: z.number(),
});
export type ImportRun = z.infer<typeof importRun>;

/** What the dry run reports before anything is written. */
export const dryRunReport = z.object({
  runId: z.string().uuid(),
  targetProjectId: z.string().uuid().nullable(),
  targetProjectName: z.string(),
  willCreate: importStats.shape.imported,
  conflicts: z.array(
    z.object({
      kind: z.enum(['duplicate_title', 'unmapped_status', 'unmapped_user', 'missing_epic', 'unsupported']),
      externalId: z.string(),
      detail: z.string(),
      resolution: z.string(),
    }),
  ),
  unsupported: z.array(z.string()),
});
export type DryRunReport = z.infer<typeof dryRunReport>;

export const startImportInput = z.object({
  credentials: jiraCredentials,
  mapping: importMapping,
  dryRun: z.boolean().default(false),
});
export type StartImportInput = z.infer<typeof startImportInput>;
