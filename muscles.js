/**
 * muscles.js — FitTrack · muscle vocabulary, per-exercise weighting, shade levels
 *
 * The data layer behind every body map. Three jobs, all pure:
 *
 *   1. NAME THE MUSCLES A MAP CAN DRAW. The vendored geometry
 *      (vendor/body-paths.js) shades eighteen regions; MUSCLES lists them in
 *      head-to-toe order, so any list built from them reads top-down like a body.
 *
 *   2. COLLAPSE THE APP'S MUSCLE SPELLINGS ONTO THOSE EIGHTEEN. FitTrack names
 *      muscles from three sources that do not agree with each other: the seeded
 *      plan writes "Front Delt" and "Gastrocnemius", vendor/exercise-library.json
 *      writes "front delt" and "soleus", and free-exercise-db writes "shoulders"
 *      and "calves". ALIAS below is the single place those spellings meet. A name
 *      with no entry contributes nothing — it is never guessed onto a nearby
 *      region.
 *
 *   3. TURN LOGGED SETS INTO A SHADE. Load is counted in EFFECTIVE SETS, not
 *      kilograms: 100 kg of leg press against 12 kg of lateral raise says nothing
 *      about which muscle worked harder, while "four sets" and "four sets" are
 *      directly comparable. A set counts 1.0 toward the exercise's primary muscle
 *      and SECONDARY (0.4) toward each supporting one — which is why the map no
 *      longer credits a bench press to the chest alone.
 *
 * Shading is always RELATIVE to the hardest-worked muscle in the same window.
 * The map answers "is my training balanced", and that question only means
 * something as a comparison inside one period.
 *
 * Pure compute, no DOM, no app.js imports — same division insights.js and
 * heatmaps.js already use.
 */

// ─────────────────────────────────────────────────────────────────────────────
//  VOCABULARY
// ─────────────────────────────────────────────────────────────────────────────

/** The eighteen regions the geometry can shade, head-to-toe. */
const MUSCLES = [
  'trapezius', 'deltoids', 'chest', 'upper-back', 'serratus',
  'biceps', 'triceps', 'forearm',
  'abs', 'obliques', 'lower-back',
  'gluteal', 'quadriceps', 'hamstring', 'adductors', 'hip-flexors',
  'calves', 'tibialis',
];

/** Drawn as the silhouette, never shaded: they carry no training load. */
const INERT = ['head', 'hair', 'neck', 'hands', 'feet', 'knees', 'ankles'];

/** Display names, in FitTrack's own house wording. */
const MUSCLE_NAME = {
  trapezius: 'Traps', deltoids: 'Shoulders', chest: 'Chest', 'upper-back': 'Upper back',
  serratus: 'Serratus', biceps: 'Biceps', triceps: 'Triceps', forearm: 'Forearms',
  abs: 'Abs', obliques: 'Obliques', 'lower-back': 'Lower back', gluteal: 'Glutes',
  quadriceps: 'Quads', hamstring: 'Hamstrings', adductors: 'Adductors',
  'hip-flexors': 'Hip flexors', calves: 'Calves', tibialis: 'Shins',
};

/**
 * Every muscle spelling that occurs anywhere in FitTrack, lowercased, mapped to
 * the region that draws it. `null` = real anatomy the map cannot draw, dropped
 * on purpose rather than folded onto a neighbour.
 *
 * Several distinct names deliberately share one region: the geometry draws one
 * deltoid, so front/lateral/rear delt and every rotator-cuff name land on it
 * together. Splitting them would imply a precision the artwork does not have.
 */
const ALIAS = {
  // ── shoulders & upper back
  'traps': 'trapezius', 'trapezius': 'trapezius', 'upper traps': 'trapezius',
  'mid traps': 'trapezius', 'middle traps': 'trapezius', 'lower traps': 'trapezius',
  'levator scapulae': 'trapezius', 'neck': 'trapezius',
  'shoulders': 'deltoids', 'deltoids': 'deltoids', 'delts': 'deltoids',
  'front delt': 'deltoids', 'anterior delt': 'deltoids', 'lateral delt': 'deltoids',
  'side delt': 'deltoids', 'medial delt': 'deltoids', 'rear delt': 'deltoids',
  'posterior delt': 'deltoids', 'rear deltoids': 'deltoids',
  'rotator cuff': 'deltoids', 'external rotators': 'deltoids',
  'internal rotators': 'deltoids', 'infraspinatus': 'deltoids',
  'teres minor': 'deltoids', 'supraspinatus': 'deltoids', 'subscapularis': 'deltoids',
  'lats': 'upper-back', 'latissimus dorsi': 'upper-back', 'upper back': 'upper-back',
  'middle back': 'upper-back', 'mid back': 'upper-back', 'back': 'upper-back',
  'rhomboids': 'upper-back', 'teres major': 'upper-back',
  'serratus': 'serratus', 'serratus anterior': 'serratus',

  // ── chest & arms
  'chest': 'chest', 'pectorals': 'chest', 'pecs': 'chest',
  'upper chest': 'chest', 'lower chest': 'chest',
  'biceps': 'biceps', 'brachialis': 'biceps', 'brachioradialis': 'forearm',
  'triceps': 'triceps',
  'forearms': 'forearm', 'forearm': 'forearm', 'wrists': 'forearm',
  'wrist flexors': 'forearm', 'wrist extensors': 'forearm', 'grip': 'forearm',
  'grip muscles': 'forearm',

  // ── trunk
  'abs': 'abs', 'abdominals': 'abs', 'core': 'abs', 'lower abs': 'abs',
  'upper abs': 'abs', 'rectus abdominis': 'abs', 'transverse abdominis': 'abs',
  'obliques': 'obliques',
  'erectors': 'lower-back', 'spinal erectors': 'lower-back', 'lower back': 'lower-back',
  'spine': 'lower-back', 'erector spinae': 'lower-back',

  // ── hips & legs
  'glutes': 'gluteal', 'gluteal': 'gluteal', 'glute': 'gluteal', 'abductors': 'gluteal',
  'quads': 'quadriceps', 'quadriceps': 'quadriceps',
  'hamstrings': 'hamstring', 'hamstring': 'hamstring',
  'adductors': 'adductors', 'groin': 'adductors', 'inner thighs': 'adductors',
  'hip flexors': 'hip-flexors', 'hip-flexors': 'hip-flexors', 'psoas': 'hip-flexors',
  'calves': 'calves', 'gastrocnemius': 'calves', 'soleus': 'calves',
  'tibialis': 'tibialis', 'tibialis anterior': 'tibialis', 'shins': 'tibialis',

  // ── real, but nothing to shade
  'full body': null, 'cardiovascular system': null, 'cardio': null,
  'hands': null, 'feet': null, 'ankles': null, 'ankle stabilizers': null,
  'sternocleidomastoid': null,
};

/** A supporting muscle counts this much against a primary. */
const SECONDARY = 0.4;

// ─────────────────────────────────────────────────────────────────────────────
//  PARSING
// ─────────────────────────────────────────────────────────────────────────────

/** Lowercase, trimmed, with any trailing "(Rotator Cuff)"-style qualifier removed. */
function normalizeMuscleName(name) {
  return String(name ?? '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim()
    .toLowerCase();
}

/** The region a single muscle name draws on, or null when nothing draws it. */
function regionOf(name) {
  const key = normalizeMuscleName(name);
  return key ? (ALIAS[key] ?? null) : null;
}

/**
 * The weights one exercise contributes: { slug: 0…1 }. `musclesField` is the
 * app's own "Chest · Front Delt · Triceps" display string, in which the FIRST
 * name is the primary — the same convention every other read path in the app
 * uses. A name that maps nowhere is skipped; a name that shares a region with
 * an earlier one keeps the higher weight rather than stacking.
 */
function musclesOfField(musclesField) {
  const parts = String(musclesField ?? '').split('·').map(s => s.trim()).filter(Boolean);
  const out = {};
  parts.forEach((name, i) => {
    const slug = regionOf(name);
    if (!slug) return;
    const w = i === 0 ? 1 : SECONDARY;
    out[slug] = Math.max(out[slug] ?? 0, w);
  });
  return out;
}

/** Same, from an explicit primary + secondaries pair (the vendored library's shape). */
function musclesOfPair(primary, secondaries = []) {
  return musclesOfField([primary, ...(secondaries ?? [])].filter(Boolean).join(' · '));
}

// ─────────────────────────────────────────────────────────────────────────────
//  LOAD & SHADING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Effective sets per muscle. `items` is [{ weights, sets }] — `weights` being
 * one musclesOfField result and `sets` a plain count, so a 4×8 bench press
 * weighs four times a single set.
 */
function loadOf(items) {
  const load = {};
  for (const { weights, sets } of items) {
    if (!sets || !weights) continue;
    for (const slug in weights) load[slug] = (load[slug] ?? 0) + weights[slug] * sets;
  }
  return load;
}

/**
 * Shade buckets 0–4 per muscle, relative to the hardest-worked muscle in the
 * same window. Anything with load gets at least level 1, so a muscle that was
 * trained never reads as untrained just because something else dwarfed it.
 */
function levelsOf(load) {
  const max = Math.max(0, ...MUSCLES.map(m => load[m] ?? 0));
  const lv = {};
  for (const m of MUSCLES) {
    const v = load[m] ?? 0;
    lv[m] = (!v || max <= 0) ? 0 : Math.max(1, Math.min(4, Math.ceil((v / max) * 4)));
  }
  return lv;
}

/**
 * Shade buckets for a 0–1 score (fatigue, retained strength) rather than a
 * relative load. `thresholds` is [{ at, level }] ascending; a value takes the
 * level of the highest threshold it reaches.
 */
function levelsFromScore(score, thresholds) {
  const lv = {};
  for (const m of MUSCLES) {
    const v = score[m];
    let level = 0;
    if (Number.isFinite(v)) {
      for (const t of thresholds) if (v >= t.at) level = t.level;
    }
    lv[m] = level;
  }
  return lv;
}

/** Muscles sorted hardest-worked first; untrained ones separately, in body order. */
function rankOf(load) {
  const worked = MUSCLES.filter(m => (load[m] ?? 0) > 0).sort((a, b) => load[b] - load[a]);
  const missed = MUSCLES.filter(m => !((load[m] ?? 0) > 0));
  return { worked, missed };
}

export {
  MUSCLES,
  INERT,
  MUSCLE_NAME,
  SECONDARY,
  regionOf,
  musclesOfField,
  musclesOfPair,
  loadOf,
  levelsOf,
  levelsFromScore,
  rankOf,
};
