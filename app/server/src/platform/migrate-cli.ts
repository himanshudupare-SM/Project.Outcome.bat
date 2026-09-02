import './env-load.js';

import { closePool } from './db.js';
import { migrate } from './migrate.js';

const applied = await migrate();
console.log(applied.length ? `Applied ${applied.length} migration(s):\n  ${applied.join('\n  ')}` : 'Schema up to date.');
await closePool();
