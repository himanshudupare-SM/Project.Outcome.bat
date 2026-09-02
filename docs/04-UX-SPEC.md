# Outcome — UX/UI Specification

Design intent: modern, fast, intelligent, minimal, professional — and
measurably easier than Jira. The primary workflow (capture → structured tasks)
must be completable with **zero manual field entry** beyond corrections.

## Design system

- **Tokens:** neutral light theme with dark mode; ink hierarchy
  (primary/secondary/muted), 1 accent (blue) for actions, reserved status
  colors (good/warning/serious/critical) always paired with icon+label; 8px
  spacing grid; system sans; `tabular-nums` in tables only.
- **Primitives:** Button, IconButton, Field (label+input+error), Select,
  DatePicker, Dialog, Drawer (right-side task panel), Menu, Tabs, Toast,
  Tooltip, Avatar(+stack), Pill (status/priority), Chip (label), Skeleton,
  EmptyState (illustration-free: heading + one primary action), Kbd.
- **Global state standards** (apply to every screen; not repeated below):
  - *Loading:* skeleton mirroring final layout; never blank > 300 ms; buttons
    show inline spinners and stay disabled during submit.
  - *Empty:* one sentence + one primary action (usually "Brain dump" or
    "New task"), never a bare "No data".
  - *Error:* human sentence + retry; forms show inline field errors + summary;
    optimistic updates roll back with a toast ("Couldn't move ATLAS-42 — back
    to In progress"); global offline banner; 403 → "You don't have access"
    view with org switcher; 404 → "Not found or deleted" with link back.
  - *Responsive:* ≥1200 px three-zone layout; 768–1200 px collapsible sidebar;
    <768 px bottom tab bar (My Work / Board / Capture / Inbox / Search),
    board becomes single-column with status switcher, task detail becomes
    full-screen page instead of drawer.
- **Keyboard:** ⌘K command palette everywhere; `c` new task, `b` brain dump,
  `/` search, `j/k` list navigation, arrows+space on board; visible focus
  rings; dialogs trap and restore focus.

## App shell / information architecture

```
┌ Topbar: org switcher · ⌘K search · Brain Dump (mic+text, always visible) · inbox bell · avatar
├ Sidebar: My Work · Inbox · Projects (list, ★ pinned) · Assistant · Team · Settings
└ Content: route view; task detail opens as right drawer over any list/board (deep-linkable)
```

---

## Screens

### 1. Login / Signup (`/login`, `/signup`, `/reset`, `/verify`)
Centered card (max 400 px), logo, email+password, submit, switch link.
Signup: name/email/password + strength hint → "check your email" verify state.
Errors: inline field errors; generic "invalid email or password" (no user
enumeration); rate-limit state ("too many attempts — try in 5 min").
Loading: button spinner. Invited users land here with banner "Join {org}".

### 2. Organization setup (`/onboarding`)
Post-signup 3-step wizard, progress dots, skippable after step 1:
(1) org name+slug → (2) invite teammates (multi-email chips, role select,
"skip") → (3) create first project (name, auto key) **with inline choice:
"Start with a brain dump" (primary) or "Empty project"**. Choosing brain dump
deep-links to screen 10 scoped to the new project. Errors inline; slug
collision auto-suffixes with edit option.

### 3. Dashboard — org home (`/o/:org`)
Header: greeting + today line ("3 due, 1 blocked").
Grid: **My focus** (top 5 AI-ordered tasks with reason chips) · **Projects**
(cards: name, open/done counts, open blockers, health pill; forecast pill when
engine has data) · **Recent activity** (org feed, filter by project) ·
**Blocked across org** (aging list). Empty org: single hero CTA "Create a
project" / "Import from Jira". All cards deep-link.

### 4. Projects list (`/o/:org/projects`)
Table: key, name, team, lead avatar, open tasks, open blockers, health,
updated. Row click → overview. Actions: New project (dialog: name → key
auto-derived, team, lead), archive (confirm), pin. Search/filter by team/state.
Empty: "No projects yet — create one or import from Jira."

### 5. Project overview (`/o/:org/p/:key`)
Tabs: **Overview · Board · Backlog · Epics · Activity · Settings**.
Overview: status summary strip (counts per status category), open blockers
list (reason, age, owner), upcoming due, epic progress bars, forecast card v1
(target date vs computed finish, top cause) when data suffices; team members
row. Actions: edit description inline, add member, Brain dump scoped here.

### 6. Backlog (`/o/:org/p/:key/backlog`)
Dense list grouped by epic (collapsible) or flat; columns: number, title,
status pill, priority, assignee, due, labels. Multi-select (shift/checkbox) →
bulk bar (status/priority/assignee/label/epic/delete). Inline "+ Add task"
row at each group end (title only — everything else defaulted). Sort menu;
filter bar (chips, same grammar as search). Infinite keyset scroll,
skeleton rows. Empty: "Backlog is empty — brain-dump your plan."

### 7. Kanban board (`/o/:org/p/:key/board`)
Columns = project statuses (WIP count in header). Cards: number, title,
priority icon, assignee avatar, due chip (red when overdue), label dots,
blocker icon with age when blocked, dependency icon when blocked-by-open-task
(tooltip lists blockers). Drag: pointer + keyboard (space lift, arrows,
space drop); optimistic with rollback. Column "+" quick-add (title →
status preset). Filter bar shared with backlog. Loading: 3 skeleton cards
per column. Empty column: faint drop hint.

### 8. Task detail (drawer `/o/:org/p/:key/t/:num`, full page on mobile/direct hit)
Header: `ATLAS-42` copy-link, title (inline edit), close/expand.
Left (main): description (markdown editor, edit-in-place), subtask checklist
(+ add, each with assignee/status), attachments grid, comments thread
(markdown, @mention autocomplete, edit/delete own).
Right (meta rail): status, priority, assignee, epic, due date, estimate,
labels — every field a click-to-edit control with keyboard support;
**Dependencies** section: "Blocks →" / "Blocked by ←" chips + add via search;
**Blockers** section: active blocker banner (reason, age, expected date,
resolve button) + add blocker; watchers; provenance line when AI/import
("Created from brain dump May 3 — view source").
Footer tab: Activity (field-change timeline).
States: not-found view; conflict toast on concurrent edit ("Updated by Maya —
refreshed"); comment send failure keeps draft with retry.

### 9. Create task (dialog, `c` anywhere)
One required field: title (smart parse inline: "tomorrow", "p1", "@dev",
"#label" become chips as typed). Collapsed "More" reveals description/epic/
estimate. Project select (defaults to current). Submit → toast with link;
"create another" checkbox keeps dialog open. AI assist row (post-parse):
"Looks like 3 tasks — split?" when multiple sentences detected.

### 10. AI task capture — Brain Dump (`/o/:org/capture`, global button)
Two-pane flow, minimal chrome:
**Input state:** big textarea ("Type or hold ⌘ and speak…"), mic button →
voice mode (screen 11), project scope select (optional), Extract button.
**Processing:** streamed progress lines ("Transcribing…", "Found 12 tasks…"),
cancellable.
**Review state (the heart):** left = original text with extracted spans
highlighted (hover ↔ card sync); right = proposal cards grouped by suggested
project/epic: title, description, assignee?, due?, priority?, labels?,
dependencies ("after: set up sandbox"), each **field carries a confidence
mark** — low-confidence fields show amber dotted underline + inline question
("Which Friday — Sep 12?"). Duplicate suspects show a "possible duplicate of
ATLAS-31" banner with side-by-side diff and keep/merge/discard.
Card actions: edit any field, remove card; bulk: approve all high-confidence,
select subset. Sticky footer: "Create 9 tasks · 2 need answers" → approve
creates only resolved cards, unresolved stay for answers.
**Done state:** created list with links, "undo all" (5 min), link to source
dump retained on every task.
Errors: AI failure → "Extraction failed — retry / edit input / create
manually" (input preserved); partial schema failure → salvaged cards + notice.

### 11. Voice capture (modal layer over any screen)
States: **requesting mic** (explainer) → **recording** (timer, live waveform,
live transcript when supported, pause/resume, cancel, stop) → **transcript
review** (editable text, re-record, "Extract tasks" primary) → hands off to
screen 10 pipeline.
Edge states, each designed: mic denied (inline how-to-enable + "type
instead"), no mic (straight to type), silent/empty recording ("We didn't
catch anything"), >10 min recording (auto-chunk warning at 8 min), network
drop (transcript kept locally, retry), transcription garbage (user edits or
re-records — transcript always editable before AI sees it).

### 12. My Work (`/o/:org/me`)
Sections: **Now** (AI-ordered ≤5 with reason chips: "unblocks 3 tasks",
"due tomorrow"), **Due soon**, **Blocked by me** (things I must unblock —
deliberately prominent), **Waiting on others** (my blocked items + who),
**Mentioned**. Row hover: complete/status quick actions. Reorder override by
drag (persisted, AI respects pinning). Empty: "Nothing assigned — check the
team board."

### 13. Sprint / Cycle view (post-MVP; nav hidden until enabled)
Cycle header (dates, capacity bar per person), two-pane planning (backlog →
cycle), same board filtered to cycle, feasibility banner from engine
("Selected 34 wd vs capacity 28 wd — over by 6").

### 14. Dependencies / blockers (`/o/:org/p/:key/graph`)
Toggle views: **Blockers list** (active: reason, task, owner, age,
expected date, cascade count "blocks 4 downstream", resolve) and **Graph**
(dependency DAG, columns by status category; blocked chains highlighted red;
click node → task drawer). Filter: only-blocked. Empty: "No dependencies
recorded — add them on any task (Blocked by ←)."

### 15. Search (`⌘K` palette + `/o/:org/search` full page)
Palette: fuzzy typeahead across tasks/projects/epics/people/commands
("> new task", "> go to board"); recent items when empty; grouped results,
keyboard-first. Full page: query + filter grammar chips
(`assignee:me status:blocked due<fri`), tabs All/Tasks/Epics/Projects/
Comments, keyset pagination, saved filters (name + pin to sidebar).
States: no results (suggest removing filters), search service slow (>2 s note).

### 16. Notifications inbox (`/o/:org/inbox`, bell popover for last 10)
Tabs: Unread / All. Rows: actor avatar, sentence ("Maya assigned you
ATLAS-42"), context snippet, time; click → entity (marks read). Bulk: mark
all read. Grouping: N comments on one task collapse. Footer link → prefs
(screen 18). Real-time via SSE (badge count). Empty: "Inbox zero 🎉" (only
allowed emoji).

### 17. Team members (`/o/:org/team`)
Members table: avatar, name, email, org role (editable by admin), teams,
last active. Invite dialog (emails + role). Pending invitations list
(resend/revoke). Teams tab: create team, manage membership. Guard rails:
can't demote last owner (explained inline); role change confirm.

### 18. Settings (`/o/:org/settings/*`)
Sub-nav: **Profile** (name, avatar, timezone, password), **Notifications**
(event × channel matrix + digest), **Organization** (name/slug, danger zone:
delete org typed-confirm), **Projects defaults** (statuses, who can create),
**API tokens** (create → show-once token, list, revoke), **Integrations**
(screen 19), **Audit log** (admin: filterable table, export CSV).

### 19. Integrations — Jira import (`/o/:org/settings/integrations/jira`)
Stepper: **Connect** (base URL, email, API token — validated live) →
**Select** (projects list with issue counts) → **Mapping** (three mapping
tables: statuses/priorities/users; unmapped rows flagged, defaults offered,
"invite as new user" option) → **Dry run** (preview counts, conflicts —
duplicate keys, missing epics — listed with resolutions) → **Import**
(progress bar per entity type, streamed counts, cancel) → **Summary**
(imported/skipped/failed with per-item reasons, retry-failed button, link to
project, full log to audit). Failure mid-run: resumable banner. Empty
creds/403: inline error with Jira-side instructions.

### 20. Activity / audit (`/o/:org/p/:key/activity` + org-level in settings)
Project feed: filter by person/type/date; human sentences ("Dev moved
ATLAS-42 In progress → Blocked", "**AI** created 9 tasks from Maya's brain
dump — view"). AI actor rows carry a distinct badge and link to provenance.
Org audit (admin-only): auth/permission/import/API/AI events, immutable,
export. Loading: skeleton feed; keyset infinite scroll.

### Assistant (sidebar `Assistant`, also ⌘J) — see PRD FR-32
Chat pane with project scope selector; answers show **Facts** (with task-link
citations) vs **Suggestion** sections; tool-call proposals render as
confirmation cards ("Create task 'Fix creds' in ATLAS — Confirm / Edit /
Cancel"); refusal state when data insufficient ("I can't see that project").

---

## Component hierarchy (frontend)

```
<App>
├─ <AuthProvider> / <ApiProvider(QueryClient)> / <SseProvider> / <ToastProvider>
├─ routes/
│  ├─ AuthLayout: Login · Signup · Reset · Verify · AcceptInvite
│  ├─ OnboardingWizard
│  └─ OrgLayout (topbar+sidebar, org context)
│     ├─ Dashboard
│     ├─ MyWork
│     ├─ Inbox
│     ├─ ProjectsList
│     ├─ ProjectLayout (tabs)
│     │  ├─ ProjectOverview · Board · Backlog · Epics · DepsGraph · ProjectActivity · ProjectSettings
│     │  └─ TaskDrawer (outlet route /t/:num over any tab)
│     ├─ CapturePage (BrainDumpInput → ExtractionProgress → ProposalReview → ResultSummary)
│     ├─ AssistantPanel
│     ├─ SearchPage
│     ├─ Team
│     └─ Settings/* (incl. JiraImportWizard)
├─ features/tasks: TaskCard · TaskRow · StatusPill · PriorityIcon · LabelChips ·
│    AssigneePicker · DueDatePicker · DependencyList · BlockerBanner ·
│    SubtaskList · CommentThread · ActivityTimeline · QuickCreateDialog
├─ features/board: BoardColumn · BoardCard · DragLayer · WipHeader
├─ features/braindump: RecorderModal · TranscriptEditor · ProposalCard ·
│    ConfidenceMark · DuplicateBanner · ApprovalFooter
├─ features/assistant: ChatThread · CitationLink · ToolConfirmCard
├─ features/importer: ConnectForm · MappingTable · DryRunReport · ImportProgress · ImportSummary
└─ ui/: Button · Field · Dialog · Drawer · Menu · Tabs · Toast · Avatar ·
     Pill · Chip · Skeleton · EmptyState · Kbd · CommandPalette
```

## Routing structure

```
/login /signup /reset /verify /invite/:token
/onboarding
/o/:orgSlug
  /                       dashboard
  /me                     my work
  /inbox
  /projects
  /p/:key                 overview
  /p/:key/board
  /p/:key/backlog
  /p/:key/epics
  /p/:key/graph
  /p/:key/activity
  /p/:key/settings
  /p/:key/(board|backlog|…)/t/:num    task drawer (also direct /p/:key/t/:num)
  /capture                brain dump (also modal from topbar)
  /assistant
  /search
  /team
  /settings/(profile|notifications|organization|api|integrations|audit)
  /settings/integrations/jira/(connect|select|mapping|dryrun|run/:id|summary/:id)
```
