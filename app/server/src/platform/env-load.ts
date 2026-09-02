/**
 * Side-effect module: import this FIRST (before anything that reads config)
 * so local .env values are present. ESM evaluates imports in order, so
 * `import './platform/env-load.js'` at the top of an entrypoint is the only
 * reliable way to do this.
 */
import { loadDotEnv } from './env.js';

loadDotEnv();
