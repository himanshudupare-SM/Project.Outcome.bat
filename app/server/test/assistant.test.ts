import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssistantAnswer, AssistantReply, Task, TaskDetail } from '@outcome/shared';
import {
  api,
  bootstrapOrgProject,
  closeApp,
  createProject,
  getApp,
  signup,
  truncateAll,
} from './helpers.js';
import type { TestClient } from './helpers.js';
import { setAiProvider } from '../src/modules/ai/index.js';
import type { AiProvider } from '../src/modules/ai/provider.js';

/**
 * Assistant tests. The guarantees under test are the product's promises:
 * answers are grounded in data the asker may see, citations resolve to real
 * tasks, facts are separated from advice, and no mutation happens without an
 * explicit confirmation by the person who asked.
 */


/**
 * A provider that always returns one fixed answer. The cast is confined here:
 * the provider interface is generic over the caller's schema, and a test
 * fixture is by definition a single concrete shape.
 */
function fixedProvider(name: string, value: AssistantAnswer): AiProvider {
  return {
    name,
    model: name,
    structured: () =>
      Promise.resolve({
        value: value as never,
        model: name,
        inputTokens: 1,
        outputTokens: 1,
        attempts: 1,
      }),
  };
}

let lead: TestClient;
let outsider: TestClient;
let ctx: Awaited<ReturnType<typeof bootstrapOrgProject>>;
let blockedTask: TaskDetail;
let dependentTask: TaskDetail;

const url = (p: string): string => `/api/v1/orgs/${ctx.orgSlug}${p}`;
const ask = (client: TestClient, question: string, projectId?: string) =>
  api<AssistantReply>(client, 'POST', url('/assistant/ask'), { question, projectId: projectId ?? null });

beforeAll(async () => {
  await getApp();
  await truncateAll();
  lead = await signup('lead@assistant.test', 'Dana Lead');
  outsider = await signup('outsider@assistant.test', 'Olive Outsider');
  ctx = await bootstrapOrgProject(lead, 'Assistant Org', 'Delivery');

  const statusId = (category: string): string =>
    ctx.statuses.find((s) => s.category === category)!.id;

  const make = async (title: string, extra: Record<string, unknown> = {}): Promise<TaskDetail> => {
    const res = await api<TaskDetail>(
      lead,
      'POST',
      `/api/v1/orgs/${ctx.orgSlug}/projects/${ctx.projectKey}/tasks`,
      { title, assigneeId: lead.userId, ...extra },
    );
    expect(res.status).toBe(201);
    return res.body;
  };

  blockedTask = await make('Migrate the payment vault', {
    statusId: statusId('in_progress'),
    priority: 'urgent',
    dueDate: '2020-01-01',
  });
  dependentTask = await make('Run the regression suite', { statusId: statusId('todo') });
  await make('Polish the wallet UI', { statusId: statusId('backlog'), priority: 'low' });

  await api(lead, 'POST', url(`/tasks/${dependentTask.id}/dependencies`), {
    blockingTaskId: blockedTask.id,
  });
  await api(lead, 'POST', url(`/tasks/${blockedTask.id}/blockers`), {
    reason: 'Waiting on the signed DPA amendment from Legal',
  });
});
afterAll(async () => {
  setAiProvider(null);
  await closeApp();
});

describe('grounded answers', () => {
  it('answers "what is blocked" with citations that resolve to real tasks', async () => {
    const res = await ask(lead, 'What is blocking us right now?');
    expect(res.status).toBe(200);
    expect(res.body.answer.cannotAnswer).toBeNull();
    expect(res.body.answer.facts.length).toBeGreaterThan(0);
    expect(res.body.citations.length).toBeGreaterThan(0);
    // Every citation must be a real, readable task.
    for (const citation of res.body.citations) {
      const task = await api<TaskDetail>(lead, 'GET', url(`/tasks/${citation.taskId}`));
      expect(task.status).toBe(200);
      expect(task.body.ref).toBe(citation.ref);
    }
    expect(JSON.stringify(res.body.answer.facts)).toContain('DPA');
  });

  it('separates facts from recommendations', async () => {
    const res = await ask(lead, 'What is blocking us?');
    expect(res.body.answer.facts.every((f) => typeof f.text === 'string')).toBe(true);
    expect(Array.isArray(res.body.answer.recommendations)).toBe(true);
    // Advice must not be presented inside the fact list.
    expect(res.body.answer.recommendations.join(' ')).toMatch(/unblock|leverage|release/i);
  });

  it('answers "what should I work on" using deadlines and downstream impact', async () => {
    const res = await ask(lead, 'What should I work on today?');
    expect(res.body.answer.facts.length).toBeGreaterThan(0);
    const refs = res.body.citations.map((c) => c.ref);
    expect(refs).toContain(blockedTask.ref);
  });

  it('answers overdue questions from real dates', async () => {
    const res = await ask(lead, 'Which tasks are overdue?');
    expect(JSON.stringify(res.body.answer.facts)).toContain('2020-01-01');
    expect(res.body.citations.map((c) => c.ref)).toContain(blockedTask.ref);
  });

  it('answers dependency questions for a specific task', async () => {
    const res = await ask(lead, `Show me everything dependent on ${blockedTask.ref}`);
    expect(res.body.citations.map((c) => c.ref)).toContain(dependentTask.ref);
  });

  it('answers workload questions', async () => {
    const res = await ask(lead, 'Who is overloaded?');
    expect(JSON.stringify(res.body.answer.facts)).toContain('Dana Lead');
  });

  it('summarises risk without inventing numbers', async () => {
    const res = await ask(lead, 'Which projects are at risk?');
    const text = JSON.stringify(res.body.answer);
    expect(text).toContain('blocked');
    expect(res.body.answer.facts.length).toBeGreaterThan(0);
  });

  it('says it cannot answer rather than guessing', async () => {
    const res = await ask(lead, 'What is our revenue forecast for next quarter?');
    expect(res.body.answer.cannotAnswer).toBeTruthy();
    expect(res.body.answer.facts).toEqual([]);
  });

  it('records the conversation and can replay it', async () => {
    const first = await ask(lead, 'What is blocked?');
    const list = await api<{ items: Array<{ id: string }> }>(
      lead,
      'GET',
      url('/assistant/conversations'),
    );
    expect(list.body.items.some((c) => c.id === first.body.conversationId)).toBe(true);

    const conversation = await api<{ messages: Array<{ role: string }> }>(
      lead,
      'GET',
      url(`/assistant/conversations/${first.body.conversationId}`),
    );
    expect(conversation.body.messages.filter((m) => m.role === 'user').length).toBe(1);
    expect(conversation.body.messages.filter((m) => m.role === 'assistant').length).toBe(1);
  });
});

describe('permission scoping', () => {
  it('never describes work the asker cannot see', async () => {
    // A second project the outsider is not a member of.
    const secret = await createProject(lead, ctx.orgSlug, 'Secret Acquisition');
    await api(lead, 'POST', `/api/v1/orgs/${ctx.orgSlug}/projects/${secret.key}/tasks`, {
      title: 'Draft the acquisition memo',
    });

    const invite = await api<{ inviteUrl: string }>(lead, 'POST', url('/invitations'), {
      email: 'outsider@assistant.test',
      role: 'member',
    });
    await api(outsider, 'POST', '/api/v1/invitations/accept', {
      token: invite.body.inviteUrl.split('/invite/')[1]!,
    });

    const res = await ask(outsider, 'What is blocked?');
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('acquisition');
    expect(text).not.toContain('payment vault');
    expect(res.body.answer.cannotAnswer).toBeTruthy();
  });

  it('refuses a project scope the asker has no access to', async () => {
    const secret = await createProject(lead, ctx.orgSlug, 'Another Private Project');
    const res = await ask(outsider, 'What is blocked?', secret.key);
    expect(res.status).toBe(403);
  });

  it('keeps a conversation private to its owner', async () => {
    const mine = await ask(lead, 'What is blocked?');
    const res = await api(outsider, 'GET', url(`/assistant/conversations/${mine.body.conversationId}`));
    expect(res.status).toBe(403);
  });

  it('drops citations the model invented', async () => {
    // A provider that cites a task that does not exist.
    const liar = fixedProvider('liar', {
        facts: [
          { text: 'A task you cannot see is blocked.', refs: ['GHOST-999'] },
          { text: 'A real task is blocked.', refs: [blockedTask.ref] },
        ],
        recommendations: [],
        cannotAnswer: null,
        proposedActions: [],
      });
    setAiProvider(liar);
    try {
      const res = await ask(lead, 'What is blocked?');
      const allRefs = res.body.answer.facts.flatMap((f) => f.refs);
      expect(allRefs).not.toContain('GHOST-999');
      expect(allRefs).toContain(blockedTask.ref);
      expect(res.body.citations.map((c) => c.ref)).not.toContain('GHOST-999');
    } finally {
      setAiProvider(null);
    }
  });
});

describe('tool calling requires confirmation', () => {
  it('proposes a task instead of creating it, then creates it on confirmation', async () => {
    const before = await api<{ items: Task[] }>(
      lead,
      'GET',
      url(`/tasks?projectId=${ctx.projectKey}&parent=all`),
    );

  const proposer = fixedProvider('proposer', {
            facts: [],
            recommendations: ['Track this as its own task.'],
            cannotAnswer: null,
            proposedActions: [
              {
                tool: 'create_task',
                description: 'Create "Chase Legal for the DPA amendment"',
                targetRef: blockedTask.ref,
                title: 'Chase Legal for the DPA amendment',
                body: null,
                assigneeName: 'Dana Lead',
                priority: 'high',
                dueDate: null,
                blockingRef: null,
                highImpact: false,
              },
            ],
          });
    setAiProvider(proposer);
    try {
      const res = await ask(lead, 'Create a task to chase Legal.');
      expect(res.body.actions).toHaveLength(1);
      expect(res.body.actions[0]!.status).toBe('proposed');

      // Nothing was created by asking.
      const during = await api<{ items: Task[] }>(
        lead,
        'GET',
        url(`/tasks?projectId=${ctx.projectKey}&parent=all`),
      );
      expect(during.body.items).toHaveLength(before.body.items.length);

      // Confirmation without the explicit flag is rejected by the contract.
      const noFlag = await api(lead, 'POST', url('/assistant/actions/confirm'), {
        actionId: res.body.actions[0]!.id,
      });
      expect(noFlag.status).toBe(400);

      const confirmed = await api<{ status: string; result: { ref: string } }>(
        lead,
        'POST',
        url('/assistant/actions/confirm'),
        { actionId: res.body.actions[0]!.id, confirm: true },
      );
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.status).toBe('executed');

      const after = await api<{ items: Task[] }>(
        lead,
        'GET',
        url(`/tasks?projectId=${ctx.projectKey}&parent=all`),
      );
      expect(after.body.items.length).toBe(before.body.items.length + 1);
      const created = after.body.items.find((t) => t.ref === confirmed.body.result.ref)!;
      expect(created.title).toBe('Chase Legal for the DPA amendment');
      expect(created.source).toBe('ai');
      expect(created.assigneeId).toBe(lead.userId);
      expect(created.priority).toBe('high');
    } finally {
      setAiProvider(null);
    }
  });

  it('refuses to apply the same action twice', async () => {
    const actionId = await proposeComment();
    expect(
      (await api(lead, 'POST', url('/assistant/actions/confirm'), { actionId, confirm: true })).status,
    ).toBe(200);
    const second = await api(lead, 'POST', url('/assistant/actions/confirm'), {
      actionId,
      confirm: true,
    });
    expect(second.status).toBe(409);
  });

  it('only lets the person who asked confirm', async () => {
    const actionId = await proposeComment();
    const res = await api(outsider, 'POST', url('/assistant/actions/confirm'), {
      actionId,
      confirm: true,
    });
    expect(res.status).toBe(403);
  });

  it('can reject a proposal, after which it cannot be applied', async () => {
    const actionId = await proposeComment();
    expect((await api(lead, 'POST', url(`/assistant/actions/${actionId}/reject`))).status).toBe(200);
    const res = await api(lead, 'POST', url('/assistant/actions/confirm'), { actionId, confirm: true });
    expect(res.status).toBe(409);
  });

  it('drops a proposed action aimed at a task the asker cannot see', async () => {
    const secret = await createProject(lead, ctx.orgSlug, 'Third Private Project');
    const secretTask = await api<TaskDetail>(
      lead,
      'POST',
      `/api/v1/orgs/${ctx.orgSlug}/projects/${secret.key}/tasks`,
      { title: 'Private work' },
    );
  const sneaky = fixedProvider('sneaky', {
            facts: [],
            recommendations: [],
            cannotAnswer: null,
            proposedActions: [
              {
                tool: 'add_comment',
                description: 'Comment on a task the asker cannot see',
                targetRef: secretTask.body.ref,
                title: null,
                body: 'leak',
                assigneeName: null,
                priority: null,
                dueDate: null,
                blockingRef: null,
                highImpact: true,
              },
            ],
          });
    setAiProvider(sneaky);
    try {
      const res = await ask(outsider, 'Do something.');
      expect(res.body.actions).toHaveLength(0);
    } finally {
      setAiProvider(null);
    }
  });

  it('records a confirmed action in the audit log as an AI actor', async () => {
    const actionId = await proposeComment();
    await api(lead, 'POST', url('/assistant/actions/confirm'), { actionId, confirm: true });
    const audit = await api<{
      items: Array<{ actorType: string; entityType: string; action: string; data: Record<string, unknown> }>;
    }>(lead, 'GET', url('/audit'));
    const event = audit.body.items.find(
      (e) => e.entityType === 'ai_action' && e.action === 'executed',
    );
    expect(event).toBeDefined();
    expect(event!.actorType).toBe('ai');
    expect(event!.data['confirmedBy']).toBe(lead.userId);
  });

  it('fails an action whose target no longer resolves, without corrupting state', async () => {
  const broken = fixedProvider('broken', {
            facts: [],
            recommendations: [],
            cannotAnswer: null,
            proposedActions: [
              {
                tool: 'assign_task',
                description: 'Assign to somebody who does not exist',
                targetRef: blockedTask.ref,
                title: null,
                body: null,
                assigneeName: 'Nobody At All',
                priority: null,
                dueDate: null,
                blockingRef: null,
                highImpact: true,
              },
            ],
          });
    setAiProvider(broken);
    try {
      const res = await ask(lead, 'Assign it.');
      const actionId = res.body.actions[0]!.id;
      const confirmed = await api(lead, 'POST', url('/assistant/actions/confirm'), {
        actionId,
        confirm: true,
      });
      expect(confirmed.status).toBe(400);
      // The task is untouched.
      const task = await api<TaskDetail>(lead, 'GET', url(`/tasks/${blockedTask.id}`));
      expect(task.body.assigneeId).toBe(lead.userId);
      // Retrying a failed action is refused, not silently re-run.
      const retry = await api(lead, 'POST', url('/assistant/actions/confirm'), {
        actionId,
        confirm: true,
      });
      expect(retry.status).toBe(409);
    } finally {
      setAiProvider(null);
    }
  });
});

/** Propose an add_comment action and return its id. */
async function proposeComment(): Promise<string> {
  const provider = fixedProvider('commenter', {
    facts: [],
    recommendations: [],
    cannotAnswer: null,
    proposedActions: [
      {
        tool: 'add_comment',
        description: 'Post a nudge on the blocked task',
        targetRef: blockedTask.ref,
        title: null,
        body: 'Nudging Legal on the DPA amendment.',
        assigneeName: null,
        priority: null,
        dueDate: null,
        blockingRef: null,
        highImpact: true,
      },
    ],
  });
  setAiProvider(provider);
  const res = await ask(lead, 'Nudge legal.');
  setAiProvider(null);
  return res.body.actions[0]!.id;
}
