import { BASE, OUT, ORG, launch, signIn, watchForFailures } from './shared.mjs';
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
watchForFailures(page, errors);
const step = async (n, fn) => { try { await fn(); console.log(`PASS  ${n}`); } catch (e) { console.log(`FAIL  ${n}: ${e.message.split('\n')[0]}`); throw e; } };

/**
 * The runner re-seeds before the journeys, so this dump is extracted against
 * a known database. The second dump of the same notes then exercises
 * duplicate detection against the tasks this run just created.
 */
const DUMP =
  'I need to finish the Codex workshop, ask engineering to check the MacBook integration, ' +
  'review the DevOps assistant, prepare the GTM deck, and follow up with the CX team. ' +
  'The GTM deck needs to be done by Friday and engineering is blocked until the API credentials are available.';
const EDITED = 'Finish the Codex workshop (edited)';
try {
  await step('sign in', () => signIn(page));

  await step('open brain dump from the topbar', async () => {
    await page.getByRole('link', { name: 'Brain dump' }).first().click();
    await page.waitForURL(/\/capture/, { timeout: 10000 });
    await page.getByRole('heading', { name: 'Brain dump' }).waitFor();
  });

  await step('type a realistic dump and extract', async () => {
    await page.getByLabel('What needs doing?').fill(DUMP);
    await page.getByLabel('Project (optional)').selectOption('ATLAS');
    await page.getByRole('button', { name: 'Extract tasks' }).click();
    await page.getByRole('heading', { name: 'Review before creating' }).waitFor({ timeout: 20000 });
  });

  const cards = await page.locator('article.card').count();
  const unsure = await page.getByText('unsure').count();
  const needsAnswer = await page.getByText('Needs your answer').count();
  const blocked = await page.getByText('Blocked:', { exact: false }).count();
  console.log(`INFO  proposal: ${cards} task cards, ${unsure} unsure fields, ${needsAnswer} needing answers, ${blocked} blocker notices`);
  await page.screenshot({ path: `${OUT}/ai-1-review.png`, fullPage: true });

  await step('create button is gated until questions are answered', async () => {
    const btn = page.getByRole('button', { name: /^Create \d+ task/ });
    if (needsAnswer > 0 && !(await btn.isDisabled())) throw new Error('should be disabled while questions remain');
  });

  await step('confirm the flagged values', async () => {
    const confirms = page.getByRole('button', { name: 'Values look right' });
    const n = await confirms.count();
    for (let i = 0; i < n; i++) await confirms.first().click();
    await page.waitForTimeout(300);
  });

  await step('edit a title before approving', async () => {
    const first = page.locator('article.card').first().getByRole('textbox').first();
    await first.fill(EDITED);
  });

  let created = 0;
  await step('approve and land on the board', async () => {
    const btn = page.getByRole('button', { name: /^Create \d+ task/ });
    created = Number((await btn.textContent()).match(/\d+/)[0]);
    await btn.click();
    await page.waitForURL(/\/p\/ATLAS\/board/, { timeout: 20000 });
    await page.getByText(EDITED).first().waitFor({ timeout: 10000 });
  });
  console.log(`INFO  approved ${created} tasks`);
  await page.screenshot({ path: `${OUT}/ai-2-board.png`, fullPage: true });

  await step('created task shows AI provenance', async () => {
    await page.getByText(EDITED).first().click();
    await page.locator('.drawer').waitFor({ timeout: 10000 });
    await page.getByText('Created by AI').waitFor({ timeout: 10000 });
  });
  await page.screenshot({ path: `${OUT}/ai-3-task.png`, fullPage: true });

  await step('activity records the AI actor', async () => {
    await page.goto(`${BASE}/o/${ORG}/p/ATLAS/activity`, { waitUntil: 'networkidle' });
    await page.getByText('AI', { exact: true }).first().waitFor({ timeout: 10000 });
  });

  await step('re-dumping the same notes is caught as duplicate work', async () => {
    await page.goto(`${BASE}/o/${ORG}/capture`, { waitUntil: 'networkidle' });
    await page.getByLabel('What needs doing?').fill(DUMP);
    await page.getByLabel('Project (optional)').selectOption('ATLAS');
    await page.getByRole('button', { name: 'Extract tasks' }).click();
    await page.getByRole('heading', { name: 'Review before creating' }).waitFor({ timeout: 30000 });

    const warnings = await page.getByText('Looks like existing', { exact: false }).count();
    if (warnings === 0) throw new Error('the tasks just created were not flagged as duplicates');
    // Flagged cards are pre-unchecked, so the safe outcome needs no action.
    const checked = await page.locator('input[type=checkbox]:checked').count();
    if (checked > 0) throw new Error(`${checked} duplicate card(s) still selected`);
    const create = page.getByRole('button', { name: /^Create 0 tasks/ });
    if (!(await create.isDisabled())) throw new Error('create should be disabled with nothing selected');
    console.log(`INFO  duplicate detection: ${warnings} warning(s), 0 cards pre-selected`);
    await page.getByRole('button', { name: 'Discard this dump' }).click();
  });
  await page.screenshot({ path: `${OUT}/ai-5-duplicates.png`, fullPage: true });

  await step('voice capture degrades gracefully with no microphone', async () => {
    await page.goto(`${BASE}/o/${ORG}/capture`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '🎙 Use voice' }).click();
    await page.getByRole('dialog', { name: 'Voice capture' }).waitFor();
    await page.getByRole('button', { name: 'Start recording' }).click();
    await page.waitForTimeout(2000);
    const alerted = await page.getByRole('alert').count();
    const typeInstead = await page.getByRole('button', { name: 'Type instead' }).count();
    if (alerted === 0 && typeInstead === 0) throw new Error('no graceful fallback shown');
    console.log(`INFO  voice fallback: ${alerted} alert(s), typeInstead=${typeInstead > 0}`);
  });
  await page.screenshot({ path: `${OUT}/ai-4-voice.png`, fullPage: true });

  console.log(`\nJS/HTTP errors: ${errors.length ? '\n  ' + errors.join('\n  ') : 'none'}`);
} catch (e) {
  await page.screenshot({ path: `${OUT}/ai-failure.png`, fullPage: true });
  console.log(`FAILED (${e.message.split('\n')[0]}) — see ai-failure.png`);
  console.log(`errors: ${errors.join('\n  ')}`);
  process.exitCode = 1;
} finally { await browser.close(); }
