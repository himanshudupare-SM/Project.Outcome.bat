import { BASE, OUT, ORG, launch, signIn, watchForFailures } from './shared.mjs';
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
watchForFailures(page, errors);
const step = async (n, fn) => { try { await fn(); console.log(`PASS  ${n}`); } catch (e) { console.log(`FAIL  ${n}: ${e.message.split('\n')[0]}`); throw e; } };

try {
  await step('sign in', () => signIn(page));

  await step('open the assistant', async () => {
    await page.getByRole('link', { name: 'Assistant' }).click();
    await page.waitForURL(/\/assistant/, { timeout: 10000 });
    await page.getByRole('heading', { name: 'Assistant' }).waitFor();
  });

  await step('ask what is blocking, get cited facts', async () => {
    await page.getByRole('button', { name: 'What is blocking us right now?' }).click();
    await page.getByText('What the data shows').waitFor({ timeout: 20000 });
  });
  const refLinks = await page.locator('.ref').count();
  const hasRecommendation = await page.getByText('Recommendation').count();
  console.log(`INFO  answer: ${refLinks} citation link(s), recommendation section=${hasRecommendation > 0}`);
  await page.screenshot({ path: `${OUT}/as-1-answer.png`, fullPage: true });

  await step('a citation links to the real task', async () => {
    const first = page.locator('.ref').first();
    const ref = (await first.textContent()).trim();
    await first.click();
    await page.locator('.drawer').waitFor({ timeout: 10000 });
    const drawerRef = (await page.locator('.drawer .ref').first().textContent()).trim();
    if (drawerRef !== ref) throw new Error(`citation ${ref} opened ${drawerRef}`);
    console.log(`INFO  citation ${ref} opened the matching task`);
    await page.keyboard.press('Escape');
  });

  await step('ask what to work on', async () => {
    await page.goto(`${BASE}/o/${ORG}/assistant`, { waitUntil: 'networkidle' });
    await page.getByLabel('Question').fill('What should I work on today?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await page.getByText('What the data shows').waitFor({ timeout: 20000 });
  });

  await step('an unanswerable question is refused, not invented', async () => {
    await page.getByLabel('Question').fill('What is our revenue forecast for next quarter?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await page.getByText(/could not tell what|cannot see|cannot answer/i).waitFor({ timeout: 20000 });
  });
  await page.screenshot({ path: `${OUT}/as-2-refusal.png`, fullPage: true });

  await step('asking for a task proposes it without creating it', async () => {
    await page.getByLabel('Question').fill('Create a task called "Chase legal for the DPA"');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await page.getByText('Proposed changes', { exact: false }).waitFor({ timeout: 20000 });
    const applyButtons = await page.getByRole('button', { name: /Apply|Confirm this change/ }).count();
    if (applyButtons === 0) throw new Error('no confirmation control rendered');
    console.log(`INFO  proposal rendered with ${applyButtons} confirmation control(s)`);
  });
  await page.screenshot({ path: `${OUT}/as-3-proposal.png`, fullPage: true });

  await step('confirming applies it', async () => {
    const confirmResponse = page.waitForResponse(
      (r) => r.url().includes('/assistant/actions/confirm') && r.request().method() === 'POST',
      { timeout: 20000 },
    );
    await page.getByRole('button', { name: /Apply|Confirm this change/ }).first().click();
    const response = await confirmResponse;
    if (!response.ok()) throw new Error(`confirm returned ${response.status()}: ${await response.text()}`);
    await page.locator('.pill-good', { hasText: 'Applied' }).first().waitFor({ timeout: 15000 });
  });

  await step('the created task exists and is attributed to AI', async () => {
    await page.goto(`${BASE}/o/${ORG}/p/ATLAS/backlog`, { waitUntil: 'networkidle' });
    await page.getByText('Chase legal for the DPA').first().click();
    await page.locator('.drawer').waitFor({ timeout: 10000 });
    await page.getByText('Created by AI').waitFor({ timeout: 10000 });
  });

  console.log(`\nJS/HTTP errors: ${errors.length ? '\n  ' + errors.join('\n  ') : 'none'}`);
} catch (e) {
  await page.screenshot({ path: `${OUT}/as-failure.png`, fullPage: true });
  console.log(`FAILED (${e.message.split('\n')[0]}) — see as-failure.png`);
  console.log(`errors: ${errors.join('\n  ')}`);
  process.exitCode = 1;
} finally { await browser.close(); }
