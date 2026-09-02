import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { JiraCredentials, JiraProjectSummary } from '@outcome/shared';
import { ValidationError } from '../../platform/errors.js';
import { logger } from '../../platform/logger.js';

/**
 * Minimal Jira Cloud REST client.
 *
 * The base URL is user-supplied, which makes this the one place in the app
 * that can be pointed at an arbitrary host — so it is also where SSRF is
 * blocked: https only, no credentials in the URL, no redirects, and the
 * resolved address must be a public unicast address.
 */

export interface JiraIssue {
  id: string;
  key: string;
  summary: string;
  description: string;
  issueType: string;
  isSubtask: boolean;
  parentKey: string | null;
  epicKey: string | null;
  statusName: string;
  priorityName: string | null;
  assigneeAccountId: string | null;
  assigneeName: string | null;
  reporterName: string | null;
  labels: string[];
  dueDate: string | null;
  createdAt: string;
  resolvedAt: string | null;
  attachmentCount: number;
  /** Jira issue links, used to seed dependencies where they map cleanly. */
  blockedByKeys: string[];
  comments: Array<{ id: string; author: string; body: string; createdAt: string }>;
}

const PRIVATE_V4 =
  /^(?:10\.|127\.|169\.254\.|192\.168\.|0\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.)/;

/** Reject anything that is not a public https endpoint. */
export async function assertSafeBaseUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('That is not a valid URL', { baseUrl: 'Invalid URL' });
  }
  if (url.protocol !== 'https:') {
    throw new ValidationError('The Jira URL must use https', { baseUrl: 'Must use https' });
  }
  if (url.username || url.password) {
    throw new ValidationError('Remove the credentials from the URL', { baseUrl: 'Invalid URL' });
  }
  if (url.port && url.port !== '443') {
    throw new ValidationError('Only the default https port is allowed', { baseUrl: 'Invalid port' });
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new ValidationError('That host is not reachable from here', { baseUrl: 'Not allowed' });
  }
  const addresses = isIP(host) ? [{ address: host }] : await resolveHost(host);
  for (const { address } of addresses) {
    if (isIP(address) === 4 && PRIVATE_V4.test(address)) {
      throw new ValidationError('That host resolves to a private address', { baseUrl: 'Not allowed' });
    }
    if (isIP(address) === 6 && /^(::1|fc|fd|fe80)/i.test(address)) {
      throw new ValidationError('That host resolves to a private address', { baseUrl: 'Not allowed' });
    }
  }
  return url;
}

async function resolveHost(host: string): Promise<Array<{ address: string }>> {
  try {
    return await lookup(host, { all: true });
  } catch {
    throw new ValidationError('That host could not be resolved', { baseUrl: 'Unknown host' });
  }
}

export interface JiraTransport {
  get(path: string): Promise<unknown>;
}

/** Real HTTP transport. Tests substitute a fixture transport. */
export async function httpTransport(creds: JiraCredentials): Promise<JiraTransport> {
  const base = await assertSafeBaseUrl(creds.baseUrl);
  const auth = Buffer.from(`${creds.email}:${creds.apiToken}`).toString('base64');
  return {
    async get(path: string): Promise<unknown> {
      const target = new URL(path, base);
      if (target.origin !== base.origin) {
        throw new ValidationError('Refusing to follow that path off the Jira host');
      }
      const response = await fetch(target, {
        method: 'GET',
        headers: { authorization: `Basic ${auth}`, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 401 || response.status === 403) {
        throw new ValidationError(
          'Jira rejected those credentials. Check the email and API token.',
          { apiToken: 'Rejected by Jira' },
        );
      }
      if (!response.ok) {
        throw new ValidationError(`Jira returned ${response.status} for ${path}`);
      }
      return response.json();
    },
  };
}

interface JiraSearchResponse {
  issues?: unknown[];
  total?: number;
  startAt?: number;
  maxResults?: number;
}

export class JiraClient {
  constructor(private readonly transport: JiraTransport) {}

  async listProjects(): Promise<JiraProjectSummary[]> {
    const data = (await this.transport.get('/rest/api/3/project/search?maxResults=100')) as {
      values?: Array<{ key?: string; name?: string }>;
    };
    const projects = data.values ?? [];
    const out: JiraProjectSummary[] = [];
    for (const project of projects) {
      if (!project.key) continue;
      out.push({
        key: project.key,
        name: project.name ?? project.key,
        issueCount: await this.countIssues(project.key),
      });
    }
    return out;
  }

  private async countIssues(projectKey: string): Promise<number> {
    const jql = encodeURIComponent(`project = "${projectKey.replace(/"/g, '')}"`);
    const data = (await this.transport.get(
      `/rest/api/3/search?jql=${jql}&maxResults=0`,
    )) as JiraSearchResponse;
    return data.total ?? 0;
  }

  /** Page through every issue in a project, newest last. */
  async listIssues(projectKey: string, pageSize = 50): Promise<JiraIssue[]> {
    const jql = encodeURIComponent(`project = "${projectKey.replace(/"/g, '')}" ORDER BY created ASC`);
    const fields =
      'summary,description,issuetype,parent,status,priority,assignee,reporter,labels,duedate,created,resolutiondate,attachment,issuelinks,comment';
    const issues: JiraIssue[] = [];
    let startAt = 0;

    for (;;) {
      const data = (await this.transport.get(
        `/rest/api/3/search?jql=${jql}&startAt=${startAt}&maxResults=${pageSize}&fields=${fields}`,
      )) as JiraSearchResponse;
      const page = data.issues ?? [];
      for (const raw of page) {
        const parsed = parseIssue(raw);
        if (parsed) issues.push(parsed);
      }
      startAt += page.length;
      const total = data.total ?? issues.length;
      if (page.length === 0 || startAt >= total) break;
      if (issues.length > 10_000) {
        logger.warn({ projectKey }, 'import truncated at 10,000 issues');
        break;
      }
    }
    return issues;
  }
}

/** Jira's document format is rich; flatten it to text rather than lose it. */
export function flattenAdf(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(flattenAdf).join('');
  const obj = node as { type?: string; text?: string; content?: unknown; attrs?: { text?: string } };
  if (obj.type === 'text') return obj.text ?? '';
  if (obj.type === 'hardBreak') return '\n';
  const inner = flattenAdf(obj.content);
  if (obj.type === 'paragraph' || obj.type === 'heading') return `${inner}\n\n`;
  if (obj.type === 'listItem') return `- ${inner}\n`;
  if (obj.type === 'codeBlock') return `\n\`\`\`\n${inner}\n\`\`\`\n`;
  if (obj.type === 'mention') return `@${obj.attrs?.text ?? ''}`;
  return inner;
}

/** Jira fields are untyped JSON; coerce only genuine primitives to text. */
function asString(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

export function parseIssue(raw: unknown): JiraIssue | null {
  const issue = raw as {
    id?: string;
    key?: string;
    fields?: Record<string, unknown>;
  };
  if (!issue.key || !issue.fields) return null;
  const f = issue.fields;

  const issueType = (f['issuetype'] as { name?: string; subtask?: boolean } | undefined) ?? {};
  const parent = f['parent'] as { key?: string; fields?: { issuetype?: { name?: string } } } | undefined;
  const status = (f['status'] as { name?: string } | undefined)?.name ?? 'Unknown';
  const priority = (f['priority'] as { name?: string } | undefined)?.name ?? null;
  const assignee = f['assignee'] as { accountId?: string; displayName?: string } | undefined;
  const reporter = f['reporter'] as { displayName?: string } | undefined;
  const comments = (f['comment'] as { comments?: unknown[] } | undefined)?.comments ?? [];
  const links = (f['issuelinks'] as unknown[] | undefined) ?? [];

  const blockedByKeys: string[] = [];
  for (const link of links) {
    const l = link as {
      type?: { inward?: string; outward?: string };
      inwardIssue?: { key?: string };
      outwardIssue?: { key?: string };
    };
    // "is blocked by" appears as the inward description on the blocked issue.
    if (l.type?.inward?.toLowerCase().includes('blocked by') && l.inwardIssue?.key) {
      blockedByKeys.push(l.inwardIssue.key);
    }
  }

  const isSubtask = issueType.subtask === true;
  const parentIsEpic = parent?.fields?.issuetype?.name?.toLowerCase() === 'epic';

  return {
    id: issue.id ?? issue.key,
    key: issue.key,
    summary: asString(f['summary'], issue.key).slice(0, 300),
    description: flattenAdf(f['description']).trim().slice(0, 50_000),
    issueType: issueType.name ?? 'Task',
    isSubtask,
    parentKey: isSubtask ? (parent?.key ?? null) : null,
    epicKey: parentIsEpic ? (parent?.key ?? null) : null,
    statusName: status,
    priorityName: priority,
    assigneeAccountId: assignee?.accountId ?? null,
    assigneeName: assignee?.displayName ?? null,
    reporterName: reporter?.displayName ?? null,
    labels: ((f['labels'] as string[] | undefined) ?? []).slice(0, 8).map((l) => l.slice(0, 40)),
    dueDate: (f['duedate'] as string | null) ?? null,
    createdAt: asString(f['created'], new Date().toISOString()),
    resolvedAt: (f['resolutiondate'] as string | null) ?? null,
    attachmentCount: ((f['attachment'] as unknown[] | undefined) ?? []).length,
    blockedByKeys,
    comments: comments.slice(0, 200).map((c) => {
      const comment = c as {
        id?: string;
        author?: { displayName?: string };
        body?: unknown;
        created?: string;
      };
      return {
        id: comment.id ?? '',
        author: comment.author?.displayName ?? 'Unknown',
        body: flattenAdf(comment.body).trim().slice(0, 20_000),
        createdAt: comment.created ?? new Date().toISOString(),
      };
    }),
  };
}
