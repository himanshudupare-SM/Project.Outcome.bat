import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { BASE } from './shared.mjs';

/**
 * Runs every end-to-end script in order against an already-running stack and
 * exits non-zero if any of them fails. Kept as plain scripts rather than a
 * test-runner harness so a single journey can be run and read on its own.
 */
const scripts = readdirSync(new URL('.', import.meta.url).pathname)
  .filter((f) => /^\d\d-.*\.mjs$/.test(f))
  .sort();

const ready = await fetch(`${BASE}/login`).then((r) => r.ok).catch(() => false);
if (!ready) {
  console.error(`No app at ${BASE}. Start it with "npm run dev" (or set E2E_BASE_URL).`);
  process.exit(1);
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', cwd: new URL('..', import.meta.url).pathname });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/**
 * The journeys assert on real data, so they need a known starting point:
 * created tasks accumulate, and the duplicate detector correctly reacts to
 * leftovers from a previous run. Re-seeding is the fix, not looser
 * assertions. Set E2E_SKIP_SEED=1 when pointing at an environment whose data
 * must be preserved.
 */
if (process.env.E2E_SKIP_SEED !== '1') {
  console.log('=== reseeding the demo data ===');
  const seeded = await run('npm', ['run', '--silent', 'db:seed']);
  if (seeded !== 0) {
    console.error('Seeding failed; not running the journeys against unknown data.');
    process.exit(1);
  }
}

let failed = 0;
for (const script of scripts) {
  console.log(`\n=== ${script} ===`);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [new URL(script, import.meta.url).pathname], { stdio: 'inherit' });
    child.on('exit', (c) => resolve(c ?? 1));
  });
  if (code !== 0) failed += 1;
}

console.log(`\n${scripts.length - failed}/${scripts.length} journeys passed.`);
process.exit(failed === 0 ? 0 : 1);
