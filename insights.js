/**
 * insights.js — FitTrack · Deterministic Insights Engine (Phase 3)
 *
 * Authored, deterministic computations over locally-stored session logs.
 * The app DISPLAYS facts; it does not coach. Every function here returns a
 * verifiable factual result — a personal record, or a "no progress in N
 * sessions" flag — never a recommendation, and never an inference about *why*.
 * Prescription and interpretation live in the external analysis layer (Claude).
 *
 * Pure compute: no DOM, no network, no persistence, no randomness. The same
 * logs in always produce the same results out. Card rendering in the house
 * style lives in app.js; this module only answers "what is true".
 *
 * Measurement is governed by each exercise's `loadType` (assigned from the
 * vendored exercise library / user typing, resolved in app.js), NOT by its
 * name. This is the fix for phantom records — a pull-up is `bodyweight`, so it
 * PRs on reps, and no meaningless kg estimate is ever computed for it:
 *   weighted   → estimated 1RM (Epley) on the top set
 *   bodyweight → reps (unloaded); loaded-set e1RM is Claude's, not the app's
 *   assisted   → progression is LESS assistance (or more reps at same assist)
 *   timed      → seconds (longest hold)
 *   reps       → rep count
 * An unknown/untyped exercise is treated conservatively as rep-based — never
 * weighted — so it can never fabricate a kg record.
 *
 * Current batch: Module 1 (PR highlighting) + Module 2 (plateau detection).
 */

// ─────────────────────────────────────────────────────────────────────────────
//  TUNABLE THRESHOLDS — every magic number lives here, nowhere inline
// ─────────────────────────────────────────────────────────────────────────────

const EPLEY_REPS_DIVISOR = 30;          // e1RM = weight × (1 + reps / 30)

// Module 1 — PR highlighting
const RECENT_PR_WINDOW_DAYS = 30;       // a PR counts as "recent" within this window
const RECENT_PR_LIMIT       = 5;        // most recent PRs surfaced on the hub

// Module 2 — plateau detection ("no improvement across N logged sessions").
// The metric watched is set by loadType; the cadence (how many flat sessions)
// still follows the compound/isolation split.
const COMPOUND_PLATEAU_SESSIONS  = 3;
const ISOLATION_PLATEAU_SESSIONS = 4;
const PLATEAU_LIMIT              = 6;    // most stale exercises surfaced at once

// How each type's plateau reads in a sentence ("no ___ gain in N sessions").
const PLATEAU_METRIC_LABELS = {
  weighted:   'estimated-1RM',
  bodyweight: 'reps',
  reps:       'reps',
  timed:      'hold-time',
  assisted:   'assistance',
};

// Axis label for the per-exercise progression chart (module 3).
const SERIES_METRIC_LABELS = {
  weighted:   'Est. 1RM (kg)',
  bodyweight: 'Reps',
  reps:       'Reps',
  timed:      'Hold (s)',
  assisted:   'Assist (kg)',
};

// Floating-point guard so an identical metric counts as "no improvement".
const IMPROVEMENT_EPSILON = 1e-6;

// Assisted progression is "lower assistance is better"; this scale lets a single
// comparable number express "less assist, ties broken by more reps".
const ASSIST_WEIGHT = 1000;

// Compound movements plateau on a shorter cadence than isolation ones. This
// keyword split ONLY chooses 3-vs-4 sessions — it never decides the metric
// (that is loadType's job), so its failure mode is at most a one-session-off
// threshold, never a phantom record.
const COMPOUND_NAME_KEYWORDS = [
  'bench press', 'squat', 'overhead press', 'romanian deadlift', 'deadlift',
  'pull-up', 'pullup', 'pull up', 'chin-up', 'chinup', 'row', 'dip',
  'clean', 'snatch', 'press', 'lat pulldown', 'leg press',
];
const ISOLATION_NAME_KEYWORDS = [
  'curl', 'pushdown', 'push-down', 'face pull', 'calf raise', 'extension',
  'external rotation', 'rear delt', 'fly', 'pull-apart', 'pull apart', 'raise',
];

// ─────────────────────────────────────────────────────────────────────────────
//  ID ALIASING — read-time history reunification
//  Fragmented history (the same movement logged under several ids) is merged
//  onto one canonical id for all metric reads. The map is authored in app.js
//  and injected here so insights.js stays dependency-free. It NEVER mutates
//  logs — it only changes which id a set is counted under when computing a
//  record or a trend. Empty by default (identity mapping).
// ─────────────────────────────────────────────────────────────────────────────

let _aliasMap = {}; // sourceId → canonical (target) id

/** Injects the authored alias map (app.js owns it; called once on load). */
function setAliasMap(map) { _aliasMap = map || {}; }

/** The canonical id a logged/queried id resolves to (itself when unaliased). */
function canonId(id) { return _aliasMap[id] ?? id; }

// ─────────────────────────────────────────────────────────────────────────────
//  SMALL LOCAL UTILITIES (self-contained — insights.js has no app.js deps)
// ─────────────────────────────────────────────────────────────────────────────

function round1(n) {
  return Math.round(n * 10) / 10;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function epley1RM(weight, reps) {
  if (weight == null || reps == null || reps <= 0) return null;
  return weight * (1 + reps / EPLEY_REPS_DIVISOR);
}

/** True when a name suggests a compound movement (used only for plateau cadence). */
function isCompoundExercise(name) {
  const n = (name ?? '').toLowerCase();
  if (ISOLATION_NAME_KEYWORDS.some(k => n.includes(k))) return false;
  if (COMPOUND_NAME_KEYWORDS.some(k => n.includes(k))) return true;
  return false;
}

/** The measurement type to use, defaulting untyped exercises to safe rep-based. */
function effectiveLoadType(ex) {
  if (ex?.loadType) return ex.loadType;
  if (ex?.unit === 'seconds') return 'timed';
  return 'reps'; // conservative — never weighted, so never a phantom kg record
}

// ─────────────────────────────────────────────────────────────────────────────
//  EXERCISE CATALOG (id → {id, name, unit, loadType})
//  Built from the same three sources app.js resolves from: the recurring plan,
//  per-session swaps/adds, and the orphan registry.
// ─────────────────────────────────────────────────────────────────────────────

function buildExerciseCatalog(plan, meta) {
  const catalog = new Map();
  // Key by canonical id and keep the FIRST def seen for it. Plan defs are added
  // before swap/registry defs, so a current plan exercise wins over the retired
  // source ids aliased onto it — the merged exercise is listed once, under its
  // current identity, and hub PR/plateau scans never double-count it.
  const add = (ex) => {
    if (!ex?.id || !ex.name) return;
    const cid = canonId(ex.id);
    if (catalog.has(cid)) return;
    catalog.set(cid, {
      id: cid, name: ex.name, unit: ex.unit ?? 'reps', loadType: ex.loadType ?? null,
    });
  };

  // Routines first (the plan's own exercises), then session-scoped swaps, then
  // the orphan registry. `plan.days` is the pre-v2 shape and is still read so a
  // backup restored from before routines existed still builds a full catalog.
  for (const routine of (plan?.routines ?? [])) {
    for (const ex of (routine.exercises ?? [])) add(ex);
  }
  for (const day of (plan?.days ?? [])) {
    for (const ex of (day.exercises ?? [])) add(ex);
  }
  for (const key in meta) {
    if (!key.startsWith('swaps_')) continue;
    for (const ex of (meta[key]?.value ?? [])) add(ex);
  }
  const registry = meta['exerciseRegistry']?.value ?? {};
  for (const id in registry) add(registry[id]);

  return catalog;
}

// ─────────────────────────────────────────────────────────────────────────────
//  METRIC HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Completed sets for one exercise on one date. Gate is reps present (reps or
 *  seconds); weight is optional, since bodyweight/timed/rep work carries none. */
function doneSets(logs, exerciseId, date) {
  const target = canonId(exerciseId);
  return logs.filter(l =>
    canonId(l.exerciseId) === target && l.date === date && l.done && l.reps != null
  );
}

/** Every date (oldest first) this exercise has at least one completed set. */
function distinctDates(logs, exerciseId) {
  const target = canonId(exerciseId);
  return [...new Set(
    logs.filter(l => canonId(l.exerciseId) === target && l.done && l.reps != null).map(l => l.date)
  )].sort();
}

/** The set maximising sel(set), with its value, or null. */
function bestBy(sets, sel) {
  let best = null;
  let bestVal = -Infinity;
  for (const s of sets) {
    const v = sel(s);
    if (v != null && v > bestVal) { bestVal = v; best = s; }
  }
  return best ? { set: best, value: bestVal } : null;
}

/**
 * The record metric for one session's sets, by loadType. Returns
 * { value, weight, reps } where `value` is what a PR/plateau ranks on and
 * weight/reps carry the achieving set for display. Null when unrankable.
 */
function sessionMetric(sets, loadType) {
  if (!sets.length) return null;

  switch (loadType) {
    case 'weighted': {
      const b = bestBy(sets, s => epley1RM(s.weight, s.reps));
      return b && { value: b.value, weight: b.set.weight, reps: b.set.reps };
    }
    case 'timed': {
      // Seconds live in the reps field for timed work.
      const b = bestBy(sets, s => s.reps);
      return b && { value: b.value, weight: null, reps: b.set.reps };
    }
    case 'assisted': {
      // Lower assistance is better; ties broken by more reps at that assist.
      const assists = sets.map(s => s.weight).filter(w => w != null);
      if (!assists.length) return null;
      const minAssist = Math.min(...assists);
      const reps = Math.max(...sets.filter(s => s.weight === minAssist).map(s => s.reps ?? 0));
      return { value: -minAssist * ASSIST_WEIGHT + reps, weight: minAssist, reps };
    }
    case 'bodyweight':
    case 'reps':
    default: {
      // Unloaded progression is reps. (Loaded-bodyweight e1RM is Claude's job.)
      const b = bestBy(sets, s => s.reps);
      return b && { value: b.value, weight: b.set.weight, reps: b.set.reps };
    }
  }
}

/** All-time best PR for one exercise (the achieving session), or null. */
function exercisePR(logs, ex) {
  const loadType = effectiveLoadType(ex);
  let best = null;
  for (const date of distinctDates(logs, ex.id)) {
    const m = sessionMetric(doneSets(logs, ex.id, date), loadType);
    if (m && (best == null || m.value > best.value)) best = { ...m, date };
  }
  if (!best) return null;
  return {
    id: ex.id, name: ex.name, unit: ex.unit, loadType,
    date: best.date, value: best.value, weight: best.weight, reps: best.reps,
  };
}

/** Formats a PR's headline value by loadType, with an optional qualifier note. */
function prDisplay(pr) {
  switch (pr.loadType) {
    case 'weighted':   return { value: `${round1(pr.value)}kg`, note: 'e1RM' };
    case 'timed':      return { value: `${pr.reps}s`, note: '' };
    case 'assisted':   return { value: `${pr.weight}kg`, note: 'assist' };
    case 'bodyweight':
    case 'reps':
    default:           return { value: `${pr.reps} reps`, note: '' };
  }
}

/**
 * Logged sessions since this series last set a new high — how many sessions of
 * "no improvement" trail the last record. A new high resets the count to zero.
 */
function sessionsSinceImprovement(series) {
  let runningMax = -Infinity;
  let lastImprovement = -1;
  series.forEach((v, i) => {
    if (v > runningMax + IMPROVEMENT_EPSILON) { runningMax = v; lastImprovement = i; }
  });
  return (series.length - 1) - lastImprovement;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Module 1 — the current all-time PR for a single exercise, or null. app.js
 * passes the {name, unit, loadType} it already knows so the log-render hot path
 * doesn't rebuild the catalog. Used for the Today badge and history marking.
 */
function getExercisePR(state, exerciseId, { name = '', unit = 'reps', loadType = null } = {}) {
  const pr = exercisePR(state.logs, { id: exerciseId, name, unit, loadType });
  if (!pr) return null;
  return { ...pr, display: prDisplay(pr) };
}

/**
 * Module 1 — recent PRs across every known exercise, newest first, for the hub.
 * A PR is "highest value to date on this exercise's metric"; it is "recent"
 * when that record was set within the window.
 */
function computeRecentPRs(state, { today, withinDays = RECENT_PR_WINDOW_DAYS, limit = RECENT_PR_LIMIT } = {}) {
  const cutoff = today ? addDays(today, -withinDays) : '';
  const catalog = buildExerciseCatalog(state.plan, state.meta);

  const prs = [];
  for (const ex of catalog.values()) {
    const pr = exercisePR(state.logs, ex);
    if (!pr) continue;
    if (cutoff && pr.date < cutoff) continue;
    prs.push({ ...pr, display: prDisplay(pr) });
  }
  prs.sort((a, b) => b.date.localeCompare(a.date));
  return prs.slice(0, limit);
}

/**
 * Module 3 — the per-exercise progression series: one point per logged session
 * (oldest first), plotting that exercise's progression metric per loadType.
 * Deterministic and lossless — every session is a point, no smoothing. For
 * assisted work the plotted value is the session's least assistance (so a
 * downward line is progress — `lowerIsBetter`).
 */
function computeExerciseSeries(state, exerciseId, { name = '', unit = 'reps', loadType = null } = {}) {
  const lt = loadType || (unit === 'seconds' ? 'timed' : 'reps');
  const points = [];
  for (const date of distinctDates(state.logs, exerciseId)) {
    const m = sessionMetric(doneSets(state.logs, exerciseId, date), lt);
    if (!m) continue;
    const value = lt === 'assisted' ? m.weight
      : lt === 'weighted' ? round1(m.value)
      : m.value;
    points.push({ date, value });
  }
  return {
    loadType: lt,
    metricLabel: SERIES_METRIC_LABELS[lt] ?? 'Reps',
    lowerIsBetter: lt === 'assisted',
    points,
  };
}

/**
 * Module 2 — exercises whose progression metric (set by loadType) hasn't
 * improved across the threshold number of sessions. A factual flag only: the
 * exercise, how many sessions without a gain, and the date of the last record.
 * No suggestion, no cause — those belong to the analysis layer.
 */
function computePlateaus(state, { limit = PLATEAU_LIMIT } = {}) {
  const catalog = buildExerciseCatalog(state.plan, state.meta);

  const flags = [];
  for (const ex of catalog.values()) {
    const loadType = effectiveLoadType(ex);
    const threshold = isCompoundExercise(ex.name) ? COMPOUND_PLATEAU_SESSIONS : ISOLATION_PLATEAU_SESSIONS;

    const dates = distinctDates(state.logs, ex.id);
    if (dates.length < threshold + 1) continue; // need a baseline + N flat sessions

    const series = dates.map(d => sessionMetric(doneSets(state.logs, ex.id, d), loadType)?.value);
    if (series.some(v => v == null)) continue; // an unrankable session — skip, don't guess

    const stale = sessionsSinceImprovement(series);
    if (stale < threshold) continue;

    flags.push({
      id: ex.id,
      name: ex.name,
      loadType,
      metricLabel: PLATEAU_METRIC_LABELS[loadType] ?? 'progress',
      sessions: stale,
      sinceDate: dates[dates.length - 1 - stale], // date of the last record
    });
  }

  flags.sort((a, b) => b.sessions - a.sessions || b.sinceDate.localeCompare(a.sinceDate));
  return flags.slice(0, limit);
}

/**
 * Module 1 — called the moment a set is marked done: did this session set a new
 * all-time PR for the exercise? Returns a facts-only message for a toast, or
 * null. States the record and its numbers; it does not coach.
 */
function checkForNewPB(state, exerciseId, exerciseName, loadType, date) {
  const kind = loadType || 'reps';
  const todayMetric = sessionMetric(doneSets(state.logs, exerciseId, date), kind);
  if (!todayMetric) return null;

  let prevBest = null;
  for (const d of distinctDates(state.logs, exerciseId)) {
    if (d === date) continue;
    const m = sessionMetric(doneSets(state.logs, exerciseId, d), kind);
    if (m && (prevBest == null || m.value > prevBest.value)) prevBest = m;
  }
  if (prevBest && todayMetric.value <= prevBest.value + IMPROVEMENT_EPSILON) return null;

  switch (kind) {
    case 'weighted':
      return `New PR · ${exerciseName}: ${round1(todayMetric.value)}kg e1RM (${todayMetric.weight}kg × ${todayMetric.reps})`;
    case 'timed':
      return `New PR · ${exerciseName}: ${todayMetric.reps}s hold`;
    case 'assisted':
      return `New PR · ${exerciseName}: ${todayMetric.weight}kg assist × ${todayMetric.reps}`;
    default:
      return `New PR · ${exerciseName}: ${todayMetric.reps} reps`;
  }
}

export {
  setAliasMap,
  checkForNewPB,
  computeRecentPRs,
  computePlateaus,
  computeExerciseSeries,
  getExercisePR,
  isCompoundExercise,
  // Additionally exported for the standalone regression test (insights.test.mjs).
  // Pure helpers with no app coupling; exporting them lets the test check each
  // in isolation rather than only through the aggregate hub functions.
  canonId,
  epley1RM,
  sessionMetric,
  sessionsSinceImprovement,
};
