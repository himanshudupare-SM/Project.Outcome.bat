# Outcome — application

AI-native work execution tool. See `../docs/` for the PRD, architecture,
database design and UX specification.

## Layout

```
app/
  shared/   Zod schemas + enums shared by API and UI (one source of truth)
  server/   Fastify API, SQL-first data layer, migrations, seed, tests
  web/      React + Vite SPA
```

## Local development

Requires Node 22+ and PostgreSQL 16.

```sh
# 1. database (once)
createdb outcome_dev && createdb outcome_test

# 2. dependencies
npm install

# 3. configuration
cp server/.env.example server/.env    # then edit DATABASE_URL / SESSION_SECRET

# 4. schema + demo data
npm run db:migrate
npm run db:seed        # prints the demo sign-in credentials

# 5. run (two terminals, or `npm run dev` for both)
npm run dev --workspace=@outcome/server   # http://localhost:3001
npm run dev --workspace=@outcome/web      # http://localhost:5173
```

Sign in with the credentials the seed prints (`dana@example.com`).

## Checks

```sh
npm run typecheck    # all three packages, strict
npm run lint         # eslint, type-aware rules
npm run test         # integration tests against outcome_test
```

Tests run against a real PostgreSQL database (no mocked persistence), so
`DATABASE_URL` for `outcome_test` must be reachable. The schema is migrated
and truncated automatically per run.

## Notes

- `AI_PROVIDER=fake` is the default: a deterministic local provider so the app
  and tests run with no API key and no network.
- Migrations are forward-only plain SQL in `server/db/migrations/`, applied in
  filename order and recorded in `schema_migrations`.
- Tenant isolation is enforced twice: org-scoped repositories, plus fail-closed
  PostgreSQL row-level security armed per transaction.
