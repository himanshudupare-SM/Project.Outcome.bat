import {
  assistantAnswerSchema,
  proposedActionSchema,
  type AskAssistantInput,
  type AssistantCitation,
  type AssistantReply,
  type ProposedAction,
} from '@outcome/shared';
import { orgDb, withOrg, type Queryable } from '../../platform/db.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from '../../platform/errors.js';
import { config } from '../../platform/config.js';
import { logger } from '../../platform/logger.js';
import type { OrgCtx } from '../../platform/ctx.js';
import { requireProjectRole } from '../auth/policy.js';
import { recordEvent } from '../activity/service.js';
import { resolveProject } from '../../http/context.js';
import * as tasksService from '../tasks/service.js';
import * as commentsService from '../comments/service.js';
import { aiProvider } from './index.js';
import { recordAiAction } from './braindump.js';
import {
  ASSISTANT_PROMPT_VERSION,
  assistantSchema,
  assistantSystem,
  assistantUser,
} from './prompts/assistant.js';

const CONTEXT_LIMIT = 120;

interface ContextRow {
  id: string;
  ref: string;
  project_key: string;
  number: number;
  title: string;
  status_name: string;
  category: string;
  assignee: string | null;
  due_date: string | null;
  priority: string;
  blocked_reason: string | null;
  blocked_by_refs: string[] | null;
  blocks_count: number;
}

/**
 * Build the assistant's context.
 *
 * Every row here is filtered by the same visibility rules the API uses, so
 * the assistant cannot describe a project the asker cannot open. Task content
 * is rendered as delimited data lines, never as prose that could read as
 * instructions.
 */
async function loadContext(
  ctx: OrgCtx,
  projectId: string | null,
): Promise<{ rows: ContextRow[]; rendered: string }> {
  const params: unknown[] = [ctx.orgId];
  const where = ['t.org_id = $1', 't.deleted_at IS NULL', 'p.deleted_at IS NULL'];
  if (projectId) {
    params.push(projectId);
    where.push(`t.project_id = $${params.length}`);
  }
  if (ctx.orgRole === 'member') {
    params.push(ctx.userId);
    where.push(
      `EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = t.project_id AND pm.user_id = $${params.length})`,
    );
  }

  const { rows } = await orgDb(ctx.orgId).query<ContextRow>(
    `SELECT t.id, p.key || '-' || t.number AS ref, p.key AS project_key, t.number, t.title,
            s.name AS status_name, s.category, u.name AS assignee, t.due_date, t.priority,
            (SELECT b.reason FROM blockers b
              WHERE b.task_id = t.id AND b.resolved_at IS NULL
              ORDER BY b.created_at LIMIT 1) AS blocked_reason,
            (SELECT array_agg(bp.key || '-' || bt.number)
               FROM task_dependencies d
               JOIN tasks bt ON bt.id = d.blocking_task_id AND bt.deleted_at IS NULL
               JOIN projects bp ON bp.id = bt.project_id
               JOIN statuses bs ON bs.id = bt.status_id AND bs.category <> 'done'
              WHERE d.blocked_task_id = t.id) AS blocked_by_refs,
            (SELECT count(*)::int FROM task_dependencies d2 WHERE d2.blocking_task_id = t.id) AS blocks_count
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       JOIN statuses s ON s.id = t.status_id
       LEFT JOIN users u ON u.id = t.assignee_id
      WHERE ${where.join(' AND ')}
      ORDER BY (s.category = 'done'), t.updated_at DESC
      LIMIT ${CONTEXT_LIMIT}`,
    params,
  );

  const rendered = rows
    .map((r) =>
      [
        `TASK ${r.ref}`,
        r.title.replace(/[|\n]/g, ' '),
        `status=${r.category}`,
        `assignee=${r.assignee ?? '-'}`,
        `due=${r.due_date ?? '-'}`,
        `priority=${r.priority}`,
        `blocked=${(r.blocked_reason ?? '-').replace(/[|\n]/g, ' ')}`,
        `blockedBy=${(r.blocked_by_refs ?? []).join(',')}`,
        `blocks=${r.blocks_count}`,
      ].join(' | '),
    )
    .join('\n');

  return { rows, rendered };
}

export async function ask(ctx: OrgCtx, input: AskAssistantInput): Promise<AssistantReply> {
  // Assistant calls share the org's daily AI budget.
  const { rows: usage } = await orgDb(ctx.orgId).query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ai_messages m
       JOIN ai_conversations c ON c.id = m.conversation_id
      WHERE c.org_id = $1 AND m.role = 'user' AND m.created_at > now() - interval '1 day'`,
    [ctx.orgId],
  );
  if ((usage[0]?.n ?? 0) >= config().AI_DAILY_CALL_BUDGET) {
    throw new RateLimitedError("This organization has reached today's AI limit.");
  }

  let projectId: string | null = null;
  let scope = 'every project you can access';
  if (input.projectId) {
    const project = await resolveProject(ctx, input.projectId);
    requireProjectRole(ctx, project.role, 'viewer');
    projectId = project.id;
    scope = `project ${project.key}`;
  }

  const { rows: contextRows, rendered } = await loadContext(ctx, projectId);
  const { rows: users } = await orgDb(ctx.orgId).query<{ name: string }>(
    'SELECT name FROM users WHERE id = $1',
    [ctx.userId],
  );

  const provider = aiProvider();
  const response = await provider.structured({
    promptVersion: ASSISTANT_PROMPT_VERSION,
    task: 'assistant',
    system: assistantSystem,
    user: assistantUser({
      question: input.question,
      today: new Date().toISOString().slice(0, 10),
      userName: users[0]?.name ?? '',
      scope,
      context: rendered,
    }),
    schema: assistantSchema,
  });

  const answer = assistantAnswerSchema.parse(response.value);

  // Citations are verified against the context the caller was allowed to see;
  // a reference the model invented (or lifted from elsewhere) is dropped.
  const allowed = new Map(contextRows.map((r) => [r.ref.toUpperCase(), r]));
  const citedRefs = new Set<string>();
  const cleanedFacts = answer.facts.map((fact) => {
    const refs = fact.refs.filter((ref) => allowed.has(ref.toUpperCase()));
    for (const ref of refs) citedRefs.add(ref.toUpperCase());
    return { text: fact.text, refs };
  });
  const citations: AssistantCitation[] = [...citedRefs].map((ref) => {
    const row = allowed.get(ref)!;
    return {
      ref: row.ref,
      taskId: row.id,
      title: row.title,
      projectKey: row.project_key,
      number: row.number,
      statusName: row.status_name,
    };
  });

  // Actions are stored as proposals. Nothing is applied here.
  const actions = answer.proposedActions
    .map((raw) => proposedActionSchema.parse(raw))
    .filter((action) => action.targetRef === null || allowed.has(action.targetRef.toUpperCase()));

  const stored = await withOrg(ctx.orgId, async (tx) => {
    const conversationId = await ensureConversation(tx, ctx, input.conversationId ?? null, input.question);
    await tx.query(
      `INSERT INTO ai_messages (conversation_id, role, content) VALUES ($1, 'user', $2)`,
      [conversationId, JSON.stringify({ text: input.question, projectId })],
    );
    const { rows: messageRows } = await tx.query<{ id: string }>(
      `INSERT INTO ai_messages (conversation_id, role, content) VALUES ($1, 'assistant', $2)
       RETURNING id`,
      [
        conversationId,
        JSON.stringify({
          facts: cleanedFacts,
          recommendations: answer.recommendations,
          cannotAnswer: answer.cannotAnswer,
          citations,
          model: response.model,
          promptVersion: ASSISTANT_PROMPT_VERSION,
        }),
      ],
    );
    const actionRows: AssistantReply['actions'] = [];
    for (const action of actions) {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO ai_actions (org_id, conversation_id, user_id, tool, input, status)
         VALUES ($1, $2, $3, $4, $5, 'proposed') RETURNING id`,
        [
          ctx.orgId,
          conversationId,
          ctx.userId,
          action.tool,
          // scopeProjectId is set by the server from the ask's scope, never by
          // the model, so a create has somewhere to land.
          JSON.stringify({ ...action, scopeProjectId: projectId }),
        ],
      );
      actionRows.push({ id: rows[0]!.id, action, status: 'proposed' });
    }
    await tx.query('UPDATE ai_conversations SET updated_at = now() WHERE id = $1', [conversationId]);
    return { conversationId, messageId: messageRows[0]!.id, actionRows };
  });

  return {
    conversationId: stored.conversationId,
    messageId: stored.messageId,
    answer: { ...answer, facts: cleanedFacts, proposedActions: actions },
    citations,
    actions: stored.actionRows,
    model: response.model,
    promptVersion: ASSISTANT_PROMPT_VERSION,
  };
}

async function ensureConversation(
  tx: Queryable,
  ctx: OrgCtx,
  conversationId: string | null,
  firstQuestion: string,
): Promise<string> {
  if (conversationId) {
    const { rows } = await tx.query<{ id: string; user_id: string }>(
      'SELECT id, user_id FROM ai_conversations WHERE id = $1 AND org_id = $2',
      [conversationId, ctx.orgId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('Conversation');
    // A conversation is personal, like a brain dump.
    if (row.user_id !== ctx.userId) throw new ForbiddenError('That conversation belongs to someone else');
    return row.id;
  }
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO ai_conversations (org_id, user_id, title) VALUES ($1, $2, $3) RETURNING id`,
    [ctx.orgId, ctx.userId, firstQuestion.slice(0, 120)],
  );
  return rows[0]!.id;
}

/**
 * Apply a proposed action, only on explicit confirmation, only by the user it
 * was proposed to, and only through the normal permission-checked services.
 */
export async function confirmAction(
  ctx: OrgCtx,
  actionId: string,
): Promise<{ status: 'executed'; result: Record<string, unknown> }> {
  const { rows } = await orgDb(ctx.orgId).query<{
    id: string;
    user_id: string;
    tool: string;
    input: unknown;
    status: string;
    conversation_id: string | null;
  }>(
    `SELECT id, user_id, tool, input, status, conversation_id
       FROM ai_actions WHERE id = $1 AND org_id = $2`,
    [actionId, ctx.orgId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError('Proposed action');
  if (row.user_id !== ctx.userId) {
    throw new ForbiddenError('Only the person who asked can confirm this action');
  }
  if (row.status !== 'proposed') {
    throw new ConflictError(`That action was already ${row.status}`);
  }

  const action = proposedActionSchema.parse(row.input);
  const scopeProjectId =
    typeof (row.input as { scopeProjectId?: unknown }).scopeProjectId === 'string'
      ? ((row.input as { scopeProjectId: string }).scopeProjectId)
      : null;
  let result: Record<string, unknown>;
  try {
    result = await execute(ctx, action, scopeProjectId);
  } catch (err) {
    await withOrg(ctx.orgId, async (tx) => {
      await tx.query(
        `UPDATE ai_actions SET status = 'failed', result = $2 WHERE id = $1`,
        [actionId, JSON.stringify({ error: (err as Error).message })],
      );
    });
    throw err;
  }

  await withOrg(ctx.orgId, async (tx) => {
    await tx.query(
      `UPDATE ai_actions SET status = 'executed', result = $2, executed_at = now() WHERE id = $1`,
      [actionId, JSON.stringify(result)],
    );
    await recordEvent(tx, {
      orgId: ctx.orgId,
      actorType: 'ai',
      actorId: ctx.userId,
      entityType: 'ai_action',
      entityId: actionId,
      taskId: typeof result['taskId'] === 'string' ? result['taskId'] : null,
      action: 'executed',
      data: { tool: action.tool, description: action.description, confirmedBy: ctx.userId },
    });
    await recordAiAction(tx, {
      orgId: ctx.orgId,
      conversationId: row.conversation_id,
      userId: ctx.userId,
      tool: action.tool,
      input: action,
      result,
    });
  });
  logger.info({ actionId, tool: action.tool, userId: ctx.userId }, 'ai action confirmed');
  return { status: 'executed', result };
}

export async function rejectAction(ctx: OrgCtx, actionId: string): Promise<void> {
  const { rowCount } = await orgDb(ctx.orgId).query(
    `UPDATE ai_actions SET status = 'rejected'
      WHERE id = $1 AND org_id = $2 AND user_id = $3 AND status = 'proposed'`,
    [actionId, ctx.orgId, ctx.userId],
  );
  if (rowCount === 0) throw new NotFoundError('Proposed action');
}

/** Resolve a task ref the caller can actually read, or 404. */
async function resolveRef(ctx: OrgCtx, ref: string): Promise<{ id: string; projectId: string }> {
  const match = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(ref.trim());
  if (!match) throw new ValidationError(`"${ref}" is not a task reference`);
  const project = await resolveProject(ctx, match[1]!);
  const { rows } = await orgDb(ctx.orgId).query<{ id: string }>(
    'SELECT id FROM tasks WHERE project_id = $1 AND number = $2 AND deleted_at IS NULL',
    [project.id, Number(match[2])],
  );
  const id = rows[0]?.id;
  if (!id) throw new NotFoundError(`Task ${ref}`);
  return { id, projectId: project.id };
}

async function resolveAssignee(ctx: OrgCtx, name: string): Promise<string> {
  const { rows } = await orgDb(ctx.orgId).query<{ id: string }>(
    `SELECT u.id FROM org_members m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1 AND u.deleted_at IS NULL
        AND (lower(u.name) = lower($2) OR lower(split_part(u.name, ' ', 1)) = lower($2)
             OR lower(u.email) = lower($2))`,
    [ctx.orgId, name],
  );
  if (rows.length !== 1) {
    throw new ValidationError(
      rows.length === 0 ? `No member matches "${name}"` : `"${name}" matches more than one member`,
    );
  }
  return rows[0]!.id;
}

/**
 * Decide which project a create lands in: the reference the model gave, else
 * the scope the question was asked in, else the caller's only project. If it
 * is still ambiguous, refuse rather than pick one.
 */
async function resolveTargetProject(
  ctx: OrgCtx,
  action: ProposedAction,
  scopeProjectId: string | null,
): Promise<{ id: string; key: string; role: 'lead' | 'member' | 'viewer' | null }> {
  const fromRef = action.targetRef?.split('-')[0];
  if (fromRef) return resolveProject(ctx, fromRef);
  if (scopeProjectId) return resolveProject(ctx, scopeProjectId);

  // Only bind the user parameter when the visibility clause actually uses it;
  // Postgres rejects a statement given more parameters than it references.
  const params: unknown[] = [ctx.orgId];
  let visibility = '';
  if (ctx.orgRole === 'member') {
    params.push(ctx.userId);
    visibility = `AND EXISTS (SELECT 1 FROM project_members pm
                               WHERE pm.project_id = p.id AND pm.user_id = $${params.length})`;
  }
  const { rows } = await orgDb(ctx.orgId).query<{ key: string }>(
    `SELECT p.key FROM projects p
      WHERE p.org_id = $1 AND p.deleted_at IS NULL AND p.state = 'active' ${visibility}
      LIMIT 2`,
    params,
  );
  if (rows.length === 1) return resolveProject(ctx, rows[0]!.key);
  throw new ValidationError(
    'Which project should this go in? Ask again with a project selected.',
  );
}

async function execute(
  ctx: OrgCtx,
  action: ProposedAction,
  scopeProjectId: string | null,
): Promise<Record<string, unknown>> {
  switch (action.tool) {
    case 'create_task': {
      if (!action.title) throw new ValidationError('That action has no task title');
      const project = await resolveTargetProject(ctx, action, scopeProjectId);
      const task = await tasksService.createTask(
        ctx,
        project,
        {
          title: action.title,
          description: action.body ?? '',
          priority: action.priority ?? 'none',
          assigneeId: action.assigneeName ? await resolveAssignee(ctx, action.assigneeName) : null,
          dueDate: action.dueDate ?? null,
          estimateDays: null,
          epicId: null,
          parentId: null,
          labelIds: [],
        },
        { source: 'ai' },
      );
      return { taskId: task.id, ref: task.ref };
    }
    case 'update_task': {
      if (!action.targetRef) throw new ValidationError('That action has no target task');
      const { id } = await resolveRef(ctx, action.targetRef);
      const task = await tasksService.updateTask(ctx, id, {
        ...(action.title ? { title: action.title } : {}),
        ...(action.dueDate ? { dueDate: action.dueDate } : {}),
        ...(action.body ? { description: action.body } : {}),
      });
      return { taskId: task.id, ref: task.ref };
    }
    case 'assign_task': {
      if (!action.targetRef || !action.assigneeName) {
        throw new ValidationError('That action is missing the task or the person');
      }
      const { id } = await resolveRef(ctx, action.targetRef);
      const assigneeId = await resolveAssignee(ctx, action.assigneeName);
      const task = await tasksService.updateTask(ctx, id, { assigneeId });
      return { taskId: task.id, ref: task.ref, assigneeId };
    }
    case 'set_priority': {
      if (!action.targetRef || !action.priority) {
        throw new ValidationError('That action is missing the task or the priority');
      }
      const { id } = await resolveRef(ctx, action.targetRef);
      const task = await tasksService.updateTask(ctx, id, { priority: action.priority });
      return { taskId: task.id, ref: task.ref, priority: action.priority };
    }
    case 'add_comment': {
      if (!action.targetRef || !action.body) {
        throw new ValidationError('That action is missing the task or the comment');
      }
      const { id } = await resolveRef(ctx, action.targetRef);
      const comment = await commentsService.create(ctx, id, { body: action.body });
      return { taskId: id, commentId: comment.id };
    }
    case 'create_dependency': {
      if (!action.targetRef || !action.blockingRef) {
        throw new ValidationError('That action is missing one end of the dependency');
      }
      const blocked = await resolveRef(ctx, action.targetRef);
      const blocking = await resolveRef(ctx, action.blockingRef);
      await tasksService.addDependency(ctx, blocked.id, blocking.id);
      return { blockedTaskId: blocked.id, blockingTaskId: blocking.id };
    }
    default: {
      const exhaustive: never = action.tool;
      throw new ValidationError(`Unsupported action ${String(exhaustive)}`);
    }
  }
}

export async function listConversations(ctx: OrgCtx) {
  const { rows } = await orgDb(ctx.orgId).query<{
    id: string;
    title: string;
    updated_at: string;
  }>(
    `SELECT id, title, updated_at FROM ai_conversations
      WHERE org_id = $1 AND user_id = $2 ORDER BY updated_at DESC LIMIT 20`,
    [ctx.orgId, ctx.userId],
  );
  return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at }));
}

export async function getConversation(ctx: OrgCtx, id: string) {
  const { rows: conv } = await orgDb(ctx.orgId).query<{ id: string; user_id: string; title: string }>(
    'SELECT id, user_id, title FROM ai_conversations WHERE id = $1 AND org_id = $2',
    [id, ctx.orgId],
  );
  const row = conv[0];
  if (!row) throw new NotFoundError('Conversation');
  if (row.user_id !== ctx.userId) throw new ForbiddenError('That conversation belongs to someone else');

  const { rows: messages } = await orgDb(ctx.orgId).query<{
    id: string;
    role: string;
    content: Record<string, unknown>;
    created_at: string;
  }>(
    'SELECT id, role, content, created_at FROM ai_messages WHERE conversation_id = $1 ORDER BY created_at',
    [id],
  );
  return { id: row.id, title: row.title, messages };
}
