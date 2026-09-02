import type * as z from 'zod/v4';

/**
 * Provider abstraction. Everything above this interface is provider-agnostic,
 * which is what lets the deterministic `fake` provider run the whole pipeline
 * in tests and offline development with no API key and no network.
 */
export interface StructuredRequest<T extends z.ZodTypeAny> {
  /** Prompt identity, recorded in the audit log with the result. */
  promptVersion: string;
  system: string;
  user: string;
  schema: T;
  /** Name used by the fake provider to pick a fixture strategy. */
  task: 'braindump' | 'assistant';
  maxTokens?: number;
}

export interface StructuredResponse<T> {
  value: T;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** How many repair attempts were needed to get schema-valid output. */
  attempts: number;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  structured<T extends z.ZodTypeAny>(req: StructuredRequest<T>): Promise<StructuredResponse<z.infer<T>>>;
}
