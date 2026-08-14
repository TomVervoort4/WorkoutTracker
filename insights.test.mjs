/**
 * insights.test.mjs — FitTrack · standalone regression guard for insights.js
 *
 * Runs under plain `node insights.test.mjs`. NO dependencies, NO framework, NO
 * build step — just ES-module imports and hand-rolled assertions. This file is
 * NOT imported by the app and is NOT in the service-worker cache list; it exists
 * only to be run by hand when insights.js changes, so a silent metric
 * regression can't quietly corrupt what the app displays.
 *
 * insights.js is pure functions over plain data (no DOM / network / persistence),
 * which is exactly what makes it cheap and meaningful to test in isolation.
 */

import {
  epley1RM,
  sessionMetric,
  sessionsSinceImprovement,
  computePlateaus,
  computeRecentPRs,
  canonId,
  setAliasMap,
} from './insights.js';

// ── Tiny assertion harness (vanilla — no test runner) ───────────────────────
let passed = 0, failed = 0;
function check(desc, cond) {
  if (cond) { passed++; console.log(`  ✓ ${desc}`); }
  else      { failed++; console.error(`  ✗ ${desc}`); }
}
/** Floating-point-tolerant equality for e1RM comparisons. */
function approx(a, b, eps = 1e-4) { return typeof a === 'number' && Math.abs(a - b) <= eps; }

// ─────────────────────────────────────────────────────────────────────────────
console.log('Epley e1RM');
// e1RM = weight × (1 + reps/30). 100kg × 5 → 100 × (1 + 5/30) = 116.6667.
check('100kg × 5 reps → 116.6667 (Epley formula)', approx(epley1RM(100, 5), 116.6666667));
check('100kg × 1 rep → weight itself + 1/30 (103.3333)', approx(epley1RM(100, 1), 103.3333333));
check('zero reps is unrankable → null (never a 1RM of the bare weight)', epley1RM(100, 0) === null);
check('missing weight → null (no fabricated estimate)', epley1RM(null, 5) === null);

// ─────────────────────────────────────────────────────────────────────────────
console.log('sessionMetric — the ranked metric is chosen by loadType');
// weighted → the set with the highest estimated 1RM (not the heaviest set).
{
  const sets = [{ weight: 100, reps: 5 }, { weight: 110, reps: 3 }];
  const m = sessionMetric(sets, 'weighted');
  // 100×5 → 116.667 vs 110×3 → 121; the 110×3 set wins on e1RM.
  check('weighted picks the top e1RM set (110×3 → 121 beats 100×5)',
    approx(m.value, 121) && m.weight === 110 && m.reps === 3);
}
// bodyweight / reps → most reps in the session; no kg estimate at all.
{
  const m = sessionMetric([{ reps: 8 }, { reps: 12 }], 'bodyweight');
  check('bodyweight ranks on reps (best of 8/12 → 12)', m.value === 12 && m.reps === 12);
  const r = sessionMetric([{ reps: 8 }, { reps: 12 }], 'reps');
  check('reps ranks on reps (best of 8/12 → 12)', r.value === 12 && r.reps === 12);
}
// timed → longest hold (seconds live in the reps field for timed work).
{
  const m = sessionMetric([{ reps: 30 }, { reps: 45 }], 'timed');
  check('timed ranks on longest hold (45s beats 30s)', m.value === 45 && m.reps === 45);
}
// assisted → least assistance wins; ties broken by more reps at that assist.
{
  const sets = [{ weight: 20, reps: 8 }, { weight: 15, reps: 6 }, { weight: 15, reps: 9 }];
  const m = sessionMetric(sets, 'assisted');
  // Lowest assist is 15kg; among 15kg sets the best is 9 reps. value encodes
  // "less assist, then more reps" as a single comparable number.
  check('assisted picks least assist, rep tie-break (15kg × 9)',
    m.weight === 15 && m.reps === 9 && m.value === -15 * 1000 + 9);
}
check('empty session is unrankable → null', sessionMetric([], 'weighted') === null);

// ─────────────────────────────────────────────────────────────────────────────
console.log('sessionsSinceImprovement — flat-session counting incl. reset-on-new-high');
// Strictly rising series: every session is a new high → 0 stale sessions.
check('all-rising [10,20,30] → 0 sessions since a new high',
  sessionsSinceImprovement([10, 20, 30]) === 0);
// Peak at index 1, then two flat sessions trail it → 2 stale.
check('[10,20,20,20] → 2 sessions since the last improvement',
  sessionsSinceImprovement([10, 20, 20, 20]) === 2);
// A dip then a new high must RESET the count to 0 (the reset-on-new-high case).
check('[10,20,15,25] → 0 (a new high resets the stale count)',
  sessionsSinceImprovement([10, 20, 15, 25]) === 0);
// A single session has nothing to plateau against → 0.
check('single session [10] → 0', sessionsSinceImprovement([10]) === 0);

// ─────────────────────────────────────────────────────────────────────────────
console.log('computePlateaus — compound/isolation thresholds + skip-unrankable');
{
  setAliasMap({}); // identity — no merging in this fixture
  // Three weighted exercises, all with 4 dates of a flat (unimproving) metric:
  //   • Bench Press — COMPOUND (threshold 3): 4 flat sessions → 3 stale → FLAGGED
  //   • Concentration Curl — ISOLATION (threshold 4): 4 dates is one short of the
  //     baseline+4 it needs → NOT flagged (proves the higher isolation cadence)
  //   • Overhead Press — COMPOUND, but one session is unrankable (a set with no
  //     weight) → the series has a null → SKIPPED, not guessed → NOT flagged
  const dates = ['2026-01-01', '2026-01-08', '2026-01-15', '2026-01-22'];
  const flat = (id, w) => dates.map(date => ({ exerciseId: id, date, weight: w, reps: 5, done: true }));

  const plan = { days: [{ exercises: [
    { id: 'bench', name: 'Bench Press',         loadType: 'weighted', unit: 'reps' },
    { id: 'curl',  name: 'Concentration Curl',  loadType: 'weighted', unit: 'reps' },
    { id: 'ohp',   name: 'Overhead Press',      loadType: 'weighted', unit: 'reps' },
  ] }] };

  const logs = [
    ...flat('bench', 100),
    ...flat('curl', 20),
    // OHP: three rankable flat sessions + one with no weight (unrankable).
    { exerciseId: 'ohp', date: dates[0], weight: 50, reps: 5, done: true },
    { exerciseId: 'ohp', date: dates[1], weight: 50, reps: 5, done: true },
    { exerciseId: 'ohp', date: dates[2], weight: 50, reps: 5, done: true },
    { exerciseId: 'ohp', date: dates[3], weight: null, reps: 5, done: true },
  ];

  const flags = computePlateaus({ plan, meta: {}, logs });
  const names = flags.map(f => f.name);
  check('compound (Bench Press) with 3 flat sessions is flagged', names.includes('Bench Press'));
  check('isolation (Concentration Curl) needs 4 flat sessions — not flagged at 3',
    !names.includes('Concentration Curl'));
  check('exercise with an unrankable session is skipped, not guessed (Overhead Press absent)',
    !names.includes('Overhead Press'));
  check('exactly one exercise flagged in this fixture', flags.length === 1);
  const bench = flags.find(f => f.name === 'Bench Press');
  check('Bench Press reports 3 flat sessions since its last record', bench && bench.sessions === 3);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('canonId + alias merge — fragmented history reunifies without double-count');
{
  // A retired id ('old_bench') aliases onto the current plan id ('bench').
  setAliasMap({ old_bench: 'bench' });
  check('canonId maps a retired id onto its canonical id', canonId('old_bench') === 'bench');
  check('canonId is identity for an unaliased id', canonId('bench') === 'bench');
  check('canonId is identity for an unknown id', canonId('mystery') === 'mystery');

  // The all-time record lives under the RETIRED id; the current id holds a lower
  // session. A correct merge counts BOTH under 'bench', surfaces the retired-id
  // record as the PR, and lists the exercise ONCE (no fragment duplicate).
  const plan = { days: [{ exercises: [
    { id: 'bench', name: 'Bench Press', loadType: 'weighted', unit: 'reps' },
  ] }] };
  const logs = [
    { exerciseId: 'old_bench', date: '2026-02-01', weight: 130, reps: 5, done: true }, // e1RM 151.667 (record)
    { exerciseId: 'bench',     date: '2026-02-08', weight: 120, reps: 3, done: true }, // e1RM 132
  ];

  const prs = computeRecentPRs({ plan, meta: {}, logs }, { today: '2026-02-10' });
  check('merged movement appears exactly once (no fragment duplicate)', prs.length === 1);
  check('PR is the retired-id record, proving history merged onto the canonical id',
    prs.length === 1 && prs[0].id === 'bench' && approx(prs[0].value, 151.6666667) && prs[0].date === '2026-02-01');
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
