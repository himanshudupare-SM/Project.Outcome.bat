import { z } from 'zod';
import type { AssistantAnswer, ProposedAction } from './assistant-output.js';

/** HTTP contracts for the assistant. */

export const askAssistantInput = z.object({
  question: z.string().trim().min(1, 'Ask a question').max(2000),
  /** Optional project scope (key or id). */
  projectId: z.string().min(1).max(64).nullish(),
  conversationId: z.string().uuid().nullish(),
});
export type AskAssistantInput = z.infer<typeof askAssistantInput>;

export interface AssistantCitation {
  ref: string;
  taskId: string;
  title: string;
  projectKey: string;
  number: number;
  statusName: string;
}

export interface AssistantReply {
  conversationId: string;
  messageId: string;
  answer: AssistantAnswer;
  /** Citations resolved server-side; a ref the caller cannot read is dropped. */
  citations: AssistantCitation[];
  /** Actions stored as proposals, each with the id needed to confirm it. */
  actions: Array<{ id: string; action: ProposedAction; status: 'proposed' }>;
  model: string;
  promptVersion: string;
}

export const confirmActionInput = z.object({
  actionId: z.string().uuid(),
  /** The user must positively confirm; there is no implicit approval. */
  confirm: z.literal(true),
});
export type ConfirmActionInput = z.infer<typeof confirmActionInput>;
