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
 * Current batch (of the phased Phase 3 rollout):
 *   Module 1 — PR highlighting
 *   Module 2 — Plateau detection
 * Later modules (progression trend, weekly volume, consistency, shared-axis
 * bodyweight/strength, note co-location) arrive as their own increments.
 */

// ─────────────────────────────────────────────────────────────────────────────
//  TUNABLE THRESHOLDS — every magic number lives here, nowhere inline
// ─────────────────────────────────────────────────────────────────────────────

const EPLEY_REPS_DIVISOR = 30;          // e1RM = weight × (1 + reps / 30)

// Module 1 — PR highlighting
const RECENT_PR_WINDOW_DAYS = 30;       // a PR counts as "recent" within this window
const RECENT_PR_LIMIT       = 5;        // most recent PRs surfaced on the hub

// Module 2 — plateau detection ("no improvement across N logged sessions")
const COMPOUND_PLATEAU_SESSIONS  = 3;   // compounds tracked by estimated 1RM
const ISOLATION_PLATEAU_SESSIONS = 4;   // isolation tracked by total volume
const PLATEAU_LIMIT              = 6;    // most stale exercises surfaced at once

// Floating-point guard so an identical e1RM counts as "no improvement", not a gain.
const IMPROVEMENT_EPSILON = 1e-6;

// Compound lifts progress by load (estimated 1RM); everything else by weight/volume.
const COMPOUND_NAME_KEYWORDS = [
  'bench press', 'squat', 'overhead press', 'romanian deadlift', 'deadlift',
  'pull-up', 'pullup', 'pull up', 'lat pulldown', 'row', 'leg press',
];
const ISOLATION_NAME_KEYWORDS = [
  'curl', 'pushdown', 'push-down', 'face pull', 'calf raise',
  'external rotation', 'rear delt', 'fly', 'pull-apart', 'pull apart', 'raise',
];

// ─────────────────────────────────────────────────────────────────────────────
//  SMALL LOCAL UTILITIES (kept self-contained — insights.js has no app.js deps)
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

// ─────────────────────────────────────────────────────────────────────────────
//  EXERCISE CLASSIFICATION
// ─────────────────────────────────────────────────────────────────────────────

/** True when a rep-based exercise should be tracked by estimated 1RM. */
function isCompoundExercise(name) {
  const n = (name ?? '').toLowerCase();
  if (ISOLATION_NAME_KEYWORDS.some(k => n.includes(k))) return false;
  if (COMPOUND_NAME_KEYWORDS.some(k => n.includes(k))) return true;
  return false;
}

/**
 * Resolves how one exercise is measured. Seconds-based holds (isometrics) are
 * never "compound" — an e1RM off a hold duration would be meaningless.
 */
function classify(name, unit) {
  const isSeconds = unit === 'seconds';
  return { isSeconds, isCompound: !isSeconds && isCompoundExercise(name) };
}

// ─────────────────────────────────────────────────────────────────────────────
//  EXERCISE CATALOG (id → {id, name, unit})
//  Built from the same three sources app.js resolves names from: the recurring
//  plan, per-session swaps/adds, and the orphan registry.
// ─────────────────────────────────────────────────────────────────────────────

function buildExerciseCatalog(plan, meta) {
  const catalog = new Map();
  const add = (ex) => {
    if (!ex?.id || !ex.name) return;
    catalog.set(ex.id, { id: ex.id, name: ex.name, unit: ex.unit ?? 'reps' });
  };

  if (plan) {
    for (const day of plan.days) {
      for (const ex of (day.exercises ?? [])) add(ex);
    }
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

function epley1RM(weight, reps) {
  if (weight == null || reps == null || reps <= 0) return null;
  return weight * (1 + reps / EPLEY_REPS_DIVISOR);
}

/** Completed, fully-numbered sets for one exercise on one date. */
function doneSets(logs, exerciseId, date) {
  return logs.filter(l =>
    l.exerciseId === exerciseId && l.date === date && l.done &&
    l.weight != null && l.reps != null
  );
}

/** Every date (oldest first) this exercise has at least one completed set. */
function distinctDates(logs, exerciseId) {
  return [...new Set(
    logs
      .filter(l => l.exerciseId === exerciseId && l.done && l.weight != null && l.reps != null)
      .map(l => l.date)
  )].sort();
}

/**
 * PR metric for one session's sets (module 1):
 *   seconds  → longest single hold
 *   compound → best set's estimated 1RM
 *   else     → heaviest single set
 * Returns { value, weight, reps } or null. `value` is what a PR ranks on.
 */
function prSessionMetric(sets, kind) {
  if (!sets.length) return null;

  if (kind.isSeconds) {
    const best = sets.reduce((b, s) => (s.reps > (b?.reps ?? -Infinity) ? s : b), null);
    return { value: best.reps, weight: best.weight, reps: best.reps };
  }
  if (kind.isCompound) {
    let best = null;
    for (const s of sets) {
      const e = epley1RM(s.weight, s.reps);
      if (e != null && (best == null || e > best.value)) {
        best = { value: e, weight: s.weight, reps: s.reps };
      }
    }
    return best;
  }
  const best = sets.reduce((b, s) => (s.weight > (b?.weight ?? -Infinity) ? s : b), null);
  return { value: best.weight, weight: best.weight, reps: best.reps };
}

/**
 * Progression metric for plateau detection (module 2):
 *   compound → best set's estimated 1RM
 *   else     → total session volume (Σ weight × reps)
 * Seconds-based holds are excluded from plateau detection entirely.
 */
function plateauSessionMetric(sets, kind) {
  if (!sets.length || kind.isSeconds) return null;
  if (kind.isCompound) {
    let best = null;
    for (const s of sets) {
      const e = epley1RM(s.weight, s.reps);
      if (e != null && (best == null || e > best)) best = e;
    }
    return best;
  }
  return sets.reduce((sum, s) => sum + s.weight * s.reps, 0);
}

/** All-time best PR for one exercise (set-level value + the date holding it), or null. */
function exercisePR(logs, ex) {
  const kind = classify(ex.name, ex.unit);
  let best = null;
  for (const date of distinctDates(logs, ex.id)) {
    const m = prSessionMetric(doneSets(logs, ex.id, date), kind);
    if (m && (best == null || m.value > best.value)) best = { ...m, date };
  }
  if (!best) return null;
  return {
    id: ex.id,
    name: ex.name,
    unit: ex.unit,
    kind,
    date: best.date,
    value: best.value,
    weight: best.weight,
    reps: best.reps,
  };
}

/** Formats a PR's headline value for display, with an optional metric qualifier. */
function prDisplay(pr) {
  if (pr.kind.isSeconds) return { value: `${pr.reps}s`, note: '' };
  if (pr.kind.isCompound) return { value: `${round1(pr.value)}kg`, note: 'e1RM' };
  return { value: `${pr.weight}kg`, note: '' };
}

/**
 * Logged sessions since this series last set a new high — i.e. how many
 * sessions of "no improvement" trail the last record. A brand-new high resets
 * the count to zero.
 */
function sessionsSinceImprovement(series) {
  let runningMax = -Infinity;
  let lastImprovement = -1;
  series.forEach((v, i) => {
    if (v > runningMax + IMPROVEMENT_EPSILON) {
      runningMax = v;
      lastImprovement = i;
    }
  });
  return (series.length - 1) - lastImprovement;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Module 1 — the current all-time PR for a single exercise, or null.
 * app.js passes the name/unit it already knows so the hot log-render path
 * doesn't rebuild the whole catalog. Used for the Today badge and to mark the
 * record session in per-exercise history.
 */
function getExercisePR(state, exerciseId, { name = '', unit = 'reps' } = {}) {
  const pr = exercisePR(state.logs, { id: exerciseId, name, unit });
  if (!pr) return null;
  return { ...pr, display: prDisplay(pr) };
}

/**
 * Module 1 — recent PRs across every known exercise, newest first, for the hub.
 * A PR is simply "highest value to date for this exercise on its metric"; it is
 * "recent" when that record was set within the window.
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
 * Module 2 — exercises whose progression metric hasn't improved across the
 * threshold number of sessions. Output is a factual flag only: the exercise,
 * how many sessions have passed without a gain, and the date of the last one.
 * No suggestion, no cause — those belong to the analysis layer.
 */
function computePlateaus(state, { limit = PLATEAU_LIMIT } = {}) {
  const catalog = buildExerciseCatalog(state.plan, state.meta);

  const flags = [];
  for (const ex of catalog.values()) {
    const kind = classify(ex.name, ex.unit);
    if (kind.isSeconds) continue; // holds aren't a load-progression concept here

    const threshold = kind.isCompound ? COMPOUND_PLATEAU_SESSIONS : ISOLATION_PLATEAU_SESSIONS;
    const dates = distinctDates(state.logs, ex.id);
    // Need a baseline session plus `threshold` flat ones to say "no gain in N".
    if (dates.length < threshold + 1) continue;

    const series = dates.map(d => plateauSessionMetric(doneSets(state.logs, ex.id, d), kind));
    const stale = sessionsSinceImprovement(series);
    if (stale < threshold) continue;

    flags.push({
      id: ex.id,
      name: ex.name,
      metric: kind.isCompound ? 'e1rm' : 'volume',
      metricLabel: kind.isCompound ? 'estimated-1RM' : 'volume',
      sessions: stale,
      sinceDate: dates[dates.length - 1 - stale], // date of the last record
    });
  }

  // Most stale first — the ones flat the longest lead.
  flags.sort((a, b) => b.sessions - a.sessions || b.sinceDate.localeCompare(a.sinceDate));
  return flags.slice(0, limit);
}

/**
 * Module 1 — called the moment a set is marked done: did this session set a new
 * all-time PR for the exercise? Returns a facts-only message for a toast, or
 * null. States the record and its numbers; it does not coach.
 */
function checkForNewPB(state, exerciseId, exerciseName, exerciseUnit, date) {
  const kind = classify(exerciseName, exerciseUnit);
  const todayMetric = prSessionMetric(doneSets(state.logs, exerciseId, date), kind);
  if (!todayMetric) return null;

  // Best across every other session — today only counts if it beats all of them.
  let prevBest = null;
  for (const d of distinctDates(state.logs, exerciseId)) {
    if (d === date) continue;
    const m = prSessionMetric(doneSets(state.logs, exerciseId, d), kind);
    if (m && (prevBest == null || m.value > prevBest.value)) prevBest = m;
  }
  if (prevBest && todayMetric.value <= prevBest.value + IMPROVEMENT_EPSILON) return null;

  if (kind.isSeconds) return `New PR · ${exerciseName}: ${todayMetric.reps}s hold`;
  if (kind.isCompound) {
    return `New PR · ${exerciseName}: ${round1(todayMetric.value)}kg e1RM (${todayMetric.weight}kg × ${todayMetric.reps})`;
  }
  return `New PR · ${exerciseName}: ${todayMetric.weight}kg`;
}

export {
  checkForNewPB,
  computeRecentPRs,
  computePlateaus,
  getExercisePR,
  isCompoundExercise,
};
