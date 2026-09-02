/**
 * Assistant OUTPUT contract (zod/v4, per the note in ai-output.ts).
 *
 * The shape enforces the product rules: facts are separated from
 * recommendations, every claim about project data must cite the task refs it
 * came from, and a mutation is a *proposal* the user confirms — the model
 * cannot execute anything by replying.
 */
import * as z from 'zod/v4';

export const ASSISTANT_TOOLS = [
  'create_task',
  'update_task',
  'assign_task',
  'set_priority',
  'add_comment',
  'create_dependency',
] as const;
export type AssistantTool = (typeof ASSISTANT_TOOLS)[number];

export const proposedActionSchema = z.object({
  tool: z.enum(ASSISTANT_TOOLS),
  /** One sentence the user can approve or reject without reading JSON. */
  description: z.string().min(1).max(300),
  /** Task ref (ATLAS-42) the action targets, when it acts on one. */
  targetRef: z.string().max(40).nullable(),
  title: z.string().max(300).nullable(),
  body: z.string().max(4000).nullable(),
  assigneeName: z.string().max(120).nullable(),
  priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).nullable(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  blockingRef: z.string().max(40).nullable(),
  /** True when applying this is hard to undo, forcing an explicit confirm. */
  highImpact: z.boolean(),
});
export type ProposedAction = z.infer<typeof proposedActionSchema>;

export const assistantAnswerSchema = z.object({
  /** What the data says. Each item must cite at least one ref when it makes
   *  a claim about specific work. */
  facts: z.array(
    z.object({
      text: z.string().min(1).max(600),
      refs: z.array(z.string().max(40)).max(20),
    }),
  ).max(20),
  /** Opinions and suggestions, explicitly separated from facts. */
  recommendations: z.array(z.string().min(1).max(600)).max(10),
  /** Set when the question cannot be answered from the permitted data. */
  cannotAnswer: z.string().max(400).nullable(),
  /** Mutations the user may confirm. Never executed by the model itself. */
  proposedActions: z.array(proposedActionSchema).max(10),
});
export type AssistantAnswer = z.infer<typeof assistantAnswerSchema>;
