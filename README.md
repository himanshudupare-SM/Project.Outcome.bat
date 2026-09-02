# Outcome Execution Engine — prototype

A demo/proof-of-concept web app that shows whether a project's **outcome** will
happen, **why** it might not, and **what to do about it** — shifting from
"tracking work" to "predicting and recovering outcomes."

**Hypothesis being tested:** if a project's execution data (tasks, dependencies,
decisions/approvals, wait/blocked time) is combined into one view, we can
predict delivery risk, explain its root causes in plain language, and recommend
specific interventions — earlier than a manager would discover the same things
through status meetings.

This is a **single-project demo**, not a Jira replacement or a multi-project PM
tool. There is **no live Jira/GitHub/Slack integration**: one example project
("Atlas — Checkout Platform Migration") is seeded with realistic mocked
execution data so the reasoning and UX can be evaluated.

## Run it

No build step, no dependencies:

```sh
# from the repo root — any static file server works
python3 -m http.server 8000
# then open http://localhost:8000
```

(Opening `index.html` directly from disk also works — the app is plain
scripts, not ES modules.)

To verify the engine without a browser:

```sh
node tools/selfcheck.js
```

This prints the computed schedule, causes and plan, and asserts the demo
scenario's key numbers (baseline 4 working days late, 3 ranked causes,
3 ranked interventions, plan recovers the target date).

## What the demo shows

Seeded "today" is **Sep 2, 2026**; the target is **Sep 30, 2026**.

- **Baseline:** forecast **Oct 6** (4 working days late), outcome confidence
  **22%** and falling week over week.
- **Top causes**, in plain English and ranked by *computed* schedule impact:
  a legal approval pending 6 working days that blocks a 6-item cascade, a
  single 5-day regression gate every stream converges into, and one engineer's
  serialized queue.
- **Recommended interventions**, ranked by computed marginal impact: escalate
  the approval (−3 wd), stage the regression (−2 wd), rebalance one item
  (−1 wd). Two more candidates (add a security reviewer, descope a UI polish
  item) are shown as *evaluated — no impact*, because knowing what **not** to
  escalate is part of the value.
- **Before/After:** applying interventions re-runs the whole engine and flips
  the dashboard into a simulated view — **Sep 28, 2 working days early, 72%
  confidence** with all three applied — with a comparison strip and a
  baseline/plan toggle.

Nothing user-facing is hand-written: every date, day-count, ranking and impact
comes out of the scheduling model, so toggling interventions produces honest,
interacting effects (e.g. an action worth 0 days alone becomes worth 1 day once
the approval above it is escalated).

## Architecture

Modular layers, each of which only reads the one below it — designed so the
seed could later be replaced by a real event-driven execution graph without
touching the reasoning or UI:

| Layer | Files | Responsibility |
|---|---|---|
| 1. Execution data | `js/data/seed.js` | Project → milestones → work items → dependencies → approvals/decisions → risks; per-item time-in-state (active/waiting/blocked/review) |
| 2. Risk & forecast | `js/engine/calendar.js`, `graph.js`, `forecast.js` | Working-day calendar; dependency graph; greedy resource-constrained scheduler; Outcome Confidence model; sequential root-cause attribution |
| 3. Recommendations | `js/engine/recommendations.js` | Generates concrete interventions from data patterns (escalate / stage / rebalance / add reviewer / descope) and ranks them by computed marginal gain |
| 4. UI | `js/ui/*.js`, `js/main.js`, `css/styles.css` | Renders evaluations; holds only the applied-intervention set + view toggle as state |

### How the forecast works

- A **greedy earliest-start scheduler** walks the dependency graph in working
  days: an item starts when its dependencies finish, its blocking
  approval/decision is expected to resolve, and its owner is free (one item per
  owner at a time). Each scheduled start records what bound it — a dependency,
  an approval, or an owner queue — which powers the "driving path" and cascade
  views.
- **Outcome Confidence** = P(finish ≤ target) under a normal error model whose
  spread widens with observed execution risk: blocked items, approvals past
  SLA, and owner contention (`CONFIG` in `js/engine/forecast.js`).
- **Root causes** are ranked by **sequential attribution**: neutralize the
  driver with the biggest computed schedule gain, re-run, repeat. This answers
  the question a manager actually has — "what's the bottleneck now, and what
  becomes the bottleneck once I fix it?"
- **Interventions** are simulated as overlay overrides (never mutating the
  seed) and re-evaluated through the same engine, so combined effects are
  computed, not summed.

## Honest limitations (it's a demo)

- One seeded project with a fixed "as of" date; durations are point estimates,
  not distributions (confidence uses a simple parametric spread, not Monte
  Carlo).
- The scheduler is deliberately simple: no preemption, no partial parallelism
  within an item, no calendars per person.
- Approval "expected remaining days" is seeded; a real system would infer it
  from approver SLA and history.
- Time-in-state history is seeded, not event-sourced.
