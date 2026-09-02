import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DryRunReport, ImportMapping, ImportRun, Task } from '@outcome/shared';
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
import { setJiraTransportFactory } from '../src/modules/importer/service.js';
import { assertSafeBaseUrl, flattenAdf, parseIssue } from '../src/modules/importer/jira-client.js';
import type { JiraTransport } from '../src/modules/importer/jira-client.js';

/**
 * Jira import tests. A fixture transport stands in for Jira Cloud so the
 * mapping, conflict detection, ordering, failure handling and retry paths are
 * all exercised against the real service code.
 */

const CREDS = {
  baseUrl: 'https://acme.atlassian.net',
  email: 'importer@example.com',
  apiToken: 'jira-api-token-value',
};

interface FixtureIssue {
  key: string;
  summary: string;
  type?: string;
  subtask?: boolean;
  parent?: { key: string; type?: string };
  status?: string;
  priority?: string | null;
  assignee?: { accountId: string; displayName: string } | null;
  labels?: string[];
  duedate?: string | null;
  attachments?: number;
  blockedBy?: string[];
  comments?: Array<{ author: string; body: string }>;
  description?: string;
}

function fixture(issues: FixtureIssue[]): JiraTransport {
  const encoded = issues.map((i) => ({
    id: `1${i.key}`,
    key: i.key,
    fields: {
      summary: i.summary,
      description: i.description
        ? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: i.description }] }] }
        : null,
      issuetype: { name: i.type ?? 'Task', subtask: i.subtask ?? false },
      parent: i.parent
        ? { key: i.parent.key, fields: { issuetype: { name: i.parent.type ?? 'Epic' } } }
        : undefined,
      status: { name: i.status ?? 'To Do' },
      priority: i.priority === null ? null : { name: i.priority ?? 'Medium' },
      assignee: i.assignee ?? null,
      reporter: { displayName: 'Jira Reporter' },
      labels: i.labels ?? [],
      duedate: i.duedate ?? null,
      created: '2026-01-05T10:00:00.000Z',
      resolutiondate: null,
      attachment: Array.from({ length: i.attachments ?? 0 }, (_, n) => ({ id: String(n) })),
      issuelinks: (i.blockedBy ?? []).map((key) => ({
        type: { inward: 'is blocked by' },
        inwardIssue: { key },
      })),
      comment: {
        comments: (i.comments ?? []).map((c, n) => ({
          id: String(n),
          author: { displayName: c.author },
          body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: c.body }] }] },
          created: '2026-01-06T09:00:00.000Z',
        })),
      },
    },
  }));

  return {
    get(path: string): Promise<unknown> {
      if (path.startsWith('/rest/api/3/project/search')) {
        return Promise.resolve({ values: [{ key: 'JIRA', name: 'Legacy Delivery' }] });
      }
      if (path.includes('maxResults=0')) return Promise.resolve({ total: encoded.length });
      if (path.startsWith('/rest/api/3/search')) {
        const startAt = Number(/startAt=(\d+)/.exec(path)?.[1] ?? 0);
        const maxResults = Number(/maxResults=(\d+)/.exec(path)?.[1] ?? 50);
        return Promise.resolve({
          issues: encoded.slice(startAt, startAt + maxResults),
          total: encoded.length,
          startAt,
          maxResults,
        });
      }
      return Promise.reject(new Error(`unexpected path ${path}`));
    },
  };
}

const ISSUES: FixtureIssue[] = [
  { key: 'JIRA-1', summary: 'Checkout epic', type: 'Epic', status: 'In Progress' },
  {
    key: 'JIRA-2',
    summary: 'Migrate payment tokens',
    parent: { key: 'JIRA-1', type: 'Epic' },
    status: 'In Progress',
    priority: 'Highest',
    assignee: { accountId: 'acc-1', displayName: 'Priya Raman' },
    labels: ['payments', 'migration'],
    duedate: '2026-03-02',
    description: 'Move stored tokens into the new vault.',
    comments: [{ author: 'Lena Fischer', body: 'Vault access is pending legal signoff.' }],
    attachments: 2,
  },
  {
    key: 'JIRA-3',
    summary: 'Write migration runbook',
    subtask: true,
    parent: { key: 'JIRA-2', type: 'Task' },
    status: 'To Do',
    assignee: { accountId: 'acc-9', displayName: 'Unknown Person' },
  },
  {
    key: 'JIRA-4',
    summary: 'Run regression suite',
    status: 'Blocked',
    priority: 'Major',
    blockedBy: ['JIRA-2'],
  },
  { key: 'JIRA-5', summary: 'Retire the old gateway', status: 'Done', priority: 'Low' },
  { key: 'JIRA-6', summary: 'Triage inbound bugs', status: 'Sprint Limbo' },
];

let admin: TestClient;
let ctx: Awaited<ReturnType<typeof bootstrapOrgProject>>;
const url = (p: string): string => `/api/v1/orgs/${ctx.orgSlug}${p}`;

function mappingFor(overrides: Partial<ImportMapping> = {}): ImportMapping {
  return {
    projectKey: 'JIRA',
    targetProjectId: ctx.projectKey,
    statuses: {
      'In Progress': 'in_progress',
      'To Do': 'todo',
      Blocked: 'blocked',
      Done: 'done',
    },
    priorities: { Highest: 'urgent', Major: 'high', Medium: 'medium', Low: 'low' },
    users: { 'acc-1': admin.userId, 'acc-9': null },
    includeComments: true,
    includeSubtasks: true,
    ...overrides,
  };
}

beforeAll(async () => {
  await getApp();
  await truncateAll();
  admin = await signup('importer@example.com', 'Ida Importer');
  ctx = await bootstrapOrgProject(admin, 'Import Org', 'Migrated Delivery');
});
afterEach(() => setJiraTransportFactory(null));
afterAll(async () => {
  setJiraTransportFactory(null);
  await closeApp();
});

describe('Jira payload parsing', () => {
  it('flattens Atlassian document format to readable text', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First line.' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second line.' }] },
      ],
    };
    expect(flattenAdf(adf).trim()).toBe('First line.\n\nSecond line.');
  });

  it('extracts type, parent, epic link, labels and blocked-by links', () => {
    const parsed = parseIssue({
      key: 'X-1',
      fields: {
        summary: 'Something',
        issuetype: { name: 'Task', subtask: false },
        parent: { key: 'X-9', fields: { issuetype: { name: 'Epic' } } },
        status: { name: 'To Do' },
        priority: { name: 'High' },
        labels: ['a'],
        issuelinks: [{ type: { inward: 'is blocked by' }, inwardIssue: { key: 'X-2' } }],
      },
    })!;
    expect(parsed.epicKey).toBe('X-9');
    expect(parsed.parentKey).toBeNull();
    expect(parsed.blockedByKeys).toEqual(['X-2']);
    expect(parsed.labels).toEqual(['a']);
  });

  it('ignores a payload with no key rather than importing junk', () => {
    expect(parseIssue({ fields: { summary: 'orphan' } })).toBeNull();
  });
});

describe('base URL safety (SSRF)', () => {
  it('accepts a public https Jira host', async () => {
    await expect(assertSafeBaseUrl('https://acme.atlassian.net')).resolves.toBeInstanceOf(URL);
  });

  it.each([
    ['http://acme.atlassian.net', 'plain http'],
    ['https://localhost/jira', 'localhost'],
    ['https://127.0.0.1/', 'loopback'],
    ['https://10.1.2.3/', 'private range'],
    ['https://169.254.169.254/', 'link-local metadata'],
    ['https://192.168.1.10/', 'private range'],
    ['https://user:pw@acme.atlassian.net', 'credentials in URL'],
    ['https://acme.atlassian.net:8443', 'non-standard port'],
    ['not-a-url', 'malformed'],
  ])('rejects %s (%s)', async (candidate) => {
    await expect(assertSafeBaseUrl(candidate)).rejects.toThrow();
  });
});

describe('mapping suggestions', () => {
  it('lists Jira projects with issue counts', async () => {
    setJiraTransportFactory(() => Promise.resolve(fixture(ISSUES)));
    const res = await api<{ items: Array<{ key: string; issueCount: number }> }>(
      admin,
      'POST',
      url('/imports/jira/projects'),
      CREDS,
    );
    expect(res.status).toBe(200);
    expect(res.body.items[0]!.key).toBe('JIRA');
    expect(res.body.items[0]!.issueCount).toBe(ISSUES.length);
  });

  it('guesses status and priority mappings and reports what it could not map', async () => {
    setJiraTransportFactory(() => Promise.resolve(fixture(ISSUES)));
    const res = await api<{
      statuses: Record<string, string>;
      priorities: Record<string, string>;
      unmapped: { statuses: string[]; users: string[] };
    }>(admin, 'POST', url('/imports/jira/mapping'), { credentials: CREDS, projectKey: 'JIRA' });
    expect(res.status).toBe(200);
    expect(res.body.statuses['In Progress']).toBe('in_progress');
    expect(res.body.statuses['Done']).toBe('done');
    expect(res.body.statuses['Blocked']).toBe('blocked');
    expect(res.body.priorities['Highest']).toBe('urgent');
    // An unrecognised status must be surfaced, not guessed.
    expect(res.body.unmapped.statuses).toContain('Sprint Limbo');
    expect(res.body.unmapped.users).toContain('Unknown Person');
  });
});

describe('dry run', () => {
  it('reports what would be created and every conflict, writing nothing', async () => {
    setJiraTransportFactory(() => Promise.resolve(fixture(ISSUES)));
    const res = await api<{ report: DryRunReport; run: ImportRun }>(
      admin,
      'POST',
      url('/imports/jira/run'),
      { credentials: CREDS, mapping: mappingFor(), dryRun: true },
    );
    expect(res.status).toBe(200);
    const { report } = res.body;
    expect(report.willCreate['epic']).toBe(1);
    expect(report.willCreate['task']).toBe(4);
    expect(report.willCreate['subtask']).toBe(1);
    expect(report.willCreate['comment']).toBe(1);
    expect(report.conflicts.some((c) => c.kind === 'unmapped_status' && c.externalId === 'JIRA-6')).toBe(true);
    expect(report.conflicts.some((c) => c.kind === 'unmapped_user' && c.externalId === 'JIRA-3')).toBe(true);
    // Attachments are honestly declared as unsupported.
    expect(report.unsupported.join(' ')).toContain('JIRA-2');
    expect(report.unsupported.join(' ')).toContain('attachment');

    const tasks = await api<{ items: Task[] }>(admin, 'GET', url(`/tasks?projectId=${ctx.projectKey}`));
    expect(tasks.body.items).toHaveLength(0);
  });
});

describe('import execution', () => {
  it('imports epics, issues, subtasks, comments and dependencies', async () => {
    setJiraTransportFactory(() => Promise.resolve(fixture(ISSUES)));
    const res = await api<{ run: ImportRun }>(admin, 'POST', url('/imports/jira/run'), {
      credentials: CREDS,
      mapping: mappingFor(),
      dryRun: false,
    });
    expect(res.status).toBe(201);
    const stats = res.body.run.stats;
    expect(stats.imported['epic']).toBe(1);
    expect(stats.imported['task']).toBe(4);
    expect(stats.imported['subtask']).toBe(1);
    expect(stats.imported['comment']).toBe(1);
    expect(stats.imported['dependency']).toBe(1);
    expect(res.body.run.status).toBe('completed');

    const tasks = await api<{ items: Task[] }>(
      admin,
      'GET',
      url(`/tasks?projectId=${ctx.projectKey}&parent=all`),
    );
    const byTitle = new Map(tasks.body.items.map((t) => [t.title, t]));

    // Status, priority, assignee, labels and due date all mapped.
    const migrate = byTitle.get('Migrate payment tokens')!;
    expect(migrate.statusCategory).toBe('in_progress');
    expect(migrate.priority).toBe('urgent');
    expect(migrate.assigneeId).toBe(admin.userId);
    expect(migrate.dueDate).toBe('2026-03-02');
    expect(migrate.labels.map((l) => l.name).sort()).toEqual(['migration', 'payments']);
    expect(migrate.source).toBe('import');
    expect(migrate.epicId).not.toBeNull();

    // An unmapped status falls back to backlog rather than failing the row.
    expect(byTitle.get('Triage inbound bugs')!.statusCategory).toBe('backlog');
    // An unmatched Jira user leaves the task unassigned rather than guessing.
    expect(byTitle.get('Write migration runbook')!.assigneeId).toBeNull();
    // Done issues arrive done, with a completion time.
    expect(byTitle.get('Retire the old gateway')!.statusCategory).toBe('done');
    expect(byTitle.get('Retire the old gateway')!.completedAt).not.toBeNull();

    // The subtask is nested under its parent.
    expect(byTitle.get('Write migration runbook')!.parentId).toBe(migrate.id);

    // The Jira dependency became a real dependency.
    const regression = byTitle.get('Run regression suite')!;
    const detail = await api<{ blockedBy: Array<{ id: string }> }>(
      admin,
      'GET',
      url(`/tasks/${regression.id}`),
    );
    expect(detail.body.blockedBy.map((d) => d.id)).toContain(migrate.id);

    // Comment content and Jira attribution are preserved.
    const comments = await api<Array<{ body: string }>>(admin, 'GET', url(`/tasks/${migrate.id}/comments`));
    expect(comments.body[0]!.body).toContain('Lena Fischer');
    expect(comments.body[0]!.body).toContain('legal signoff');
    // Provenance is kept in the description.
    const full = await api<{ description: string }>(admin, 'GET', url(`/tasks/${migrate.id}`));
    expect(full.body.description).toContain('Imported from Jira JIRA-2');
  });

  it('skips duplicates on a second import instead of doubling the project', async () => {
    setJiraTransportFactory(() => Promise.resolve(fixture(ISSUES)));
    const res = await api<{ run: ImportRun }>(admin, 'POST', url('/imports/jira/run'), {
      credentials: CREDS,
      mapping: mappingFor(),
      dryRun: false,
    });
    expect(res.status).toBe(201);
    expect(res.body.run.stats.skipped['task']).toBeGreaterThanOrEqual(4);
    expect(res.body.run.stats.imported['task'] ?? 0).toBe(0);
  });

  it('records per-record failures and allows retrying only those', async () => {
    // A mapping that points at an account which is not a member of this org
    // (for example, someone removed after the mapping was saved) must fail
    // that record only — the rest of the import still lands.
    const broken: FixtureIssue[] = [
      { key: 'JIRA-90', summary: 'Fine issue', status: 'To Do' },
      {
        key: 'JIRA-91',
        summary: 'Issue with a stale assignee mapping',
        status: 'To Do',
        assignee: { accountId: 'acc-gone', displayName: 'Departed Person' },
      },
    ];
    setJiraTransportFactory(() => Promise.resolve(fixture(broken)));
    const fresh = await createProject(admin, ctx.orgSlug, 'Retry Target');

    const res = await api<{ run: ImportRun }>(admin, 'POST', url('/imports/jira/run'), {
      credentials: CREDS,
      mapping: {
        ...mappingFor(),
        targetProjectId: fresh.key,
        users: { 'acc-gone': '11111111-1111-4111-8111-111111111111' },
      },
      dryRun: false,
    });
    expect(res.status).toBe(201);
    expect(res.body.run.status).toBe('completed_with_errors');
    expect(res.body.run.stats.failed['task']).toBe(1);
    expect(res.body.run.stats.imported['task']).toBe(1);

    const items = await api<{ items: Array<{ externalId: string; status: string; error: string | null }> }>(
      admin,
      'GET',
      url(`/imports/${res.body.run.id}/items?onlyFailed=true`),
    );
    expect(items.body.items).toHaveLength(1);
    expect(items.body.items[0]!.externalId).toBe('JIRA-91');
    expect(items.body.items[0]!.error).toContain('not a member');
    expect(items.body.items[0]!.error).toBeTruthy();

    // Retry still fails (the data is genuinely invalid) but must not throw
    // away the run or duplicate the record that already succeeded.
    const retry = await api<ImportRun>(admin, 'POST', url(`/imports/${res.body.run.id}/retry`), CREDS);
    expect(retry.status).toBe(200);
    const after = await api<{ items: Array<{ attempts: number }> }>(
      admin,
      'GET',
      url(`/imports/${res.body.run.id}/items?onlyFailed=true`),
    );
    expect(after.body.items[0]!.attempts).toBeGreaterThanOrEqual(2);
  });

  it('honours a mapping that excludes subtasks and comments', async () => {
    setJiraTransportFactory(() => Promise.resolve(fixture(ISSUES)));
    const fresh = await createProject(admin, ctx.orgSlug, 'Lean Import');
    const res = await api<{ run: ImportRun }>(admin, 'POST', url('/imports/jira/run'), {
      credentials: CREDS,
      mapping: {
        ...mappingFor(),
        targetProjectId: fresh.key,
        includeSubtasks: false,
        includeComments: false,
      },
      dryRun: false,
    });
    expect(res.body.run.stats.imported['subtask'] ?? 0).toBe(0);
    expect(res.body.run.stats.imported['comment'] ?? 0).toBe(0);
  });

  it('rejects an empty Jira project', async () => {
    setJiraTransportFactory(() => Promise.resolve(fixture([])));
    const res = await api(admin, 'POST', url('/imports/jira/run'), {
      credentials: CREDS,
      mapping: mappingFor(),
      dryRun: true,
    });
    expect(res.status).toBe(400);
  });

  it('surfaces rejected Jira credentials as a field error', async () => {
    setJiraTransportFactory(() =>
      Promise.resolve({
        get: () =>
          Promise.reject(
            Object.assign(new Error('Jira rejected those credentials'), { statusCode: 400 }),
          ),
      }),
    );
    const res = await api(admin, 'POST', url('/imports/jira/projects'), CREDS);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('requires org admin to import', async () => {
    setJiraTransportFactory(() => Promise.resolve(fixture(ISSUES)));
    const member = await signup('plain@example.com', 'Plain Member');
    const invite = await api<{ inviteUrl: string }>(admin, 'POST', url('/invitations'), {
      email: 'plain@example.com',
      role: 'member',
    });
    await api(member, 'POST', '/api/v1/invitations/accept', {
      token: invite.body.inviteUrl.split('/invite/')[1]!,
    });
    const res = await api(member, 'POST', url('/imports/jira/projects'), CREDS);
    expect(res.status).toBe(403);
  });

  it('records the import in the audit log', async () => {
    const audit = await api<{ items: Array<{ entityType: string; action: string }> }>(
      admin,
      'GET',
      url('/audit'),
    );
    const importEvents = audit.body.items.filter((e) => e.entityType === 'import_run');
    expect(importEvents.some((e) => e.action === 'started')).toBe(true);
    expect(importEvents.some((e) => e.action === 'completed')).toBe(true);
  });
});
