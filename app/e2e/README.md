# End-to-end journeys

Playwright-driven scripts that exercise the real stack in a real browser: no
mocked API, no mocked database. They are the last line of the test pyramid —
if one of these fails, a user is affected.

## Running them

```bash
# Terminal 1 — stack must be running and migrated/seeded
npm run db:migrate && npm run db:seed && npm run dev

# Terminal 2
npm run test:e2e
```

Each journey can also be run on its own:

```bash
node e2e/01-core-journey.mjs
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `E2E_BASE_URL` | `http://127.0.0.1:5173` | Where the web app is served |
| `E2E_EMAIL` / `E2E_PASSWORD` | seeded demo account | Login used by every journey |
| `E2E_ORG` | `northwind` | Org slug the seed creates |
| `E2E_ARTIFACTS` | `e2e/artifacts` | Where screenshots are written |
| `CHROMIUM_PATH` | `/opt/pw-browsers/chromium` | Browser binary |

## What each journey covers

| Script | Journey |
|---|---|
| `01-core-journey.mjs` | Sign in → board → create a task → edit it → comment → record a blocker → audit trail → blockers view → backlog filters → My Work → search → team → inbox → drag between columns → sign out |
| `02-braindump-and-voice.mjs` | Brain dump → extraction → review gating on unanswered questions → edit before approving → tasks created with AI provenance → activity attributes the AI actor → voice capture degrades gracefully with no microphone |
| `03-assistant.mjs` | Ask a question → cited facts that link to real tasks → a question it cannot answer is refused → a requested change is proposed, not applied → confirming applies it → the created task is attributed to AI |

Screenshots are written to the artifacts directory on both success and
failure; a failing run also writes `*-failure.png` at the point of failure.

## Notes

- Every script fails the run if the page logs a JS error or the API answers
  4xx/5xx (401 excepted — an unauthenticated `/me` probe is expected before
  login and after sign-out).
- Assertions target user-visible outcomes and, for mutations, the actual HTTP
  response — an earlier version of `03` passed on a stale "Applied" label
  while the request behind it was returning 500.
