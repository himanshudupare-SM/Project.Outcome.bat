# Outcome — Product Requirements Document

**Product:** Outcome — an AI-native work execution tool (modern alternative/complement to Jira)
**Status:** Draft v1 for MVP planning
**Author:** Product architecture (this repo)
**Related:** The `prototype/` app in this repo validates the outcome-forecasting concept (section 10.4) with a working scheduling engine.

---

## 0. One-paragraph summary

Outcome lets people capture work by talking or typing naturally; the system turns
that into structured, connected, prioritized tasks, keeps the structure current as
work happens, and tells each user what matters now — including whether the
project's outcome will actually land, why it might not, and what to do about it.
Jira optimizes for *recording* work; Outcome optimizes for *deciding and
recovering* work. The tagline discipline for every feature: **minimal manual data
entry, no silent AI decisions.**

---

## 1. Target users / personas

| Persona | Profile | What they need |
|---|---|---|
| **Maya — Team lead / EM** (primary buyer & power user) | Leads 5–10 engineers at a 20–500 person company; currently the "Jira janitor" | Capture planning output fast; see blockers/dependencies without archaeology; trustworthy status without chasing people |
| **Dev — IC engineer** (primary daily user) | Senior engineer; hates ticket bureaucracy; updates Jira under duress | "What should I work on today?"; create/updates in seconds; never re-type what was said in standup |
| **Sara — Product/ops manager** | Runs cross-functional launches (eng + legal + marketing) | One place where approvals, decisions and tasks connect; sees what's stuck and who's waiting on whom |
| **Ravi — CTO / VP Eng** (economic buyer) | Accountable for delivery dates | Per-project forecast and risk with causes, not RAG-status theater; audit trail |
| **Nina — Non-PM contributor** (CX / marketing / legal) | Occasional user, allergic to Jira | Gets assigned work with context; can respond by commenting or completing, never has to learn a workflow editor |

Anti-persona for MVP: heavily-regulated enterprise (SSO/SCIM/compliance-first),
agencies billing by the hour, and companies wanting deep Jira workflow parity.

## 2. User problems

1. **Capture friction.** Turning a planning meeting or a head full of tasks into
   tickets takes 30–60 minutes of form-filling; so it doesn't happen, and the
   tracker diverges from reality.
2. **Field bureaucracy.** Priority, labels, estimates, components, sprint,
   epic-links… most fields are guessed once and never maintained.
3. **Invisible blockage.** Dependencies and blockers live in people's heads and
   Slack; managers discover them in status meetings, days late.
4. **Status is self-reported.** Dashboards show what people typed, not what is
   happening; risk is discovered at the deadline.
5. **Prioritization is manual and stale.** "What should I do today?" requires a
   human to have groomed a backlog yesterday.
6. **Jira's flexibility tax.** Workflow/screen/scheme configuration makes simple
   things slow and migration terrifying — teams feel locked in.

## 3. Core value proposition

- **Speak → structured work.** Brain dump by voice or text; AI extracts tasks,
  projects, priorities, deadlines, dependencies, people — the user approves,
  never transcribes.
- **The graph stays alive.** Dependencies, blockers and approvals are first-class
  objects, so the system can compute what is stuck and what it cascades into.
- **Outcome intelligence.** Per-project delivery forecast, plain-language root
  causes, and ranked interventions with computed impact (validated by the
  prototype in this repo).
- **Zero-bureaucracy adoption.** Sensible defaults everywhere; a team is
  productive in 10 minutes; Jira import for the history.

## 4. Primary use cases

1. **Brain dump → tasks** (voice or text) with review/approve screen.
2. **Daily focus:** IC opens "My Work", gets an AI-ordered list with reasons.
3. **Sprint/cycle planning:** select scope, see computed feasibility vs capacity.
4. **Blocker management:** mark blocked → who/what is waiting is visible; alerts
   when a blocker ages past its expected resolution.
5. **Exec review:** project overview with forecast, causes, interventions.
6. **Meeting notes → tasks** ("create tasks from these notes").
7. **Assistant Q&A:** "what changed while I was away?", "what's blocking GTM?"
8. **Jira migration:** import projects/epics/issues/comments with mapping review.

## 5. MVP scope

- Organizations, teams, projects, members, invitations.
- Task hierarchy: Project → Epic → Task → Subtask; labels, priority, status,
  assignee, due date, estimates (S/M/L or days).
- Board (kanban by status), backlog list, task detail, comments, @mentions.
- Dependencies (blocks / blocked-by) + explicit blocker records with reason.
- **AI Brain Dump** (text + voice) → structured proposal → review → bulk create,
  with confidence marking and audit trail.
- **AI assistant v1**: read-only Q&A over the user's permitted data + safe tool
  calls (create/update task, comment, search) with confirmation.
- My Work view; global search (keyword); notification inbox + email.
- Dashboard per project incl. v1 outcome signals (blocked count, aging,
  turnaround split — forecast v1 from the prototype engine where data allows).
- Jira import (cloud export/API) with mapping + review.
- Audit/activity log (human and AI actions), RBAC, session auth.

## 6. Post-MVP scope

- Full outcome forecasting with confidence trends + intervention simulation
  (productionizing the prototype engine on live data).
- Sprints/cycles with capacity, burnup; workload/overload view.
- Automation rules; custom fields (constrained); custom statuses per project.
- GitHub/GitLab linking (PR ↔ task state), Slack capture + notifications,
  calendar sync.
- Semantic search; duplicate detection at creation time everywhere.
- SSO (SAML/OIDC), SCIM; guest/external roles; public API + webhooks GA.
- Mobile apps; offline capture.

## 7. User journeys

**J1 — Team onboarding (Maya):** sign up → create org → invite 6 people →
create project "Checkout Migration" → brain-dumps the kickoff meeting (voice,
4 min) → reviews 18 proposed tasks, fixes 2 owners, approves → board is live.
*Success: < 15 minutes, no field filled in manually except 2 corrections.*

**J2 — Daily IC (Dev):** opens My Work → sees 3 ordered items with "why" →
starts one; hits a missing-credentials blocker → types "blocked: need API creds
from platform team" on the task → dependency graph + notifications update;
Maya's dashboard shows the new blocker cause. *Success: blocker visible
org-wide in < 1 minute with zero forms.*

**J3 — Weekly exec review (Ravi):** opens project overview → forecast "6 wd
late, 3 causes" → drills into the legal-approval cascade → clicks the
recommended escalation → assistant drafts the escalation comment and tags
legal. *Success: decision made without a status meeting.*

**J4 — Migration (Maya):** connects Jira → picks 2 projects → mapping screen
(statuses, priorities, users) with conflicts highlighted → dry-run preview →
import with progress → summary lists 3 failed attachments with retry.
*Success: < 30 min for 1,000 issues; nothing silently dropped.*

**J5 — Cross-functional ask (Sara → Nina):** Sara's brain dump generates a
task assigned to Nina (marketing) with inferred due date flagged "low
confidence — confirm"; Nina gets one email, opens task, confirms date,
completes it Friday. *Success: Nina never sees a board she didn't ask for.*

## 8. Functional requirements (condensed)

**Identity & tenancy**
- FR-1 Email+password signup/login, email verification, password reset; Google OAuth post-MVP.
- FR-2 A user belongs to ≥1 organization; all data is org-scoped; org switcher.
- FR-3 Invitations by email with role; revocable; expiring tokens.

**Work management**
- FR-10 CRUD for projects, epics, tasks, subtasks with optimistic UI.
- FR-11 Task fields: title, description (rich text/markdown), status, priority,
  assignee, labels, due date, estimate, epic, project; all optional except title.
- FR-12 Status model: global defaults (Backlog/Todo/In progress/In review/Blocked/Done) per project; custom statuses post-MVP.
- FR-13 Dependencies: task→task "blocks"; cycle prevention; blocker records carry reason, owner, created-at, resolved-at.
- FR-14 Comments with @mentions, markdown, edit/delete windows.
- FR-15 Attachments on tasks/comments (type/size limited, virus-scan hook).
- FR-16 Board: drag between status columns; backlog: sortable/filterable list; bulk edit.
- FR-17 My Work: assigned + mentioned + blocked-by-me, AI-ordered with stated reasons.

**AI**
- FR-30 Brain dump (text/voice) produces a structured proposal (schema §10.2); nothing is created without explicit user approval.
- FR-31 Every AI-proposed field carries a confidence level; low-confidence fields are visually marked and prompt a question — never silently assumed.
- FR-32 Assistant chat scoped to the user's permissions; cites task links; distinguishes fact vs recommendation; tool calls that mutate data require confirmation.
- FR-33 All AI-generated actions land in the audit log flagged `actor=ai`, linked to the originating conversation/dump.

**Collaboration & signal**
- FR-40 Notification inbox + email for: assignment, @mention, comment on
  watched task, blocker created/resolved on your work, import finished, AI
  proposal ready. Per-user channel preferences; digest option.
- FR-41 Activity timeline per task/project; org-level audit log (admin).
- FR-42 Global search: tasks, projects, epics, comments; filters (assignee,
  status, label, project, date); keyboard-first (⌘K).

**Import/integration**
- FR-50 Jira import per §Jira-comparison with mapping review, dry run, progress, summary, retry of failures.
- FR-51 Personal API tokens (org-scoped, revocable) for the REST API; webhooks post-MVP.

## 9. Non-functional requirements

- **Performance:** p95 API < 300 ms (non-AI); board interactive < 1.5 s on 1k
  visible tasks; AI proposal < 15 s for a 5-minute dump (streamed progress).
- **Availability:** 99.9% monthly for core CRUD; AI degradation must not block
  manual task management (graceful fallback).
- **Data:** daily backups, PITR; soft-delete with 30-day restore for user data.
- **Accessibility:** WCAG 2.1 AA; full keyboard operation of board and forms.
- **Browsers:** last 2 versions of Chrome/Firefox/Safari/Edge; responsive ≥ 360 px.
- **Privacy:** customer data never used for model training; AI provider calls
  carry only permitted, minimum context; configurable data region post-MVP.

## 10. AI capabilities

1. **Extraction** (brain dump/meeting notes): tasks, grouping into
   projects/epics, priority, deadlines (resolves "Friday" against user TZ),
   assignees/teams, dependencies, blockers, duplicates vs existing tasks,
   ambiguities + clarifying questions.
2. **Structured output contract:** strict JSON schema, server-side validation,
   per-field confidence ∈ {high, medium, low}; `low` ⇒ marked uncertain + question.
   Retries with repair on schema violation; hard budget/token limits; failures
   surface as actionable errors, never partial silent writes.
3. **Assistant:** grounded Q&A with citations (task IDs/links); tool calling
   (create/update/assign/prioritize/comment/depend/search/summarize);
   permission-filtered retrieval; confirmation gate on mutations; no
   fabrication — "not in the data" is a valid answer.
4. **Outcome intelligence** (v1 signals in MVP, full post-MVP): working-day
   schedule forecast from dependencies/owners/approvals, confidence score,
   sequential root-cause attribution, ranked interventions with computed
   impact — the algorithms validated in `prototype/`.
5. **Prioritization:** "My Work" ordering from due dates, blocking impact
   (how many items each task unblocks), and staleness, with the reason shown.

## 11. Project/task hierarchy

```
Organization
└─ Team (grouping of people; a project belongs to one team, visible org-wide per permissions)
   └─ Project (has statuses, members, forecast)
      └─ Epic (optional grouping, has target date)
         └─ Task (the atomic unit of work)
            └─ Subtask (lightweight checklist child, own assignee/status)
Sprint/Cycle (post-MVP): a time-boxed selection of tasks across one project.
```
No separate "Story" type: a task with an estimate covers it (see Jira comparison).

## 12. Roles and permissions

| Role | Scope | Can |
|---|---|---|
| Org **Owner** | org | everything incl. billing, delete org, manage admins |
| Org **Admin** | org | manage members/teams/projects/integrations, view audit log |
| Org **Member** | org | create projects (policy-controlled), work in projects they belong to |
| **Guest** (post-MVP) | explicit projects | view/comment/complete assigned tasks only |
| Project **Lead** | project | manage project settings/members, edit anything in project |
| Project **Member** | project | create/edit tasks, comment |
| Project **Viewer** | project | read + comment |

Enforcement is server-side on every query (tenancy + role), not UI-only. AI
retrieval uses the caller's permissions.

## 13. Notifications

Events (MVP): assigned, @mentioned, comment on watched/authored task, status
of my task changed by someone else, blocker created/resolved affecting my
task, dependency I'm waiting on completed, AI proposal ready, import finished,
invitation. Channels: in-app inbox (real-time), email (immediate or daily
digest). Per-user per-event-channel matrix; org-level defaults; unsubscribe
links; batching to prevent storms (e.g., bulk import ⇒ one notification).

## 14. Integrations

- **MVP:** Jira import (REST API + file export); personal API tokens; outbound
  email (transactional provider).
- **Post-MVP:** Slack (capture a message as task, notifications), GitHub/GitLab
  (link PRs, auto-move status), Google/Outlook calendar (due dates, focus
  blocks), generic webhooks, Zapier/Make, incoming email-to-task.

## 15. Analytics

Per project: throughput (done/wk), cycle time (start→done), time-in-state split
(active/waiting/blocked/review — the "turnaround" view), blocker count & age,
forecast vs target history, scope change. Per person (privacy-aware, manager
scope): WIP, blocked items. Org: adoption metrics for admins. All charts backed
by queryable events, exportable CSV.

## 16. Search

MVP: Postgres full-text over tasks/epics/projects/comments with typeahead
(⌘K), filter grammar (`assignee:me status:blocked label:gtm due<friday`),
recent items, saved filters. Post-MVP: semantic search (pgvector) and
natural-language search via assistant ("that task about vault tokens").

## 17. Activity / audit history

- Per-entity timeline: field changes (old→new), comments, dependency changes,
  AI actions — rendered human-readably.
- Org audit log (admin-only): auth events, permission changes, imports,
  API-token use, AI mutations; immutable, append-only, exportable, retained ≥ 1 year.
- Every AI write links to its conversation/dump for provenance.

## 18. Error / empty / loading states (product standards)

- **Empty:** every list/board/inbox ships a designed empty state with the one
  primary next action (e.g., empty backlog → "Brain-dump your plan").
- **Loading:** skeletons for structure, spinners only inside buttons; AI
  operations stream progress ("Transcribing… Extracting 12 tasks…"); never a
  blank screen > 300 ms.
- **Errors:** human sentence + what to do + retry where safe; form errors
  inline; AI failures offer "try again / edit input / create manually";
  optimistic updates roll back visibly with a toast; global offline banner.

## 19. Security requirements

Tenant isolation enforced in the data layer (org_id on every row + scoped
queries; RLS as defense-in-depth), RBAC server-side, Argon2id password
hashing, httpOnly SameSite session cookies + CSRF token, rate limiting
(auth, AI, API), input validation everywhere (schema-first), output encoding
(XSS), signed URLs for files with type/size allowlists, secrets in env/manager
(never in repo), dependency scanning in CI, audit log (§17), prompt-injection
defenses: retrieved content is data-not-instructions, tool allowlist,
mutation confirmation, no secrets in prompts. Full audit phase before launch.

## 20. Scalability requirements

Design targets (MVP architecture must not preclude): 10k orgs / 200 users/org
/ 200k tasks/org; 500 rps API burst; AI pipeline horizontally scalable via
queue; DB read-mostly with pagination + keyset everywhere; events/audit
append-only (partitionable); file storage on object store from day one.
Modular monolith with clean module boundaries so the AI worker and importer
can split out first.

## 21. Success metrics

- **Activation:** ≥ 60% of new orgs run a brain dump and approve ≥ 5 tasks in week 1.
- **Capture efficiency:** median voice-dump→approved-tasks < 3 min for 10 tasks; ≥ 80% of AI-proposed field values accepted unedited.
- **Trust:** < 2% of AI-created tasks deleted as wrong; 100% of AI writes audited.
- **Signal value:** blockers surfaced by the system before a human reports them ≥ 50% of the time (measurable via timestamps); forecast error ≤ ±20% at 2 weeks out.
- **Retention:** 4-week team retention ≥ 40%; weekly active capture (dump or assistant) per team ≥ 3.
- **Migration:** Jira import success rate ≥ 98% of issues; < 30 min median.

---

## Jira concept comparison

| Jira concept | Outcome equivalent | Notes |
|---|---|---|
| Project | Project | Same role; creation is one field, defaults applied |
| Epic | Epic | Kept — the grouping level people actually use |
| Story | Task (+estimate) | No separate type; type-zoo is Jira overhead we drop |
| Task | Task | Atomic unit |
| Subtask | Subtask | Lightweight, own assignee/status |
| Sprint | Cycle (post-MVP) | Optional overlay, capacity-aware |
| Backlog | Backlog list | AI-ordered option; same mental model |
| Board | Board | Kanban by status; swimlanes post-MVP |
| Workflow | Fixed sensible statuses (custom post-MVP) | Deliberately NOT a workflow editor at MVP |
| Assignee | Assignee | Single assignee + watchers |
| Priority | Priority (P0–P3) | AI-inferred with confidence, user-approved |
| Labels | Labels | Org-scoped, autocomplete, AI-suggested |
| Components | Labels (typed later) | Not a separate system at MVP |
| Dependencies (issue links) | First-class dependency edges | Typed "blocks"; cycles prevented; drives forecasting |
| Blockers (flag) | Blocker records | Reason + who/what + age + cascade — richer than a flag |
| Comments | Comments | Markdown, mentions |
| Attachments | Attachments | Object storage, signed URLs |
| Notifications | Inbox + email | Fewer, smarter defaults |
| Reports | Analytics + Outcome intelligence | Forecast/causes/interventions replace burndown-only |
| Permissions | Org + project roles | Simpler matrix; schemes dropped |
| Automation | Post-MVP rules | AI assistant covers many automation asks first |

### A. Must-have to be credible vs Jira
Projects/epics/tasks/subtasks; board + backlog; statuses, priorities,
assignees, labels, due dates; comments + attachments + mentions; search;
notifications; permissions; activity history; Jira import; REST API tokens.

### B. Where we must be substantially better
1. Capture (voice/NL brain dump → approved tasks in minutes).
2. Dependencies & blockers as a live graph with cascade visibility.
3. Outcome forecasting: date + causes + interventions, computed not asserted.
4. "My Work" prioritization with reasons.
5. Time-to-first-value (10-minute team onboarding; no scheme configuration).
6. Assistant that answers project questions with citations.

### C. Do NOT build initially
Custom workflow editor, custom fields, issue-type schemes/screens; sprints
with full scrum ceremony support; time tracking/worklogs; portfolio/advanced
roadmaps; automation rule builder; SSO/SCIM; on-prem; mobile apps; Gantt.

### D. Potential differentiators
Outcome Execution Engine (forecast/causes/interventions — prototype proven);
approval/decision objects as schedulable blockers; sequential bottleneck
attribution ("fix this, THEN this becomes binding"); "evaluated — no impact"
anti-recommendations; voice-first capture with confidence-marked review; AI
actions with full provenance/audit.

---

## Prioritized MVP feature list

**P0 — absolutely required**
1. Auth (email/password, verification, reset), sessions
2. Orgs, teams, members, invitations, roles (owner/admin/member; project lead/member/viewer)
3. Projects, epics, tasks, subtasks CRUD; statuses, priority, assignee, labels, due date, estimate
4. Board (drag by status) + backlog list + task detail + comments/@mentions
5. Dependencies + blocker records (create/resolve, reason, visibility)
6. AI Brain Dump (text) → structured proposal → review/edit → bulk create, confidence marking, audit
7. Voice capture front-end (record, transcribe, edit transcript) feeding the same pipeline
8. My Work view (AI-ordered with reasons)
9. Notification inbox + email (assignment, mention, blocker, proposal ready)
10. Global keyword search (⌘K) with filters
11. Activity timeline + org audit log (incl. AI actions)
12. Tenant isolation + RBAC enforcement + rate limiting; error/empty/loading standards
13. Seed/demo data + working local dev environment

**P1 — important**
14. Jira import with mapping review, dry-run, progress, summary, retry
15. AI assistant chat with citations + confirmed tool calls
16. Project dashboard with turnaround split, blocker aging, forecast v1
17. Attachments; saved filters; email digests
18. Personal API tokens + documented REST API
19. Duplicate detection inside brain-dump review

**P2 — later**
20. Full outcome simulation UI (before/after interventions) on live data
21. Cycles/sprints with capacity; overload view
22. Slack + GitHub integrations; webhooks
23. Custom statuses; automation rules; semantic search
24. SSO/SCIM, guests; data-region choice; mobile
