/**
 * progression.js — FitTrack · automatic progression
 *
 * What weight (or how many reps, or how many seconds) the plan calls for NEXT,
 * derived from what was actually logged. Pure functions over the log; nothing
 * here writes anything back.
 *
 * That last point is the design. There are no stored counters, no "streak"
 * field on an exercise, no snapshot of the last prescription. The next target
 * is recomputed from history every time it is needed, which means correcting a
 * mistyped set — or changing the rule — immediately produces the right number
 * instead of leaving a stale counter to drift.
 *
 * READING A SESSION HONESTLY IS THE WHOLE GAME:
 *   · a set checked off with at least its target reps  → hit
 *   · a set checked off with fewer reps                → miss (you logged what you got)
 *   · a set never checked off                          → miss (it was not performed)
 *   · fewer sets logged than prescribed                → miss
 * A session that fell apart can therefore never advance the load as though it
 * had succeeded.
 *
 * WHERE THIS SITS RELATIVE TO THE APP'S "FACTS ONLY" LINE. A progression rule
 * is not an inference about the user — it is arithmetic on a rule THEY chose
 * and can see. Every prescription carries a `why`, in plain words, naming the
 * rule and the sessions it read. Nothing is suggested that the user could not
 * work out by hand from the same two numbers. Turning the rule off ('off')
 * leaves targets exactly where they were set.
 *
 * Ported from openGym's lib/progression.js (AGPL, personal use) and adapted to
 * FitTrack's log shape and loadType vocabulary.
 */

// ─────────────────────────────────────────────────────────────────────────────
//  POLICIES
// ─────────────────────────────────────────────────────────────────────────────

const POLICIES = ['off', 'linear', 'greyskull', 'double', 'time'];

/**
 * Which policies can sensibly drive which logging mode. `assisted` gets only
 * 'off': "add 2.5 kg" is backwards when less assistance is the progress, and
 * the app does not invent a reverse-linear rule the user never asked for.
 */
const POLICIES_FOR = {
  reps:       ['off', 'linear', 'greyskull', 'double'],
  bodyweight: ['off', 'linear', 'double'],
  time:       ['off', 'time'],
  assisted:   ['off'],
};

const POLICY_NAME = {
  off:       'No automatic progression',
  linear:    'Linear progression',
  greyskull: 'Greyskull LP',
  double:    'Double progression',
  time:      'Add time',
};

const POLICY_DESC = {
  off:       'Targets stay where you set them.',
  linear:    'Hit every rep in every set and the weight goes up. Repeated misses trigger a deload.',
  greyskull: 'Two straight sets plus a final set taken to failure. Beat the target on that set and the weight goes up — double if you double the reps. One failure resets 10%.',
  double:    'Work up through a rep range at the same weight. Reach the top of the range in every set and the weight goes up, reps back to the bottom.',
  time:      'Hold every set for the full duration and the target goes up.',
};

/**
 * Sessions of repeated misses before a deload. Greyskull resets on the first
 * failure by design; the general linear policy gives two more cracks at it.
 */
const DELOAD_AFTER = { linear: 3, greyskull: 1, double: 3, time: 3 };
const DELOAD_FACTOR = 0.9;

/** Default load step, in kg. Lower-body lifts take the bigger jump — that is the
 *  "lift-specific increment" a linear program lives on. An exercise overrides it
 *  with its own `inc`. */
const HEAVY_MUSCLES = /quad|glute|hamstring|calf|calve|gastro|soleus|erector|lower back|spine/i;
const DEFAULT_INCREMENT_KG = 2.5;
const HEAVY_INCREMENT_KG   = 5;
const DEFAULT_SEC_INCREMENT = 5;

/** The step for one exercise: its own override, else muscle-group default. */
function defaultIncrement(ex) {
  if (loggingModeOf(ex) === 'time') return DEFAULT_SEC_INCREMENT;
  return HEAVY_MUSCLES.test(ex?.muscles ?? '') ? HEAVY_INCREMENT_KG : DEFAULT_INCREMENT_KG;
}

function incrementFor(ex) {
  return ex?.inc > 0 ? Number(ex.inc) : defaultIncrement(ex);
}

// ─────────────────────────────────────────────────────────────────────────────
//  MODES — FitTrack's loadType folded onto what a policy actually needs to know
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 'reps' (external load × reps) | 'bodyweight' (reps, load optional) |
 * 'time' (seconds held) | 'assisted' (machine assistance, lower is better).
 */
function loggingModeOf(ex) {
  const lt = ex?.loadType ?? (ex?.unit === 'seconds' ? 'timed' : null);
  if (lt === 'timed') return 'time';
  if (lt === 'assisted') return 'assisted';
  if (lt === 'bodyweight' || lt === 'reps') return 'bodyweight';
  return 'reps';
}

/**
 * The policy in force for one exercise: its own override, else the routine's
 * default, else the mode's default. An override the mode cannot honour (a
 * linear rule left on an exercise later switched to timed) falls back to 'off'
 * rather than silently doing something else.
 */
function policyFor(ex, routine) {
  const mode = loggingModeOf(ex);
  const allowed = POLICIES_FOR[mode] ?? ['off'];
  const pick = ex?.prog || routine?.prog || (mode === 'time' ? 'time' : mode === 'assisted' ? 'off' : 'linear');
  return allowed.includes(pick) ? pick : 'off';
}

// ─────────────────────────────────────────────────────────────────────────────
//  SMALL NUMERIC HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const round1 = (v) => Math.round(v * 10) / 10;

/** Snap to a loadable multiple of the step. */
function snap(v, step) {
  if (!(step > 0)) return round1(v);
  return round1(Math.round(v / step) * step);
}

/**
 * Back off by DELOAD_FACTOR, landing on something you can actually load.
 * Rounding to the nearest step keeps the cut close to the intended 10%, but on
 * small weights the nearest step can be the weight you started from — so a
 * deload that did not actually reduce anything takes one step down instead.
 */
function deloadTo(cur, step) {
  let next = snap(cur * DELOAD_FACTOR, step);
  if (next >= cur) next = snap(cur - step, step);
  return Math.max(step, next);
}

/**
 * The target rep range from a plan's `reps` field. FitTrack stores it as free
 * text, so "8", "8-10" and "8–10" all have to read. Returns { bottom, top },
 * or nulls when there is no number in there at all.
 */
function parseRepRange(reps) {
  const nums = String(reps ?? '').match(/\d+/g);
  if (!nums || !nums.length) return { bottom: null, top: null };
  const a = Number(nums[0]);
  const b = nums.length > 1 ? Number(nums[1]) : a;
  return { bottom: Math.min(a, b), top: Math.max(a, b) };
}

// ─────────────────────────────────────────────────────────────────────────────
//  READING THE LOG
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reduce one logged session to what a policy needs to judge it. `logs` is that
 * date's set records for one exercise, `ex` the plan entry they were performed
 * against (for the target they should be judged on).
 *
 * A set that was never checked off scores zero rather than being skipped — the
 * distinction between "did three of five sets" and "did three sets" is exactly
 * what stops a collapsed session reading as a clean one.
 */
function readSession(logs, ex) {
  const mode = loggingModeOf(ex);
  const planned = Number(ex?.sets) || logs.length;
  const enough = logs.length >= planned;
  const doneLogs = logs.filter(l => l.done);
  const weight = doneLogs.length ? Math.max(0, ...doneLogs.map(l => Number(l.weight) || 0)) : 0;

  if (mode === 'time') {
    // Seconds live in the reps field for timed work — the same convention
    // insights.js uses.
    const goal = parseRepRange(ex?.reps).top ?? 0;
    const held = logs.map(l => (l.done ? (Number(l.reps) || 0) : 0));
    return {
      mode, goal, weight,
      best: held.length ? Math.max(...held) : 0,
      ok: goal > 0 && enough && held.length > 0 && held.every(h => h >= goal),
    };
  }

  const { bottom, top } = parseRepRange(ex?.reps);
  // A rep RANGE is met at its bottom; a single number is met at that number.
  const goal = bottom ?? 0;
  const reps = logs.map(l => (l.done ? (Number(l.reps) || 0) : 0));
  return {
    mode, goal, top: top ?? goal, weight,
    low: reps.length ? Math.min(...reps) : 0,
    amrap: reps.length ? reps[reps.length - 1] : 0, // Greyskull's final set
    ok: goal > 0 && enough && reps.length > 0 && reps.every(r => r >= goal),
  };
}

/** Every past session for one exercise, oldest first, judged against `ex`. */
function sessionsFor(logs, ex, { canon = (id) => id, before = null } = {}) {
  const target = canon(ex.id);
  const byDate = new Map();
  for (const l of logs) {
    if (canon(l.exerciseId) !== target) continue;
    if (before && l.date >= before) continue;
    if (!byDate.has(l.date)) byDate.set(l.date, []);
    byDate.get(l.date).push(l);
  }
  return [...byDate.entries()]
    .filter(([, ls]) => ls.some(l => l.done))
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, ls]) => ({
      date,
      ...readSession(ls.sort((x, y) => (x.setIndex ?? 0) - (y.setIndex ?? 0)), ex),
    }));
}

/** How many sessions in a row ended in a miss, counting back from the newest. */
function stallCount(sessions) {
  let n = 0;
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (sessions[i].ok) break;
    n++;
  }
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
//  THE PRESCRIPTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The next prescription for one exercise.
 *
 * Returns `{ policy, kind, weight?, reps?, why }` — `kind` being one of
 * first | up | hold | deload | off, and `why` a finished sentence, because a
 * suggestion you cannot audit is one you stop trusting. A field the policy has
 * no opinion on comes back undefined and the caller keeps whatever the plan
 * said.
 */
function nextPrescription(logs, ex, routine, { canon, before = null } = {}) {
  const mode = loggingModeOf(ex);
  const policy = policyFor(ex, routine);
  if (policy === 'off') return { policy, kind: 'off' };

  const inc = incrementFor(ex);
  const sessions = sessionsFor(logs, ex, { canon, before }).filter(s => s.mode === mode);
  const last = sessions[sessions.length - 1];
  if (!last) {
    return { policy, kind: 'first', why: 'Nothing logged yet — this session sets the baseline.' };
  }

  const stalls = stallCount(sessions);
  const deloadAt = DELOAD_AFTER[policy] ?? 3;

  if (mode === 'time') {
    if (last.ok) {
      const secs = (last.goal || 0) + inc;
      return { policy, kind: 'up', reps: secs, why: `Held every set for the full time — target up by ${inc}s.` };
    }
    if (stalls >= deloadAt) {
      const secs = deloadTo(last.goal || 0, DEFAULT_SEC_INCREMENT);
      return { policy, kind: 'deload', reps: secs, why: `Short ${stalls} sessions in a row — back off to ${secs}s and build up again.` };
    }
    return { policy, kind: 'hold', reps: last.goal || undefined, why: 'Last time came up short — same target again.' };
  }

  const w = last.weight;

  // Unloaded work carries no external load, so there is nothing to add or take
  // away — "deload your push-ups to 2.5 kg" is not advice. Progress in reps
  // instead. This runs ahead of the individual policies because it is true for
  // all of them.
  if (w <= 0) {
    const goal = last.goal || 0;
    if (last.ok && goal > 0) {
      return { policy, kind: 'up', weight: 0, reps: goal + 1, why: `Bodyweight — every rep last time, so go for ${goal + 1} this time.` };
    }
    return { policy, kind: 'hold', weight: 0, reps: goal || undefined, why: 'Bodyweight — same target again until every set is clean.' };
  }

  if (policy === 'double') {
    const top = last.top || last.goal || 10;
    const bottom = Math.min(last.goal || Math.max(1, top - 2), top);
    // Double progression advances only at the TOP of the range.
    const toppedOut = last.ok && last.low >= top;
    if (toppedOut) {
      return { policy, kind: 'up', weight: snap(w + inc, inc), reps: bottom, why: `Top of the rep range in every set — ${inc} kg more, back to ${bottom} reps.` };
    }
    if (!last.ok && stalls >= deloadAt) {
      const dw = deloadTo(w, inc);
      return { policy, kind: 'deload', weight: dw, reps: bottom, why: `Stalled ${stalls} sessions — deload to ${dw} kg.` };
    }
    const aim = Math.min(top, Math.max(bottom, last.low + 1));
    return { policy, kind: 'hold', weight: w, reps: aim, why: `Same weight — aim for ${aim} reps this time.` };
  }

  // linear + greyskull
  if (last.ok) {
    // Greyskull's final set is taken to failure: double the target reps there
    // and you have earned a double jump.
    const dbl = policy === 'greyskull' && last.goal > 0 && last.amrap >= last.goal * 2;
    const step = dbl ? inc * 2 : inc;
    return {
      policy, kind: 'up', weight: snap(w + step, inc),
      why: dbl
        ? `Last set hit ${last.amrap} reps — twice the target, so take a double jump of ${step} kg.`
        : `Every rep last time — ${step} kg more.`,
    };
  }
  if (stalls >= deloadAt) {
    const dw = deloadTo(w, inc);
    return {
      policy, kind: 'deload', weight: dw,
      why: stalls > 1
        ? `Missed reps ${stalls} sessions running — reset to ${dw} kg and work back up.`
        : `Missed reps — reset to ${dw} kg and work back up.`,
    };
  }
  return {
    policy, kind: 'hold', weight: w,
    why: `Missed reps last time — same weight again (${deloadAt - stalls} of ${deloadAt} before a deload).`,
  };
}

/** A one-line headline for a prescription, or '' when there is nothing to say. */
function prescriptionLabel(p, ex) {
  if (!p || p.kind === 'off') return '';
  if (p.kind === 'first') return 'Baseline session';
  const bits = [];
  if (p.weight != null && p.weight > 0) bits.push(`${p.weight} kg`);
  if (p.reps != null) bits.push(loggingModeOf(ex) === 'time' ? `${p.reps}s` : `${p.reps} reps`);
  return bits.join(' × ');
}

export {
  POLICIES,
  POLICIES_FOR,
  POLICY_NAME,
  POLICY_DESC,
  DELOAD_AFTER,
  DEFAULT_SEC_INCREMENT,
  DEFAULT_INCREMENT_KG,
  loggingModeOf,
  policyFor,
  defaultIncrement,
  incrementFor,
  parseRepRange,
  readSession,
  sessionsFor,
  stallCount,
  nextPrescription,
  prescriptionLabel,
};
