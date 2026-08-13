/**
 * reference.js — FitTrack · Open Exercise Reference (free-exercise-db)
 *
 * Static, public-domain reference data (yuhonas/free-exercise-db, Unlicense),
 * vendored at data/exercise-reference.json. Loaded once into memory on app
 * start; NEVER written to IndexedDB and NEVER included in the JSON export — it
 * is app content, identical for every user, changing only on redeploy. Keeping
 * it out of the DB is what keeps the export pure user data.
 *
 * This module is the DATA + PURE-QUERY layer only: load, look up, filter. DOM
 * rendering (the browse list, the exercise-detail panel) lives in app.js,
 * matching the insights.js / app.js split. Nothing here coaches or infers — it
 * surfaces facts (target muscles, equipment, mechanic, instructions) verbatim.
 *
 * Two datasets are involved and MUST NOT be confused:
 *   • vendor/exercise-library.json — FitTrack's own tiny table that assigns a
 *     `loadType` (how to MEASURE an exercise). Owned by app.js.
 *   • data/exercise-reference.json — this file's rich reference (muscles,
 *     equipment, instructions, images). Owned here.
 * The bridge between the app's own exercise ids and a reference entry is the
 * authored, deterministic map at data/exercise-map.json (never runtime-fuzzy).
 */

// Remote base for browse-library images ONLY. The featured plan exercises get
// their images vendored locally (data/exercise-images/…) so they work fully
// offline; the 800-entry browse list would be megabytes of images, so those
// lazy-load from here and degrade to a text placeholder when offline.
const REFERENCE_IMAGE_BASE =
  'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/';

// The three categories the browse filter groups under its default "lifting"
// option. Everything else (cardio, stretching, plyometrics, strongman) is
// reachable only via "All categories".
const LIFTING_CATEGORIES = ['strength', 'powerlifting', 'olympic weightlifting'];

// ─────────────────────────────────────────────────────────────────────────────
//  STATE — module-scope memory only. Never persisted, never exported.
// ─────────────────────────────────────────────────────────────────────────────

let REFERENCE_LIST = [];              // full array, sorted by name
const REFERENCE_BY_ID = new Map();    // id → entry
let REFERENCE_MUSCLES = [];           // sorted union of primaryMuscles
let REFERENCE_EQUIPMENT = [];         // sorted union of equipment (non-null)
let REFERENCE_CATEGORIES = [];        // sorted union of category

// The authored id-bridge, loaded from data/exercise-map.json. Shape per entry:
//   { referenceId: string|null, confidence: 'high'|'medium'|'low'|'none' }
// A null referenceId (or a missing key) means "no reference panel" — correct,
// not an error. Runtime code NEVER fuzzy-matches to fill a gap.
let EXERCISE_MAP = {};

// ─────────────────────────────────────────────────────────────────────────────
//  LOADING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads and indexes the vendored reference dataset. Degrades to an empty set
 * (no reference panels, empty browse list) if the file is missing or malformed
 * — never throws, so a reference failure can't take down the whole app.
 */
async function loadReference() {
  try {
    const res  = await fetch('./data/exercise-reference.json');
    const data = await res.json();
    REFERENCE_LIST = Array.isArray(data) ? data.slice() : [];
  } catch (err) {
    console.error('[FitTrack] exercise reference failed to load:', err);
    REFERENCE_LIST = [];
  }

  REFERENCE_LIST.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));

  REFERENCE_BY_ID.clear();
  const muscles = new Set(), equipment = new Set(), categories = new Set();
  for (const ex of REFERENCE_LIST) {
    if (ex?.id) REFERENCE_BY_ID.set(ex.id, ex);
    for (const m of ex.primaryMuscles ?? []) muscles.add(m);
    if (ex.equipment) equipment.add(ex.equipment);
    if (ex.category)  categories.add(ex.category);
  }
  REFERENCE_MUSCLES    = [...muscles].sort();
  REFERENCE_EQUIPMENT  = [...equipment].sort();
  REFERENCE_CATEGORIES = [...categories].sort();
}

/**
 * Loads the authored id-bridge (data/exercise-map.json). Optional: absent or
 * malformed leaves the map empty, so exercises simply show no reference panel.
 * The file may be either a flat { id: entry } object or { map: { id: entry } }.
 */
async function loadExerciseMap() {
  try {
    const res  = await fetch('./data/exercise-map.json');
    const data = await res.json();
    EXERCISE_MAP = (data && typeof data === 'object')
      ? (data.map && typeof data.map === 'object' ? data.map : data)
      : {};
  } catch (err) {
    // A missing map is a normal state (nothing mapped yet) — log quietly.
    console.warn('[FitTrack] exercise map not loaded:', err?.message ?? err);
    EXERCISE_MAP = {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  LOOKUP
// ─────────────────────────────────────────────────────────────────────────────

/** The whole reference array (sorted by name). Callers must not mutate it. */
function getReferenceList() {
  return REFERENCE_LIST;
}

/** A single reference entry by its free-exercise-db id, or null. */
function getReferenceById(id) {
  return (id && REFERENCE_BY_ID.get(id)) || null;
}

/** Filter-dropdown vocabularies, derived from the loaded data. */
function getReferenceFacets() {
  return {
    muscles:    REFERENCE_MUSCLES,
    equipment:  REFERENCE_EQUIPMENT,
    categories: REFERENCE_CATEGORIES,
  };
}

/**
 * The reference entry an app exercise id resolves to via the authored map, or
 * null when unmapped / explicitly mapped to null. Deterministic: it only reads
 * the committed map, never guesses. Returns the map's confidence alongside so
 * the UI can flag low-confidence matches.
 * @returns {{ entry: object, confidence: string }|null}
 */
function referenceForExerciseId(exerciseId) {
  const m = EXERCISE_MAP[exerciseId];
  if (!m || !m.referenceId) return null;
  const entry = getReferenceById(m.referenceId);
  if (!entry) return null;
  return { entry, confidence: m.confidence ?? 'high' };
}

// ─────────────────────────────────────────────────────────────────────────────
//  BROWSE FILTERING (pure)
// ─────────────────────────────────────────────────────────────────────────────

/** lowercase, collapse non-alphanumerics to spaces — for tolerant text search. */
function normalizeText(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Filters the reference list for the browse view. All criteria are ANDed; an
 * empty/absent criterion is ignored. Pure — same inputs, same output.
 *
 * @param {object} opts
 * @param {string} [opts.query]     free-text over name + muscles + equipment
 * @param {string} [opts.muscle]    exact primaryMuscles membership
 * @param {string} [opts.equipment] exact equipment match
 * @param {string} [opts.category]  'lifting' (the grouped default), 'all'/'' ,
 *                                   or a specific category string
 */
function filterReference({ query = '', muscle = '', equipment = '', category = 'lifting' } = {}) {
  const q = normalizeText(query);
  const qTerms = q ? q.split(' ') : [];

  return REFERENCE_LIST.filter((ex) => {
    // Category
    if (category === 'lifting') {
      if (!LIFTING_CATEGORIES.includes(ex.category)) return false;
    } else if (category && category !== 'all') {
      if (ex.category !== category) return false;
    }
    // Muscle (primary only — that is what the filter promises)
    if (muscle && !(ex.primaryMuscles ?? []).includes(muscle)) return false;
    // Equipment
    if (equipment && ex.equipment !== equipment) return false;
    // Text — every term must appear somewhere in the haystack
    if (qTerms.length) {
      const hay = normalizeText([
        ex.name,
        ...(ex.primaryMuscles ?? []),
        ...(ex.secondaryMuscles ?? []),
        ex.equipment,
      ].join(' '));
      if (!qTerms.every(t => hay.includes(t))) return false;
    }
    return true;
  });
}

/** Absolute URL for a reference image's relative path (browse-library use). */
function referenceImageUrl(relativePath) {
  return REFERENCE_IMAGE_BASE + relativePath;
}

export {
  loadReference,
  loadExerciseMap,
  getReferenceList,
  getReferenceById,
  getReferenceFacets,
  referenceForExerciseId,
  filterReference,
  referenceImageUrl,
  LIFTING_CATEGORIES,
};
