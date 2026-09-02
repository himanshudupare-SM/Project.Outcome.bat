/* ============================================================================
 * LAYER 4 — UI
 *
 * Pure rendering over the evaluations computed in main.js. Nothing in here
 * invents numbers: every date, day-count and percentage comes from the
 * forecast/recommendation layers.
 * ========================================================================== */
(function (global) {
  const OEE = (global.OEE = global.OEE || {});
  const { el, clear, fmtDate, fmtDateLong, signed, esc } = OEE.fmt;
  const { sparkline, stackedBar } = OEE.charts;

  const STATE_META = [
    { key: 'active', label: 'Active', color: 'var(--s-active)' },
    { key: 'waiting', label: 'Waiting', color: 'var(--s-waiting)' },
    { key: 'review', label: 'In review', color: 'var(--s-review)' },
    { key: 'blocked', label: 'Blocked', color: 'var(--s-blocked)' }
  ];

  const ITEM_PILL = {
    blocked: ['pill-critical', 'Blocked'],
    waiting: ['pill-warning', 'Waiting'],
    review: ['pill-neutral', 'In review'],
    active: ['pill-good', 'Active'],
    not_started: ['pill-neutral', 'Not started'],
    done: ['pill-neutral', 'Done']
  };

  function ctxHelpers(ctx) {
    const people = new Map(ctx.data.people.map((p) => [p.id, p]));
    const items = new Map(ctx.data.workItems.map((w) => [w.id, w]));
    const approvals = new Map(ctx.data.approvals.map((a) => [a.id, a]));
    return {
      name: (id) => (people.get(id) ? people.get(id).name : id),
      item: (id) => items.get(id),
      approval: (id) => approvals.get(id)
    };
  }

  function pill(kind, text) {
    return el('span', { class: `pill ${kind}` }, [el('span', { class: 'dot' }), text]);
  }

  function confBand(c) {
    if (c >= 70) return { cls: 'sev-good', word: 'on track' };
    if (c >= 45) return { cls: 'sev-warning', word: 'at risk' };
    if (c >= 25) return { cls: 'sev-serious', word: 'high risk' };
    return { cls: 'sev-critical', word: 'critical risk' };
  }

  /* Walk the schedule's binding constraints back from the finishing item. */
  function criticalChain(ev, ctx) {
    let endId = null, endFinish = -1;
    for (const [id, s] of ev.schedule) {
      if (s.finish > endFinish) { endFinish = s.finish; endId = id; }
    }
    const chain = [];
    let cur = endId;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      chain.unshift({ type: 'item', id: cur });
      const b = ev.schedule.get(cur).boundBy;
      if (b.type === 'dependency') cur = b.ref;
      else if (b.type === 'approval') { chain.unshift({ type: 'approval', id: b.ref }); cur = null; }
      else if (b.type === 'owner') { chain.unshift({ type: 'owner', id: b.ref }); cur = null; }
      else cur = null;
    }
    return chain;
  }

  /* ------------------------------------------------------------------ */

  function renderTopbar(ctx) {
    const n = clear(document.getElementById('topbar-meta'));
    n.appendChild(el('span', {}, `As of ${fmtDateLong(ctx.data.project.asOf)} · seeded demo data`));
  }

  function renderHead(ctx) {
    const p = ctx.data.project;
    const ev = ctx.viewEval;
    const n = clear(document.getElementById('project-head'));
    const band = confBand(ev.confidence);
    const statusPill =
      ev.confidence >= 70 ? pill('pill-good', 'On track')
        : ev.confidence >= 45 ? pill('pill-warning', 'At risk')
        : ev.confidence >= 25 ? pill('pill-serious', 'High risk')
        : pill('pill-critical', 'Off track');

    const left = el('div', {}, [
      el('h1', { class: 'project-title' }, p.name),
      el('div', { class: 'project-sub' }, [
        `Lead: ${ctxHelpers(ctx).name(p.lead)}`,
        el('span', { class: 'sep' }, '·'),
        `Target: ${fmtDateLong(p.targetDate)}`,
        el('span', { class: 'sep' }, '·'),
        `${ctx.data.workItems.filter((w) => w.status === 'done').length} of ${ctx.data.workItems.length} items done`
      ])
    ]);
    const right = el('div', { style: 'display:flex;align-items:center;gap:8px;' }, [
      ctx.view === 'plan' ? el('span', { class: 'sim-badge' }, 'SIMULATION') : null,
      statusPill
    ]);
    n.appendChild(left);
    n.appendChild(right);
  }

  function renderCompareStrip(ctx) {
    const n = document.getElementById('compare-strip');
    clear(n);
    if (ctx.applied.size === 0) { n.hidden = true; return; }
    n.hidden = false;

    const b = ctx.base, s = ctx.sim;
    function cell(label, beforeTxt, afterTxt, improved) {
      return el('div', { class: 'compare-cell' }, [
        el('div', { class: 'l' }, label),
        el('div', { class: 'v', html:
          `${esc(beforeTxt)}<span class="arrow">→</span><span class="after${improved ? '' : ' worse'}">${esc(afterTxt)}</span>` })
      ]);
    }
    const latenessTxt = (ev) =>
      ev.latenessWd > 0 ? `${ev.latenessWd} wd late` : ev.earlyWd > 0 ? `${ev.earlyWd} wd early` : 'on target';

    n.appendChild(cell('Outcome confidence', `${b.confidence}%`, `${s.confidence}%`, s.confidence >= b.confidence));
    n.appendChild(cell('Forecast finish', fmtDate(b.finishDate), fmtDate(s.finishDate), s.finishDay <= b.finishDay));
    n.appendChild(cell('Vs target', latenessTxt(b), latenessTxt(s), s.finishDay <= b.finishDay));
    n.appendChild(el('div', { class: 'compare-cell' }, [
      el('div', { class: 'l' }, 'Plan'),
      el('div', { class: 'v' }, `${ctx.applied.size} intervention${ctx.applied.size === 1 ? '' : 's'} applied`)
    ]));
    n.appendChild(el('div', { class: 'compare-spacer' }));

    const toggle = el('div', { class: 'view-toggle', role: 'group', 'aria-label': 'dashboard view' });
    const bBtn = el('button', { class: ctx.view === 'baseline' ? 'on' : '', onclick: () => ctx.setView('baseline') }, 'Before (baseline)');
    const aBtn = el('button', { class: ctx.view === 'plan' ? 'on' : '', onclick: () => ctx.setView('plan') }, 'After (with plan)');
    toggle.appendChild(bBtn); toggle.appendChild(aBtn);
    n.appendChild(toggle);
  }

  function renderConfidence(ctx) {
    const n = clear(document.getElementById('card-confidence'));
    const p = ctx.data.project;
    const ev = ctx.viewEval;
    const band = confBand(ev.confidence);

    n.appendChild(el('h2', {}, 'Outcome confidence'));
    n.appendChild(el('p', { class: 'card-sub' }, `Likelihood of hitting the ${fmtDate(p.targetDate)} target`));
    n.appendChild(el('div', { class: `stat-value ${band.cls}` }, [
      String(ev.confidence), el('span', { class: 'unit' }, '%')
    ]));

    if (ctx.view === 'plan') {
      const d = ev.confidence - ctx.base.confidence;
      n.appendChild(el('div', { class: `stat-delta ${d >= 0 ? 'up' : 'down'}` },
        `${signed(d)} pts vs baseline — simulated with ${ctx.applied.size} intervention${ctx.applied.size === 1 ? '' : 's'}`));
    } else {
      const hist = ctx.data.confidenceHistory;
      const d = ev.confidence - hist[hist.length - 1].value;
      n.appendChild(el('div', { class: `stat-delta ${d > 0 ? 'up' : d < 0 ? 'down' : 'flat'}` },
        `${signed(d)} pts vs last week (${band.word})`));
    }

    const wrap = el('div', { class: 'spark-wrap' });
    const points = ctx.data.confidenceHistory
      .map((h) => ({ label: fmtDate(h.date), value: h.value }))
      .concat([{ label: `${fmtDate(p.asOf)} (now)`, value: ctx.base.confidence }]);
    n.appendChild(wrap);
    sparkline(wrap, points, { seriesName: 'Outcome confidence', ariaLabel: 'Outcome confidence, weekly trend' });
    n.appendChild(el('div', { class: 'spark-caption' },
      `Weekly since ${fmtDate(ctx.data.confidenceHistory[0].date)} · computed from execution data, not self-reported status`));
  }

  function renderForecast(ctx) {
    const n = clear(document.getElementById('card-forecast'));
    const p = ctx.data.project;
    const ev = ctx.viewEval;
    const h = ctxHelpers(ctx);

    n.appendChild(el('h2', {}, 'Delivery forecast'));
    n.appendChild(el('p', { class: 'card-sub' }, 'Resource- and dependency-constrained schedule'));

    const sevCls = ev.latenessWd > 2 ? 'sev-critical' : ev.latenessWd > 0 ? 'sev-serious' : 'sev-good';
    n.appendChild(el('div', { class: `stat-value ${sevCls}`, style: 'font-size:36px;' }, fmtDateLong(ev.finishDate)));

    let line;
    if (ev.latenessWd > 0) {
      line = `This project is forecast <strong>${ev.latenessWd} working day${ev.latenessWd === 1 ? '' : 's'} late</strong> against the ${fmtDate(p.targetDate)} target.`;
    } else if (ev.earlyWd > 0) {
      line = `Forecast <strong>${ev.earlyWd} working day${ev.earlyWd === 1 ? '' : 's'} early</strong> against the ${fmtDate(p.targetDate)} target.`;
    } else {
      line = `Forecast <strong>on target</strong> for ${fmtDate(p.targetDate)}.`;
    }
    n.appendChild(el('p', { class: 'forecast-line', html: line }));

    const chain = criticalChain(ev, ctx);
    const chips = el('div', { class: 'cause-meta', style: 'margin-top:12px;' });
    for (const node of chain) {
      let label;
      if (node.type === 'approval') label = `⏳ ${node.id}`;
      else if (node.type === 'owner') label = `queue: ${h.name(node.id)}`;
      else label = node.id;
      chips.appendChild(el('span', { class: 'chip', title: node.type === 'item' ? h.item(node.id).title : '' }, label));
    }
    n.appendChild(el('div', { class: 'stat-note' }, 'Driving path (what sets the finish date):'));
    n.appendChild(chips);
  }

  function renderFlow(ctx) {
    const n = clear(document.getElementById('card-flow'));
    const st = ctx.base.stalled; // facts about today; identical in both views
    const h = ctxHelpers(ctx);

    n.appendChild(el('h2', {}, 'Execution flow today'));
    n.appendChild(el('p', { class: 'card-sub' }, 'Where open work is actually sitting'));
    n.appendChild(el('div', { class: 'stat-value', style: 'font-size:36px;' }, [
      String(st.count),
      el('span', { class: 'unit' }, ` of ${st.open} open items stalled`)
    ]));

    const rows = el('div', { style: 'margin-top:10px;display:flex;flex-direction:column;gap:5px;' });
    const mapping = [
      ['blocked', 'Blocked on approvals', 'var(--s-blocked)'],
      ['waiting', 'Waiting on people / decisions', 'var(--s-waiting)'],
      ['review', 'Sitting in review', 'var(--s-review)']
    ];
    for (const [key, label, color] of mapping) {
      rows.appendChild(el('div', { style: 'display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--ink-2);' }, [
        el('span', { style: `width:9px;height:9px;border-radius:3px;background:${color};flex:0 0 auto;` }),
        el('span', { style: 'flex:1;' }, label),
        el('span', { style: 'font-variant-numeric:tabular-nums;color:var(--ink);font-weight:600;' }, String(st.byState[key]))
      ]));
    }
    n.appendChild(rows);

    if (st.oldest) {
      const w = st.oldest.item;
      const apr = w.blockedBy ? h.approval(w.blockedBy) : null;
      n.appendChild(el('div', { class: 'stat-note' },
        `Longest stall: ${w.id} “${w.title}” — ${st.oldest.days} working days` +
        (apr ? ` (${apr.approverGroup} ${apr.kind})` : '')));
    }
  }

  /* ---------------- top risk causes ---------------- */

  function driverProse(ctx, d) {
    const h = ctxHelpers(ctx);
    const cal = OEE.calendar;
    const F = OEE.forecast;

    // The viewed world may have overridden expectations (an escalated
    // approval, a staged gate) — quote the effective values, not the seed's.
    const viewMods = ctx.viewEval.mods || {};

    if (d.kind === 'approval') {
      const a = d.meta.approval;
      const blocked = d.meta.blocked;
      const age = F.approvalAgeWd(ctx.data, a);
      const over = age - a.slaWorkdays;
      const owners = new Set(d.downstreamIds.map((id) => h.item(id).owner));
      const kindWord = a.kind === 'decision' ? 'decision' : a.kind === 'review' ? 'review' : 'approval';
      const expected = viewMods.approvalExpected && viewMods.approvalExpected[a.id] != null
        ? viewMods.approvalExpected[a.id] : a.expectedRemainingWorkdays;
      return {
        title: `${a.approverGroup} ${kindWord} pending ${age} working days: “${a.title}”`,
        text:
          `“${blocked.title}” cannot start until ${h.name(a.approver)} signs off` +
          (over > 0 ? ` — the request is ${over} working days past its ${a.slaWorkdays}-day SLA` : '') +
          ` and the ${ctx.view === 'plan' ? 'simulated plan expects' : 'team currently expects'} ~${expected} more day${expected === 1 ? '' : 's'}. ` +
          `The wait cascades into ${d.downstreamIds.length - 1} downstream items across ${owners.size} owners. ` +
          (a.note || ''),
        chips: [`blocks ${d.downstreamIds.length} items`, `${age} wd pending · SLA ${a.slaWorkdays} wd`, a.id]
      };
    }

    if (d.kind === 'gate') {
      const w = d.meta.item;
      const sched = ctx.viewEval.schedule.get(w.id);
      const feeders = d.meta.feeders;
      const remaining = viewMods.remaining && viewMods.remaining[w.id] != null
        ? viewMods.remaining[w.id] : w.remainingWorkdays;
      return {
        title: `Single ${remaining}-day convergence gate before cutover: “${w.title}”`,
        text:
          `All ${feeders.length} remaining workstreams funnel into this one serial pass, owned by ` +
          `${h.name(w.owner)}, which can only start once the last stream lands ` +
          `(currently ${fmtDate(sched.startDate)}). Until then, every upstream slip moves the deadline 1-for-1. ` +
          (w.stageNote || ''),
        chips: [`${feeders.length} streams converge`, `starts ${fmtDate(sched.startDate)}`, w.id]
      };
    }

    if (d.kind === 'ownerQueue') {
      const p = d.meta.person;
      const items = d.meta.items;
      return {
        title: `${p.name}'s queue serializes ${items.length} remaining items`,
        text:
          `${p.name} is the single owner of ${items.map((w) => `“${w.title}”`).join(', ')} — ` +
          `${d.meta.queueWd} working days of work that can only run one item at a time. ` +
          `Downstream items wait on this queue even after their dependencies are ready.`,
        chips: [`${d.meta.queueWd} wd serialized`, `${items.length} items, 1 owner`]
      };
    }
    return { title: d.id, text: '', chips: [] };
  }

  function renderCauses(ctx) {
    const n = clear(document.getElementById('card-causes'));
    n.appendChild(el('h2', {}, 'Why the outcome is at risk — top causes'));
    n.appendChild(el('p', { class: 'card-sub' },
      'Ranked by computed schedule impact; each next cause is the bottleneck that emerges once the ones above are resolved'));

    if (ctx.drivers.ranked.length === 0) {
      n.appendChild(el('p', { class: 'cause-text' }, 'No schedule-moving causes detected — the remaining risk is execution noise.'));
    }

    ctx.drivers.ranked.forEach((d, i) => {
      const prose = driverProse(ctx, d);
      const row = el('div', { class: 'cause' }, [
        el('div', { class: 'cause-rank' }, String(i + 1)),
        el('div', { class: 'cause-body' }, [
          el('div', { class: 'cause-title' }, prose.title),
          el('div', { class: 'cause-text' }, prose.text + (d.sequenceNote ? ` (${d.sequenceNote}.)` : '')),
          el('div', { class: 'cause-meta' }, prose.chips.map((c) => el('span', { class: 'chip' }, c)))
        ]),
        el('div', { class: 'cause-days' }, [
          el('span', { class: 'n sev-serious' }, `${d.marginalWd} wd`),
          el('span', { class: 'l' }, 'of forecast delay')
        ])
      ]);
      n.appendChild(row);
    });

    // watchlist: pending blockers + register risks that aren't driving the date
    const watch = el('div', { class: 'watchlist' });
    watch.appendChild(el('div', { class: 'watchlist-title' }, 'Watching — not driving the date today'));
    for (const c of ctx.drivers.watchlist.filter((w) => w.kind === 'approval')) {
      const a = c.meta.approval;
      const age = OEE.forecast.approvalAgeWd(ctx.data, a);
      watch.appendChild(el('div', { class: 'watch-row' }, [
        `${a.id} · ${a.approverGroup} ${a.kind} “${a.title}” — ${age} wd pending. `,
        el('span', { class: 'why' }, 'Currently absorbed by slack elsewhere in the schedule.')
      ]));
    }
    for (const r of ctx.data.risks) {
      watch.appendChild(el('div', { class: 'watch-row' }, [
        `${r.id} · ${r.title} — `, el('span', { class: 'why' }, r.note)
      ]));
    }
    n.appendChild(watch);
  }

  /* ---------------- interventions ---------------- */

  function renderInterventions(ctx) {
    const n = clear(document.getElementById('card-interventions'));
    n.appendChild(el('h2', {}, 'Recommended interventions'));
    n.appendChild(el('p', { class: 'card-sub' },
      'Ranked by computed marginal impact; apply them to simulate the recovered forecast'));

    function card(c, applied, impact) {
      const noImpact = !applied && impact.gain === 0 && !(c.marginalWd > 0);
      const wrap = el('div', { class: `iv-card${applied ? ' applied' : ''}${noImpact ? ' noimpact' : ''}` });
      // A step can be worthless alone but valuable once the steps ranked above
      // it are applied (computed, not asserted) — label that case honestly.
      let impactTxt, impactLbl, good;
      if (applied) {
        impactTxt = impact.gain > 0 ? `−${impact.gain} wd` : '±0 wd';
        impactLbl = 'contribution in plan';
        good = impact.gain > 0;
      } else if (impact.gain > 0) {
        impactTxt = `−${impact.gain} wd`; impactLbl = 'if applied now'; good = true;
      } else if (c.marginalWd > 0) {
        impactTxt = `−${c.marginalWd} wd`; impactLbl = 'with the steps above applied'; good = true;
      } else {
        impactTxt = '±0 wd'; impactLbl = 'if applied now'; good = false;
      }
      wrap.appendChild(el('div', { class: 'iv-head' }, [
        el('div', { class: 'iv-title' }, c.title),
        el('div', { class: 'iv-impact' }, [
          el('span', { class: `n ${good ? 'sev-good' : ''}` }, impactTxt),
          el('span', { class: 'l' }, impactLbl)
        ])
      ]));
      wrap.appendChild(el('div', { class: 'iv-text' }, c.detail));
      const meta = el('div', { class: 'iv-meta' }, [
        el('span', { class: 'chip' }, c.effort),
        el('span', { class: 'chip' }, c.who),
        ...c.tags.map((t) => el('span', { class: 'chip' }, t))
      ]);
      wrap.appendChild(meta);
      if (!applied && impact.gain > 0) {
        wrap.appendChild(el('div', { class: 'iv-text', style: 'margin-top:6px;color:var(--muted);' },
          `→ forecast ${fmtDate(impact.evalIf.finishDate)}, confidence ${impact.evalIf.confidence}%`));
      }
      const btn = el('button', {
        class: `btn${applied ? '' : ' primary'}`,
        onclick: () => ctx.toggle(c.id)
      }, applied ? 'Remove from simulation' : 'Apply in simulation');
      wrap.appendChild(el('div', { class: 'iv-actions' }, [btn]));
      return wrap;
    }

    for (const c of ctx.rec.ranked) {
      n.appendChild(card(c, ctx.applied.has(c.id), ctx.impact(c)));
    }

    if (ctx.rec.noImpact.length) {
      const det = el('details', { class: 'data-table' });
      det.appendChild(el('summary', {},
        `Also evaluated — no impact on the current forecast (${ctx.rec.noImpact.length})`));
      const inner = el('div', { style: 'margin-top:8px;' });
      for (const c of ctx.rec.noImpact) {
        inner.appendChild(card(c, ctx.applied.has(c.id), ctx.impact(c)));
      }
      det.appendChild(inner);
      n.appendChild(det);
      n.appendChild(el('p', { class: 'card-sub', style: 'margin-top:8px;' },
        'Knowing what NOT to escalate matters too: these actions look sensible but would not move the date today.'));
    }
  }

  /* ---------------- dependency cascade ---------------- */

  function renderCascade(ctx) {
    const n = clear(document.getElementById('card-cascade'));
    const h = ctxHelpers(ctx);
    n.appendChild(el('h2', {}, 'Dependency impact — how delays cascade'));
    n.appendChild(el('p', { class: 'card-sub' },
      `Scheduled dates under the ${ctx.view === 'plan' ? 'simulated plan' : 'current baseline'}; ` +
      `deltas show how much earlier each item starts if the source is cleared today`));

    const ev = ctx.viewEval;

    function itemNode(id, extras) {
      const w = h.item(id);
      const s = ev.schedule.get(id);
      const [pillCls, pillTxt] = ITEM_PILL[w.status] || ITEM_PILL.not_started;
      const line = el('div', { class: 'cnode-line' }, [
        el('span', { class: 'cnode-id' }, id),
        el('span', { class: 'cnode-title' }, w.title),
        pill(pillCls, pillTxt),
        s ? el('span', { class: 'cnode-note' },
          w.remainingWorkdays === 0
            ? `clears ${fmtDate(s.finishDate)}`
            : `${fmtDate(s.startDate)} → ${fmtDate(s.finishDate)} · ${h.name(w.owner)}`)
          : el('span', { class: 'cnode-note' }, 'done'),
        extras || null
      ]);
      return el('li', { class: 'cnode' }, [line]);
    }

    function pushDelta(d, id) {
      if (!d.soloEval) return null;
      const viewS = ev.schedule.get(id); // soloEval is computed on top of the viewed world
      const soloS = d.soloEval.schedule.get(id);
      if (!viewS || !soloS) return null;
      const delta = viewS.start - soloS.start;
      if (delta <= 0) return null;
      return el('span', { class: 'cnode-push' }, `+${delta} wd later because of this block`);
    }

    const top = ctx.drivers.ranked.slice(0, 2);
    if (top.length === 0) {
      n.appendChild(el('p', { class: 'cause-text' }, 'No active cascade — nothing is structurally blocking downstream work.'));
      return;
    }

    for (const d of top) {
      const block = el('div', { class: 'cascade-block' });

      if (d.kind === 'approval') {
        const a = d.meta.approval;
        const age = OEE.forecast.approvalAgeWd(ctx.data, a);
        block.appendChild(el('div', { class: 'cascade-src' }, [
          el('span', { class: 'src-kind' }, 'Source'),
          pill('pill-critical', `${a.kind} pending ${age} wd`),
          el('span', {}, `${a.id} · ${a.title} (${a.approverGroup}: ${h.name(a.approver)})`)
        ]));
        const tree = el('ul', { class: 'cascade-tree' });
        for (const id of d.downstreamIds) tree.appendChild(itemNode(id, pushDelta(d, id)));
        block.appendChild(tree);
        const owners = new Set(d.downstreamIds.map((id) => h.item(id).owner));
        const last = d.downstreamIds[d.downstreamIds.length - 1];
        const lastS = ev.schedule.get(last);
        block.appendChild(el('div', { class: 'cascade-sum' },
          `${d.downstreamIds.length} items across ${owners.size} owners inherit this wait — ` +
          `the chain currently ends ${fmtDate(lastS.finishDate)}.`));
      }

      if (d.kind === 'gate') {
        const w = d.meta.item;
        const s = ev.schedule.get(w.id);
        const vm = ctx.viewEval.mods || {};
        const remaining = vm.remaining && vm.remaining[w.id] != null ? vm.remaining[w.id] : w.remainingWorkdays;
        block.appendChild(el('div', { class: 'cascade-src' }, [
          el('span', { class: 'src-kind' }, 'Convergence'),
          pill('pill-serious', `${remaining}-day serial gate`),
          el('span', {}, `${w.id} · ${w.title} (${h.name(w.owner)})`)
        ]));
        const tree = el('ul', { class: 'cascade-tree' });
        let latest = null;
        for (const fid of d.meta.feeders) {
          const fs = ev.schedule.get(fid);
          if (fs && (!latest || fs.finish > ev.schedule.get(latest).finish)) latest = fid;
        }
        for (const fid of d.meta.feeders) {
          const fs = ev.schedule.get(fid);
          const isLast = fid === latest;
          tree.appendChild(itemNode(fid, fs && isLast
            ? el('span', { class: 'cnode-push' }, 'last to land — sets the gate start')
            : null));
        }
        tree.appendChild(itemNode(w.id, el('span', { class: 'cnode-push' },
          `all of the above must land first`)));
        for (const did of d.downstreamIds.slice(1)) tree.appendChild(itemNode(did));
        block.appendChild(tree);
        block.appendChild(el('div', { class: 'cascade-sum' },
          `The gate runs ${fmtDate(s.startDate)} → ${fmtDate(s.finishDate)}; every slip in a feeder moves the deadline 1-for-1.`));
      }

      if (d.kind === 'ownerQueue') {
        const p = d.meta.person;
        block.appendChild(el('div', { class: 'cascade-src' }, [
          el('span', { class: 'src-kind' }, 'Queue'),
          pill('pill-warning', `${d.meta.queueWd} wd serialized`),
          el('span', {}, `${p.name} — ${d.meta.items.length} remaining items, one at a time`)
        ]));
        const tree = el('ul', { class: 'cascade-tree' });
        for (const w of d.meta.items) tree.appendChild(itemNode(w.id, pushDelta(d, w.id)));
        block.appendChild(tree);
      }

      n.appendChild(block);
    }
  }

  /* ---------------- turnaround ---------------- */

  function renderTurnaround(ctx) {
    const n = clear(document.getElementById('card-turnaround'));
    n.appendChild(el('h2', {}, 'Turnaround breakdown'));
    n.appendChild(el('p', { class: 'card-sub' }, 'Working days accumulated per state since project start (all items)'));

    const legend = el('div', { class: 'legend' });
    for (const s of STATE_META) {
      legend.appendChild(el('span', { class: 'key' }, [
        el('span', { class: 'swatch', style: `background:${s.color}` }), s.label
      ]));
    }
    n.appendChild(legend);

    const totals = { active: 0, waiting: 0, blocked: 0, review: 0 };
    const byMs = new Map(ctx.data.milestones.map((m) => [m.id, { active: 0, waiting: 0, blocked: 0, review: 0 }]));
    for (const w of ctx.data.workItems) {
      for (const k of Object.keys(totals)) {
        totals[k] += w.timeInState[k] || 0;
        byMs.get(w.milestone)[k] += w.timeInState[k] || 0;
      }
    }
    const grand = Object.values(totals).reduce((a, b) => a + b, 0);
    const nonActive = grand - totals.active;
    const nonActivePct = Math.round((100 * nonActive) / grand);

    const overall = el('div', { class: 'tstack' });
    overall.appendChild(el('div', { class: 'tstack-label' }, [
      el('span', {}, 'Whole project'), el('span', { class: 'r' }, `${grand} wd logged`)
    ]));
    stackedBar(overall, STATE_META.map((s) => ({ label: s.label, value: totals[s.key], color: s.color })),
      { title: 'Whole project', height: 22 });
    n.appendChild(overall);

    for (const m of ctx.data.milestones) {
      const t = byMs.get(m.id);
      const sum = Object.values(t).reduce((a, b) => a + b, 0);
      if (!sum) continue;
      const row = el('div', { class: 'tstack' });
      row.appendChild(el('div', { class: 'tstack-label' }, [
        el('span', {}, `${m.id} · ${m.name}`), el('span', { class: 'r' }, `${sum} wd`)
      ]));
      stackedBar(row, STATE_META.map((s) => ({ label: s.label, value: t[s.key], color: s.color })),
        { title: `${m.id} · ${m.name}`, height: 14, labels: false });
      n.appendChild(row);
    }

    n.appendChild(el('p', { class: 'turn-insight', html:
      `<strong>${nonActivePct}% of all effort-days so far were spent waiting, blocked, or in review.</strong> ` +
      `The biggest lever on this project is queue time — approvals and handoffs — not build velocity.` }));

    const det = el('details', { class: 'data-table' });
    det.appendChild(el('summary', {}, 'View as table'));
    const table = el('table', {});
    table.appendChild(el('tr', {}, [
      el('th', {}, 'Scope'),
      ...STATE_META.map((s) => el('th', {}, s.label + ' (wd)'))
    ]));
    table.appendChild(el('tr', {}, [
      el('td', {}, 'Whole project'),
      ...STATE_META.map((s) => el('td', {}, String(totals[s.key])))
    ]));
    for (const m of ctx.data.milestones) {
      const t = byMs.get(m.id);
      if (!Object.values(t).some((v) => v > 0)) continue;
      table.appendChild(el('tr', {}, [
        el('td', {}, `${m.id} · ${m.name}`),
        ...STATE_META.map((s) => el('td', {}, String(t[s.key])))
      ]));
    }
    det.appendChild(table);
    n.appendChild(det);
  }

  /* ---------------- milestones ---------------- */

  function renderMilestones(ctx) {
    const n = clear(document.getElementById('card-milestones'));
    const ev = ctx.viewEval;
    n.appendChild(el('h2', {}, 'Milestones'));
    n.appendChild(el('p', { class: 'card-sub' },
      `Forecast dates under the ${ctx.view === 'plan' ? 'simulated plan' : 'current baseline'}`));

    const table = el('table', { class: 'ms-table' });
    table.appendChild(el('tr', {}, [
      el('th', {}, 'Milestone'), el('th', {}, 'Status'), el('th', {}, 'Due'),
      el('th', {}, 'Forecast'), el('th', {}, 'Variance'), el('th', {}, 'Progress')
    ]));

    for (const m of ev.milestones) {
      let statusP, varTxt, varCls;
      if (m.done) {
        statusP = pill('pill-good', 'Done');
        varTxt = m.varianceWd > 0 ? `${m.varianceWd} wd late` : 'on time';
        varCls = 'ms-var-done';
      } else if (m.varianceWd > 2) {
        statusP = pill('pill-critical', 'At risk'); varTxt = `+${m.varianceWd} wd late`; varCls = 'ms-var-verylate';
      } else if (m.varianceWd > 0) {
        statusP = pill('pill-serious', 'Slipping'); varTxt = `+${m.varianceWd} wd late`; varCls = 'ms-var-late';
      } else {
        statusP = pill('pill-good', 'On track');
        varTxt = m.varianceWd < 0 ? `${Math.abs(m.varianceWd)} wd early` : 'on time';
        varCls = 'ms-var-ok';
      }
      table.appendChild(el('tr', {}, [
        el('td', {}, [el('span', { class: 'ms-name' }, `${m.id} · ${m.name}`)]),
        el('td', {}, [statusP]),
        el('td', { class: 'num' }, fmtDate(m.due)),
        el('td', { class: 'num' }, fmtDate(m.forecastDate)),
        el('td', { class: varCls }, varTxt),
        el('td', { class: 'num' }, `${m.doneCount}/${m.total} items done`)
      ]));
    }
    n.appendChild(table);
  }

  OEE.render = function renderAll(ctx) {
    renderTopbar(ctx);
    renderHead(ctx);
    renderCompareStrip(ctx);
    renderConfidence(ctx);
    renderForecast(ctx);
    renderFlow(ctx);
    renderCauses(ctx);
    renderInterventions(ctx);
    renderCascade(ctx);
    renderTurnaround(ctx);
    renderMilestones(ctx);
  };
})(typeof window !== 'undefined' ? window : globalThis);
