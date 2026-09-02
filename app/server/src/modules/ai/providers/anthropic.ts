import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type * as z from 'zod/v4';
import { config } from '../../../platform/config.js';
import { logger } from '../../../platform/logger.js';
import { AiUnavailableError } from '../../../platform/errors.js';
import type { AiProvider, StructuredRequest, StructuredResponse } from '../provider.js';

const MAX_ATTEMPTS = 3;

/**
 * Claude-backed provider using structured outputs, so the model is constrained
 * to our schema rather than asked politely for JSON. A schema violation or a
 * transient API failure is retried with backoff; anything still failing after
 * that surfaces as a typed error the UI can offer to retry.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;

  constructor() {
    const cfg = config();
    this.model = cfg.ANTHROPIC_MODEL;
    this.client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY, maxRetries: 0 });
  }

  async structured<T extends z.ZodTypeAny>(
    req: StructuredRequest<T>,
  ): Promise<StructuredResponse<z.infer<T>>> {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await this.client.messages.parse({
          model: this.model,
          max_tokens: req.maxTokens ?? 16_000,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
          output_config: { format: zodOutputFormat(req.schema) },
        });

        if (response.stop_reason === 'refusal') {
          throw new AiUnavailableError(
            'The AI declined to process this input. Edit it and try again, or create tasks manually.',
          );
        }
        const parsed: z.infer<T> | null = response.parsed_output;
        if (parsed === null) {
          lastError = new Error('model returned output that did not match the schema');
          logger.warn({ attempt, promptVersion: req.promptVersion }, 'ai schema mismatch, retrying');
          await delay(attempt);
          continue;
        }
        return {
          value: parsed,
          model: this.model,
          inputTokens: response.usage.input_tokens ?? null,
          outputTokens: response.usage.output_tokens ?? null,
          attempts: attempt,
        };
      } catch (err) {
        if (err instanceof AiUnavailableError) throw err;
        lastError = err;
        const status = (err as { status?: number }).status;
        // 4xx other than rate limiting will not fix themselves.
        if (status && status !== 429 && status < 500) break;
        logger.warn({ attempt, err }, 'ai request failed, retrying');
        await delay(attempt);
      }
    }

    logger.error({ err: lastError, promptVersion: req.promptVersion }, 'ai request failed');
    throw new AiUnavailableError(
      'The AI service could not be reached. Try again, or add the tasks manually.',
    );
  }
}

function delay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 400 * 2 ** (attempt - 1)));
}
