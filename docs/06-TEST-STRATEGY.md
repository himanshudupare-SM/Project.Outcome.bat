# Outcome — Test Strategy and Audit Report

**Status of this document:** a record of what is actually tested, what the
tests found, and what is still untested. Every number here came from a run on
this codebase, not from an estimate. Where something is weak, it says so.

Run everything:

```bash
cd app
npm run typecheck && npm run lint     # 0 errors
npm run test                          # unit + integration, needs Postgres
npm run test:e2e                      # real browser, needs the stack running
```

---

## 1. Headline numbers

| Suite | Tests | Result | Statement coverage |
|---|---|---|---|
| Server (`app/server`) | 249 | all pass | **89.09%** (4573/5133) |
| Web (`app/web`) | 78 | all pass | **32.63%** (1315/4030) |
| End-to-end (`app/e2e`) | 38 assertions across 3 journeys | all pass | not measured |
| **Total automated** | **365** | **all pass** | — |

Other quality gates: `tsc --noEmit` clean across all three packages under
`strict`; ESLint 9 with `typescript-eslint` type-checked rules clean, 0
warnings suppressed.

The web number is deliberately unflattering. Test files are excluded from
their own coverage measurement, and the 15 route screens that are covered
only by end-to-end journeys count as 0%. Read section 3 for what that
actually means.

## 2. Coverage in detail

### Server — 89.09%

| Area | Tests | File |
|---|---|---|
| AI brain dump extraction and approval | 38 | `test/braindump.test.ts` |
| Task CRUD, dependencies, board, search | 33 | `test/tasks.test.ts` |
| Orgs, members, invitations, roles | 27 | `test/orgs.test.ts` |
| Jira import mapping and failure handling | 24 | `test/import.test.ts` |
| Projects, statuses, epics, labels | 22 | `test/projects.test.ts` |
| AI assistant answers, citations, actions | 20 | `test/assistant.test.ts` |
| Cross-tenant isolation | 16 | `test/tenancy.test.ts` |
| Schema, constraints, RLS, soft delete, migrations | 17 | `test/database.test.ts` |
| Auth, sessions, CSRF, password change | 11 | `test/auth.test.ts` |
| Index use and query latency | 11 | `test/performance.test.ts` |
| Config and environment validation | 10 | `test/config.test.ts` |
| Concurrent writes and AI budget | 13 | `test/concurrency.test.ts` |
| Platform helpers | 7 | `test/platform.test.ts` |

Tests run against a real PostgreSQL 16 instance — real migrations, real
constraints, real row-level security, real transactions. Nothing about the
data layer is mocked, so a constraint or policy that would fail in production
fails here.

Lowest-covered server files, and why:

| File | Stmts | Reason |
|---|---|---|
| `ai/providers/anthropic.ts` | 4.91% | Live API calls. Exercised only when `ANTHROPIC_API_KEY` is set; the deterministic `FakeProvider` carries the tested logic. **This is a real gap** — see risk R1. |
| `ai/providers/provider.ts`, `platform/ctx.ts` | 0% | Type-only modules; nothing executes. |
| `platform/migrate.ts` | 51.16% | The happy path runs on every test boot; the failure and lock-contention branches do not. |
| `http/app.ts`, `http/routes.ts` | 79%, 67% | Shutdown hooks and the 404 fallback. |

### Web — 32.63%

| Area | Tests | File |
|---|---|---|
| Voice capture states | 19 | `src/__tests__/voice.test.tsx` |
| UI primitives + axe accessibility | 14 | `src/__tests__/ui.test.tsx` |
| Assistant safety behaviour | 13 | `src/__tests__/assistant.test.tsx` |
| Sign-in and sign-up | 12 | `src/__tests__/auth-ui.test.tsx` |
| AI proposal approval gate | 11 | `src/__tests__/proposal-review.test.tsx` |
| API client and error translation | 9 | `src/__tests__/api.test.ts` |

Coverage is concentrated where a defect is expensive rather than spread
evenly:

| File | Stmts | |
|---|---|---|
| `lib/api.ts` | 100% | Every screen goes through it |
| `features/assistant/Assistant.tsx` | 98.44% | AI actions, confirmation gate |
| `routes/Login.tsx` | 98.24% | Credential handling |
| `features/braindump/VoiceRecorder.tsx` | 94.62% | Seven distinct failure modes |
| `features/braindump/ProposalReview.tsx` | 92.28% | Nothing reaches the DB without passing it |
| `ui/index.tsx` | 82.96% | Primitives every screen composes |

At 0% in unit tests, covered by end-to-end journeys only: `Board.tsx`,
`TaskDrawer.tsx`, `JiraImport.tsx`, `Capture.tsx`, and 12 route screens
(`Dashboard`, `Backlog`, `Blockers`, `MyWork`, `Search`, `Team`, `Inbox`,
`Activity`, `Projects`, `Onboarding`, `AcceptInvite`, `AppShell`). See risk R2.

### End-to-end — 3 journeys, 38 assertions

Real Chromium against the running stack. No mocked API, no mocked database.

| Journey | Steps | Covers |
|---|---|---|
| `01-core-journey.mjs` | 17 | Sign in → board → create → edit → comment → record a blocker → audit trail → blockers → backlog filters → My Work → search → team → inbox → drag between columns → sign out |
| `02-braindump-and-voice.mjs` | 12 | Brain dump → extraction → gating on unanswered questions → edit before approving → AI provenance on created tasks → activity attributes the AI actor → re-dumping the same notes is caught as duplicate work → voice degrades with no microphone |
| `03-assistant.mjs` | 9 | Cited facts linking to real tasks → an unanswerable question refused → a change proposed but not applied → confirmation applies it → the result is attributed to AI |

The runner re-seeds the demo data first, so runs are reproducible; two
back-to-back runs both passed 38/38. Every journey also fails if the page
logs a JS error or the API answers 4xx/5xx (401 excepted: an unauthenticated
`/me` probe is expected before login and after sign-out).

## 3. The 14 test categories

| # | Category | Where | State |
|---|---|---|---|
| 1 | Unit | `web/src/__tests__`, `server/test/platform`, `config` | Covered |
| 2 | Integration | All 13 server suites (HTTP → service → real Postgres) | Covered |
| 3 | API contract | Zod schemas asserted per route; problem-details shape | Covered |
| 4 | Authentication | `auth.test.ts`, `auth-ui.test.tsx` | Covered |
| 5 | Multi-tenancy | `tenancy.test.ts` — API and RLS layers separately | Covered |
| 6 | AI behaviour | `braindump.test.ts`, `assistant.test.ts` + UI gates | Covered |
| 7 | Import | `import.test.ts` — mapping, conflicts, partial failure, retry | Covered |
| 8 | Concurrency | `concurrency.test.ts` — 4 real defects found, see §4 | Covered |
| 9 | Performance | `performance.test.ts` — index use + latency budgets | Covered, narrow |
| 10 | Accessibility | axe-core on every rendered primitive; keyboard and focus tests | Partial — see R3 |
| 11 | End-to-end | `app/e2e` — 3 journeys | Covered |
| 12 | Security | CSRF, session invalidation, SSRF, cross-tenant reads, citation forgery | Covered; full audit is Phase 11 |
| 13 | Error handling | Every failure path in `api.ts`; 7 voice failure modes; server refusals surfaced | Covered |
| 14 | Data integrity | `database.test.ts` — constraints, cascades, soft delete, task numbering | Covered |

Not covered as a category: load and soak testing, and browsers other than
Chromium.

## 4. Defects the tests found, and the fixes

Every item below was found by writing a test, and fixed in application code
unless marked otherwise. None were "documented and left".

### Correctness

| # | Defect | Fix |
|---|---|---|
| 1 | **Keyset pagination returned an empty second page.** Cursors were built from the driver's `Date`, which stringifies to a format Postgres cannot parse; routing through `toISOString()` then truncated Postgres's microseconds, so the cursor compared as older than the row it came from. | `timestampToIso()` in `platform/db.ts` reformats the raw text, preserving all digits. Timestamps are ISO strings end to end. |
| 2 | **Non-JSON error responses crashed the UI.** A proxy's HTML 502 page or a truncated body threw a raw `SyntaxError` past the UI's `ApiError` handling, so the screen broke instead of showing an error. | `lib/api.ts` parses defensively and raises a typed `malformed_response` error. |
| 3 | **Live transcription stopped silently mid-recording.** `SpeechRecognition.onend` tested a `phase` value captured when `start()` ran, which was always `'permission'`, so Chrome's periodic session end was never restarted — the tail of a long dump was simply not transcribed. | A `recording` ref holds the live value; pause clears it so a paused session does not resume itself. |
| 4 | **The voice transcript could not be edited.** The review textarea was bound to a trimmed string, so every space typed was immediately stripped: "prepare the GTM deck" became "preparetheGTMdeck". | The textarea holds the raw text. Interim words are folded in on entering review via a single `enterReview()` path, so the tail of speech is not dropped. |
| 5 | **Relative times reported time that had not passed.** `Math.round` turned 30 seconds ago into "1m ago" and 90 minutes into "2h ago". | `Math.floor` throughout `relativeTime`. |
| 6 | **A dialog put focus on its close button.** A CSS selector list matches in document order, not the order written, so the intended "focus the first field" landed on the header's ✕. | Selectors are now tried in preference order. |
| 7 | **Board move direction was inverted.** | Fixed in the component, not the test. |
| 8 | **Topological sort was re-sorted by seed order**, destroying dependency order. | Removed the trailing sort. |
| 9 | **`moveTask` computed a position and discarded it.** | Rewritten as one value-returning transaction. |
| 10 | **Follow-up sentences became duplicate tasks** in extraction. | Merge pass, ordered after dependency inference. |
| 11 | **Prompt scaffolding leaked into extracted task titles.** | Reworded prompt; `extractPayload` uses `lastIndexOf`. |
| 12 | **A `useMemo` called `setState`** in the proposal review. | Moved to `useEffect`. |
| 13 | **The assistant proposed `create_task` with no project.** | The scope project is now decided server-side. |
| 14 | **SQL bound a parameter the query did not reference**, so the statement failed. | Conditional parameter binding. |

### Concurrency (all four found by `concurrency.test.ts`)

| # | Defect | Fix |
|---|---|---|
| 15 | **A concurrent board move returned a spurious 404.** `FOR UPDATE` with a JOIN made Postgres re-check the join against a stale tuple under EvalPlanQual, and the row read as missing. | Lock the `tasks` row alone, then read the status category separately. |
| 16 | **Two cards dropped at once got identical positions.** | Position is resolved inside the update transaction under a per-column advisory lock. |
| 17 | **Concurrent dependency edges could create a cycle**, because each transaction's cycle check ran before the other's insert was visible. | A per-project advisory lock spans the check and the insert. |
| 18 | **The daily AI budget could be overspent.** Both AI entry points counted rows and then wrote one, so simultaneous requests all read a count below the limit and all proceeded. Counting rows also could not be made atomic without holding a lock across the model call, which would serialize every AI request in the org behind a network round trip. | Migration `0006` adds `ai_usage_daily`; `reserveAiCall()` increments and reads it in a single upsert, so reservation is atomic and holds no lock across I/O. Both brain dumps and assistant questions draw on the same counter. A refused call rolls back and does not consume a slot. |

### Row-level security

| # | Defect | Fix |
|---|---|---|
| 19 | **RLS threw `22P02` after a transaction ended.** The `app.org_id` GUC reverts to an empty string, and `''::uuid` is not a valid cast. | Migration `0005`: `app_current_org()` wraps the setting in `NULLIF`, so an unset context yields NULL and the policy fails closed. All tenant reads additionally go through the org-scoped `orgDb()`. |

### Test infrastructure — my errors, not the app's

| # | Problem | Fix |
|---|---|---|
| 20 | **Components leaked between tests.** With `globals: false`, Testing Library cannot register its own teardown, so a mounted dialog's body scroll lock carried into the next test. | Explicit `afterEach(cleanup)` in `test-setup.ts`. |
| 21 | **Coverage counted the test files themselves**, inflating web coverage from a real 32.63% to a flattering 47.21%. | `src/__tests__/**` excluded from the coverage measurement. |
| 22 | **An end-to-end test passed while the request behind it returned 500.** It asserted on a stale "Applied" label. | Hardened to `waitForResponse` plus a specific locator — which then exposed the real 500. |
| 23 | **A "first page took 15.8 seconds" result was a cold-start artifact.** | Warmup loop before timing. |
| 24 | **`EXPLAIN` assertions were testing Postgres's cost model**, not the schema; a sequential scan legitimately wins on 1,200 rows. | Assert the indexes exist, plus a plan check with `enable_seqscan = off`. |
| 25 | **Journey 02 depended on leftover data.** On a second run the duplicate detector correctly pre-unchecked every card and the journey failed on its own output. | The runner re-seeds first, and duplicate detection got its own explicit assertion instead of being an accident. |
| 26 | **A test hardcoded the list of migration files**, so adding one broke an unrelated suite. | It now reads `db/migrations` and compares — which also catches a recorded migration whose file has been deleted. |
| 27 | Three test expectations were wrong, not the app: 30 seconds ago really is "1m ago" under rounding (then fixed properly, #5); suspected duplicates are deliberately pre-unchecked; a per-field error legitimately carries `role="alert"`. | Expectations corrected. |

## 5. Remaining risks

Ordered by how much damage each could do in production.

**R1 — The live Anthropic provider is barely covered (4.91%).**
All AI logic is tested through the deterministic `FakeProvider`, which is why
the pipeline can be tested offline with no key. But real model output is
messier than the fake's: malformed JSON, refusals, truncation, rate limits,
timeouts. The schema validation and sanitisation those hit are tested; the
provider's own retry and error mapping are not. *Mitigation: a contract test
run against the live API in a nightly job, not on every commit.*

**R2 — 15 route screens have no unit tests.** They are covered by
end-to-end journeys, which is real coverage but coarse: a journey proves the
happy path renders, not that an empty state, a permission error, or a failed
mutation renders correctly. `TaskDrawer.tsx` (568 lines) and `JiraImport.tsx`
(573 lines) are the two largest untested components and both handle
mutations. *Mitigation: unit tests for their error and empty states, in the
order listed in section 2.*

**R3 — Accessibility checking is structural only.** axe-core runs in jsdom,
which has no layout and no paint, so colour contrast cannot be evaluated and
is explicitly disabled. Focus order, labels, ARIA wiring and keyboard traps
are tested. Contrast has been checked by hand against the token palette but
is not enforced by a test. *Mitigation: axe against real Chromium in the
end-to-end run, where contrast is measurable.*

**R4 — Performance testing is narrow.** It asserts that the hot-path indexes
exist and that queries stay inside a latency budget on ~1,200 rows. That
catches a missing index; it says nothing about behaviour at a million tasks,
under concurrent load, or with connection-pool contention. No load or soak
test exists. *Mitigation: a k6 or similar profile against seeded volume data
before any real traffic.*

**R5 — One browser.** All end-to-end runs use Chromium. Safari and Firefox
are untested, and `SpeechRecognition` — the whole live-transcription path —
does not exist in Firefox at all. The fallback for a missing engine is unit
tested, but never on a real Firefox.

**R6 — Migrations are only tested forward, from empty.** Every test run
applies all migrations to a fresh database. No test applies them to a
database holding real data, and there are no down migrations by design
(forward-only, expand/contract). A migration that is correct on empty and
wrong on populated data would not be caught here.

**R7 — The e2e runner re-seeds by default**, which is right for a dev
database and destructive anywhere else. `E2E_SKIP_SEED=1` exists, but the
safe behaviour is opt-in rather than the default. Worth inverting before this
can point at a shared environment.
