/* Application shell: holds UI state, wires the layers together, re-renders.
 * State is tiny on purpose: the set of applied interventions + which view
 * (baseline vs simulated plan) the dashboard shows. */
(function () {
  const OEE = window.OEE;
  const F = OEE.forecast;
  const data = OEE.seed;

  // Static, computed once: baseline evaluation + ranked recommendation plan.
  const rec = OEE.recommend.rank(data, 3);
  const base = rec.base;
  const allCandidates = rec.ranked.concat(rec.noImpact);
  const candById = new Map(allCandidates.map((c) => [c.id, c]));

  const state = {
    applied: new Set(),
    view: 'baseline'
  };

  function appliedMods(excludeId, extraId) {
    let mods = {};
    for (const id of state.applied) {
      if (id === excludeId) continue;
      mods = F.mergeMods(mods, candById.get(id).mods);
    }
    if (extraId) mods = F.mergeMods(mods, candById.get(extraId).mods);
    return mods;
  }

  function recompute() {
    const sim = F.evaluate(data, appliedMods());
    const viewMods = state.view === 'plan' && state.applied.size ? appliedMods() : {};
    const viewEval = state.view === 'plan' && state.applied.size ? sim : base;
    // Root causes are re-derived for the viewed world, so the "why" panel
    // reflects what remains after the applied interventions.
    const drivers = F.rankDrivers(data, viewMods, 3);

    const ctx = {
      data, base, sim, rec, drivers, viewEval,
      applied: state.applied,
      view: state.view === 'plan' && state.applied.size ? 'plan' : 'baseline',

      /* Live marginal impact of a candidate against the current simulation:
       * applied → its contribution (what removing it would cost);
       * not applied → what adding it now would recover. */
      impact(c) {
        if (state.applied.has(c.id)) {
          const without = F.evaluate(data, appliedMods(c.id));
          return { gain: without.finishDay - sim.finishDay, evalIf: sim };
        }
        const withIt = F.evaluate(data, appliedMods(null, c.id));
        return { gain: sim.finishDay - withIt.finishDay, evalIf: withIt };
      },

      toggle(id) {
        if (state.applied.has(id)) {
          state.applied.delete(id);
          if (state.applied.size === 0) state.view = 'baseline';
        } else {
          state.applied.add(id);
          state.view = 'plan'; // applying an intervention shows its effect
        }
        recompute();
      },

      setView(v) {
        state.view = v;
        recompute();
      }
    };

    OEE.render(ctx);
  }

  recompute();
})();
