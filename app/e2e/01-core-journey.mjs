import { BASE, OUT, ORG, launch, signIn, watchForFailures } from './shared.mjs';

const TITLE = `E2E task ${Date.now().toString().slice(-6)}`;
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
watchForFailures(page, errors);

const step = async (name, fn) => {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (e) { console.log(`FAIL  ${name}: ${e.message.split('\n')[0]}`); throw e; }
};

try {
  // 1. Sign in with the seeded account
  await step('login page loads', async () => {
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Sign in' }).waitFor({ timeout: 10000 });
  });

  await step('sign in', () => signIn(page));

  await step('dashboard shows the seeded project', async () => {
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
    await page.getByText('Checkout Platform Migration').first().waitFor({ timeout: 10000 });
  });
  await page.screenshot({ path: `${OUT}/e2e-1-dashboard.png`, fullPage: true });

  // 2. Board
  await step('open the project board', async () => {
    await page.getByRole('link', { name: /Checkout Platform Migration/ }).first().click();
    await page.waitForURL(/\/p\/ATLAS\/board/, { timeout: 10000 });
    await page.locator('.board-col').first().waitFor();
  });
  const cols = await page.locator('.board-col').count();
  const cards = await page.locator('.board-card').count();
  console.log(`INFO  board: ${cols} columns, ${cards} cards`);
  await page.screenshot({ path: `${OUT}/e2e-2-board.png`, fullPage: true });

  // 3. Create a task from the board quick-add
  await step('quick-add a task on the board', async () => {
    await page.locator('.board-col').first().getByRole('button', { name: /Add task to/ }).click();
    const input = page.locator('.board-col').first().getByRole('textbox');
    await input.fill(TITLE);
    await input.press('Enter');
    await page.getByText(TITLE, { exact: true }).waitFor({ timeout: 10000 });
  });

  // 4. Open task detail, edit fields
  await step('open the new task detail drawer', async () => {
    await page.getByText(TITLE, { exact: true }).click();
    await page.waitForURL(/\/t\/\d+/, { timeout: 10000 });
    await page.locator('.drawer').waitFor();
    await page.getByLabel('Task title').waitFor();
  });

  await step('set priority and assignee', async () => {
    await page.getByLabel('Priority').selectOption('urgent');
    await page.waitForTimeout(600);
    await page.getByLabel('Assignee').selectOption({ label: 'Dana Whitfield' });
    await page.waitForTimeout(800);
  });

  await step('add a comment', async () => {
    await page.getByLabel('New comment').fill('Verified by the end-to-end check.');
    await page.getByRole('button', { name: 'Post comment' }).click();
    await page.getByText('Verified by the end-to-end check.').waitFor({ timeout: 10000 });
  });

  await step('record a blocker and see the status flip', async () => {
    await page.getByRole('button', { name: '+ Mark as blocked' }).click();
    await page.getByLabel('What is blocking this?').fill(`Blocked: ${TITLE}`);
    await page.getByRole('button', { name: 'Record blocker' }).click();
    await page.getByText('Blocked.', { exact: false }).first().waitFor({ timeout: 10000 });
  });
  await page.screenshot({ path: `${OUT}/e2e-3-task.png`, fullPage: true });

  await step('activity tab shows the audit trail', async () => {
    await page.getByRole('tab', { name: 'Activity' }).click();
    await page.getByText(/created this task|changed/).first().waitFor({ timeout: 10000 });
  });

  // 5. Blockers view
  await step('blockers view lists the new blocker', async () => {
    await page.goto(`${BASE}/o/${ORG}/p/ATLAS/blockers`, { waitUntil: 'networkidle' });
    await page.getByText(`Blocked: ${TITLE}`).waitFor({ timeout: 10000 });
  });
  const blockerRows = await page.locator('.table tbody tr').count();
  console.log(`INFO  blockers listed: ${blockerRows}`);
  await page.screenshot({ path: `${OUT}/e2e-4-blockers.png`, fullPage: true });

  // 6. Backlog + filters
  await step('backlog lists tasks and filters', async () => {
    await page.goto(`${BASE}/o/${ORG}/p/ATLAS/backlog`, { waitUntil: 'networkidle' });
    await page.locator('.table tbody tr').first().waitFor({ timeout: 10000 });
    await page.getByLabel('Filter by assignee').selectOption('me');
    await page.waitForTimeout(900);
  });
  console.log(`INFO  backlog rows (assigned to me): ${await page.locator('.table tbody tr').count()}`);
  await page.screenshot({ path: `${OUT}/e2e-5-backlog.png`, fullPage: true });

  // 7. My work
  await step('my work ranks with reasons', async () => {
    await page.goto(`${BASE}/o/${ORG}/me`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'My work' }).waitFor();
    await page.locator('.list-row').first().waitFor({ timeout: 10000 });
  });
  await page.screenshot({ path: `${OUT}/e2e-6-mywork.png`, fullPage: true });

  // 8. Search
  await step('search finds a seeded task', async () => {
    await page.goto(`${BASE}/o/${ORG}/search`, { waitUntil: 'networkidle' });
    await page.getByLabel('Search query').fill('tokenization');
    await page.getByRole('button', { name: 'Search' }).click();
    await page.getByText(/Tokenization migration/).first().waitFor({ timeout: 10000 });
  });

  // 9. Team + inbox
  await step('team page lists members', async () => {
    await page.goto(`${BASE}/o/${ORG}/team`, { waitUntil: 'networkidle' });
    await page.getByText('lena@example.com').waitFor({ timeout: 10000 });
  });
  await step('inbox loads', async () => {
    await page.goto(`${BASE}/o/${ORG}/inbox`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Inbox' }).waitFor();
  });

  // 10. Drag a card between columns
  await step('drag a card to another column', async () => {
    await page.goto(`${BASE}/o/${ORG}/p/ATLAS/board`, { waitUntil: 'networkidle' });
    const card = page.locator('.board-card').filter({ hasText: TITLE }).first();
    await card.waitFor({ timeout: 10000 });
    const before = await card.evaluate((el) => el.closest('.board-col')?.querySelector('.board-col-head span')?.textContent);
    // HTML5 drag/drop needs a manual dispatch in headless Chromium.
    const targetCol = page.locator('.board-col').filter({ hasText: 'In progress' }).first();
    const taskId = await card.getAttribute('href');
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await card.dispatchEvent('dragstart', { dataTransfer });
    await targetCol.dispatchEvent('dragover', { dataTransfer });
    await targetCol.dispatchEvent('drop', { dataTransfer });
    await page.waitForTimeout(1500);
    const after = await page.locator('.board-card').filter({ hasText: TITLE }).first()
      .evaluate((el) => el.closest('.board-col')?.querySelector('.board-col-head span')?.textContent);
    console.log(`INFO  drag: "${before}" -> "${after}" (${taskId})`);
    if (before === after) throw new Error(`card did not move (still in ${after})`);
  });

  // 11. Logout
  await step('sign out returns to login', async () => {
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL(/\/login/, { timeout: 10000 });
  });

  console.log(`\nJS errors: ${errors.length ? '\n  ' + errors.join('\n  ') : 'none'}`);
} catch (e) {
  await page.screenshot({ path: `${OUT}/e2e-failure.png`, fullPage: true });
  console.log(`\nFAILED (${e.message.split('\n')[0]}). Screenshot: e2e-failure.png`);
  console.log(`JS errors: ${errors.length ? '\n  ' + errors.join('\n  ') : 'none'}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
