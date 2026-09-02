import {
  assistantAnswerSchema,
  type AssistantAnswer,
  type ProposedAction,
} from '@outcome/shared';

/**
 * Deterministic assistant used by tests and offline development.
 *
 * Like the extraction fake, it does real work against the supplied context
 * rather than returning canned text: it reads the context block, answers the
 * common question shapes with citations, refuses when the data is absent, and
 * proposes (never executes) mutations. That makes the product's guarantees —
 * citations resolve, facts and advice are separate, nothing is applied without
 * confirmation — testable without a network call.
 */

interface ContextTask {
  ref: string;
  title: string;
  status: string;
  assignee: string | null;
  due: string | null;
  priority: string;
  blockedReason: string | null;
  blockedByRefs: string[];
  blocksCount: number;
}

export function parseContext(context: string): ContextTask[] {
  const tasks: ContextTask[] = [];
  for (const line of context.split('\n')) {
    // TASK ATLAS-1 | title | status=... | assignee=... | due=... | priority=... | blocked=... | blockedBy=... | blocks=N
    const match = /^TASK\s+([A-Z][A-Z0-9]*-\d+)\s*\|\s*(.*?)\s*\|\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const fields = new Map<string, string>();
    for (const part of match[3]!.split('|')) {
      const [key, ...rest] = part.split('=');
      if (key) fields.set(key.trim(), rest.join('=').trim());
    }
    const blockedBy = fields.get('blockedBy');
    tasks.push({
      ref: match[1]!,
      title: match[2]!,
      status: fields.get('status') ?? 'unknown',
      assignee: emptyToNull(fields.get('assignee')),
      due: emptyToNull(fields.get('due')),
      priority: fields.get('priority') ?? 'none',
      blockedReason: emptyToNull(fields.get('blocked')),
      blockedByRefs: blockedBy ? blockedBy.split(',').map((r) => r.trim()).filter(Boolean) : [],
      blocksCount: Number(fields.get('blocks') ?? 0),
    });
  }
  return tasks;
}

function emptyToNull(value: string | undefined): string | null {
  if (!value || value === '-' || value === 'none') return null;
  return value;
}

export function answerQuestion(
  question: string,
  context: string,
  today: string,
  askingName: string,
): AssistantAnswer {
  const tasks = parseContext(context);
  const q = question.toLowerCase();
  const facts: AssistantAnswer['facts'] = [];
  const recommendations: string[] = [];
  const proposedActions: ProposedAction[] = [];

  if (tasks.length === 0) {
    return assistantAnswerSchema.parse({
      facts: [],
      recommendations: [],
      cannotAnswer:
        'I cannot see any work you have access to, so I have nothing to answer from.',
      proposedActions: [],
    });
  }

  const open = tasks.filter((t) => t.status !== 'done');
  const blocked = open.filter((t) => t.blockedReason !== null || t.blockedByRefs.length > 0);
  const overdue = open.filter((t) => t.due !== null && t.due < today);
  const mine = open.filter((t) => t.assignee === askingName);

  // "create tasks from these notes" / "add a task"
  if (/\b(create|add|make)\b.*\btask/.test(q)) {
    const title = extractQuoted(question) ?? 'New task from the assistant';
    proposedActions.push(action('create_task', `Create a task "${title}"`, { title, highImpact: false }));
    recommendations.push('Review the proposed task before it is created.');
    return finish(facts, recommendations, null, proposedActions);
  }

  // "what should I work on"
  // "next" only counts as a request for focus in these phrasings — a bare
  // "next" appears in unrelated questions ("next quarter").
  if (/\bwhat should i\b|\bwork on\b|\bmy focus\b|\bwhat'?s next\b|\bnext up\b|\bmy priorit/.test(q)) {
    const ranked = [...mine].sort((a, b) => score(b, today) - score(a, today));
    if (ranked.length === 0) {
      return finish(
        [],
        ['Nothing is assigned to you right now — pick something from the team board.'],
        null,
        [],
      );
    }
    for (const task of ranked.slice(0, 3)) {
      facts.push({
        text: `${task.title} is ${task.status}${task.due ? `, due ${task.due}` : ''}${
          task.blocksCount > 0 ? `, and ${task.blocksCount} other task(s) wait on it` : ''
        }.`,
        refs: [task.ref],
      });
    }
    const top = ranked[0]!;
    recommendations.push(
      top.blockedReason
        ? `Unblock ${top.ref} first — it is stuck on: ${top.blockedReason}`
        : `Start with ${top.ref}; it has the highest combination of deadline and downstream impact.`,
    );
    return finish(facts, recommendations, null, proposedActions);
  }

  // "what is blocking X" / "what's blocked"
  if (/\bblock/.test(q)) {
    if (blocked.length === 0) {
      return finish([{ text: 'Nothing is currently blocked.', refs: [] }], [], null, []);
    }
    for (const task of blocked) {
      const reason = task.blockedReason
        ? task.blockedReason
        : `waiting on ${task.blockedByRefs.join(', ')}`;
      facts.push({ text: `${task.title} is blocked: ${reason}.`, refs: [task.ref, ...task.blockedByRefs] });
    }
    const worst = blocked.reduce((a, b) => (b.blocksCount > a.blocksCount ? b : a));
    if (worst.blocksCount > 0) {
      recommendations.push(
        `Clearing ${worst.ref} would release ${worst.blocksCount} downstream task(s) — it is the highest-leverage unblock.`,
      );
    }
    return finish(facts, recommendations, null, proposedActions);
  }

  // "which tasks are overdue"
  if (/\boverdue|late|past due\b/.test(q)) {
    if (overdue.length === 0) {
      return finish([{ text: 'Nothing is overdue.', refs: [] }], [], null, []);
    }
    for (const task of overdue) {
      facts.push({ text: `${task.title} was due ${task.due}.`, refs: [task.ref] });
    }
    recommendations.push('Re-date or re-assign the overdue items rather than leaving them silently late.');
    return finish(facts, recommendations, null, proposedActions);
  }

  // "who is overloaded"
  if (/\boverload|capacity|workload|busy\b/.test(q)) {
    const byOwner = new Map<string, ContextTask[]>();
    for (const task of open) {
      const owner = task.assignee ?? 'Unassigned';
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), task]);
    }
    const sorted = [...byOwner.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [owner, list] of sorted.slice(0, 5)) {
      facts.push({
        text: `${owner} has ${list.length} open item(s).`,
        refs: list.map((t) => t.ref).slice(0, 10),
      });
    }
    const top = sorted[0];
    if (top && top[0] !== 'Unassigned' && top[1].length >= 3) {
      recommendations.push(`${top[0]} is carrying the most open work; consider redistributing.`);
    }
    return finish(facts, recommendations, null, proposedActions);
  }

  // "which projects are at risk" / "summarize"
  if (/\bat risk|summar|status|how are we|sprint\b/.test(q)) {
    facts.push({
      text: `${open.length} open item(s), ${blocked.length} blocked, ${overdue.length} overdue.`,
      refs: open.slice(0, 10).map((t) => t.ref),
    });
    if (blocked.length > 0) {
      facts.push({
        text: `The blocked work is: ${blocked.map((t) => t.ref).join(', ')}.`,
        refs: blocked.map((t) => t.ref),
      });
    }
    recommendations.push(
      blocked.length > 0 || overdue.length > 0
        ? 'Delivery risk here is queue time, not throughput: resolve the blockers before adding scope.'
        : 'Nothing is blocked or overdue; the main risk is unplanned work arriving.',
    );
    return finish(facts, recommendations, null, proposedActions);
  }

  // "what changed while I was away"
  if (/\bchanged|while i was|catch me up|since\b/.test(q)) {
    facts.push({
      text: `I can see ${tasks.length} item(s) you have access to; ${blocked.length} are blocked and ${overdue.length} are overdue.`,
      refs: tasks.slice(0, 10).map((t) => t.ref),
    });
    return finish(
      facts,
      ['Open the project activity feed for the change-by-change history.'],
      null,
      [],
    );
  }

  // "show me everything dependent on X"
  const refMatch = /\b([A-Z][A-Z0-9]*-\d+)\b/.exec(question);
  if (refMatch && /\bdepend|downstream|waiting on\b/.test(q)) {
    const ref = refMatch[1]!;
    const dependents = tasks.filter((t) => t.blockedByRefs.includes(ref));
    if (dependents.length === 0) {
      return finish([{ text: `Nothing I can see depends on ${ref}.`, refs: [ref] }], [], null, []);
    }
    for (const task of dependents) {
      facts.push({ text: `${task.title} waits on ${ref}.`, refs: [task.ref, ref] });
    }
    return finish(facts, recommendations, null, proposedActions);
  }

  // Anything else: refuse rather than improvise.
  return finish(
    [],
    [],
    `I can answer questions about your tasks, blockers, deadlines, dependencies and workload. I could not tell what "${question.slice(0, 80)}" is asking for.`,
    [],
  );
}

function score(task: ContextTask, today: string): number {
  let value = 0;
  if (task.due) value += task.due < today ? 60 : 20;
  value += task.blocksCount * 12;
  if (task.priority === 'urgent') value += 35;
  if (task.priority === 'high') value += 18;
  if (task.blockedReason) value -= 25;
  return value;
}

function extractQuoted(text: string): string | null {
  const quoted = /["“']([^"”']{3,200})["”']/.exec(text);
  if (quoted) return quoted[1]!;
  const after = /\b(?:task|todo)\s+(?:called|named|for|to)\s+(.{3,120})$/i.exec(text.trim());
  return after ? after[1]!.replace(/[.?!]$/, '') : null;
}

function action(
  tool: ProposedAction['tool'],
  description: string,
  overrides: Partial<ProposedAction>,
): ProposedAction {
  return {
    tool,
    description,
    targetRef: null,
    title: null,
    body: null,
    assigneeName: null,
    priority: null,
    dueDate: null,
    blockingRef: null,
    highImpact: true,
    ...overrides,
  };
}

function finish(
  facts: AssistantAnswer['facts'],
  recommendations: string[],
  cannotAnswer: string | null,
  proposedActions: ProposedAction[],
): AssistantAnswer {
  return assistantAnswerSchema.parse({ facts, recommendations, cannotAnswer, proposedActions });
}
