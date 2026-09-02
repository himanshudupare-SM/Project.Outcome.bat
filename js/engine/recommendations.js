/* ============================================================================
 * LAYER 3 — RECOMMENDATIONS
 *
 * Generates concrete, named interventions from patterns in the execution data
 * (never generic advice), then ranks them by COMPUTED marginal impact: each
 * candidate's mods are run through the forecast engine on top of the ones
 * already picked, so impacts reflect interaction between actions rather than
 * naive addition. Candidates whose best variant moves nothing are surfaced as
 * "evaluated — no impact", which is as much a part of the value prop as the
 * ranked list (it tells a manager what NOT to spend a favor on).
 * ========================================================================== */
(function (global) {
  const OEE = (global.OEE = global.OEE || {});
  const F = OEE.forecast;

  function peopleIndex(data) {
    return new Map(data.people.map((p) => [p.id, p]));
  }

  function candidates(data) {
    const people = peopleIndex(data);
    const itemById = new Map(data.workItems.map((w) => [w.id, w]));
    const index = OEE.graph.buildIndex(data);
    const out = [];

    for (const a of data.approvals) {
      if (a.status !== 'pending' || !a.blocksItem) continue;
      const age = F.approvalAgeWd(data, a);
      const blocked = itemById.get(a.blocksItem);
      const downstream = OEE.graph.descendants(index, a.blocksItem).length;

      if (a.kind === 'review' && a.expectedRemainingWorkdays >= 3) {
        out.push({
          id: 'iv-review-' + a.id,
          group: 'review-' + a.id,
          kind: 'review',
          title: `Add a second reviewer to “${a.title}”`,
          detail:
            `${a.approverGroup} review has a single reviewer queued behind on-call ` +
            `(${age} working days in review, ~${a.expectedRemainingWorkdays} more expected). ` +
            `A second reviewer or a timeboxed slot brings resolution to ~2 days and de-risks “${blocked.title}”.`,
          who: `${people.get(data.project.lead).name} → ${people.get(a.approver).name} (${a.approverGroup})`,
          effort: 'Low effort',
          tags: ['Review queue', a.id],
          mods: { approvalExpected: { [a.id]: 2 } }
        });
      } else if (a.expectedRemainingWorkdays >= 3) {
        const word = a.kind === 'decision' ? 'decision' : 'approval';
        out.push({
          id: 'iv-escalate-' + a.id,
          group: 'escalate-' + a.id,
          kind: 'escalate',
          title: `Escalate “${a.title}” to ${a.approverGroup} leadership today`,
          detail:
            `The ${word} has been pending ${age} working days against a ${a.slaWorkdays}-day SLA ` +
            `and currently expects ~${a.expectedRemainingWorkdays} more. An escalation with a committed ` +
            `next-day turnaround unblocks “${blocked.title}” and ${downstream} downstream item${downstream === 1 ? '' : 's'}.`,
          who: `${people.get(data.project.lead).name} → ${people.get(a.approver).name} (${a.approverGroup})`,
          effort: 'Low effort',
          tags: ['Blocking ' + word, a.id],
          mods: { approvalExpected: { [a.id]: 1 } }
        });
      }
    }

    for (const w of data.workItems) {
      if (w.status === 'done') continue;
      if (w.stageable && w.remainingWorkdays >= 4) {
        const staged = Math.max(2, Math.ceil(w.remainingWorkdays * 0.6));
        out.push({
          id: 'iv-stage-' + w.id,
          group: 'stage-' + w.id,
          kind: 'stage',
          title: `Stage “${w.title}” instead of one big pass`,
          detail:
            (w.stageNote ? w.stageNote + ' ' : '') +
            `Running it incrementally cuts the final serial window from ` +
            `${w.remainingWorkdays} to ~${staged} working days.`,
          who: `${people.get(w.owner).name} (owner)`,
          effort: 'Medium effort',
          tags: ['Convergence gate', w.id],
          mods: { remaining: { [w.id]: staged } }
        });
      }
      if (w.descopable) {
        out.push({
          id: 'iv-descope-' + w.id,
          group: 'descope-' + w.id,
          kind: 'descope',
          title: `Move “${w.title}” out of launch scope`,
          detail: (w.descopeNote ? w.descopeNote + ' ' : '') + `Ship it in the first post-launch iteration.`,
          who: `${people.get(data.project.lead).name} (scope call)`,
          effort: 'Low effort',
          tags: ['Scope', w.id],
          mods: { descoped: { [w.id]: true } }
        });
      }
    }

    // Rebalancing: one variant per (movable item × same-team teammate).
    const byOwner = new Map();
    for (const w of data.workItems) {
      if (w.status === 'done' || w.remainingWorkdays === 0) continue;
      if (!byOwner.has(w.owner)) byOwner.set(w.owner, []);
      byOwner.get(w.owner).push(w);
    }
    for (const [owner, items] of byOwner) {
      if (items.length < 3) continue; // only genuinely overloaded owners
      const ownerP = people.get(owner);
      const queueWd = items.reduce((s, w) => s + w.remainingWorkdays, 0);
      const movable = items.filter(
        (w) => (w.status === 'not_started' || w.status === 'waiting') && (w.timeInState.active || 0) === 0
      );
      const teammates = data.people.filter((p) => p.team === ownerP.team && p.id !== owner);
      for (const w of movable) {
        for (const t of teammates) {
          out.push({
            id: `iv-move-${w.id}-${t.id}`,
            group: 'rebalance-' + owner,
            kind: 'rebalance',
            title: `Move “${w.title}” from ${ownerP.name} to ${t.name}`,
            detail:
              `${ownerP.name} is the single owner of ${items.length} remaining items ` +
              `(${queueWd} working days of serialized work). “${w.title}” has no work started yet, ` +
              `so it hands over cleanly; ${t.name} is on the same team.`,
            who: `${people.get(data.project.lead).name} → ${ownerP.name}, ${t.name}`,
            effort: 'Medium effort',
            tags: ['Owner load', w.id],
            mods: { owner: { [w.id]: t.id } }
          });
        }
      }
    }

    return out;
  }

  /* Greedy ranking by marginal computed gain; at most one candidate per group
   * makes the list. Returns the ranked plan plus a deduplicated "no impact"
   * list for everything that would not move the forecast right now. */
  function rank(data, maxN) {
    maxN = maxN || 3;
    const cands = candidates(data);
    const base = F.evaluate(data, {});

    let currentMods = {};
    let current = base;
    const ranked = [];
    const usedGroups = new Set();

    for (let round = 0; round < maxN; round++) {
      let best = null;
      for (const c of cands) {
        if (usedGroups.has(c.group)) continue;
        const ev = F.evaluate(data, F.mergeMods(currentMods, c.mods));
        const gain = current.finishDay - ev.finishDay;
        if (!best || gain > best.gain) best = { c, gain, ev };
      }
      if (!best || best.gain < 1) break;
      ranked.push({ ...best.c, marginalWd: best.gain, cumulativeEval: best.ev });
      usedGroups.add(best.c.group);
      currentMods = F.mergeMods(currentMods, best.c.mods);
      current = best.ev;
    }

    // One representative per remaining group, with its best solo gain.
    const restByGroup = new Map();
    for (const c of cands) {
      if (usedGroups.has(c.group)) continue;
      const ev = F.evaluate(data, F.mergeMods(currentMods, c.mods));
      const gain = current.finishDay - ev.finishDay;
      const prev = restByGroup.get(c.group);
      if (!prev || gain > prev.gain) restByGroup.set(c.group, { ...c, gain });
    }
    const noImpact = [...restByGroup.values()];

    return { base, ranked, noImpact, planMods: currentMods, planEval: current };
  }

  OEE.recommend = { candidates, rank };
})(typeof window !== 'undefined' ? window : globalThis);
