import '../platform/env-load.js';

import { closePool, db, withOrg } from '../platform/db.js';
import { migrate } from '../platform/migrate.js';
import { hashPassword } from '../platform/crypto.js';
import * as orgsService from '../modules/orgs/service.js';
import * as projectsService from '../modules/projects/service.js';
import * as tasksService from '../modules/tasks/service.js';
import * as commentsService from '../modules/comments/service.js';
import type { OrgCtx, UserCtx } from '../platform/ctx.js';
import type { CreateTaskInput } from '@outcome/shared';

/**
 * Development seed: a realistic single project with dependencies, blockers,
 * comments and history so every screen has something meaningful to show.
 * Idempotent — re-running replaces the demo org.
 */

const PEOPLE = [
  { email: 'dana@example.com', name: 'Dana Whitfield', role: 'owner' as const },
  { email: 'priya@example.com', name: 'Priya Raman', role: 'member' as const },
  { email: 'marco@example.com', name: 'Marco Silva', role: 'member' as const },
  { email: 'lena@example.com', name: 'Lena Fischer', role: 'member' as const },
  { email: 'jules@example.com', name: 'Jules Tan', role: 'member' as const },
  { email: 'sam@example.com', name: 'Sam Ortiz', role: 'member' as const },
  { email: 'ingrid@example.com', name: 'Ingrid Holm', role: 'admin' as const },
];
const DEMO_PASSWORD = 'demo-password-123';

async function upsertUser(email: string, name: string): Promise<string> {
  const hash = await hashPassword(DEMO_PASSWORD);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, name, password_hash, email_verified_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [email, name, hash],
  );
  return rows[0]!.id;
}

function ctxFor(userId: string, orgId: string, role: 'owner' | 'admin' | 'member'): OrgCtx {
  return { userId, orgId, orgRole: role, sessionId: null, apiKeyId: null, requestId: 'seed' };
}

async function main(): Promise<void> {
  await migrate();

  // Fresh demo org each run, so the seed is deterministic.
  await db.query(`DELETE FROM organizations WHERE slug = 'northwind'`);

  const userIds = new Map<string, string>();
  for (const p of PEOPLE) userIds.set(p.email, await upsertUser(p.email, p.name));
  const danaId = userIds.get('dana@example.com')!;
  const userCtx: UserCtx = { userId: danaId, sessionId: null, apiKeyId: null, requestId: 'seed' };

  const org = await orgsService.createOrg(userCtx, { name: 'Northwind', slug: 'northwind' });
  const ctx = ctxFor(danaId, org.id, 'owner');

  await withOrg(org.id, async (tx) => {
    for (const p of PEOPLE) {
      if (p.email === 'dana@example.com') continue;
      await tx.query(
        `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [org.id, userIds.get(p.email), p.role],
      );
    }
  });

  const platformTeam = await orgsService.createTeam(ctx, {
    name: 'Platform',
    memberIds: [danaId, userIds.get('priya@example.com')!, userIds.get('marco@example.com')!, userIds.get('lena@example.com')!],
  });

  const project = await projectsService.createProject(ctx, {
    name: 'Checkout Platform Migration',
    key: 'ATLAS',
    description:
      'Move checkout to the new payment provider before the contract renewal date.',
    teamId: platformTeam.id,
    leadId: danaId,
    targetDate: '2026-09-30',
  });

  for (const p of PEOPLE) {
    const id = userIds.get(p.email);
    if (!id || id === danaId) continue;
    await projectsService.addMember(ctx, { id: project.id, key: project.key, role: 'lead' }, id, 'member');
  }

  const statusByCategory = new Map(project.statuses.map((s) => [s.category, s.id]));
  const labels = {
    payments: await tasksService.createLabel(ctx, 'payments', '#2a78d6'),
    compliance: await tasksService.createLabel(ctx, 'compliance', '#eb6834'),
    frontend: await tasksService.createLabel(ctx, 'frontend', '#1baf7a'),
  };

  const epics = {
    integration: await projectsService.createEpic(ctx, project, {
      name: 'Payment provider integration',
      description: 'Adapter service, tokenization, webhooks.',
      targetDate: '2026-08-07',
    }),
    flows: await projectsService.createEpic(ctx, project, {
      name: 'Checkout flows',
      description: 'Everything the customer touches during payment.',
      targetDate: '2026-09-15',
    }),
    compliance: await projectsService.createEpic(ctx, project, {
      name: 'Compliance & quality',
      description: 'Evidence, pen-test remediation, regression suite.',
      targetDate: '2026-09-22',
    }),
  };

  const proj = { id: project.id, key: project.key, role: 'lead' as const };
  const mk = async (
    input: Omit<CreateTaskInput, 'description' | 'labelIds' | 'priority'> &
      Partial<Pick<CreateTaskInput, 'description' | 'labelIds' | 'priority'>>,
  ) =>
    tasksService.createTask(ctx, proj, {
      description: '',
      labelIds: [],
      priority: 'none',
      ...input,
    });

  const done = statusByCategory.get('done')!;
  const inProgress = statusByCategory.get('in_progress')!;
  const todo = statusByCategory.get('todo')!;
  const backlog = statusByCategory.get('backlog')!;
  const review = statusByCategory.get('in_review')!;

  const adapter = await mk({
    title: 'Payment provider adapter service',
    description: 'Wrap the provider SDK behind our own interface with contract tests.',
    epicId: epics.integration.id,
    statusId: done,
    assigneeId: userIds.get('marco@example.com'),
    priority: 'high',
    estimateDays: 8,
    labelIds: [labels.payments.id],
  });

  const tokenization = await mk({
    title: 'Tokenization migration — provider vault cutover',
    description:
      'Move stored card tokens into the provider vault. Requires the amended data-processing agreement to be countersigned before production vault access is enabled.',
    epicId: epics.integration.id,
    statusId: inProgress,
    assigneeId: userIds.get('lena@example.com'),
    priority: 'urgent',
    estimateDays: 9,
    dueDate: '2026-09-10',
    labelIds: [labels.payments.id, labels.compliance.id],
  });

  await mk({
    title: 'Webhook idempotency & retry hardening',
    epicId: epics.integration.id,
    statusId: inProgress,
    assigneeId: userIds.get('priya@example.com'),
    priority: 'high',
    estimateDays: 8,
    labelIds: [labels.payments.id],
  });

  const refunds = await mk({
    title: 'Refunds & partial-capture migration',
    epicId: epics.flows.id,
    statusId: inProgress,
    assigneeId: userIds.get('priya@example.com'),
    priority: 'medium',
    estimateDays: 8,
    labelIds: [labels.payments.id],
  });

  const backfill = await mk({
    title: 'Stored payment methods — backfill job',
    epicId: epics.flows.id,
    statusId: backlog,
    assigneeId: userIds.get('marco@example.com'),
    estimateDays: 3,
  });

  const fallback = await mk({
    title: 'Checkout fallback & provider-retry path',
    epicId: epics.flows.id,
    statusId: todo,
    assigneeId: userIds.get('priya@example.com'),
    priority: 'high',
    estimateDays: 4,
  });

  const errorStates = await mk({
    title: 'Checkout error states & recovery UX',
    description: 'Two competing proposals; needs a product decision, not more design work.',
    epicId: epics.flows.id,
    statusId: todo,
    assigneeId: userIds.get('jules@example.com'),
    priority: 'medium',
    estimateDays: 6,
    labelIds: [labels.frontend.id],
  });

  await mk({
    title: 'Checkout UI migration to new payment fields',
    epicId: epics.flows.id,
    statusId: done,
    assigneeId: userIds.get('jules@example.com'),
    estimateDays: 9,
    labelIds: [labels.frontend.id],
  });

  const pci = await mk({
    title: 'PCI DSS evidence pack',
    description: 'Awaiting security review; single reviewer queued behind on-call.',
    epicId: epics.compliance.id,
    statusId: review,
    assigneeId: userIds.get('lena@example.com'),
    priority: 'high',
    estimateDays: 6,
    labelIds: [labels.compliance.id],
  });

  const pentest = await mk({
    title: 'Pen-test findings — remediation',
    epicId: epics.compliance.id,
    statusId: backlog,
    assigneeId: userIds.get('ingrid@example.com'),
    estimateDays: 4,
    labelIds: [labels.compliance.id],
  });

  const regression = await mk({
    title: 'End-to-end payment regression suite',
    description: 'Full pass must wait for the last flow to land.',
    epicId: epics.compliance.id,
    statusId: backlog,
    assigneeId: userIds.get('sam@example.com'),
    priority: 'high',
    estimateDays: 5,
    dueDate: '2026-09-22',
  });

  const cutover = await mk({
    title: 'Production cutover & hypercare window',
    statusId: backlog,
    assigneeId: danaId,
    priority: 'urgent',
    estimateDays: 3,
    dueDate: '2026-09-30',
  });

  // Subtasks
  await mk({ title: 'Write vault migration runbook', parentId: tokenization.id, statusId: todo, assigneeId: userIds.get('lena@example.com') });
  await mk({ title: 'Dry-run migration on staging data', parentId: tokenization.id, statusId: backlog, assigneeId: userIds.get('lena@example.com') });
  await mk({ title: 'Smoke tests for retry path', parentId: fallback.id, statusId: backlog, assigneeId: userIds.get('sam@example.com') });

  // Dependency graph: the cascade the dashboards are meant to reveal.
  const dep = async (blocked: { id: string }, blocking: { id: string }) =>
    tasksService.addDependency(ctx, blocked.id, blocking.id);
  await dep(tokenization, adapter);
  await dep(backfill, tokenization);
  await dep(fallback, tokenization);
  await dep(regression, backfill);
  await dep(regression, fallback);
  await dep(regression, errorStates);
  await dep(regression, refunds);
  await dep(pentest, pci);
  await dep(cutover, regression);
  await dep(cutover, pentest);

  // Blockers with real reasons — the raw material for risk analysis.
  await tasksService.addBlocker(ctx, tokenization.id, {
    reason:
      'Legal has not countersigned the DPA amendment for provider vault access (requested 25 Aug, 3-day SLA).',
    expectedResolutionDate: '2026-09-09',
  });
  await tasksService.addBlocker(ctx, errorStates.id, {
    reason: 'Product decision pending on error-state copy and retry flows — two competing proposals.',
    expectedResolutionDate: '2026-09-04',
  });

  // Conversation history
  await commentsService.create(ctxFor(userIds.get('lena@example.com')!, org.id, 'member'), tokenization.id, {
    body: 'Provider confirmed they will not enable production vault access until the amendment is signed. @dana can you escalate to Legal?',
  });
  await commentsService.create(ctx, tokenization.id, {
    body: 'Escalating today. If it is not signed by Tuesday we should plan for a staged cutover instead.',
  });
  await commentsService.create(ctxFor(userIds.get('sam@example.com')!, org.id, 'member'), regression.id, {
    body: 'I can run a smoke suite continuously against the flows that are already finished — only the final full pass needs everything landed.',
  });

  console.log(
    [
      '',
      'Seed complete.',
      `  Organization: ${org.name} (/o/${org.slug})`,
      `  Project:      ${project.key} — ${project.name}`,
      `  Sign in as:   dana@example.com  /  ${DEMO_PASSWORD}`,
      `  Other users:  ${PEOPLE.filter((p) => p.email !== 'dana@example.com').map((p) => p.email).join(', ')}`,
      '',
    ].join('\n'),
  );
}

await main();
await closePool();
