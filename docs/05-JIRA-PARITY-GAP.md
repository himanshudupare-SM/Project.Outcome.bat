# Jira parity gap report

**Scope:** what the Jira import in `app/server/src/modules/importer/` actually
moves today, and what Outcome does **not** support. Every "supported" row below
is covered by a test in `app/server/test/import.test.ts`; nothing is claimed on
the strength of intent.

**Standing rule:** this is not a Jira clone. Some gaps are deliberate product
decisions (we are not building a workflow editor); others are simply not built
yet. The table says which is which, because a buyer needs to know the difference.

---

## 1. Import coverage

| Jira concept | Status | Notes |
|---|---|---|
| Projects | **Imported** | Into a new project, or merged into an existing one (chosen in the mapping step). |
| Epics | **Imported** | Jira epics become Outcome epics; the epic link on issues is preserved. |
| Stories / Tasks / Bugs | **Imported** | All become tasks; the Jira issue type is not preserved as a field (see §2). |
| Subtasks | **Imported** | Nested one level under the parent task. Skipped with a reason when the parent failed to import. Can be excluded in the mapping. |
| Statuses | **Imported via mapping** | Mapped by the user onto our six fixed categories, with guesses pre-filled. Unmapped statuses land in Backlog and are reported per issue. |
| Priorities | **Imported via mapping** | Jira priority names mapped onto urgent/high/medium/low/none. |
| Assignees | **Imported via mapping** | Matched by display name, user-confirmable. An unmatched Jira user leaves the task **unassigned** — never guessed. |
| Reporter | **Preserved as text** | Written into the task description ("reported by …"), because there is no reporter field. |
| Labels | **Imported** | Created in the org label set on demand, capped at 8 per issue. |
| Due dates | **Imported** | |
| Comments | **Imported** | Body flattened from Atlassian Document Format to text; the original Jira author and date are preserved **in the comment body** (see §2). Can be excluded in the mapping. |
| Dependencies ("is blocked by" links) | **Imported** | Become real dependency edges. A link that would create a cycle is skipped and counted, not imported. |
| Descriptions (rich text) | **Imported as text** | ADF is flattened: paragraphs, headings, lists, code blocks and mentions. Formatting fidelity is lost. |
| Attachments | **NOT imported** | Counted and listed in the dry-run report as unsupported. Attachment storage exists in the schema but no file transfer is implemented. |
| Sprints | **NOT imported** | Sprints/cycles are post-MVP in the product itself. Sprint membership is dropped. |
| Story points / estimates | **NOT imported** | We model estimates in days; no mapping is offered, so the value is dropped rather than mistranslated. |
| Components | **NOT imported** | Would be mapped to labels; not built. |
| Custom fields | **NOT imported** | No custom-field support in the product. |
| Worklogs / time tracking | **NOT imported** | Not modelled. |
| Versions / releases (fixVersion) | **NOT imported** | Not modelled. |
| Watchers | **NOT imported** | Watchers exist in Outcome but are set from local activity, not Jira. |
| Issue history / changelog | **NOT imported** | Our activity log starts at import time; one `import_run` event records the import itself. |
| Workflows and transitions | **NOT imported — by design** | We deliberately do not offer a workflow engine at MVP. |
| Permission schemes | **NOT imported — by design** | Outcome has a simpler org/project role matrix. |
| Automation rules | **NOT imported** | Not built. |
| Boards / board configuration | **NOT imported** | Our board derives from project statuses. |
| Dashboards / filters / JQL | **NOT imported** | Search uses our own filter grammar. |
| Other issue-link types (relates to, duplicates, clones) | **NOT imported** | Only "is blocked by" maps cleanly onto a dependency; the rest are dropped rather than flattened into something wrong. |

## 2. Known fidelity losses (things that import, but not perfectly)

1. **Comment authorship.** Jira users are not Outcome accounts, so an imported
   comment is stored as authored by the importing admin with the original
   author and date quoted in the body. It is honest but not equivalent.
2. **Rich text.** ADF becomes plain text/markdown-ish; tables, panels, media
   and macros are lost.
3. **Issue type.** Bug/Story/Task all collapse into "task". A `bug` label is
   *not* auto-applied (that would be inventing data); use the mapping's labels
   if you need the distinction.
4. **Duplicate handling is title-based.** Re-importing skips issues whose title
   already exists in the destination project. Two genuinely different issues
   sharing a title will be treated as duplicates.
5. **Ordering.** Imported tasks are ordered by creation date, not Jira rank.
6. **No incremental sync.** This is a one-way migration, not a live
   integration: running it again skips duplicates but does not update
   previously imported tasks or detect Jira-side deletions.

## 3. Operational limits

- **10,000 issues per project** per run (logged and truncated beyond that).
- **200 comments per issue**, 8 labels per issue (both truncated).
- Import runs **synchronously in the request** in this build. For a large
  project that means a long-running request; the architecture puts this in a
  background queue (`import.jira`), which is the next change needed before this
  is used on a big Jira instance. This is the most significant operational gap.
- Jira credentials are **not persisted** in this build: they are supplied per
  call and used for that call only. The `integrations` table exists with an
  encrypted-credentials column for when connected (rather than one-shot)
  imports are added.
- `import_runs` / `import_items` record every record's outcome, so a run can be
  inspected and its failures retried; retry re-fetches from Jira using the
  run's stored mapping.

## 4. Security notes specific to import

The Jira base URL is user-supplied, which makes this the app's only
outbound-fetch surface. `assertSafeBaseUrl` enforces: https only, no
credentials in the URL, default port only, no redirects followed, and the
resolved address must not be loopback, link-local (including the cloud
metadata address), or RFC1918/unique-local. These are covered by tests.

## 5. What would close the biggest gaps, in order

1. Move import execution to the background queue with resumable progress (P0
   before real customer migrations).
2. Attachments: stream Jira attachments into object storage.
3. Story points → estimate mapping with an explicit user-chosen ratio.
4. Components → labels mapping.
5. Sprint import, once cycles ship in the product.
6. Comment authorship via invited-user matching (import creates invitations,
   then re-attributes on acceptance).
