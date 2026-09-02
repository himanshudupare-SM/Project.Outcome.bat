import { z } from 'zod';
import { PRIORITIES } from '../enums.js';
import { isoDate } from './common.js';
import type { ExtractionResult } from './ai-output.js';

/**
 * HTTP contracts for the AI features. The model's own output contract lives in
 * `ai-output.ts` (see the note there about zod versions).
 */

export const createBraindumpInput = z.object({
  text: z.string().trim().min(1, 'Say or type something first').max(40_000),
  source: z.enum(['text', 'voice']).default('text'),
  /** Optional project scope; when set, extraction is told that context. */
  projectId: z.string().min(1).max(64).nullish(),
});
export type CreateBraindumpInput = z.infer<typeof createBraindumpInput>;

export const BRAINDUMP_STATUSES = [
  'queued',
  'processing',
  'ready',
  'failed',
  'approved',
  'discarded',
] as const;
export type BraindumpStatus = (typeof BRAINDUMP_STATUSES)[number];

export interface Braindump {
  id: string;
  userId: string;
  projectId: string | null;
  source: 'text' | 'voice';
  rawInput: string;
  status: BraindumpStatus;
  proposal: ExtractionResult | null;
  error: string | null;
  model: string | null;
  promptVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One task the user approved, with any edits they made during review. */
export const approvedTask = z.object({
  key: z.string().min(1).max(40),
  title: z.string().trim().min(1).max(300),
  description: z.string().max(50_000).default(''),
  priority: z.enum(PRIORITIES).default('none'),
  assigneeId: z.string().uuid().nullish(),
  dueDate: isoDate.nullish(),
  estimateDays: z.number().min(0).max(365).nullish(),
  epicId: z.string().uuid().nullish(),
  labelIds: z.array(z.string().uuid()).default([]),
  dependsOnKeys: z.array(z.string().max(40)).default([]),
  blockerReason: z.string().max(600).nullish(),
});
export type ApprovedTask = z.infer<typeof approvedTask>;

export const approveBraindumpInput = z.object({
  projectId: z.string().min(1).max(64),
  tasks: z.array(approvedTask).min(1, 'Approve at least one task').max(60),
});
export type ApproveBraindumpInput = z.infer<typeof approveBraindumpInput>;
