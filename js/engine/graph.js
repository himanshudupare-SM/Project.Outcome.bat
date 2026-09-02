/* Dependency-graph utilities over the execution data. */
(function (global) {
  const OEE = (global.OEE = global.OEE || {});

  function buildIndex(data) {
    const items = new Map(data.workItems.map((w) => [w.id, w]));
    const people = new Map(data.people.map((p) => [p.id, p]));
    const approvals = new Map(data.approvals.map((a) => [a.id, a]));
    const milestones = new Map(data.milestones.map((m) => [m.id, m]));

    const dependents = new Map(); // itemId -> [itemIds that depend on it]
    for (const w of data.workItems) {
      for (const dep of w.dependsOn || []) {
        if (!dependents.has(dep)) dependents.set(dep, []);
        dependents.get(dep).push(w.id);
      }
    }
    return { items, people, approvals, milestones, dependents };
  }

  /* All transitive dependents of an item, in BFS order. */
  function descendants(index, itemId) {
    const out = [];
    const seen = new Set([itemId]);
    const queue = [itemId];
    while (queue.length) {
      const cur = queue.shift();
      for (const next of index.dependents.get(cur) || []) {
        if (seen.has(next)) continue;
        seen.add(next);
        out.push(next);
        queue.push(next);
      }
    }
    return out;
  }

  /* Deterministic topological order; ties keep seed order. */
  function topoOrder(data) {
    const indegree = new Map(data.workItems.map((w) => [w.id, (w.dependsOn || []).length]));
    const dependents = buildIndex(data).dependents;
    const order = [];
    let frontier = data.workItems.filter((w) => indegree.get(w.id) === 0).map((w) => w.id);
    while (frontier.length) {
      const next = [];
      for (const id of frontier) {
        order.push(id);
        for (const dep of dependents.get(id) || []) {
          indegree.set(dep, indegree.get(dep) - 1);
          if (indegree.get(dep) === 0) next.push(dep);
        }
      }
      frontier = next;
    }
    if (order.length !== data.workItems.length) {
      throw new Error('Dependency cycle detected in work items');
    }
    return order;
  }

  OEE.graph = { buildIndex, descendants, topoOrder };
})(typeof window !== 'undefined' ? window : globalThis);
