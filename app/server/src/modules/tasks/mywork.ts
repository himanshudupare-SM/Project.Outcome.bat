import type { Task } from '@outcome/shared';
import { listTasks } from './service.js';
import type { OrgCtx } from '../../platform/ctx.js';
import { db, orgDb } from '../../platform/db.js';

export interface RankedTask {
  task: Task;
  score: number;
  reasons: string[];
}

export interface MyWork {
  now: RankedTask[];
  dueSoon: Task[];
  blockedByMe: Task[];
  waitingOnOthers: Task[];
  mentioned: Task[];
}

/**
 * Prioritization for "My Work". Deliberately explainable: each contributing
 * factor adds a score and a human-readable reason, so the UI can always say
 * *why* something is at the top. Not an LLM call — a ranking function whose
 * inputs (due dates, unblocking impact, staleness) are auditable.
 */
export async function myWork(ctx: OrgCtx): Promise<MyWork> {
  const assigned = await listTasks(
    ctx,
    { assigneeId: 'me', parent: 'all', limit: 200 } as never,
    null,
  );
  const open = assigned.items.filter((t) => t.statusCategory !== 'done');

  // How many open tasks each of my tasks unblocks (transitively).
  const ids = open.map((t) => t.id);
  const downstream = new Map<string, number>();
  if (ids.length > 0) {
    const { rows } = await orgDb(ctx.orgId).query<{ id: string; n: number }>(
      `WITH RECURSIVE seed(root, id) AS (
         SELECT d.blocking_task_id, d.blocked_task_id
           FROM task_dependencies d WHERE d.blocking_task_id = ANY($1::uuid[])
         UNION
         SELECT s.root, d.blocked_task_id
           FROM task_dependencies d JOIN seed s ON d.blocking_task_id = s.id
       )
       SELECT seed.root AS id, count(DISTINCT seed.id)::int AS n
         FROM seed
         JOIN tasks t ON t.id = seed.id AND t.deleted_at IS NULL
         JOIN statuses s ON s.id = t.status_id AND s.category <> 'done'
        GROUP BY seed.root`,
      [ids],
    );
    for (const r of rows) downstream.set(r.id, r.n);
  }

  const today = new Date().toISOString().slice(0, 10);
  const ranked: RankedTask[] = open.map((task) => {
    let score = 0;
    const reasons: string[] = [];

    if (task.dueDate) {
      const days = Math.round(
        (new Date(task.dueDate).getTime() - new Date(today).getTime()) / 86_400_000,
      );
      if (days < 0) {
        score += 60;
        reasons.push(`overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}`);
      } else if (days === 0) {
        score += 45;
        reasons.push('due today');
      } else if (days <= 3) {
        score += 30;
        reasons.push(`due in ${days} day${days === 1 ? '' : 's'}`);
      } else if (days <= 7) {
        score += 12;
        reasons.push('due this week');
      }
    }

    const unblocks = downstream.get(task.id) ?? 0;
    if (unblocks > 0) {
      score += Math.min(40, 12 * unblocks);
      reasons.push(`unblocks ${unblocks} task${unblocks === 1 ? '' : 's'}`);
    }

    if (task.priority === 'urgent') {
      score += 35;
      reasons.push('urgent priority');
    } else if (task.priority === 'high') {
      score += 18;
      reasons.push('high priority');
    }

    if (task.statusCategory === 'in_progress') {
      score += 10;
      reasons.push('already in progress');
    }
    // Things I cannot act on shouldn't lead the list.
    if (task.openBlockerCount > 0) {
      score -= 25;
      reasons.push('blocked — needs unblocking first');
    }
    if (task.blockedByOpenCount > 0) {
      score -= 20;
      reasons.push(`waiting on ${task.blockedByOpenCount} upstream task${task.blockedByOpenCount === 1 ? '' : 's'}`);
    }
    if (reasons.length === 0) reasons.push('assigned to you');
    return { task, score, reasons };
  });

  ranked.sort((a, b) => b.score - a.score || a.task.ref.localeCompare(b.task.ref));

  // Tasks I own that block someone else's work — the highest-leverage list.
  const blockedByMe = open.filter((t) => (downstream.get(t.id) ?? 0) > 0);

  const mentionedTasks = await mentioned(ctx);

  return {
    now: ranked.slice(0, 5),
    dueSoon: open
      .filter((t) => t.dueDate && t.dueDate <= addDays(today, 7))
      .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '')),
    blockedByMe,
    waitingOnOthers: open.filter((t) => t.openBlockerCount > 0 || t.blockedByOpenCount > 0),
    mentioned: mentionedTasks,
  };
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function mentioned(ctx: OrgCtx): Promise<Task[]> {
  const { rows } = await orgDb(ctx.orgId).query<{ task_id: string }>(
    `SELECT DISTINCT task_id FROM notifications
      WHERE org_id = $1 AND user_id = $2 AND type = 'comment.mentioned'
        AND task_id IS NOT NULL AND created_at > now() - interval '30 days'
      LIMIT 20`,
    [ctx.orgId, ctx.userId],
  );
  if (rows.length === 0) return [];
  const all = await listTasks(ctx, { parent: 'all', limit: 200 } as never, null);
  const wanted = new Set(rows.map((r) => r.task_id));
  return all.items.filter((t) => wanted.has(t.id));
}
