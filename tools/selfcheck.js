/* Engine self-check: runs the data → forecast → recommendation layers in Node
 * (no browser needed) and prints the computed baseline, drivers and plan.
 * Usage: node tools/selfcheck.js */
const path = require('path');
const root = path.join(__dirname, '..');
for (const f of ['js/data/seed.js', 'js/engine/calendar.js', 'js/engine/graph.js', 'js/engine/forecast.js', 'js/engine/recommendations.js']) {
  require(path.join(root, f));
}
const OEE = globalThis.OEE;
const data = OEE.seed;
const F = OEE.forecast;

const base = F.evaluate(data, {});
console.log('=== BASELINE ===');
console.log(`finish ${base.finishDate} (day ${base.finishDay}, target day ${base.targetDay})`);
console.log(`slack ${base.slackWd} wd · sigma ${base.sigma.toFixed(2)} · confidence ${base.confidence}%`);
console.log('risk factors:', base.factors);

console.log('\nschedule:');
for (const [id, s] of base.schedule) {
  console.log(`  ${id}: day ${s.start}-${s.finish}  ${s.startDate} → ${s.finishDate}  bound=${s.boundBy.type}${s.boundBy.ref ? ':' + s.boundBy.ref : ''}`);
}

console.log('\nmilestones:');
for (const m of base.milestones) {
  console.log(`  ${m.id} ${m.name}: due ${m.due}, forecast ${m.forecastDate}, variance ${m.varianceWd} wd (${m.doneCount}/${m.total} done)`);
}

console.log('\n=== TOP CAUSES (sequential attribution) ===');
const dr = F.rankDrivers(data, {}, 3);
dr.ranked.forEach((d, i) => console.log(`  ${i + 1}. ${d.id} (${d.kind}) — ${d.marginalWd} wd of forecast delay`));
console.log('  watching:', dr.watchlist.map((w) => w.id).join(', '));

console.log('\n=== RECOMMENDED PLAN (greedy marginal ranking) ===');
const rec = OEE.recommend.rank(data, 3);
rec.ranked.forEach((r, i) =>
  console.log(`  ${i + 1}. ${r.title} — recovers ${r.marginalWd} wd → ${r.cumulativeEval.finishDate}, confidence ${r.cumulativeEval.confidence}%`));
console.log('  evaluated, no impact:', rec.noImpact.map((c) => c.title).join(' | ') || '(none)');
console.log(`\nplan result: ${rec.planEval.finishDate}, slack ${rec.planEval.slackWd} wd, confidence ${rec.planEval.confidence}%`);

// hard assertions so this doubles as a regression test for the demo story
const assert = require('assert');
assert.strictEqual(base.latenessWd, 4, 'baseline should be 4 wd late');
assert.ok(base.confidence < 30, 'baseline confidence should read as critical');
assert.strictEqual(dr.ranked.length, 3, 'should find 3 ranked causes');
assert.strictEqual(rec.ranked.length, 3, 'should rank 3 interventions');
assert.ok(rec.planEval.slackWd >= 0, 'full plan should recover the target date');
assert.ok(rec.planEval.confidence > base.confidence + 30, 'plan should move confidence materially');
console.log('\nall assertions passed');
