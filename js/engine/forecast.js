/* ============================================================================
 * LAYER 2 — RISK & FORECAST LOGIC
 *
 * Everything here is computed from the execution data — no hand-written
 * forecasts. The same evaluate() runs for the baseline and for any simulated
 * plan, which is what makes the before/after view honest.
 *
 * Model (deliberately simple, but real):
 *  - A greedy resource-constrained scheduler walks the dependency graph in
 *    working days: an item starts when its dependencies are done, its blocking
 *    approval is expected to resolve, and its owner is free.
 *  - Outcome Confidence = P(finish <= target) under a normal error model whose
 *    spread widens with observed execution risk (blocked items, approvals past
 *    SLA, owner contention).
 *  - Root causes are ranked by SEQUENTIAL attribution: neutralize the driver
 *    with the biggest schedule gain, re-run, repeat. That answers the question
 *    a manager actually has: "what is the bottleneck now, and what becomes the
 *    bottleneck once I fix it?"
 *
 * "mods" are overlay overrides used for simulation (never mutating the seed):
 *   { approvalExpected: {APR-1: days}, remaining: {WI-1: days},
 *     owner: {WI-1: personId}, unboundedOwner: {personId: true},
 *     descoped: {WI-1: true} }
 * ========================================================================== */
(function (global) {
  const OEE = (global.OEE = global.OEE || {});
  const cal = OEE.calendar;
  const graph = OEE.graph;

  const CONFIG = {
    baseSigmaWd: 2.2,        // irreducible forecast noise, in working days
    sigmaPerBlockedItem: 0.7, // each item stuck behind a slow approval/review
    sigmaPerOverSlaDay: 0.35, // worst pending approval, days past its SLA
    sigmaPerContention: 0.6,  // each schedule start set by owner capacity
    blockedThresholdWd: 2,    // approvals expected to clear in <=2d don't count
    minConfidence: 2,
    maxConfidence: 98
  };

  function mergeMods(a, b) {
    const out = {};
    for (const key of ['approvalExpected', 'remaining', 'owner', 'unboundedOwner', 'descoped']) {
      out[key] = Object.assign({}, (a && a[key]) || {}, (b && b[key]) || {});
    }
    return out;
  }

  function phi(x) { // standard normal CDF (Abramowitz–Stegun 26.2.17)
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804 * Math.exp((-x * x) / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  }

  function effective(data, mods) {
    mods = mergeMods(mods, null);
    const items = data.workItems.map((w) => ({
      ...w,
      remainingWorkdays: mods.remaining[w.id] != null ? mods.remaining[w.id] : w.remainingWorkdays,
      owner: mods.owner[w.id] || w.owner,
      descoped: !!mods.descoped[w.id]
    }));
    const approvals = data.approvals.map((a) => ({
      ...a,
      expectedRemainingWorkdays:
        mods.approvalExpected[a.id] != null ? mods.approvalExpected[a.id] : a.expectedRemainingWorkdays
    }));
    return { items, approvals, unboundedOwner: mods.unboundedOwner };
  }

  /* Greedy earliest-start list scheduler. Deterministic: among schedulable
   * items, pick the one that can start soonest (ties: earliest ready, then
   * seed order). Returns per-item {start, finish, boundBy} in workdays from
   * asOf (day 0 = start of "today"). */
  function schedule(data, mods) {
    const eff = effective(data, mods);
    const asOf = data.project.asOf;
    const aprById = new Map(eff.approvals.map((a) => [a.id, a]));
    const result = new Map();
    const ownerFree = new Map();

    const open = eff.items.filter((w) => w.status !== 'done' && !w.descoped);
    const doneIds = new Set(eff.items.filter((w) => w.status === 'done' || w.descoped).map((w) => w.id));
    const seedPos = new Map(data.workItems.map((w, i) => [w.id, i]));
    const pending = new Set(open.map((w) => w.id));
    const byId = new Map(open.map((w) => [w.id, w]));

    function readyInfo(w) {
      let depMax = 0;
      let depId = null;
      for (const dep of w.dependsOn || []) {
        if (doneIds.has(dep)) continue;
        if (!result.has(dep)) return null; // dependency not yet scheduled
        const f = result.get(dep).finish;
        if (f > depMax) { depMax = f; depId = dep; }
      }
      let aprDelay = 0;
      let aprId = null;
      if (w.blockedBy) {
        const apr = aprById.get(w.blockedBy);
        if (apr && apr.status === 'pending') {
          aprDelay = Math.max(0, apr.expectedRemainingWorkdays);
          aprId = apr.id;
        }
      }
      const ready = Math.max(depMax, aprDelay);
      return { ready, depMax, depId, aprDelay, aprId };
    }

    while (pending.size) {
      let pick = null;
      for (const id of pending) {
        const w = byId.get(id);
        const info = readyInfo(w);
        if (!info) continue;
        const unbounded = eff.unboundedOwner[w.owner];
        const free = unbounded ? 0 : ownerFree.get(w.owner) || 0;
        const start = w.remainingWorkdays === 0 ? info.ready : Math.max(info.ready, free);
        const cand = { id, w, info, start, unbounded };
        if (
          !pick ||
          cand.start < pick.start ||
          (cand.start === pick.start && cand.info.ready < pick.info.ready) ||
          (cand.start === pick.start && cand.info.ready === pick.info.ready &&
            seedPos.get(cand.id) < seedPos.get(pick.id))
        ) {
          pick = cand;
        }
      }
      if (!pick) throw new Error('Unschedulable items (cycle or missing dependency)');

      const { id, w, info, start } = pick;
      const finish = start + w.remainingWorkdays;
      let boundBy = { type: 'ready' };
      if (start > info.ready) boundBy = { type: 'owner', ref: w.owner };
      else if (info.aprDelay >= info.depMax && info.aprDelay > 0) boundBy = { type: 'approval', ref: info.aprId };
      else if (info.depMax > 0) boundBy = { type: 'dependency', ref: info.depId };

      result.set(id, {
        start,
        finish,
        boundBy,
        startDate: cal.dayToDate(asOf, start + 1),
        finishDate: cal.dayToDate(asOf, finish)
      });
      if (w.remainingWorkdays > 0 && !pick.unbounded) ownerFree.set(w.owner, finish);
      pending.delete(id);
    }
    return result;
  }

  function approvalAgeWd(data, apr) {
    if (apr.status !== 'pending') return 0;
    // age = workdays since requested, excluding the request day itself
    return Math.max(0, cal.workdaysInclusive(apr.requestedOn, data.project.asOf) - 1);
  }

  /* Full evaluation: schedule → forecast → confidence → milestone forecasts. */
  function evaluate(data, mods) {
    mods = mergeMods(mods, null);
    const eff = effective(data, mods);
    const sched = schedule(data, mods);
    const asOf = data.project.asOf;

    let finishDay = 0;
    for (const s of sched.values()) finishDay = Math.max(finishDay, s.finish);
    const finishDate = cal.dayToDate(asOf, finishDay);
    const targetDay = cal.workdaysInclusive(asOf, data.project.targetDate);
    const slackWd = targetDay - finishDay;

    // --- confidence spread from observed execution risk ---
    const pendingApprovals = eff.approvals.filter((a) => a.status === 'pending');
    const blockedItems = pendingApprovals.filter(
      (a) => a.blocksItem && a.expectedRemainingWorkdays > CONFIG.blockedThresholdWd
    );
    let overSla = 0;
    for (const a of pendingApprovals) {
      if (a.expectedRemainingWorkdays <= CONFIG.blockedThresholdWd) continue;
      overSla = Math.max(overSla, approvalAgeWd(data, a) - a.slaWorkdays);
    }
    overSla = Math.max(0, Math.min(6, overSla));
    let contention = 0;
    for (const s of sched.values()) if (s.boundBy.type === 'owner') contention += 1;

    const sigma =
      CONFIG.baseSigmaWd +
      CONFIG.sigmaPerBlockedItem * blockedItems.length +
      CONFIG.sigmaPerOverSlaDay * overSla +
      CONFIG.sigmaPerContention * contention;

    const confidence = Math.min(
      CONFIG.maxConfidence,
      Math.max(CONFIG.minConfidence, Math.round(100 * phi(slackWd / sigma)))
    );

    // --- per-milestone forecasts ---
    const milestones = data.milestones.map((m) => {
      const all = eff.items.filter((w) => w.milestone === m.id);
      const open = all.filter((w) => w.status !== 'done' && !w.descoped);
      let msFinish = 0;
      for (const w of open) msFinish = Math.max(msFinish, sched.get(w.id) ? sched.get(w.id).finish : 0);
      const dueDay = cal.workdaysInclusive(asOf, m.due);
      return {
        ...m,
        total: all.length,
        doneCount: all.length - open.length,
        openCount: open.length,
        forecastDate: m.done ? m.completedOn : cal.dayToDate(asOf, msFinish),
        varianceWd: m.done
          ? Math.max(0, cal.workdaysInclusive(m.due, m.completedOn) - 1)
          : msFinish - dueDay
      };
    });

    // --- current stall picture (facts about today, not the schedule) ---
    const aprIndex = new Map(data.approvals.map((a) => [a.id, a]));
    const openItems = data.workItems.filter((w) => w.status !== 'done');
    const stalledStates = ['blocked', 'waiting', 'review'];
    const stalledItems = openItems.filter((w) => stalledStates.includes(w.status));
    let oldest = null;
    for (const w of stalledItems) {
      const apr = w.blockedBy ? aprIndex.get(w.blockedBy) : null;
      const days = apr && apr.status === 'pending'
        ? approvalAgeWd(data, apr)
        : (w.timeInState[w.status] || 0);
      if (!oldest || days > oldest.days) oldest = { item: w, days };
    }
    const byState = { blocked: 0, waiting: 0, review: 0 };
    for (const w of stalledItems) byState[w.status] += 1;

    return {
      mods, finishDay, finishDate, targetDay, slackWd,
      latenessWd: Math.max(0, -slackWd), earlyWd: Math.max(0, slackWd),
      sigma, confidence, schedule: sched, milestones,
      stalled: { open: openItems.length, count: stalledItems.length, byState, oldest },
      factors: { blockedItems: blockedItems.length, overSlaWd: overSla, contention }
    };
  }

  /* ------------------------------------------------------------------ */
  /* Root-cause drivers                                                  */
  /* ------------------------------------------------------------------ */

  function driverCandidates(data) {
    const index = graph.buildIndex(data);
    const out = [];

    // 1. pending approvals / decisions / reviews that block an item
    for (const a of data.approvals) {
      if (a.status !== 'pending' || !a.blocksItem) continue;
      const blocked = index.items.get(a.blocksItem);
      const downstream = graph.descendants(index, a.blocksItem);
      out.push({
        id: 'drv-' + a.id,
        kind: 'approval',
        sourceApproval: a.id,
        blockedItem: a.blocksItem,
        downstreamIds: [a.blocksItem, ...downstream],
        mods: { approvalExpected: { [a.id]: 0 } },
        meta: { approval: a, blocked, downstreamCount: downstream.length }
      });
    }

    // 2. owners whose queue serializes several remaining items
    const byOwner = new Map();
    for (const w of data.workItems) {
      if (w.status === 'done' || w.remainingWorkdays === 0) continue;
      if (!byOwner.has(w.owner)) byOwner.set(w.owner, []);
      byOwner.get(w.owner).push(w);
    }
    for (const [owner, items] of byOwner) {
      if (items.length < 2) continue;
      const downstream = new Set();
      for (const w of items) {
        downstream.add(w.id);
        for (const d of graph.descendants(index, w.id)) downstream.add(d);
      }
      out.push({
        id: 'drv-queue-' + owner,
        kind: 'ownerQueue',
        owner,
        downstreamIds: [...downstream],
        mods: { unboundedOwner: { [owner]: true } },
        meta: {
          person: index.people.get(owner),
          items,
          queueWd: items.reduce((s, w) => s + w.remainingWorkdays, 0),
          downstreamCount: downstream.size - items.length
        }
      });
    }

    // 3. convergence gates: one late-starting item every stream funnels into
    for (const w of data.workItems) {
      if (w.status === 'done') continue;
      if ((w.dependsOn || []).length >= 3 && w.remainingWorkdays >= 4) {
        const downstream = graph.descendants(index, w.id);
        out.push({
          id: 'drv-gate-' + w.id,
          kind: 'gate',
          item: w.id,
          downstreamIds: [w.id, ...downstream],
          mods: { remaining: { [w.id]: 2 } },
          meta: { item: w, feeders: w.dependsOn.slice(), downstreamCount: downstream.length }
        });
      }
    }
    return out;
  }

  /* Sequential attribution: repeatedly neutralize the driver with the largest
   * marginal schedule gain. Returns ranked drivers plus the leftovers
   * (watchlist), each with baseline/neutralized evaluations for the UI. */
  function rankDrivers(data, baseMods, maxN) {
    baseMods = mergeMods(baseMods, null);
    maxN = maxN || 3;
    const candidates = driverCandidates(data);
    const base = evaluate(data, baseMods);

    let currentMods = baseMods;
    let current = base;
    const ranked = [];
    const used = new Set();

    for (let round = 0; round < maxN; round++) {
      let best = null;
      for (const c of candidates) {
        if (used.has(c.id)) continue;
        const ev = evaluate(data, mergeMods(currentMods, c.mods));
        const gain = current.finishDay - ev.finishDay;
        const better =
          !best ||
          gain > best.gain ||
          (gain === best.gain && (c.meta.downstreamCount || 0) > (best.c.meta.downstreamCount || 0));
        if (better) best = { c, gain, ev };
      }
      if (!best || best.gain < 1) break;
      // standalone neutralization vs the ORIGINAL baseline, for the cascade view
      const solo = evaluate(data, mergeMods(baseMods, best.c.mods));
      ranked.push({
        ...best.c,
        marginalWd: best.gain,
        sequenceNote: round === 0 ? null : 'becomes binding once the causes above are resolved',
        soloEval: solo
      });
      used.add(best.c.id);
      currentMods = mergeMods(currentMods, best.c.mods);
      current = best.ev;
    }

    const watchlist = candidates.filter((c) => !used.has(c.id));
    return { base, ranked, watchlist, fullyNeutralized: current };
  }

  OEE.forecast = {
    CONFIG, mergeMods, phi, schedule, evaluate,
    driverCandidates, rankDrivers, approvalAgeWd
  };
})(typeof window !== 'undefined' ? window : globalThis);
