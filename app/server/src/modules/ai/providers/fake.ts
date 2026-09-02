import type * as z from 'zod/v4';
import {
  extractionResultSchema,
  type ClarifyingQuestion,
  type Confidence,
  type ExtractionResult,
  type ProposedTask,
} from '@outcome/shared';
import type { AiProvider, StructuredRequest, StructuredResponse } from '../provider.js';

/**
 * Deterministic local provider.
 *
 * This is NOT a stub that returns canned data: it does real (rule-based)
 * extraction, so the whole brain-dump pipeline — grouping, dependencies,
 * blockers, confidence marking, clarifying questions — can be exercised in
 * tests and offline development without a network call or an API key.
 *
 * It is deliberately conservative: anything it cannot justify from the text
 * is left null and raised as a question, which is exactly the behaviour the
 * product requires of the real model.
 */
export class FakeProvider implements AiProvider {
  readonly name = 'fake';
  readonly model = 'fake-deterministic-v1';

  async structured<T extends z.ZodTypeAny>(
    req: StructuredRequest<T>,
  ): Promise<StructuredResponse<z.infer<T>>> {
    if (req.task !== 'braindump') {
      throw new Error(`fake provider does not implement task "${req.task}"`);
    }
    const text = extractPayload(req.user);
    const result = extract(text, extractExistingRefs(req.user));
    // Validate through the same schema the real provider is held to.
    const value = extractionResultSchema.parse(result) as z.infer<T>;
    return {
      value,
      model: this.model,
      inputTokens: Math.ceil(req.user.length / 4),
      outputTokens: Math.ceil(JSON.stringify(value).length / 4),
      attempts: 1,
    };
  }
}

/**
 * The prompt wraps the user's text in a delimited block; pull it back out.
 * Uses the LAST opening delimiter so prose that merely names the tag cannot
 * be swept into the payload.
 */
function extractPayload(user: string): string {
  const open = user.lastIndexOf('<braindump>');
  const close = user.lastIndexOf('</braindump>');
  if (open === -1 || close <= open) return user.trim();
  return user.slice(open + '<braindump>'.length, close).trim();
}

function extractExistingRefs(user: string): Array<{ ref: string; title: string }> {
  const block = /<existing_tasks>([\s\S]*?)<\/existing_tasks>/.exec(user)?.[1] ?? '';
  const out: Array<{ ref: string; title: string }> = [];
  for (const line of block.split('\n')) {
    const m = /^\s*-\s*([A-Z][A-Z0-9]*-\d+):\s*(.+?)\s*$/.exec(line);
    if (m) out.push({ ref: m[1]!, title: m[2]! });
  }
  return out;
}

const PRIORITY_SIGNALS: Array<{ re: RegExp; value: 'urgent' | 'high' | 'medium' | 'low' }> = [
  { re: /\b(asap|urgent|critical|immediately|drop everything|blocker for launch)\b/i, value: 'urgent' },
  { re: /\b(important|high priority|priority|must (?:be )?(?:done|ship)|needs to (?:be )?(?:done|ship))\b/i, value: 'high' },
  {
    re: /\b(nice to have|low priority|eventually|when there(?:'s| is) time|if there(?:'s| is) time|someday)\b/i,
    value: 'low',
  },
];

const BLOCKER_SIGNALS =
  /\b(blocked|blocking|can'?t (?:start|proceed|continue)|waiting (?:on|for)|stuck (?:on|behind)|held up)\b/i;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const ACTION_VERBS = [
  'add','approve','ask','audit','build','call','chase','check','clean up','close','confirm','create',
  'delete','deploy','design','document','draft','email','escalate','estimate','finish','fix','follow up',
  'follow-up','get','groom','hand over','handle','investigate','kick off','land','merge','migrate','move',
  'open','plan','prepare','prioritise','prioritize','publish','refactor','release','remove','renew',
  'replace','research','review','revert','roll out','rotate','run','schedule','scope','send','set up',
  'setup','ship','sort out','spec','split','sync','test','unblock','update','upgrade','validate','verify',
  'wire up','write',
];

const verbPatterns = new Map<string, RegExp>();

/**
 * Matches a verb and its common inflections, including doubled-consonant
 * gerunds ("run" -> "running", "ship" -> "shipping").
 */
function verbPattern(verb: string): RegExp {
  const cached = verbPatterns.get(verb);
  if (cached) return cached;
  const last = verb.at(-1) ?? '';
  const doubled = /[bdgmnprt]$/.test(last) ? `|${last}ing|${last}ed` : '';
  const pattern = new RegExp(`\\b${verb}(?:s|es|d|ed|ing${doubled})?\\b`);
  verbPatterns.set(verb, pattern);
  return pattern;
}

interface Clause {
  text: string;
  /** 'after' = this depends on the previous clause. */
  link: 'after' | null;
}

/** True when a fragment reads like work someone has to do. */
function looksActionable(clause: string): boolean {
  const lower = clause.toLowerCase().trim();
  if (lower.length < 6) return false;
  if (ACTION_VERBS.some((verb) => verbPattern(verb).test(lower))) return true;
  // A fragment naming a deadline or a blocker is work even without a verb.
  return BLOCKER_SIGNALS.test(clause) || /\b(due|by)\s+\w/i.test(clause);
}

/**
 * Split a dump into candidate task clauses.
 *
 * Two passes: list conjunctions ("A, B and C") separate parallel work, then
 * ordering words ("A before B", "once A, B") separate sequential work and
 * record which way the dependency points.
 */
function splitClauses(text: string): Clause[] {
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const clauses: Clause[] = [];
  for (const sentence of sentences) {
    for (const listPart of splitList(sentence)) {
      clauses.push(...splitOrdering(listPart));
    }
  }
  return clauses;
}

/** "I need to do A, ask B and review C" -> three fragments. */
function splitList(sentence: string): string[] {
  const parts = sentence
    .split(/,\s*(?:and\s+|also\s+)?|\s+and then\s+|\s+and also\s+|\s+and\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 1) return [sentence];

  // Only treat a split as real when both sides are themselves work. A
  // non-actionable fragment is glued to its neighbour rather than becoming a
  // bogus task: backwards for a trailing object ("the deck and the notes"),
  // forwards for a leading preamble ("Once that is done, run the tests").
  const out: string[] = [];
  let carry = '';
  for (const [index, part] of parts.entries()) {
    const fragment = carry ? `${carry}, ${part}` : part;
    carry = '';
    if (looksActionable(fragment)) {
      out.push(fragment);
      continue;
    }
    const previous = out[out.length - 1];
    const isLast = index === parts.length - 1;
    if (previous !== undefined && isLast) {
      out[out.length - 1] = `${previous} and ${fragment}`;
    } else if (isLast) {
      out.push(fragment);
    } else {
      carry = fragment;
    }
  }
  if (carry) out.push(carry);
  return out;
}

/** "write the script before running the backfill" -> two ordered fragments. */
function splitOrdering(fragment: string): Clause[] {
  // "Once that is done, run the load tests" — the preamble is a back-reference
  // to the previous task, so drop it and carry the link instead.
  const preamble = /^\s*(once|after|then|when)\b([^,]{0,60}),\s*(.+)$/i.exec(fragment);
  if (preamble) {
    const head = `${preamble[1]!}${preamble[2]!}`;
    const tail = preamble[3]!.trim();
    if (!looksActionable(head) && looksActionable(tail)) {
      return [{ text: tail, link: 'after' }];
    }
  }
  const match = /^(.*?)\s+\b(before|after|once|then|until)\b\s+(.*)$/i.exec(fragment);
  if (!match) return [{ text: fragment, link: null }];

  const left = match[1]!.trim();
  const word = match[2]!.toLowerCase();
  const right = match[3]!.trim();

  // "before Friday", "until the credentials arrive" — the tail is a date or a
  // condition, not a second piece of work. Leave the fragment whole.
  if (!looksActionable(left) || !looksActionable(right)) {
    return [{ text: fragment, link: null }];
  }
  if (word === 'after' || word === 'once' || word === 'until') {
    // "A after B": B happens first, so emit it first and link A to it.
    return [
      { text: right, link: null },
      { text: left, link: 'after' },
    ];
  }
  // "A before B" and "A then B" are already in execution order.
  return [
    { text: left, link: null },
    { text: right, link: 'after' },
  ];
}

function titleFrom(clause: string): string {
  const FILLER =
    /^\s*(?:and|also|then|next|ok(?:ay)?|so|first|finally|i\s+(?:need|have|want|must|should)\s+to|i(?:'| a)?m going to|we\s+(?:need|should|have)\s+to|we\s+want\s+to|todo:?|to\s+do:?)\s*/i;
  let title = clause;
  // Strip stacked filler ("Ok so I need to ...") until nothing matches.
  for (let i = 0; i < 5 && FILLER.test(title); i++) title = title.replace(FILLER, '');
  title = title.replace(/\s*[.;]$/, '').trim();
  // Drop trailing schedule/blocker context; those become fields, not titles.
  title = title
    .replace(/\s*[—-]\s*(?:blocked|waiting|due|by)\b.*$/i, '')
    .replace(/\s*\b(?:which|that)\s+is\s+blocked\b.*$/i, '')
    .trim();
  if (title.length > 0) title = title[0]!.toUpperCase() + title.slice(1);
  return title.slice(0, 300);
}

/** Resolve relative dates against the caller's "today" — never invent one. */
function resolveDate(clause: string, today: string): { value: string; confidence: Confidence } | null {
  const base = new Date(`${today}T00:00:00Z`);
  const iso = (d: Date): string => d.toISOString().slice(0, 10);

  const explicit = /\b(\d{4}-\d{2}-\d{2})\b/.exec(clause);
  if (explicit) return { value: explicit[1]!, confidence: 'high' };

  if (/\btoday\b/i.test(clause)) return { value: iso(base), confidence: 'high' };
  if (/\btomorrow\b/i.test(clause)) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + 1);
    return { value: iso(d), confidence: 'high' };
  }
  const inDays = /\bin (\d{1,2}) days?\b/i.exec(clause);
  if (inDays) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + Number(inDays[1]));
    return { value: iso(d), confidence: 'high' };
  }
  const weekday = new RegExp(`\\b(?:by|before|on|due)\\s+(${WEEKDAYS.join('|')})\\b`, 'i').exec(clause);
  if (weekday) {
    const target = WEEKDAYS.indexOf(weekday[1]!.toLowerCase());
    const d = new Date(base);
    const delta = (target - d.getUTCDay() + 7) % 7 || 7;
    d.setUTCDate(d.getUTCDate() + delta);
    // A bare weekday is ambiguous (this week or next?) — mark it low so the
    // reviewer is asked instead of being handed a guess.
    return { value: iso(d), confidence: 'low' };
  }
  if (/\b(?:end of|by end of|eow)\s+(?:the\s+)?week\b/i.test(clause)) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7));
    return { value: iso(d), confidence: 'medium' };
  }
  if (/\bnext week\b/i.test(clause)) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + 7);
    return { value: iso(d), confidence: 'low' };
  }
  return null;
}

function findAssignee(clause: string): { value: string; confidence: Confidence } | null {
  // "ask engineering to…", "with the CX team", "@priya", "Marco will…"
  const at = /@([a-z][\w.-]{1,40})/i.exec(clause);
  if (at) return { value: at[1]!, confidence: 'high' };

  const team = /\b(?:ask|with|from|for|tell|chase)\s+(?:the\s+)?([a-z][a-z ]{2,24}?)\s+(?:team|group)\b/i.exec(clause);
  if (team) return { value: `${team[1]!.trim()} team`, confidence: 'medium' };

  const asked = /\b(?:ask|tell|chase|follow up with|remind)\s+([A-Z][a-z]{1,20})\b/.exec(clause);
  if (asked) return { value: asked[1]!, confidence: 'medium' };

  const will = /\b([A-Z][a-z]{1,20})\s+(?:will|is going to|should|needs to|owns)\b/.exec(clause);
  if (will) return { value: will[1]!, confidence: 'low' };

  const dept = /\b(?:ask|with|from|for)\s+(engineering|legal|security|finance|marketing|design|product|devops|cx|support|qa)\b/i.exec(clause);
  if (dept) return { value: dept[1]!.toLowerCase(), confidence: 'medium' };
  return null;
}

function findGroup(clause: string): string | null {
  const known: Array<[RegExp, string]> = [
    [/\bgtm\b|go[- ]to[- ]market/i, 'GTM'],
    [/\bworkshop\b/i, 'Enablement'],
    [/\bapi\b|integration|credentials?/i, 'Platform'],
    [/\bdevops\b|deploy|infra(?:structure)?|pipeline/i, 'DevOps'],
    [/\bcx\b|customer|support/i, 'Customer'],
    [/\bsecurity\b|pen[- ]?test|compliance|pci|dpa/i, 'Security & compliance'],
    [/\bcheckout\b|payment|billing|refund/i, 'Payments'],
    [/\bhiring\b|interview|candidate/i, 'Hiring'],
    [/\bdesign\b|mockup|figma/i, 'Design'],
  ];
  for (const [re, label] of known) if (re.test(clause)) return label;
  return null;
}

function findLabels(clause: string): string[] {
  const labels = new Set<string>();
  const hashes = clause.match(/#([a-z][\w-]{1,24})/gi) ?? [];
  for (const h of hashes) labels.add(h.slice(1).toLowerCase());
  if (/\bbug|broken|failing|regression\b/i.test(clause)) labels.add('bug');
  if (/\bdocs?|documentation\b/i.test(clause)) labels.add('docs');
  return [...labels].slice(0, 8);
}

function similarity(a: string, b: string): number {
  const norm = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 3),
    );
  const setA = norm(a);
  const setB = norm(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const word of setA) if (setB.has(word)) shared += 1;
  return shared / Math.min(setA.size, setB.size);
}

export function extract(
  text: string,
  existing: Array<{ ref: string; title: string }> = [],
  today = new Date().toISOString().slice(0, 10),
): ExtractionResult {
  const clauses = splitClauses(text);
  const tasks: ProposedTask[] = [];
  const questions: ClarifyingQuestion[] = [];
  const notes: string[] = [];

  // Remembers which clause index produced which task key, so ordering links
  // resolve to the task that actually preceded it (not merely the last one).
  const emitted: Array<{ key: string; link: 'after' | null }> = [];

  for (const { text: clause, link } of clauses) {
    if (!looksActionable(clause)) {
      if (clause.length > 12) notes.push(clause.slice(0, 300));
      continue;
    }
    const key = `t${tasks.length + 1}`;
    const title = titleFrom(clause);
    if (!title) continue;

    const priorityMatch = PRIORITY_SIGNALS.find((p) => p.re.test(clause));
    const due = resolveDate(clause, today);
    const assignee = findAssignee(clause);
    const blocked = BLOCKER_SIGNALS.test(clause);

    const task: ProposedTask = {
      key,
      title,
      description: clause.length > title.length + 12 ? clause.slice(0, 4000) : '',
      suggestedGroup: findGroup(clause),
      priority: priorityMatch
        ? {
            value: priorityMatch.value,
            confidence: 'medium' as Confidence,
            evidence: matchText(clause, priorityMatch.re) ?? null,
          }
        : null,
      dueDate: due
        ? { value: due.value, confidence: due.confidence, evidence: clause.slice(0, 200) }
        : null,
      assigneeHint: assignee
        ? { value: assignee.value, confidence: assignee.confidence, evidence: clause.slice(0, 200) }
        : null,
      estimateDays: null,
      labels: findLabels(clause),
      dependsOnKeys: [],
      blocker: blocked
        ? { reason: clause.replace(/^.*?\b(blocked|waiting|stuck|held up)\b/i, '$1').slice(0, 600), expectedResolutionDate: null }
        : null,
      possibleDuplicateOf: existing
        .filter((e) => similarity(title, e.title) >= 0.6)
        .map((e) => e.ref)
        .slice(0, 5),
      sourceQuote: clause.slice(0, 600),
    };

    // Ambiguity is surfaced, never resolved silently.
    if (due && due.confidence === 'low') {
      questions.push({
        taskKey: key,
        field: 'dueDate',
        question: `Which date does "${matchText(clause, /\b(?:by|before|on|due)\s+\w+|next week/i) ?? 'that deadline'}" mean? I read it as ${due.value}.`,
      });
    }
    if (assignee && assignee.confidence === 'low') {
      questions.push({
        taskKey: key,
        field: 'assignee',
        question: `Should "${title}" be assigned to ${assignee.value}?`,
      });
    }
    if (task.possibleDuplicateOf.length > 0) {
      questions.push({
        taskKey: key,
        field: 'duplicate',
        question: `This looks like existing ${task.possibleDuplicateOf.join(', ')}. Create it anyway?`,
      });
    }
    tasks.push(task);
    emitted.push({ key, link });
  }

  // Dependencies come from the ordering split ("A before B" -> B after A) and,
  // as a fallback, from a cross-sentence back-reference ("Once that is done").
  for (let i = 1; i < emitted.length; i++) {
    const current = emitted[i]!;
    const previous = emitted[i - 1]!;
    const task = tasks[i]!;
    // Only a clause that *opens* with a back-reference ("Once that is done,
    // ...", "Then ...") inherits the previous task; a trailing "before it
    // expires" is a condition, not a dependency.
    const linked =
      current.link === 'after' ||
      /^\s*(?:once|after|then|when)\b[^.]{0,40}\b(?:that|this|it|those)\b/i.test(task.sourceQuote) ||
      /^\s*(?:once|after|then)\b/i.test(task.sourceQuote);
    if (linked && !task.dependsOnKeys.includes(previous.key)) {
      task.dependsOnKeys.push(previous.key);
    }
  }

  // Merge follow-up clauses into the task they describe. "The GTM deck needs
  // to be done by Friday" is a deadline for an existing task, not a second
  // task; "engineering is blocked until X" is a blocker on one. Doing this
  // here keeps the reviewer from having to delete near-duplicates by hand.
  const merged = new Set<string>();
  for (let i = tasks.length - 1; i >= 1; i--) {
    const candidate = tasks[i]!;
    const target = findMergeTarget(candidate, tasks.slice(0, i));
    if (!target) continue;
    if (candidate.dueDate && !target.dueDate) target.dueDate = candidate.dueDate;
    if (candidate.priority && !target.priority) target.priority = candidate.priority;
    if (candidate.blocker && !target.blocker) target.blocker = candidate.blocker;
    if (candidate.assigneeHint && !target.assigneeHint) target.assigneeHint = candidate.assigneeHint;
    for (const label of candidate.labels) if (!target.labels.includes(label)) target.labels.push(label);
    // Keep the evidence for the merged detail visible in the review UI.
    target.sourceQuote = `${target.sourceQuote} ${candidate.sourceQuote}`.slice(0, 600);
    merged.add(candidate.key);
    // Move any question about the merged clause onto the surviving task.
    for (const question of questions) {
      if (question.taskKey === candidate.key) question.taskKey = target.key;
    }
  }
  if (merged.size > 0) {
    const surviving = tasks.filter((t) => !merged.has(t.key));
    const survivingKeys = new Set(surviving.map((t) => t.key));
    for (const task of surviving) {
      task.dependsOnKeys = task.dependsOnKeys.filter((k) => survivingKeys.has(k) && k !== task.key);
    }
    tasks.length = 0;
    tasks.push(...surviving);
    for (const question of questions) {
      if (question.taskKey !== null && !survivingKeys.has(question.taskKey)) question.taskKey = null;
    }
  }

  const summary =
    tasks.length === 0
      ? 'No actionable tasks found in this input.'
      : `${tasks.length} task${tasks.length === 1 ? '' : 's'} extracted` +
        (questions.length > 0 ? `, ${questions.length} need${questions.length === 1 ? 's' : ''} confirmation` : '') +
        '.';

  return { summary, tasks, questions, notes: notes.slice(0, 20) };
}

/**
 * A clause is a detail about an earlier task when it carries no new work of
 * its own — only a deadline, priority or blocker — and clearly refers to that
 * task, either by strong wording overlap or by naming its subject.
 */
function findMergeTarget(candidate: ProposedTask, earlier: ProposedTask[]): ProposedTask | null {
  const carriesOnlyDetail =
    candidate.dueDate !== null || candidate.priority !== null || candidate.blocker !== null;
  if (!carriesOnlyDetail) return null;
  // A clause with its own action verb at the front is real work, not a detail.
  if (/^(?:[a-z]+)\b/i.test(candidate.title) && startsWithActionVerb(candidate.title)) return null;

  let best: { task: ProposedTask; score: number } | null = null;
  for (const task of earlier) {
    const score = similarity(candidate.title, task.title);
    if (score >= 0.5 && (!best || score > best.score)) best = { task, score };
  }
  if (best) return best.task;

  // Blocker statements often name only the owner ("engineering is blocked...").
  if (candidate.blocker) {
    const subject = /^([A-Za-z][\w-]{2,24})\b/.exec(candidate.title)?.[1]?.toLowerCase();
    if (subject) {
      const named = earlier.find((t) => t.title.toLowerCase().includes(subject));
      if (named) return named;
    }
  }
  return null;
}

function startsWithActionVerb(title: string): boolean {
  const first = title.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return ACTION_VERBS.some((verb) => verb === first || verbPattern(verb).test(first));
}

function matchText(text: string, re: RegExp): string | null {
  return re.exec(text)?.[0] ?? null;
}
