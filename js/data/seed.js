/* ============================================================================
 * LAYER 1 — EXECUTION DATA
 *
 * Mocked seed for one example project. In a real deployment this layer would
 * be populated by an event-driven execution graph fed from work trackers,
 * VCS and comms tools; everything downstream (forecast, recommendations, UI)
 * only reads this shape, so the source can be swapped without touching them.
 *
 * Shape:
 *   project → milestones → workItems → dependencies → approvals/decisions
 *           → risks → confidenceHistory
 *
 * Durations and ages are in WORKING DAYS (Mon–Fri).
 * ========================================================================== */
(function (global) {
  const OEE = (global.OEE = global.OEE || {});

  OEE.seed = {
    project: {
      id: 'PRJ-ATLAS',
      name: 'Atlas — Checkout Platform Migration',
      goal: 'Move checkout to the new payment provider before the contract renewal date',
      lead: 'dana',
      startDate: '2026-07-06',
      targetDate: '2026-09-30',
      asOf: '2026-09-02' // "today" for the demo — keeps every number deterministic
    },

    people: [
      { id: 'dana',   name: 'Dana Whitfield', role: 'Delivery lead',      team: 'delivery' },
      { id: 'priya',  name: 'Priya Raman',    role: 'Backend engineer',   team: 'backend' },
      { id: 'marco',  name: 'Marco Silva',    role: 'Backend engineer',   team: 'backend' },
      { id: 'lena',   name: 'Lena Fischer',   role: 'Payments engineer',  team: 'backend' },
      { id: 'jules',  name: 'Jules Tan',      role: 'Frontend engineer',  team: 'frontend' },
      { id: 'aisha',  name: 'Aisha Bello',    role: 'Frontend engineer',  team: 'frontend' },
      { id: 'sam',    name: 'Sam Ortiz',      role: 'QA engineer',        team: 'qa' },
      { id: 'ingrid', name: 'Ingrid Holm',    role: 'Security engineer',  team: 'security' },
      { id: 'rohan',  name: 'Rohan Mehta',    role: 'Legal counsel',      team: 'legal' }
    ],

    milestones: [
      { id: 'M1', name: 'Payment provider integration', due: '2026-08-07', done: true, completedOn: '2026-08-06' },
      { id: 'M2', name: 'Checkout flows feature-complete', due: '2026-09-15', done: false },
      { id: 'M3', name: 'Compliance & quality sign-off', due: '2026-09-22', done: false },
      { id: 'M4', name: 'Production cutover', due: '2026-09-30', done: false }
    ],

    /* Approvals and decisions are first-class blockers, not task metadata.
     * expectedRemainingWorkdays = the team's current best estimate of time to
     * resolution (a live system would infer this from approver SLA + history). */
    approvals: [
      {
        id: 'APR-201', kind: 'approval',
        title: 'DPA amendment — provider vault access',
        approverGroup: 'Legal', approver: 'rohan',
        requestedOn: '2026-08-25', slaWorkdays: 3,
        status: 'pending', expectedRemainingWorkdays: 5,
        blocksItem: 'WI-112',
        note: 'Provider will not enable production vault access until the amended data-processing agreement is countersigned.'
      },
      {
        id: 'APR-330', kind: 'review',
        title: 'PCI evidence pack — security review',
        approverGroup: 'Security', approver: 'ingrid',
        requestedOn: '2026-08-27', slaWorkdays: 5,
        status: 'pending', expectedRemainingWorkdays: 4,
        blocksItem: 'WI-124',
        note: 'Single reviewer; review is queued behind the on-call rotation.'
      },
      {
        id: 'DEC-77', kind: 'decision',
        title: 'Error-state UX copy & retry flows',
        approverGroup: 'Product', approver: 'dana',
        requestedOn: '2026-08-27', slaWorkdays: 2,
        status: 'pending', expectedRemainingWorkdays: 2,
        blocksItem: 'WI-122',
        note: 'Two competing proposals; needs a product call, not more design work.'
      },
      {
        id: 'APR-118', kind: 'approval',
        title: 'Provider fee schedule sign-off',
        approverGroup: 'Finance', approver: 'dana',
        requestedOn: '2026-08-10', slaWorkdays: 3,
        status: 'approved', resolvedOn: '2026-08-14',
        blocksItem: null,
        note: 'Resolved — kept for history.'
      }
    ],

    /* timeInState = working days accumulated in each state since the item
     * started (the execution-history side of the model; drives Turnaround).
     * remainingWorkdays = current estimate of work left (drives the forecast). */
    workItems: [
      // -- M1 (done) --------------------------------------------------------
      { id: 'WI-101', title: 'Provider integration spike & contract tests', milestone: 'M1', owner: 'lena',
        status: 'done', estimateWorkdays: 5, remainingWorkdays: 0, dependsOn: [],
        timeInState: { active: 5, waiting: 1, blocked: 0, review: 1 } },
      { id: 'WI-103', title: 'Payment provider adapter service', milestone: 'M1', owner: 'marco',
        status: 'done', estimateWorkdays: 8, remainingWorkdays: 0, dependsOn: ['WI-101'],
        timeInState: { active: 8, waiting: 2, blocked: 1, review: 2 } },
      { id: 'WI-105', title: 'Sandbox environment & test-card matrix', milestone: 'M1', owner: 'sam',
        status: 'done', estimateWorkdays: 4, remainingWorkdays: 0, dependsOn: ['WI-101'],
        timeInState: { active: 4, waiting: 3, blocked: 2, review: 1 } },
      { id: 'WI-108', title: 'Data-residency assessment', milestone: 'M1', owner: 'lena',
        status: 'done', estimateWorkdays: 3, remainingWorkdays: 0, dependsOn: [],
        timeInState: { active: 3, waiting: 2, blocked: 0, review: 2 } },

      // -- M2: checkout flows ----------------------------------------------
      { id: 'WI-112', title: 'Tokenization migration — provider vault cutover', milestone: 'M2', owner: 'lena',
        status: 'blocked', estimateWorkdays: 9, remainingWorkdays: 5, dependsOn: ['WI-103'],
        blockedBy: 'APR-201',
        timeInState: { active: 4, waiting: 1, blocked: 6, review: 0 } },
      { id: 'WI-115', title: 'Webhook idempotency & retry hardening', milestone: 'M2', owner: 'priya',
        status: 'active', estimateWorkdays: 8, remainingWorkdays: 2, dependsOn: ['WI-103'],
        timeInState: { active: 5, waiting: 1, blocked: 0, review: 1 } },
      { id: 'WI-116', title: 'Provider webhook consumers', milestone: 'M2', owner: 'marco',
        status: 'active', estimateWorkdays: 6, remainingWorkdays: 2, dependsOn: ['WI-103'],
        timeInState: { active: 4, waiting: 1, blocked: 0, review: 1 } },
      { id: 'WI-119', title: 'Refunds & partial-capture migration', milestone: 'M2', owner: 'priya',
        status: 'active', estimateWorkdays: 8, remainingWorkdays: 5, dependsOn: ['WI-103'],
        timeInState: { active: 3, waiting: 2, blocked: 2, review: 0 } },
      { id: 'WI-118', title: 'Stored payment methods — backfill job', milestone: 'M2', owner: 'marco',
        status: 'not_started', estimateWorkdays: 3, remainingWorkdays: 3, dependsOn: ['WI-112'],
        timeInState: { active: 0, waiting: 0, blocked: 0, review: 0 } },
      { id: 'WI-121', title: 'Checkout fallback & provider-retry path', milestone: 'M2', owner: 'priya',
        status: 'waiting', estimateWorkdays: 4, remainingWorkdays: 4, dependsOn: ['WI-112'],
        timeInState: { active: 0, waiting: 3, blocked: 0, review: 0 } },
      { id: 'WI-122', title: 'Checkout error states & recovery UX', milestone: 'M2', owner: 'aisha',
        status: 'waiting', estimateWorkdays: 6, remainingWorkdays: 3, dependsOn: [],
        blockedBy: 'DEC-77',
        timeInState: { active: 3, waiting: 4, blocked: 0, review: 0 } },
      { id: 'WI-130', title: 'Checkout UI migration to new payment fields', milestone: 'M2', owner: 'jules',
        status: 'done', estimateWorkdays: 9, remainingWorkdays: 0, dependsOn: ['WI-103'],
        timeInState: { active: 7, waiting: 2, blocked: 0, review: 2 } },
      { id: 'WI-131', title: 'Saved-card vault UI polish', milestone: 'M2', owner: 'jules',
        status: 'active', estimateWorkdays: 5, remainingWorkdays: 4, dependsOn: ['WI-130'],
        descopable: true, descopeNote: 'Cosmetic pass on the saved-card wallet; launch-blocking scope is already covered by WI-130.',
        timeInState: { active: 2, waiting: 1, blocked: 0, review: 0 } },

      // -- M3: compliance & quality ----------------------------------------
      { id: 'WI-124', title: 'PCI DSS evidence pack', milestone: 'M3', owner: 'lena',
        status: 'review', estimateWorkdays: 6, remainingWorkdays: 0, dependsOn: ['WI-108'],
        blockedBy: 'APR-330',
        timeInState: { active: 5, waiting: 1, blocked: 0, review: 4 } },
      { id: 'WI-133', title: 'Pen-test findings — remediation', milestone: 'M3', owner: 'ingrid',
        status: 'not_started', estimateWorkdays: 4, remainingWorkdays: 4, dependsOn: ['WI-124'],
        timeInState: { active: 0, waiting: 0, blocked: 0, review: 0 } },
      { id: 'WI-127', title: 'End-to-end payment regression suite', milestone: 'M3', owner: 'sam',
        status: 'not_started', estimateWorkdays: 5, remainingWorkdays: 5,
        dependsOn: ['WI-118', 'WI-119', 'WI-121', 'WI-122', 'WI-131'],
        stageable: true,
        stageNote: 'Smoke suite can run continuously against finished flows; only the final full pass must wait for the last stream.',
        timeInState: { active: 0, waiting: 0, blocked: 0, review: 0 } },

      // -- M4: cutover ------------------------------------------------------
      { id: 'WI-140', title: 'Cutover runbook & production dry-run', milestone: 'M4', owner: 'dana',
        status: 'not_started', estimateWorkdays: 3, remainingWorkdays: 3, dependsOn: ['WI-127', 'WI-133'],
        timeInState: { active: 0, waiting: 0, blocked: 0, review: 0 } },
      { id: 'WI-141', title: 'Production cutover & hypercare window', milestone: 'M4', owner: 'dana',
        status: 'not_started', estimateWorkdays: 3, remainingWorkdays: 3, dependsOn: ['WI-140'],
        timeInState: { active: 0, waiting: 0, blocked: 0, review: 0 } }
    ],

    /* Register risks that are watched but not (yet) driving the forecast. */
    risks: [
      { id: 'RSK-2', title: 'Provider sandbox instability', note: 'Sandbox outages cost ~2 days in August; a recurrence during regression would land on the critical path.' },
      { id: 'RSK-3', title: 'Hypercare staffing', note: 'Cutover week overlaps two planned PTOs on the backend team.' }
    ],

    /* Weekly Outcome Confidence snapshots (what the engine computed each
     * Friday). The current value is computed live, not seeded. */
    confidenceHistory: [
      { date: '2026-07-10', value: 86 },
      { date: '2026-07-17', value: 82 },
      { date: '2026-07-24', value: 76 },
      { date: '2026-07-31', value: 69 },
      { date: '2026-08-07', value: 61 },
      { date: '2026-08-14', value: 52 },
      { date: '2026-08-21', value: 41 },
      { date: '2026-08-28', value: 29 }
    ]
  };
})(typeof window !== 'undefined' ? window : globalThis);
