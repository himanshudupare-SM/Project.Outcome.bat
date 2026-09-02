/**
 * The AI OUTPUT contract — the shape the model is constrained to produce.
 *
 * Authored with `zod/v4` because the Anthropic SDK's structured-output helper
 * requires it. Kept in its own module so the rest of the codebase (HTTP input
 * validation, which relies on classic-zod error handling) is unaffected.
 *
 * Every inferred field carries a confidence level, and anything the model is
 * unsure about must be reported in `questions` rather than guessed. The server
 * validates model output against this schema before it is shown or written,
 * so a malformed or hallucinated shape cannot reach the database.
 */
import * as z from 'zod/v4';

export const CONFIDENCE = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCE)[number];

const confidence = z.enum(CONFIDENCE);
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const priority = z.enum(['urgent', 'high', 'medium', 'low', 'none']);

/** A field the model inferred, plus how sure it is and the evidence for it. */
function inferred<T extends z.ZodType>(value: T) {
  return z.object({
    value,
    confidence,
    /** Short quote from the input that justifies this value. */
    evidence: z.string().max(400).nullable(),
  });
}

export const proposedTaskSchema = z.object({
  /** Stable id within this proposal, used to link dependencies. */
  key: z.string().min(1).max(40),
  title: z.string().min(1).max(300),
  description: z.string().max(4000),
  /** Suggested grouping label, not a project id — the user picks the project. */
  suggestedGroup: z.string().max(120).nullable(),
  priority: inferred(priority).nullable(),
  dueDate: inferred(dateString).nullable(),
  /** Person named in the input; resolved against org members server-side. */
  assigneeHint: inferred(z.string().max(120)).nullable(),
  estimateDays: inferred(z.number().min(0).max(365)).nullable(),
  labels: z.array(z.string().max(40)).max(8),
  /** Keys of tasks in this proposal that must finish first. */
  dependsOnKeys: z.array(z.string().max(40)).max(20),
  /** A reason this task cannot start, if the input says it is stuck. */
  blocker: z
    .object({
      reason: z.string().min(1).max(600),
      expectedResolutionDate: dateString.nullable(),
    })
    .nullable(),
  /** Existing task refs that look like the same work. */
  possibleDuplicateOf: z.array(z.string().max(40)).max(5),
  /** Quote from the input this task came from, for the review UI. */
  sourceQuote: z.string().max(600),
});
export type ProposedTask = z.infer<typeof proposedTaskSchema>;

export const clarifyingQuestionSchema = z.object({
  /** Which proposed task this is about, or null for the dump as a whole. */
  taskKey: z.string().max(40).nullable(),
  field: z.string().max(40),
  question: z.string().min(1).max(300),
});
export type ClarifyingQuestion = z.infer<typeof clarifyingQuestionSchema>;

export const extractionResultSchema = z.object({
  summary: z.string().max(600),
  tasks: z.array(proposedTaskSchema).max(60),
  /** Things the model could not resolve. Never silently assumed. */
  questions: z.array(clarifyingQuestionSchema).max(40),
  /** Statements that were not actionable, kept so nothing looks dropped. */
  notes: z.array(z.string().max(300)).max(20),
});
export type ExtractionResult = z.infer<typeof extractionResultSchema>;
