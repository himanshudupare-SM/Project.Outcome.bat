import { config } from '../../platform/config.js';
import type { AiProvider } from './provider.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { FakeProvider } from './providers/fake.js';

let instance: AiProvider | null = null;

/** Provider selected by configuration; `fake` needs no key and no network. */
export function aiProvider(): AiProvider {
  if (!instance) {
    instance = config().AI_PROVIDER === 'anthropic' ? new AnthropicProvider() : new FakeProvider();
  }
  return instance;
}

/** Tests swap in their own provider (e.g. one that always fails). */
export function setAiProvider(provider: AiProvider | null): void {
  instance = provider;
}

export type { AiProvider } from './provider.js';
