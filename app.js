/**
 * app.js  —  FitTrack · Application Engine  (Part 1 of 2)
 *
 * Contains: constants, date utilities, global state, seed data,
 * DB↔state sync, render dispatch, navigation, header, week strip,
 * and init(). All tab renders and event handlers follow in Part 2.
 */

import { get, put, del, getAll, getAllKeys, putMany, clear } from './db.js';
import { setAliasMap, checkForNewPB, computeRecentPRs, computePlateaus, computeExerciseSeries, getExercisePR } from './insights.js';
import { buildActivityHeatmapCard, buildMuscleMapCard, buildLoadBodyMap, loadBodyPaths, bodyPathsReady } from './heatmaps.js';
import {
  PLAN_VERSION, DAY_NAMES as PLAN_DAY_NAMES, REST as DAY_REST, dayPlanKey,
  GLYPHS, DEFAULT_GLYPH, glyphOf, glyphSvg, guessGlyph,
  routinesOf, routineById, activeExercises, allPlanExercises, routineForDayIndex, resolveDay,
  supersetUnits, cleanupSupersets, migrateToRoutines,
  buildWeekScheduleHTML, buildRoutineListHTML, exerciseLine, buildRoutineExerciseRowHTML,
  buildRoutineCoverageHTML, routineLoad, buildProgressionRowHTML, routineTag, exCountLabel,
} from './plan.js';
import {
  POLICIES_FOR, POLICY_NAME, POLICY_DESC, DEFAULT_SEC_INCREMENT,
  loggingModeOf, policyFor, incrementFor, nextPrescription, prescriptionLabel,
} from './progression.js';
import {
  loadReference,
  loadExerciseMap,
  getReferenceById,
  getReferenceFacets,
  referenceForExerciseId,
  filterReference,
  referenceImageUrl,
} from './reference.js';
import {
  importFitdaysFile,
  loadBodyComposition,
  renderBodyTab,
  importSummaryMessage,
  toDailySeries,
  fmt as bcFmt,
  deltaBadge as bcDeltaBadge,
  longDate as bcLongDate,
} from './bodycomp.js';

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chart colours, read from the CSS custom properties rather than repeated as
 * hex literals in the SVG builders below. Before this, the same hue was written
 * out by hand in three places and drifted: cyan meant "lean mass" on one hub
 * card and "back squat" on the next, and the volume chart used a fifth and
 * sixth hue that existed nowhere else in the app. Keeping them in :root means
 * the palette is stated once, and the SVG builders and the CSS-drawn legends
 * are guaranteed to agree.
 *
 * Read once and memoised: these are static tokens, and the SVG builders call
 * for them inside per-point loops where a getComputedStyle each time would be
 * wasteful. See the --chart-* block in styles.css for why these four.
 */
const CHART_COLORS = (() => {
  let cache = null;
  return () => {
    if (cache) return cache;
    const cs = getComputedStyle(document.documentElement);
    const v = (n, fallback) => cs.getPropertyValue(n).trim() || fallback;
    cache = {
      series: [v('--chart-1', '#13A7A6'), v('--chart-2', '#616FFE'),
               v('--chart-3', '#F8495F'), v('--chart-4', '#D059D5')],
      other:  v('--chart-other', '#8B949E'),
      grid:   v('--chart-grid',  '#21262D'),
      axis:   v('--chart-axis',  '#8B949E'),
      accent: v('--color-accent', '#00F0FF'),
    };
    return cache;
  };
})();

const DAY_NAMES_LONG  = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const DAY_NAMES_SHORT = ['M','T','W','T','F','S','S'];
const MONTH_NAMES     = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

const PLAN_DOC_ID          = 'weekly-plan';
const FINISHED_KEY         = 'finishedSessions';

// Meta key holding the date ('YYYY-MM-DD') of the last successful backup. Stored
// like any other meta record so it serialises into the snapshot and restores.
const LAST_BACKUP_KEY = 'lastBackupDate';

// Days since the last backup at which the hub card's wording shifts from a
// neutral fact to an attention accent. The card's ONLY computation is
// (today − lastBackupDate) in whole days compared against this threshold.
const LAST_BACKUP_STALE_DAYS = 14;

// Days since the most recent body-composition reading at which the body card's
// freshness line takes an attention accent. Same (today − date) computation.
const BODY_COMP_STALE_DAYS = 14;

// Sane bounds for the optional per-set RPE (rate of perceived exertion). Values
// outside this domain are simply not stored — never an error. Capture-only.
const RPE_MIN = 6;
const RPE_MAX = 10;

// Whether best-effort haptics fire. User-toggleable in Settings, default ON,
// stored like any other meta record. Absent = on; only an explicit `false`
// disables. The Vibration API is unsupported on iOS Safari, so every call is
// wrapped to no-op silently there — this key only governs the user's choice.
const HAPTICS_KEY = 'hapticsEnabled';

// Meta keys from retired features (streak counter, fixed-Monday bodyweight
// prompt) — silently deleted from the DB on load, never written again.
const RETIRED_META_KEYS = ['streak', 'bwPromptDate'];

// Shown for any exercise record whose name is missing or was never
// migrated off its internal id (see the orphan-review flow below).
const UNNAMED_EXERCISE_PLACEHOLDER = 'Unnamed exercise';

// Durable name/unit registry for exercise ids that appear in the logs but have
// no definition anywhere else (the historical `added_*` / `swap_*` orphans).
// Stored as one meta doc { key, value: { <id>: { id, name, unit, archived } } }
// so it round-trips through the JSON export like every other meta record, and
// so name resolution has a single source of truth to fall back on.
const EXERCISE_REGISTRY_KEY = 'exerciseRegistry';

// Set once the user has been through the one-time "Name your exercises" review
// so it does not auto-surface on every load. The review is still reachable on
// demand from the Data tab, and the backfill itself is idempotent.
const ORPHAN_REVIEW_DONE_KEY = 'orphanReviewCompleted';

// Orphan ids the brief flags as recurring, actively-progressed exercises.
// These — plus any orphan logged on ORPHAN_RECURRING_DATES+ distinct dates —
// are never pre-selected for archive and are surfaced as "recurring — likely
// keep" in the review screen. They must never be auto-archived or removed.
const PROTECTED_ORPHAN_IDS = [
  'added_mrdx5pc1_tf8b4',
  'added_ms6a8n2j_s2j0n',
  'added_mslqbhjr_g271t',
];
const ORPHAN_RECURRING_DATES = 3;

// ─────────────────────────────────────────────────────────────────────────────
//  DATE UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

/** Format a Date as 'YYYY-MM-DD' using local time. */
function formatDate(d) {
  const y  = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${dy}`;
}

/** Today's date as 'YYYY-MM-DD'. */
function todayStr() {
  return formatDate(new Date());
}

/**
 * Parse 'YYYY-MM-DD' into a local-midnight Date.
 * Uses the explicit 3-arg constructor to avoid UTC-midnight DST traps.
 */
function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * ISO 8601 week string — e.g. '2026-W26'.
 * Anchors on Thursday to correctly handle year-boundary edge cases
 * where Jan 1 belongs to the previous year's last week.
 */
function isoWeekStr(d) {
  const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow  = utc.getUTCDay() || 7;           // Sun(0) → 7
  utc.setUTCDate(utc.getUTCDate() + 4 - dow);  // shift to Thursday of this week
  const jan1 = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc - jan1) / 86_400_000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Return the Monday of the calendar week that contains d (local time). */
function getMondayOf(d) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow  = date.getDay();                        // 0=Sun … 6=Sat
  date.setDate(date.getDate() + (dow === 0 ? -6 : 1 - dow));
  return date;
}

/** 7 'YYYY-MM-DD' strings [Mon … Sun] for the week that contains d. */
function weekDatesOf(d) {
  const mon = getMondayOf(d);
  return Array.from({ length: 7 }, (_, i) =>
    formatDate(new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i))
  );
}

/**
 * Day-of-week index (0=Mon … 6=Sun) from a 'YYYY-MM-DD' string.
 * Uses local parseDate to avoid DST midnight issues.
 */
function dayIndexOf(dateStr) {
  const js = parseDate(dateStr).getDay(); // 0=Sun, 1=Mon, …
  return js === 0 ? 6 : js - 1;
}

/** 'June 30' display label from 'YYYY-MM-DD'. */
function friendlyDateLabel(dateStr) {
  const d = parseDate(dateStr);
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
}

/**
 * "Jun 15" axis label. The two SVG charts in this file used
 * formatDate(d).slice(5), which renders "06-15" — while the body-composition
 * charts one card away render "Jun 15". Two date formats on adjacent cards in
 * the same scroll is exactly the kind of drift that makes an app feel
 * assembled rather than designed, so both now speak the same way.
 */
function axisDateLabel(d) {
  return `${MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
}

/** Returns true if dateStr is before todayStr. */
function isPast(dateStr) {
  return dateStr < state.ui.today;
}

/** Whole calendar days from `fromStr` to `toStr` (both 'YYYY-MM-DD'). */
function daysBetweenDates(fromStr, toStr) {
  const MS_PER_DAY = 86_400_000;
  // parseDate anchors on local midnight, so rounding absorbs any DST hour.
  return Math.round((parseDate(toStr) - parseDate(fromStr)) / MS_PER_DAY);
}

// ─────────────────────────────────────────────────────────────────────────────
//  ID GENERATION
// ─────────────────────────────────────────────────────────────────────────────

/** Generates a unique, URL-safe ID. Stable across sessions. */
function generateId(prefix = 'ex') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  GLOBAL STATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single source of truth for the UI.
 * All DB writes mirror their result here, then trigger render().
 */
const state = {
  /** Weekly plan document from the 'plan' store: { id, version, days:[…] } */
  plan: null,

  /** All log entries from the 'logs' store. */
  logs: [],

  /**
   * NOTE: there is no `bodyweight` field here on purpose. The legacy manual
   * bodyweight store still exists in IndexedDB and still round-trips through
   * the JSON export, but nothing in the UI reads it any more — manual weight
   * entry was replaced by Fitdays imports, and the insight that consumed it
   * was retired with it. It is archival data, so it is left on disk and out
   * of memory rather than loaded on every boot.
   */

  /**
   * Raw Fitdays readings from the 'bodyComposition' store, sorted
   * datetime-asc. Stored exactly as imported — the per-day series the Body tab
   * draws is derived at render time and never written back.
   */
  bodyComposition: [],

  /**
   * Map of key → record from the 'meta' store.
   * Keys in use: FINISHED_KEY, plus per-date `swaps_<date>` / `removed_<date>`.
   */
  meta: {},

  /** Transient UI state — never written to IndexedDB. */
  ui: {
    currentView: 'hub',           // 'hub' | 'today' | 'stats' | 'body' | 'plan' | 'library' | 'data'
    today: '',                    // 'YYYY-MM-DD'
    weekDates: [],                // [Mon … Sun] date strings for current week
    todayDayIndex: 0,             // 0=Mon … 6=Sun
    viewedDate: '',               // 'YYYY-MM-DD' — date shown in the Today/day-view tab
    expandedExerciseId: null,     // exercise ID whose accordion is open, or null
    // Stats tab · muscle-map card. Which of the three readings is showing,
    // which window the balance reading counts over, and which muscle (if any)
    // is tapped. View state only — nothing here is persisted.
    muscleMap: { tab: 'balance', win: 30, hard: false, selected: null },
    // Plan tab · which routine the editor is showing, and where 'back' returns
    // to. View state only — the routine itself lives in the plan document.
    editingRoutineId: null,
    _dialogConfirmCallback: null, // pending confirm action
    _dialogExtraCallback: null,   // pending non-closing extra action (e.g. Back up first)
  },
};

// ─────────────────────────────────────────────────────────────────────────────
//  DEFAULT SEED DATA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stable exercise IDs hardcoded into the seed plan.
 * MUST NOT change — historical log entries are keyed to these strings forever.
 * Any future renaming must preserve the id and only change the `name` field.
 */
const SEED_IDS = {
  // Monday — Upper Heavy
  benchPress:           'ex_seed_bench_press',
  overheadPress:        'ex_seed_ohp',
  barbellRow:           'ex_seed_bb_row',
  weightedPullup:       'ex_seed_pullup',
  // Id kept as the original 'ex_seed_incline_db' string on purpose: this slot
  // has long since become a Biceps Curl, but every logged set is keyed to the
  // old id forever, so renaming the id would orphan that history. Only the
  // human-facing name/muscles/cue below are honest about what it is now.
  bicepsCurl:           'ex_seed_incline_db',
  tricepPushdown:       'ex_seed_tri_pushdown',
  // Wednesday — Upper Moderate
  dbBenchPress:         'ex_seed_db_bench',
  dbOhp:                'ex_seed_db_ohp',
  cableRow:             'ex_seed_cable_row',
  latPulldown:          'ex_seed_lat_pulldown',
  dbCurl:               'ex_seed_db_curl',
  facePull:             'ex_seed_face_pull',
  // Friday — Lower + Cuff Prehab
  backSquat:            'ex_seed_squat',
  romanianDeadlift:     'ex_seed_rdl',
  legPress:             'ex_seed_leg_press',
  legCurl:              'ex_seed_leg_curl',
  calfRaise:            'ex_seed_calf_raise',
  bandExternalRotation: 'ex_seed_ext_rot',
  bandPullApart:        'ex_seed_pull_apart',
};

/** Builds the default 3-day split plan document to store on first run. */
function buildDefaultPlan() {
  return {
    id: PLAN_DOC_ID,
    version: 1,
    days: [
      // ── 0 · Monday — Upper Heavy ─────────────────────────────────────────
      {
        dayIndex: 0,
        sessionName: 'Upper Heavy',
        isRest: false,
        exercises: [
          {
            id: SEED_IDS.benchPress,
            name: 'Bench Press',
            sets: 4,
            reps: '5',
            muscles: 'Chest · Front Delt · Triceps',
            cue: 'Retract scapula, plant feet flat, bar to lower chest, press up and slightly back.',
            archived: false,
          },
          {
            id: SEED_IDS.overheadPress,
            name: 'Overhead Press',
            sets: 4,
            reps: '5',
            muscles: 'Front Delt · Triceps · Upper Traps',
            cue: 'Brace core hard, squeeze glutes, bar presses in a straight vertical line.',
            archived: false,
          },
          {
            id: SEED_IDS.barbellRow,
            name: 'Barbell Row',
            sets: 4,
            reps: '5',
            muscles: 'Lats · Rhomboids · Biceps · Erectors',
            cue: 'Hinge to ~45°, pull bar to navel leading with elbows, hold 1s at top.',
            archived: false,
          },
          {
            id: SEED_IDS.weightedPullup,
            name: 'Weighted Pull-up',
            sets: 3,
            reps: '5',
            muscles: 'Lats · Biceps · Rear Delt',
            cue: 'Dead-hang start, drive elbows to hips, chin clears bar, lower with full control.',
            archived: false,
          },
          {
            id: SEED_IDS.bicepsCurl,
            name: 'Biceps Curl',
            sets: 3,
            reps: '10',
            muscles: 'Biceps · Brachialis',
            cue: 'Supinate wrist at the top, full stretch at bottom, no torso swing.',
            archived: false,
          },
          {
            id: SEED_IDS.tricepPushdown,
            name: 'Tricep Pushdown',
            sets: 3,
            reps: '10–12',
            muscles: 'Triceps (all heads)',
            cue: 'Lock elbows at sides, full extension at bottom, 2s squeeze, controlled return.',
            archived: false,
          },
        ],
      },
      // ── 1 · Tuesday — Rest ───────────────────────────────────────────────
      {
        dayIndex: 1,
        sessionName: '',
        isRest: true,
        exercises: [],
      },
      // ── 2 · Wednesday — Upper Moderate ──────────────────────────────────
      {
        dayIndex: 2,
        sessionName: 'Upper Moderate',
        isRest: false,
        exercises: [
          {
            id: SEED_IDS.dbBenchPress,
            name: 'DB Bench Press',
            sets: 4,
            reps: '10',
            muscles: 'Chest · Front Delt · Triceps',
            cue: 'Elbows at 75°, full stretch at bottom, squeeze chest at top.',
            archived: false,
          },
          {
            id: SEED_IDS.dbOhp,
            name: 'DB Overhead Press',
            sets: 4,
            reps: '10',
            muscles: 'Front Delt · Triceps · Lateral Delt',
            cue: 'Sit tall, dumbbells at ear height, press in a slight arc overhead.',
            archived: false,
          },
          {
            id: SEED_IDS.cableRow,
            name: 'Cable Row',
            sets: 4,
            reps: '10',
            muscles: 'Lats · Rhomboids · Biceps',
            cue: 'Tall chest, initiate with shoulder blades, pull to navel, hold 1s.',
            archived: false,
          },
          {
            id: SEED_IDS.latPulldown,
            name: 'Lat Pulldown',
            sets: 4,
            reps: '10',
            muscles: 'Lats · Biceps · Teres Major',
            cue: 'Lean back 10°, pull bar to upper chest, elbows fall straight down.',
            archived: false,
          },
          {
            id: SEED_IDS.dbCurl,
            name: 'DB Curl',
            sets: 3,
            reps: '12',
            muscles: 'Biceps · Brachialis',
            cue: 'Supinate wrist at the top, full stretch at bottom, no torso swing.',
            archived: false,
          },
          {
            id: SEED_IDS.facePull,
            name: 'Face Pull',
            sets: 3,
            reps: '15',
            muscles: 'Rear Delt · External Rotators · Mid Traps',
            cue: 'Cable at forehead height, pull to face with thumbs pointing back, externally rotate.',
            archived: false,
          },
        ],
      },
      // ── 3 · Thursday — Rest ──────────────────────────────────────────────
      {
        dayIndex: 3,
        sessionName: '',
        isRest: true,
        exercises: [],
      },
      // ── 4 · Friday — Lower + Cuff Prehab ────────────────────────────────
      {
        dayIndex: 4,
        sessionName: 'Lower + Cuff Prehab',
        isRest: false,
        exercises: [
          {
            id: SEED_IDS.backSquat,
            name: 'Back Squat',
            sets: 4,
            reps: '6',
            muscles: 'Quads · Glutes · Hamstrings · Erectors',
            cue: 'Brace 360°, knees track toes, hip crease below parallel, drive through whole foot.',
            archived: false,
          },
          {
            id: SEED_IDS.romanianDeadlift,
            name: 'Romanian Deadlift',
            sets: 3,
            reps: '8',
            muscles: 'Hamstrings · Glutes · Erectors',
            cue: 'Hip hinge, soft knees, bar stays against legs throughout, feel hamstring stretch.',
            archived: false,
          },
          {
            id: SEED_IDS.legPress,
            name: 'Leg Press',
            sets: 3,
            reps: '12',
            muscles: 'Quads · Glutes',
            cue: 'Feet shoulder-width at mid-plate, do not lock knees at top, controlled descent.',
            archived: false,
          },
          {
            id: SEED_IDS.legCurl,
            name: 'Leg Curl',
            sets: 3,
            reps: '12',
            muscles: 'Hamstrings',
            cue: '3s eccentric, do not let hips rise off pad, hold full contraction briefly.',
            archived: false,
          },
          {
            id: SEED_IDS.calfRaise,
            name: 'Calf Raise',
            sets: 4,
            reps: '15',
            muscles: 'Gastrocnemius · Soleus',
            cue: 'Full stretch at bottom, 2s pause at top, slow and deliberate throughout.',
            archived: false,
          },
          {
            id: SEED_IDS.bandExternalRotation,
            name: 'Band External Rotation',
            sets: 3,
            reps: '15',
            muscles: 'Infraspinatus · Teres Minor (Rotator Cuff)',
            cue: 'Elbow pinned to side at 90°, rotate forearm out slowly, control the return.',
            archived: false,
          },
          {
            id: SEED_IDS.bandPullApart,
            name: 'Band Pull-Apart',
            sets: 3,
            reps: '20',
            muscles: 'Rear Delt · Rhomboids · Mid Traps',
            cue: 'Arms straight, pull to chest height, squeeze shoulder blades together, slow return.',
            archived: false,
          },
        ],
      },
      // ── 5 · Saturday — Rest ──────────────────────────────────────────────
      {
        dayIndex: 5,
        sessionName: '',
        isRest: true,
        exercises: [],
      },
      // ── 6 · Sunday — Rest ────────────────────────────────────────────────
      {
        dayIndex: 6,
        sessionName: '',
        isRest: true,
        exercises: [],
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  DATABASE ↔ STATE SYNC
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads the stores the UI actually renders from into `state`, in parallel.
 * The legacy 'bodyweight' store is deliberately not among them — see the note
 * on `state`.
 */
async function loadState() {
  const [planDoc, allLogs, allMeta, allBodyComp] = await Promise.all([
    get('plan', PLAN_DOC_ID),
    getAll('logs'),
    getAll('meta'),
    loadBodyComposition(),
  ]);

  state.plan            = planDoc ?? null;
  state.logs            = allLogs ?? [];
  state.bodyComposition = allBodyComp;

  // Flatten meta array into a lookup map for O(1) access
  state.meta = {};
  for (const record of (allMeta ?? [])) {
    state.meta[record.key] = record;
  }
}

/** Seeds the default plan and meta documents on the absolute first run. */
async function seedIfFirstRun() {
  if (state.plan !== null) return; // DB already has a plan — not a first run

  const defaultPlan = buildDefaultPlan();
  await put('plan', defaultPlan);
  state.plan = defaultPlan;

  const finishedDoc = {
    key: FINISHED_KEY,
    value: {}, // dateStr → true, marks explicitly finished sessions
  };
  await put('meta', finishedDoc);
  state.meta[FINISHED_KEY] = finishedDoc;
}

/**
 * Drops meta records left behind by retired features (streak counter,
 * fixed-Monday bodyweight prompt). No backfill or conversion — the data
 * is simply discarded. No-op once cleaned.
 */
async function dropRetiredMeta() {
  for (const key of RETIRED_META_KEYS) {
    if (!state.meta[key]) continue;
    await del('meta', key);
    delete state.meta[key];
  }
}

/**
 * Ensures every exercise definition (recurring plan + session-scoped extras)
 * carries a `unit` field: 'reps' (default) or 'seconds'. Plank and Dead Bug
 * are duration-based and get 'seconds'; their historical logged values were
 * always seconds, so no value conversion is needed — only the label changes.
 * No-op once every definition has a unit.
 */
async function migrateExerciseUnits() {
  const SECONDS_BY_DEFAULT = /^(plank|dead ?bug)$/i;
  const unitFor = ex =>
    SECONDS_BY_DEFAULT.test((ex.name ?? '').trim()) ? 'seconds' : 'reps';

  let planDirty = false;
  for (const ex of allPlanExercises(state.plan)) {
    if (ex.unit) continue;
    ex.unit = unitFor(ex);
    planDirty = true;
  }
  if (planDirty) await put('plan', state.plan);

  for (const key in state.meta) {
    if (!key.startsWith('swaps_')) continue;
    const doc = state.meta[key];
    let dirty = false;
    for (const extra of doc?.value ?? []) {
      if (extra.unit) continue;
      extra.unit = unitFor(extra);
      dirty = true;
    }
    if (dirty) {
      await put('meta', doc);
      state.meta[key] = doc;
    }
  }
}

/**
 * Corrects the stale `ex_seed_incline_db` slot, which is used everywhere as a
 * Biceps Curl now. The id is deliberately left untouched — renaming it would
 * orphan every logged set keyed to the old string — so only the human-facing
 * name/muscles/cue are fixed if they still say "incline". Never touches logs.
 * No-op once corrected.
 */
async function migrateInclineDbLabel() {
  const STALE_ID = 'ex_seed_incline_db';
  let dirty = false;
  for (const ex of allPlanExercises(state.plan)) {
    if (ex.id !== STALE_ID) continue;
    if (/incline/i.test(ex.name ?? '') || /incline/i.test(ex.cue ?? '')) {
      ex.name    = 'Biceps Curl';
      ex.muscles = 'Biceps · Brachialis';
      ex.cue     = 'Supinate wrist at the top, full stretch at bottom, no torso swing.';
      dirty = true;
    }
  }
  if (dirty) await put('plan', state.plan);
}

// ─────────────────────────────────────────────────────────────────────────────
//  EXERCISE LIBRARY + loadType
//
//  A vendored, static reference table (vendor/exercise-library.json) pre-tags
//  common exercises with a `loadType` — the fact that governs how the app
//  measures, PRs, and progresses each one. This is reference data, not logic:
//  a pull-up being `bodyweight` is a fact, not a coaching judgement. Types:
//    weighted   — external load; metric = weight×reps, Epley e1RM applies
//    bodyweight — load ≈ bodyweight (± added load); metric = reps (unloaded)
//    assisted   — bodyweight minus machine assist; progression = less assist
//    timed      — isometric/timed hold; metric = seconds
//    reps       — rep count, no meaningful external load; metric = reps
//  The app never computes a bodyweight-adjusted e1RM (that pairing is Claude's).
// ─────────────────────────────────────────────────────────────────────────────

let EXERCISE_LIBRARY = [];
const LIBRARY_BY_KEY = new Map(); // normalized name/alias → library entry

/** Normalises a name for matching: lowercase, punctuation → spaces, collapsed. */
function normalizeExName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Loads and indexes the vendored library. Degrades to empty (no matches). */
async function loadExerciseLibrary() {
  try {
    const res = await fetch('./vendor/exercise-library.json');
    const data = await res.json();
    EXERCISE_LIBRARY = Array.isArray(data?.exercises) ? data.exercises : [];
  } catch (err) {
    console.error('[FitTrack] exercise library failed to load:', err);
    EXERCISE_LIBRARY = [];
  }
  LIBRARY_BY_KEY.clear();
  for (const entry of EXERCISE_LIBRARY) {
    LIBRARY_BY_KEY.set(normalizeExName(entry.name), entry);
    for (const alias of entry.aliases ?? []) LIBRARY_BY_KEY.set(normalizeExName(alias), entry);
  }
}

/** The library entry matching an exercise name/alias, or null. */
function matchLibraryEntry(name) {
  const key = normalizeExName(name);
  return key ? (LIBRARY_BY_KEY.get(key) ?? null) : null;
}

/**
 * The loadType for an exercise id: an explicitly stored type wins; otherwise a
 * confident library match by name/alias. Returns null when neither resolves —
 * an unmatched, untyped exercise is never silently defaulted to `weighted`
 * (that is exactly what produced phantom pull-up/leg-raise records). Callers
 * treat null conservatively — reps-based, no e1RM.
 */
function getExerciseLoadType(exerciseId) {
  const def = getExerciseDef(exerciseId);
  if (def?.loadType) return def.loadType;
  return def?.name ? (matchLibraryEntry(def.name)?.loadType ?? null) : null;
}

/**
 * Stamps `loadType` onto every exercise definition (plan, session swaps,
 * registry) that a library match resolves, so the type is durable and the
 * insights engine can read it straight off the catalog. Match-and-preserve:
 * never touches logged sets, never auto-types an unmatched exercise, never
 * archives. Also aligns the reps/seconds unit for `timed` entries. No-op once
 * everything matchable is typed.
 */
async function migrateExerciseLoadTypes() {
  // Returns true only when it actually changed the definition.
  const applyTo = (ex) => {
    if (!ex?.name) return false;
    let changed = false;
    if (!ex.loadType) {
      const match = matchLibraryEntry(ex.name);
      if (match) { ex.loadType = match.loadType; changed = true; } // else: leave untyped
    }
    // A timed movement is measured in seconds; keep the unit toggle consistent.
    if (ex.loadType === 'timed' && ex.unit !== 'seconds') { ex.unit = 'seconds'; changed = true; }
    return changed;
  };

  let planDirty = false;
  for (const ex of allPlanExercises(state.plan)) if (applyTo(ex)) planDirty = true;
  if (planDirty) await put('plan', state.plan);

  for (const key in state.meta) {
    if (!key.startsWith('swaps_')) continue;
    const doc = state.meta[key];
    let dirty = false;
    for (const extra of doc?.value ?? []) if (applyTo(extra)) dirty = true;
    if (dirty) { await put('meta', doc); state.meta[key] = doc; }
  }

  const regDoc = state.meta[EXERCISE_REGISTRY_KEY];
  if (regDoc?.value) {
    let dirty = false;
    for (const id in regDoc.value) if (applyTo(regDoc.value[id])) dirty = true;
    if (dirty) { await put('meta', regDoc); state.meta[EXERCISE_REGISTRY_KEY] = regDoc; }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ID ALIASING — read-time history reunification (authored, non-destructive)
//
//  The same real movement is often logged under several ids over time (a plan
//  rebuild mints new ids; every swap/add mints one too). The authored map at
//  data/exercise-aliases.json links each retired source id to the current plan
//  id for the SAME movement, so progress / PB / history / the "Previous" column
//  read one merged series. Logs are NEVER rewritten — removing an entry
//  instantly un-merges it, and the JSON export stays pristine (this map lives in
//  a vendored file, never IndexedDB). insights.js gets the same map via
//  setAliasMap so every metric agrees.
// ─────────────────────────────────────────────────────────────────────────────

let EXERCISE_ALIASES = {}; // sourceId → canonical (target) id

/** Loads the authored alias map. Degrades to identity (no merging) on failure. */
async function loadExerciseAliases() {
  try {
    const res  = await fetch('./data/exercise-aliases.json');
    const data = await res.json();
    const src  = (data && data.aliases) || {};
    const map  = {};
    for (const id in src) {
      const target = src[id]?.target;
      if (target && target !== id) map[id] = target;
    }
    EXERCISE_ALIASES = map;
  } catch (err) {
    console.warn('[FitTrack] exercise aliases not loaded:', err?.message ?? err);
    EXERCISE_ALIASES = {};
  }
  setAliasMap(EXERCISE_ALIASES); // keep insights.js in lock-step
}

/** The canonical id a logged/queried id resolves to (itself when unaliased). */
function canonicalExerciseId(id) {
  return EXERCISE_ALIASES[id] ?? id;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ORPHAN EXERCISE DETECTION + BACKFILL
// ─────────────────────────────────────────────────────────────────────────────

/** Every exerciseId that appears anywhere in the logs (flat + defensive nested). */
function collectLoggedExerciseIds() {
  const ids = new Set();
  for (const log of state.logs) {
    if (log?.exerciseId) ids.add(log.exerciseId);
    // Defensive: older "retroactive" session records nested sets under an
    // `exercises` array rather than one flat record per set.
    if (Array.isArray(log?.exercises)) {
      for (const e of log.exercises) {
        const id = e?.exerciseId ?? e?.id;
        if (id) ids.add(id);
      }
    }
  }
  return [...ids];
}

/**
 * Logged exercise ids that cannot be resolved to a real name from any source
 * (plan, session extras, registry, substituteName, or a stamped log name).
 * These are the anonymous `added_*` / `swap_*` orphans surfaced for naming.
 */
function findOrphanExerciseIds() {
  return collectLoggedExerciseIds()
    .filter(id => getExerciseName(id) === UNNAMED_EXERCISE_PLACEHOLDER);
}

/** Distinct dates on which an id has a meaningful (valued) logged set. */
function orphanLoggedDates(id) {
  const dates = new Set();
  for (const l of state.logs) {
    if (l.exerciseId === id && (l.weight != null || l.reps != null)) dates.add(l.date);
  }
  return [...dates].sort();
}

/**
 * A protected orphan is never pre-selected for archive: the brief's named
 * recurring ids, plus anything logged on ORPHAN_RECURRING_DATES+ distinct
 * dates (a pattern that only real, progressed exercises produce).
 */
function isProtectedOrphan(id) {
  if (PROTECTED_ORPHAN_IDS.includes(id)) return true;
  return orphanLoggedDates(id).length >= ORPHAN_RECURRING_DATES;
}

/** Identifying hints for the review screen: per-date weight×reps and totals. */
function orphanHints(id) {
  const byDate = {};
  for (const l of state.logs) {
    if (l.exerciseId !== id) continue;
    if (l.weight == null && l.reps == null) continue;
    (byDate[l.date] ??= []).push(l);
  }
  const dates = Object.keys(byDate).sort();
  const perDate = dates.map(date => {
    const sets = byDate[date]
      .sort((a, b) => a.setIndex - b.setIndex)
      .map(l => {
        const w = l.weight != null ? `${l.weight}kg` : '';
        const r = l.reps != null ? (w ? `×${l.reps}` : String(l.reps)) : '';
        return (w + r) || '—';
      });
    return { date, sets };
  });
  return { dates, sessionCount: dates.length, perDate };
}

/**
 * Backfills a resolved name/unit for an orphan id: writes it to the durable
 * registry and stamps `exerciseName`/`unit` onto every existing logged set for
 * that id so history and future exports resolve. Never deletes anything.
 */
async function backfillOrphanName(id, name, unit, archived = false, loadType = null) {
  const entry = { name, unit, archived };
  if (loadType) entry.loadType = loadType; // omit when unset — never guess a type
  await upsertRegistryEntry(id, entry);

  const affected = state.logs.filter(l => l.exerciseId === id);
  for (const log of affected) {
    log.exerciseName = name;
    log.unit = unit;
  }
  await putMany('logs', affected);
}

/** Marks the one-time orphan review as seen so it stops auto-surfacing. */
async function markOrphanReviewDone() {
  const doc = { key: ORPHAN_REVIEW_DONE_KEY, value: true };
  await put('meta', doc);
  state.meta[ORPHAN_REVIEW_DONE_KEY] = doc;
}

/** One review row: id, memory-jogging hints, and name / unit / archive controls. */
function buildOrphanRowHTML(id) {
  const { sessionCount, perDate } = orphanHints(id);
  const protectedFlag = isProtectedOrphan(id);

  const hintLines = perDate.map(d => `
    <div class="orphan-hint-line">
      <span class="orphan-hint-date">${escHtml(friendlyDateLabel(d.date))}</span>
      <span class="orphan-hint-sets">${escHtml(d.sets.join(', '))}</span>
    </div>`).join('');

  return `
    <div class="orphan-row" data-orphan-id="${escHtml(id)}">
      <div class="orphan-row-head">
        <code class="orphan-row-id">${escHtml(id)}</code>
        ${protectedFlag ? '<span class="orphan-recurring-badge">recurring — likely keep</span>' : ''}
      </div>
      <div class="orphan-hints">
        <p class="orphan-hint-summary">${sessionCount} session${sessionCount === 1 ? '' : 's'} logged</p>
        ${hintLines}
      </div>
      <div class="orphan-row-fields">
        <input class="orphan-name-input" type="text"
               placeholder="Real exercise name"
               aria-label="Name for ${escHtml(id)}" />
        <select class="orphan-loadtype-select" aria-label="Type for ${escHtml(id)}">
          <option value="" selected>Type…</option>
          <option value="weighted">Weighted (kg × reps)</option>
          <option value="bodyweight">Bodyweight (reps)</option>
          <option value="assisted">Assisted (less is better)</option>
          <option value="timed">Timed (seconds)</option>
          <option value="reps">Reps only</option>
        </select>
        <label class="orphan-archive">
          <input type="checkbox" class="orphan-archive-check" />
          Archive
        </label>
      </div>
    </div>`;
}

/** Opens the "Name your exercises" review overlay for all current orphans. */
function openOrphanReview() {
  const orphans = findOrphanExerciseIds();
  const overlay = document.getElementById('orphan-review-overlay');
  const list    = document.getElementById('orphan-review-list');

  if (!orphans.length) {
    showToast('No unnamed exercises to review.');
    return;
  }

  // Protected/recurring first, then by most sessions — the meaningful ones lead.
  orphans.sort((a, b) => {
    const pa = isProtectedOrphan(a), pb = isProtectedOrphan(b);
    if (pa !== pb) return pa ? -1 : 1;
    return orphanLoggedDates(b).length - orphanLoggedDates(a).length;
  });

  list.innerHTML = orphans.map(buildOrphanRowHTML).join('');

  // Archiving disables the name field for that row (archive keeps logs, no name needed)
  list.querySelectorAll('.orphan-row').forEach(row => {
    const check = row.querySelector('.orphan-archive-check');
    const name  = row.querySelector('.orphan-name-input');
    check.addEventListener('change', () => {
      name.disabled = check.checked;
      row.classList.toggle('orphan-row-archived', check.checked);
    });
  });

  overlay.hidden = false;
}

function closeOrphanReview() {
  document.getElementById('orphan-review-overlay').hidden = true;
}

/**
 * Applies the review: each row is named (and its logs backfilled) or archived.
 * Rows left blank are skipped and remain orphans for a later pass. Nothing is
 * ever hard-deleted. Marks the one-time review as seen when done.
 */
async function saveOrphanReview() {
  const rows = document.querySelectorAll('#orphan-review-list .orphan-row');
  let named = 0, archived = 0;

  for (const row of rows) {
    const id      = row.dataset.orphanId;
    const name    = row.querySelector('.orphan-name-input').value.trim();
    // Type is the primary fact the user assigns; the reps/seconds unit derives
    // from it. Left unset, the exercise is named but untyped — never guessed.
    const loadType = row.querySelector('.orphan-loadtype-select').value || null;
    const unit    = loadType === 'timed' ? 'seconds' : 'reps';
    const doArchive = row.querySelector('.orphan-archive-check').checked;

    if (doArchive) {
      await backfillOrphanName(id, name || 'Archived exercise', unit, true, loadType);
      archived++;
    } else if (name) {
      await backfillOrphanName(id, name, unit, false, loadType);
      named++;
    }
    // else: left blank — untouched, still an orphan for next time.
  }

  await markOrphanReviewDone();
  closeOrphanReview();
  render();

  const parts = [];
  if (named)    parts.push(`${named} named`);
  if (archived) parts.push(`${archived} archived`);
  showToast(parts.length ? `Saved — ${parts.join(', ')}.` : 'No changes made.');
}

// ─────────────────────────────────────────────────────────────────────────────
//  RENDER DISPATCH
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Master render routine — call after any state mutation.
 * Header and week strip always re-render.
 * Only the active tab view re-renders (defined in Part 2).
 */
function render() {
  renderHeader();
  renderWeekStrip();

  switch (state.ui.currentView) {
    case 'hub':      renderHub();          break;
    case 'today':    renderToday();        break;
    case 'stats':    renderStats();        break;
    case 'body':     renderBodyTab(state.bodyComposition); break;
    case 'plan':     renderPlan();         break;
    case 'routine':  renderRoutine();      break;
    case 'library':  renderLibrary();      break;
    case 'data':     renderData();         break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  NAVIGATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Views that are not themselves a bottom-nav tab, mapped to the tab that should
 * stay lit while they are open. The routine editor is a page you reach FROM the
 * Plan tab, so dimming the whole nav bar while editing would read as "you have
 * left the app" rather than "you are one level down".
 */
const NAV_ALIAS = { routine: 'plan' };

function switchView(viewName) {
  if (state.ui.currentView === viewName) return;

  state.ui.currentView = viewName;
  state.ui.expandedExerciseId = null; // collapse open accordions on tab change

  document.querySelectorAll('.tab-view').forEach(el => {
    const isTarget = el.id === `view-${viewName}`;
    el.classList.toggle('active', isTarget);
    el.hidden = !isTarget;
  });

  const navFor = NAV_ALIAS[viewName] ?? viewName;
  document.querySelectorAll('.nav-tab').forEach(btn => {
    const isActive = btn.dataset.view === navFor;
    btn.classList.toggle('active-tab', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });

  render();
}

/** Open the header settings menu (Data & Library live here now). */
/** Whether the user asked for reduced motion — used to skip exit animations. */
function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * Play a quick fade-out on an overlay, then run `hide` (which sets [hidden] and
 * resets state). A setTimeout fallback GUARANTEES `hide` always runs even if
 * `animationend` never fires, so an exit animation can never leave an overlay
 * stuck open. Reduced motion (or an already-hidden overlay) hides instantly.
 */
function closeOverlayAnimated(overlay, hide) {
  if (!overlay || overlay.hidden || prefersReducedMotion()) { hide(); return; }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    overlay.classList.remove('overlay-closing');
    hide();
  };
  overlay.classList.add('overlay-closing');
  overlay.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, 220); // fallback — never leave the overlay stranded
}

function openSettings() {
  const overlay = document.getElementById('settings-overlay');
  overlay.classList.remove('overlay-closing'); // clear a mid-exit state on rapid reopen
  // Reflect the stored haptics choice each time the menu opens.
  document.getElementById('haptics-toggle')?.setAttribute('aria-checked', String(hapticsEnabled()));
  overlay.hidden = false;
  overlay.querySelector('.settings-menu-item')?.focus();
}

/** Close the header settings menu (quick fade-out) and return focus to the gear. */
function closeSettings() {
  const overlay = document.getElementById('settings-overlay');
  closeOverlayAnimated(overlay, () => { overlay.hidden = true; });
  document.getElementById('settings-btn')?.focus();
}

// ─────────────────────────────────────────────────────────────────────────────
//  HEADER RENDER
// ─────────────────────────────────────────────────────────────────────────────

function renderHeader() {
  document.getElementById('header-day-name').textContent =
    DAY_NAMES_LONG[state.ui.todayDayIndex];
  document.getElementById('header-date').textContent =
    friendlyDateLabel(state.ui.today);
}

// ─────────────────────────────────────────────────────────────────────────────
//  WEEK STRIP RENDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derives the visual status of a single day cell.
 * Returns: 'done' | 'inprogress' | 'today' | 'untrained' | 'rest' | 'upcoming'
 *
 * Model A (weekly quota): there is no per-weekday "missed". A past day is simply
 * 'done' (a session was logged) or 'untrained' (none) — an untrained day is a
 * neutral fact, never a failure, because the plan's real goal is a NUMBER of
 * sessions per week, not the specific weekday. Training Tue instead of Mon is
 * not a miss. Shortfall (fewer sessions than the weekly target) is computed at
 * the week level, not here.
 */
function getDayStatus(dateStr) {
  const today      = state.ui.today;
  const { activeEx, extras } = resolveExercisesForDate(dateStr);
  const isRestDay  = activeEx.length === 0 && extras.length === 0;
  const finishedMap = state.meta[FINISHED_KEY]?.value ?? {};

  // Explicitly finished sessions win over everything else
  if (finishedMap[dateStr]) return 'done';

  if (dateStr === today) {
    const logsToday = state.logs.filter(l => l.date === today);
    if (logsToday.length > 0 && !isRestDay) return 'inprogress';
    return 'today'; // default today state (could be a rest day — still shows as 'today')
  }

  if (dateStr > today) {
    return isRestDay ? 'rest' : 'upcoming';
  }

  // Past day — a logged session WINS over the plan's weekday opinion. Training
  // on a day the plan calls rest (a shifted session) is still 'done' (green);
  // Model A cares that you trained, not which weekday it landed on.
  const logsOnDay = state.logs.filter(l => l.date === dateStr);
  if (logsOnDay.length > 0) return 'done'; // any logged activity counts
  if (isRestDay) return 'rest';            // a plan rest day, untrained — neutral
  return 'untrained';                      // a plan weekday with no session — neutral, not a miss
}

function renderWeekStrip() {
  const grid      = document.getElementById('week-grid');
  const today     = state.ui.today;
  const weekDates = state.ui.weekDates;

  grid.innerHTML = weekDates.map((dateStr, i) => {
    const status = getDayStatus(dateStr);
    const dayNum = parseDate(dateStr).getDate();

    const cssClasses = [
      'day-cell',
      status === 'done'       ? 'day-done'       : '',
      status === 'inprogress' ? 'day-inprogress' : '',
      status === 'untrained'  ? 'day-untrained'  : '',
      status === 'rest'       ? 'day-rest'        : '',
      status === 'upcoming'   ? 'day-upcoming'    : '',
      status === 'today'      ? 'day-today'       : '',
    ].filter(Boolean).join(' ');

    return `
      <div class="${cssClasses}"
           data-date="${dateStr}"
           role="button"
           tabindex="0"
           aria-label="${DAY_NAMES_LONG[i]} ${dayNum}, ${status}">
        <span class="day-letter">${DAY_NAMES_SHORT[i]}</span>
        <span class="day-number">${dayNum}</span>
      </div>
    `;
  }).join('');

  // Tapping any day cell opens that date's session in the day view (Today tab)
  grid.querySelectorAll('.day-cell').forEach(cell => {
    cell.addEventListener('click', () => handleDayCellClick(cell.dataset.date));
    cell.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        cell.click();
      }
    });
  });
}

/** Opens a given date's session in the day view, switching to the Today tab if needed. */
function handleDayCellClick(dateStr) {
  state.ui.viewedDate = dateStr;
  state.ui.expandedExerciseId = null;
  if (state.ui.currentView !== 'today') {
    switchView('today'); // switchView() already calls render()
  } else {
    render();
  }
}

/** Returns the day view to today, clearing any past/future date being viewed. */
function handleBackToToday() {
  if (state.ui.viewedDate === state.ui.today) return;
  state.ui.viewedDate = state.ui.today;
  state.ui.expandedExerciseId = null;
  render();
}

// ─────────────────────────────────────────────────────────────────────────────
//  INITIALISATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Surfaces an init/setup failure instead of letting it strand the app silently.
 * The original "gear does nothing on phone" bug was exactly this: an awaited
 * step rejected, init aborted with no trace, and every later listener binding
 * was skipped. Anything that can fail during boot routes here so it's both
 * logged and visible on screen — a dead button is no longer the only symptom.
 */
function reportInitError(context, err) {
  console.error(`[FitTrack] ${context} failed during startup:`, err);
  try {
    showToast(`${context} had a problem — some data may be incomplete. See console.`);
  } catch { /* toast unavailable this early — the console line above still lands */ }
}

/** Runs one boot step so a single failure can't abort the whole init sequence. */
async function runSetupStep(label, fn) {
  try {
    await fn();
  } catch (err) {
    reportInitError(label, err);
  }
}

/**
 * Binds every static-DOM event listener. Called BEFORE any awaited data work so
 * that a data-load or migration failure can never strand the nav or the header
 * settings gear — that was the phone-only bug. None of these handlers read data
 * at bind time; they fire on user interaction, by which point the data has
 * loaded (or failed loudly), so binding them first is always safe. All the
 * referenced elements are static in index.html and present at DOMContentLoaded.
 */
function wireStaticListeners() {
  // 4. Bottom tab navigation
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // 4b. Header settings menu — reaches the Data and Library views that left the
  //     primary nav. The views themselves are unchanged; only how they're opened.
  //     This binding intentionally runs before any data work: opening the menu
  //     only toggles the overlay's `hidden` attribute and calls switchView, so
  //     it must stay live even if IndexedDB setup fails entirely.
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('settings-close-btn').addEventListener('click', closeSettings);
  document.querySelectorAll('.settings-menu-item').forEach(btn => {
    btn.addEventListener('click', () => {
      closeSettings();
      switchView(btn.dataset.settingsView);
    });
  });
  document.getElementById('settings-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'settings-overlay') closeSettings(); // tap the backdrop to dismiss
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('settings-overlay').hidden) closeSettings();
  });
  const hapticsToggle = document.getElementById('haptics-toggle');
  hapticsToggle.addEventListener('click', () => toggleHaptics(hapticsToggle));

  // 5. Body tab — Fitdays import. The visible button drives the hidden file
  //    input so the control is keyboard-focusable and styled like the app.
  const bcInput = document.getElementById('bc-import-input');
  document.getElementById('bc-import-btn').addEventListener('click', () => bcInput.click());
  bcInput.addEventListener('change', handleFitdaysImport);

  // 6. Empty-plan shortcut button
  document.getElementById('go-to-plan-btn').addEventListener('click', () => switchView('plan'));

  // 6b. "Train anyway" on a rest day — adds an ad hoc session for the viewed date
  document.getElementById('train-anyway-btn').addEventListener('click', () =>
    handleAddExercise(state.ui.viewedDate)
  );

  // 7. Finish session CTA
  document.getElementById('finish-session-btn').addEventListener('click', () =>
    handleFinishSession(state.ui.viewedDate)
  );

  // 7b. Back-to-today banner button
  document.getElementById('back-to-today-btn').addEventListener('click', handleBackToToday);

  // 7c. Rest timer controls
  document.getElementById('rest-timer-extend').addEventListener('click', () => extendRestTimer(30));
  document.getElementById('rest-timer-skip').addEventListener('click', stopRestTimer);

  // 8. Data tab actions
  document.getElementById('export-btn').addEventListener('click', handleExport);
  document.getElementById('import-file-input').addEventListener('change', handleImport);
  document.getElementById('clear-data-btn').addEventListener('click', handleClearData);
  document.getElementById('review-orphans-btn').addEventListener('click', () => openOrphanReview());

  // 8b. Orphan-review overlay controls
  document.getElementById('orphan-review-later-btn').addEventListener('click', closeOrphanReview);
  document.getElementById('orphan-review-save-btn').addEventListener('click', saveOrphanReview);

  // 8c. Exercise-detail overlay — close button, backdrop tap, Esc, and the
  //     start/finish frame toggle inside the reference panel.
  const detailOverlay = document.getElementById('exercise-detail-overlay');
  document.getElementById('exercise-detail-close').addEventListener('click', closeExerciseDetail);
  detailOverlay.addEventListener('click', (e) => {
    if (e.target === detailOverlay) closeExerciseDetail();
    const toggle = e.target.closest('[data-ref-frames-toggle]');
    if (toggle) toggle.closest('[data-ref-frames]')?.classList.toggle('showing-finish');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !detailOverlay.hidden) closeExerciseDetail();
  });

  // 8d. Bottom sheet — backdrop tap and Esc. Every picker the Plan tab and the
  //     day view open shares this one surface, so this is all the wiring it needs;
  //     each sheet binds only its own rows when it opens.
  const sheetOverlay = document.getElementById('sheet-overlay');
  sheetOverlay.addEventListener('click', (e) => {
    if (e.target === sheetOverlay) closeSheet();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sheetOverlay.hidden) closeSheet();
  });

  // 9. Confirm dialog buttons
  document.getElementById('dialog-cancel-btn').addEventListener('click', closeDialog);
  document.getElementById('dialog-confirm-btn').addEventListener('click', () => {
    if (typeof state.ui._dialogConfirmCallback === 'function') {
      state.ui._dialogConfirmCallback();
    }
    closeDialog();
  });
  // The extra action runs WITHOUT closing the dialog, so the confirm stays the
  // last step (e.g. tap "Back up first", then still face the delete confirm).
  document.getElementById('dialog-extra-btn').addEventListener('click', () => {
    if (typeof state.ui._dialogExtraCallback === 'function') {
      state.ui._dialogExtraCallback();
    }
  });

  // Session-level note — static element, so wire once here; renderToday keeps its
  // value and dataset.date current. Persists on blur against the viewed date.
  const sessionNoteInput = document.getElementById('session-note-input');
  sessionNoteInput.addEventListener('blur', () => saveSessionNote(sessionNoteInput));
}

async function init() {
  // 1. Resolve today's position in the calendar (synchronous — never touches
  //    IndexedDB, so it cannot be the thing that fails).
  const today      = todayStr();
  const weekDates  = weekDatesOf(new Date());
  state.ui.today         = today;
  state.ui.weekDates     = weekDates;
  state.ui.todayDayIndex = dayIndexOf(today);
  state.ui.viewedDate    = today;

  // 2. Wire ALL static UI listeners UP FRONT, before any awaited data work.
  //    This is the core of the phone-gear fix: the nav and settings gear are
  //    live even if the data load or a migration below throws.
  wireStaticListeners();

  // 3. Ask the browser to protect IndexedDB from eviction under storage
  //    pressure — all training history lives there with no server copy.
  navigator.storage?.persist?.().catch(() => {});

  // 4. Pull everything out of IndexedDB (and the vendored exercise library +
  //    the open reference dataset / id-map, static app content held in memory
  //    only). Guarded: a load failure surfaces visibly but still lets the UI
  //    boot with the safe empty-state defaults on `state`.
  try {
    await Promise.all([
      loadState(),
      loadExerciseLibrary(),
      loadReference(),
      loadExerciseMap(),
      loadExerciseAliases(),
    ]);
  } catch (err) {
    reportInitError('Loading your data', err);
  }

  // 5. Seed defaults on first launch, then run migrations: drop retired meta,
  //    ensure every exercise has a unit, fix the stale incline-DB label, and
  //    type library-matched exercises. Each step is INDIVIDUALLY non-fatal —
  //    one hitting an unexpected record must not abort the boot or take the UI
  //    (the settings gear included) down with it.
  await runSetupStep('First-run setup', seedIfFirstRun);
  await runSetupStep('Cleaning up old settings', dropRetiredMeta);
  await runSetupStep('Routine migration', migratePlanToRoutines);
  await runSetupStep('Exercise-unit migration', migrateExerciseUnits);
  await runSetupStep('Incline-DB label fix', migrateInclineDbLabel);
  await runSetupStep('Load-type migration', migrateExerciseLoadTypes);

  // 6. First paint — guarded so a render error can't strand the already-wired UI.
  try {
    render();
  } catch (err) {
    reportInitError('Rendering', err);
  }

  // 7. Surface any anonymous historical exercise ids for naming — once, unless
  //     re-opened manually from the Data tab. Deferred so it never blocks paint.
  try {
    if (!state.meta[ORPHAN_REVIEW_DONE_KEY] && findOrphanExerciseIds().length > 0) {
      setTimeout(() => openOrphanReview(), 400);
    }
  } catch (err) {
    reportInitError('Orphan review', err);
  }
}

// Final safety net: init() is internally guarded, but a `.catch()` here means a
// rejection can never again strand the app without a trace.
document.addEventListener('DOMContentLoaded', () => {
  init().catch(err => reportInitError('Startup', err));
});

// ═════════════════════════════════════════════════════════════════════════════
//  PART 2 — renders, event handlers, charts, plan editing, data I/O
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
//  UTILITY FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─────────────────────────────────────────────────────────────────────────────
//  HAPTICS — best-effort, gated, silent when unavailable
// ─────────────────────────────────────────────────────────────────────────────

/** True unless the user has explicitly turned haptics off (default on). */
function hapticsEnabled() {
  return state.meta[HAPTICS_KEY]?.value !== false;
}

/**
 * Fire a short haptic tap. A no-op — never an error — when the user has haptics
 * off, when the browser has no Vibration API (iOS Safari), or if the call
 * throws. Patterns are kept short (single 10–20ms taps or a brief double) so it
 * reads as a click, not an alarm. Reserved for the four meaningful moments only
 * (set done, PR, rest-zero); never wired to navigation, scrolling, or typing.
 */
function haptic(pattern) {
  if (!hapticsEnabled()) return;
  try { navigator.vibrate?.(pattern); } catch { /* absent/blocked — silent */ }
}

/**
 * Flip the haptics setting and persist it to meta. Reflects into `state.meta`
 * immediately so the confirming tap (when turning ON) already respects it, and
 * updates the toggle's aria-checked. Storage only — no data-model change.
 */
async function toggleHaptics(btn) {
  const next = !hapticsEnabled();
  const doc  = { key: HAPTICS_KEY, value: next };
  state.meta[HAPTICS_KEY] = doc;
  btn.setAttribute('aria-checked', String(next));
  if (next) haptic(15); // a single confirming tap when switching haptics on
  try {
    await put('meta', doc);
  } catch (err) {
    console.error('[FitTrack] Could not save haptics setting:', err);
  }
}

let _toastTimer = null;

function showToast(message, duration = 2800) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('toast-show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('toast-show'), duration);
}

// ─────────────────────────────────────────────────────────────────────────────
//  REST TIMER
// ─────────────────────────────────────────────────────────────────────────────

const REST_TIMER_SECONDS = 90;

// endsAt-based countdown — survives background-tab interval throttling
const _restTimer = { interval: null, endsAt: 0 };

function formatTimerSeconds(s) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function updateRestTimerDisplay() {
  const remaining = Math.max(0, Math.round((_restTimer.endsAt - Date.now()) / 1000));
  document.getElementById('rest-timer-count').textContent = formatTimerSeconds(remaining);
  return remaining;
}

function startRestTimer() {
  clearInterval(_restTimer.interval);
  _restTimer.endsAt = Date.now() + REST_TIMER_SECONDS * 1000;
  document.getElementById('rest-timer').hidden = false;
  // The rest-timer bar floats above the nav; give the scroll content extra
  // bottom clearance so the last set row can scroll clear of both stacked bars.
  document.body.classList.add('rest-timer-active');
  updateRestTimerDisplay();
  _restTimer.interval = setInterval(() => {
    if (updateRestTimerDisplay() <= 0) {
      clearInterval(_restTimer.interval);
      _restTimer.interval = null;
      restTimerComplete();
    }
  }, 1000);
}

/**
 * Rest countdown reached zero — a genuinely useful signal (the user is looking
 * away from the phone). A clear haptic pulse plus ONE calm accent pulse on the
 * still-visible bar, then it hides. Only fires at zero, never mid-countdown.
 */
function restTimerComplete() {
  haptic([20, 60, 20]);
  showToast('Rest over — next set!');

  const bar = document.getElementById('rest-timer');
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    bar.classList.remove('rest-timer-done');
    stopRestTimer();
  };
  // Pulse the bar once, then hide it when the pulse resolves. The setTimeout is
  // the fallback that also covers reduced-motion (where the animation is flat).
  bar.classList.add('rest-timer-done');
  bar.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, 450);
}

function stopRestTimer() {
  clearInterval(_restTimer.interval);
  _restTimer.interval = null;
  const bar = document.getElementById('rest-timer');
  bar.hidden = true;
  bar.classList.remove('rest-timer-done');
  document.body.classList.remove('rest-timer-active');
}

function extendRestTimer(seconds = 30) {
  if (!_restTimer.interval) return;
  _restTimer.endsAt += seconds * 1000;
  updateRestTimerDisplay();
}

// ─────────────────────────────────────────────────────────────────────────────
//  DURATION TIMER — stopwatch for seconds-based sets (plank, dead bug, …)
// ─────────────────────────────────────────────────────────────────────────────

const DURATION_PLAY_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 4 20 12 6 20"/></svg>';
const DURATION_STOP_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>';

// startedAt-based count-up — survives background-tab interval throttling
const _durationTimer = { interval: null, btn: null, input: null, startedAt: 0 };

function durationTimerElapsed() {
  return Math.round((Date.now() - _durationTimer.startedAt) / 1000);
}

/**
 * Stops the running set stopwatch, restores its button, and leaves the
 * elapsed seconds in the input. Returns the elapsed seconds (0 if idle).
 */
function stopDurationTimer() {
  if (!_durationTimer.interval) return 0;
  clearInterval(_durationTimer.interval);
  const elapsed = durationTimerElapsed();
  const { btn, input } = _durationTimer;
  if (btn?.isConnected) {
    btn.innerHTML = DURATION_PLAY_SVG;
    btn.setAttribute('aria-pressed', 'false');
    btn.classList.remove('set-timer-running');
  }
  if (input?.isConnected) input.value = String(elapsed);
  _durationTimer.interval = null;
  _durationTimer.btn = null;
  _durationTimer.input = null;
  return elapsed;
}

function startDurationTimer(btn, input) {
  stopDurationTimer(); // only one hold can be timed at a time
  _durationTimer.btn       = btn;
  _durationTimer.input     = input;
  _durationTimer.startedAt = Date.now();
  btn.innerHTML = DURATION_STOP_SVG;
  btn.setAttribute('aria-pressed', 'true');
  btn.classList.add('set-timer-running');
  input.value = '0';
  _durationTimer.interval = setInterval(() => {
    if (!input.isConnected) { stopDurationTimer(); return; }
    input.value = String(durationTimerElapsed());
  }, 250);
}

function handleDurationTimerClick(btn, date) {
  const setRow = btn.closest('.set-row');
  const input  = setRow?.querySelector('.set-reps');
  if (!input) return;

  if (_durationTimer.btn === btn) {
    const secs = stopDurationTimer();
    if (secs > 0) {
      writeLog(date, btn.dataset.exId, parseInt(btn.dataset.setIndex, 10), { reps: secs });
    }
  } else {
    startDurationTimer(btn, input);
  }
}

function showDialog(message, onConfirm, { confirmLabel = 'Confirm', danger = true, extraAction = null } = {}) {
  const confirmBtn = document.getElementById('dialog-confirm-btn');
  confirmBtn.textContent = confirmLabel;
  confirmBtn.className   = danger ? 'btn-danger' : 'btn-primary';
  document.getElementById('dialog-inputs').hidden = true;
  document.getElementById('dialog-message').textContent = message;

  // Optional non-closing extra action (e.g. "Back up first"): runs its callback
  // but leaves the dialog open, so the confirm below remains the final step.
  const extraBtn = document.getElementById('dialog-extra-btn');
  if (extraAction) {
    extraBtn.textContent = extraAction.label;
    extraBtn.hidden = false;
    state.ui._dialogExtraCallback = extraAction.onClick;
  } else {
    extraBtn.hidden = true;
    state.ui._dialogExtraCallback = null;
  }

  state.ui._dialogConfirmCallback = onConfirm;
  const overlay = document.getElementById('dialog-overlay');
  overlay.classList.remove('overlay-closing'); // clear a mid-exit state on rapid reopen
  overlay.hidden = false;
  confirmBtn.focus();
}

/**
 * Confirm dialog variant with input fields, replacing window.prompt chains.
 * `fields`: [{ name, label, placeholder?, type?, inputmode?, value? }] for
 * text inputs, or [{ name, label, options: [{value, label}], value? }] for
 * a select. `onSubmit` receives { fieldName: trimmedValue, … } when confirmed.
 */
function showFormDialog(message, fields, onSubmit, confirmLabel = 'Save') {
  const confirmBtn = document.getElementById('dialog-confirm-btn');
  confirmBtn.textContent = confirmLabel;
  confirmBtn.className   = 'btn-primary';
  document.getElementById('dialog-extra-btn').hidden = true;
  state.ui._dialogExtraCallback = null;
  document.getElementById('dialog-message').textContent = message;

  const wrap = document.getElementById('dialog-inputs');
  wrap.innerHTML = fields.map(f => {
    const control = f.options
      ? `<select class="dialog-input"
                 id="dialog-field-${escHtml(f.name)}"
                 data-field="${escHtml(f.name)}">
           ${f.options.map(o => `
             <option value="${escHtml(o.value)}"${o.value === f.value ? ' selected' : ''}>
               ${escHtml(o.label)}
             </option>`).join('')}
         </select>`
      : `<input class="dialog-input"
                id="dialog-field-${escHtml(f.name)}"
                type="${escHtml(f.type ?? 'text')}"
                ${f.inputmode ? `inputmode="${escHtml(f.inputmode)}"` : ''}
                value="${escHtml(f.value ?? '')}"
                placeholder="${escHtml(f.placeholder ?? '')}"
                data-field="${escHtml(f.name)}" />`;
    return `
    <div class="dialog-field">
      <label class="dialog-input-label" for="dialog-field-${escHtml(f.name)}">${escHtml(f.label)}</label>
      ${control}
    </div>`;
  }).join('');
  wrap.hidden = false;

  wrap.querySelectorAll('.dialog-input').forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') confirmBtn.click();
    });
  });

  state.ui._dialogConfirmCallback = () => {
    const values = {};
    wrap.querySelectorAll('.dialog-input').forEach(i => {
      values[i.dataset.field] = i.value.trim();
    });
    onSubmit(values);
  };

  const overlay = document.getElementById('dialog-overlay');
  overlay.classList.remove('overlay-closing'); // clear a mid-exit state on rapid reopen
  overlay.hidden = false;
  wrap.querySelector('.dialog-input')?.focus();
}

function closeDialog() {
  const overlay = document.getElementById('dialog-overlay');
  closeOverlayAnimated(overlay, () => {
    overlay.hidden = true;
    const wrap = document.getElementById('dialog-inputs');
    wrap.innerHTML = '';
    wrap.hidden = true;
    document.getElementById('dialog-extra-btn').hidden = true;
    state.ui._dialogConfirmCallback = null;
    state.ui._dialogExtraCallback = null;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  LOG HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function getLogId(date, exerciseId, setIndex) {
  return `${date}_${exerciseId}_${setIndex}`;
}

function getExistingLog(date, exerciseId, setIndex) {
  const id = getLogId(date, exerciseId, setIndex);
  return state.logs.find(l => l.id === id) ?? null;
}

async function writeLog(date, exerciseId, setIndex, fields) {
  const id       = getLogId(date, exerciseId, setIndex);
  const existing = getExistingLog(date, exerciseId, setIndex);

  // Stamp the resolved name and unit onto the set itself so the export is
  // self-describing. This is the durable fix for the anonymous-id bug: even if
  // the session-scoped `swaps_<date>` definition is ever lost, the name still
  // lives on every set logged against the exercise. Purely additive fields.
  const resolvedName = getExerciseName(exerciseId);
  const entry    = {
    id,
    date,
    exerciseId,
    setIndex,
    weight:         fields.weight         ?? existing?.weight         ?? null,
    reps:           fields.reps           ?? existing?.reps           ?? null,
    // Optional felt-effort (RPE), capture-only. Purely additive and nullable
    // like every field here — absent means null, and no insight/PR/volume path
    // ever reads it. It exists to be logged and exported, nothing more.
    rpe:            fields.rpe            ?? existing?.rpe            ?? null,
    done:           fields.done           ?? existing?.done           ?? false,
    notes:          fields.notes          ?? existing?.notes          ?? '',
    substituteName: fields.substituteName ?? existing?.substituteName ?? null,
    exerciseName:   resolvedName !== UNNAMED_EXERCISE_PLACEHOLDER
                      ? resolvedName
                      : (existing?.exerciseName ?? null),
    unit:           getExerciseUnit(exerciseId),
  };
  await put('logs', entry);
  const idx = state.logs.findIndex(l => l.id === id);
  if (idx >= 0) state.logs[idx] = entry;
  else state.logs.push(entry);
  return entry;
}

/**
 * Persist the whole-session note for a date. Keyed in meta as
 * `sessionNote_<date>` — the same per-date convention as swaps_/removed_ — so it
 * round-trips through the existing meta export with no changes to
 * buildBackupPayload or handleImport. An empty note deletes the key rather than
 * storing a blank record. In-memory state.meta is updated so it survives tab
 * switches without a reload. Capture-only: nothing interprets this string.
 */
async function saveSessionNote(input) {
  const date = input.dataset.date;
  if (!date) return;
  const key = `sessionNote_${date}`;
  const val = input.value.trim();

  if (!val) {
    if (state.meta[key]) {
      await del('meta', key);
      delete state.meta[key];
    }
    return;
  }

  const doc = { key, value: val };
  await put('meta', doc);
  state.meta[key] = doc;
}

/**
 * Most recent completed logs for an exercise on any date strictly before
 * excludeDate. Requires weight OR reps so duration-only sets (e.g. an
 * unweighted plank hold) still surface as a last-time reference.
 */
function getRecentLogsForExercise(exerciseId, excludeDate) {
  // Merge aliased history so "Previous" reflects the last real session of this
  // movement, even if it was logged under a retired id.
  const target = canonicalExerciseId(exerciseId);
  const done = state.logs.filter(l =>
    canonicalExerciseId(l.exerciseId) === target &&
    l.date < excludeDate &&
    l.done &&
    (l.weight != null || l.reps != null)
  );
  if (!done.length) return [];
  done.sort((a, b) => b.date.localeCompare(a.date));
  const mostRecentDate = done[0].date;
  return done
    .filter(l => l.date === mostRecentDate)
    .sort((a, b) => a.setIndex - b.setIndex);
}

/**
 * All-time best logged set (done=true) for an exercise.
 * Rep-based exercises rank by heaviest weight; seconds-based exercises rank
 * by longest duration (stored in the `reps` field). Returns null if none.
 */
/** Returns true when every set 0…totalSets-1 has a done=true log on date. */
function isExerciseComplete(exerciseId, date, totalSets) {
  return Array.from({ length: totalSets }, (_, i) => i)
    .every(i => getExistingLog(date, exerciseId, i)?.done === true);
}

/**
 * Resolves the full list of exercises for a given date: the day's active
 * plan exercises (by weekday) — minus any session-scoped removals — plus
 * any session-scoped swaps/adds. Both overrides are stored in `meta`
 * under `removed_<date>` and `swaps_<date>` respectively, and never touch
 * the recurring weekly plan document.
 */
function resolveExercisesForDate(date) {
  const day         = dayForDate(date);
  const routine     = day.routine;
  const removedIds  = state.meta[`removed_${date}`]?.value ?? [];
  const activeEx    = (routine?.exercises ?? [])
    .filter(e => !e.archived && !removedIds.includes(e.id));
  const swapsKey    = `swaps_${date}`;
  const extras      = state.meta[swapsKey]?.value ?? [];
  // `dayPlan` keeps the shape the rest of the app already reads: a truthy object
  // means "this date has a session", and `sessionName` is what the session
  // header and the volume chart label it with.
  const dayPlan = routine
    ? {
        dayIndex: dayIndexOf(date), sessionName: routine.name, isRest: false,
        routineId: routine.id, exercises: routine.exercises ?? [],
      }
    : null;
  return {
    dayPlan, routine, rescheduled: day.overridden,
    activeEx, extras, allExercises: [...activeEx, ...extras],
  };
}

/** Adds an exerciseId to a date's session-scoped removal list (idempotent). */
async function addRemovedId(date, exerciseId) {
  const key = `removed_${date}`;
  const doc = state.meta[key] ?? { key, value: [] };
  if (!doc.value.includes(exerciseId)) doc.value.push(exerciseId);
  await put('meta', doc);
  state.meta[key] = doc;
}

/** Removes an exerciseId from a date's session-scoped removal list, if present. */
async function unremoveId(date, exerciseId) {
  const key = `removed_${date}`;
  const doc = state.meta[key];
  if (!doc || !doc.value.includes(exerciseId)) return;
  doc.value = doc.value.filter(id => id !== exerciseId);
  await put('meta', doc);
  state.meta[key] = doc;
}

/**
 * Resolves a display name for an exerciseId — from the recurring plan, or
 * from a session-scoped swap/add extra (stored per-date under `swaps_<date>`
 * meta keys, searched across all dates since an exercise logged on one date
 * may be looked up from anywhere, e.g. the Progress tab history selector).
 * Never returns the raw internal id.
 */
/**
 * Resolves the full exercise definition for an id — recurring plan first
 * (any day, archived included so history keeps its metadata), then
 * session-scoped swap/add extras. Returns null when unknown.
 */
function getExerciseDef(exerciseId) {
  for (const ex of allPlanExercises(state.plan)) {
    if (ex.id === exerciseId) return ex;
  }
  for (const key in state.meta) {
    if (!key.startsWith('swaps_')) continue;
    const extra = state.meta[key]?.value?.find(e => e.id === exerciseId);
    if (extra) return extra;
  }
  // Backfilled orphans — named through the review screen, kept in the registry.
  const reg = getRegistry()[exerciseId];
  if (reg?.name) return reg;
  return null;
}

/** The exercise-name registry map ({ id: {id,name,unit,archived} }), or {}. */
function getRegistry() {
  return state.meta[EXERCISE_REGISTRY_KEY]?.value ?? {};
}

/** Insert/merge a registry entry for an id and persist it. */
async function upsertRegistryEntry(id, entry) {
  const doc = state.meta[EXERCISE_REGISTRY_KEY] ?? { key: EXERCISE_REGISTRY_KEY, value: {} };
  doc.value[id] = { id, ...doc.value[id], ...entry };
  await put('meta', doc);
  state.meta[EXERCISE_REGISTRY_KEY] = doc;
}

/** 'reps' | 'seconds' for an exercise id; unknown ids default to 'reps'. */
function getExerciseUnit(exerciseId) {
  return getExerciseDef(exerciseId)?.unit ?? 'reps';
}

/** Formats a logged reps-field value per unit: 8 → '8' (reps) or '45s' (seconds). */
function formatEffort(value, unit) {
  if (value == null) return '?';
  return unit === 'seconds' ? `${value}s` : String(value);
}

function getExerciseName(exerciseId) {
  const def = getExerciseDef(exerciseId);
  if (def?.name?.trim()) return def.name;

  // Legacy swap logs carried the substitute's name on the set record itself.
  const swapLog = state.logs.find(l => l.exerciseId === exerciseId && l.substituteName);
  if (swapLog?.substituteName) return swapLog.substituteName;

  // Newer logs self-describe: the name is stamped on the set at write time.
  const named = state.logs.find(l => l.exerciseId === exerciseId && l.exerciseName);
  if (named?.exerciseName) return named.exerciseName;

  return UNNAMED_EXERCISE_PLACEHOLDER;
}

// ═════════════════════════════════════════════════════════════════════════════
//  HUB — THE DASHBOARD LANDING VIEW
//
//  Pure presentation over data already in the app. No new sources, no coaching
//  inference — every figure here is a deterministic read of the plan, the logs,
//  and the stored Fitdays readings, formatted in the house style established by
//  the body-composition page (shared tokens, shared recomposition chart).
// ═════════════════════════════════════════════════════════════════════════════

/** 'YYYY-MM-DD' offset by a number of days from a base date string. */
function dateStrPlus(baseStr, days) {
  const d = parseDate(baseStr);
  return formatDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));
}

/** Distinct dates that hold at least one done set or a finished marker. */
function sessionDatesSet() {
  const dates = new Set();
  for (const l of state.logs) if (l.done) dates.add(l.date);
  const finishedMap = state.meta[FINISHED_KEY]?.value ?? {};
  for (const d in finishedMap) if (finishedMap[d]) dates.add(d);
  return dates;
}

/** Sessions logged within the current Mon–Sun week. */
function sessionsThisWeek() {
  const dates = sessionDatesSet();
  return state.ui.weekDates.filter(d => dates.has(d)).length;
}

/**
 * Model A weekly target: the number of populated (non-rest) days in the plan —
 * `plan.days` entries with at least one non-archived exercise. Mon/Wed/Fri → 3.
 * Zero populated days ⇒ target 0 ⇒ nothing is ever flagged short.
 */
function weeklyTrainingTarget() {
  let n = 0;
  for (let i = 0; i < 7; i++) {
    const routine = routineForDayIndex(state.plan, i);
    if (routine && activeExercises(routine).length) n++;
  }
  return n;
}

/** Distinct session dates within the Mon–Sun week beginning at `mondayDate`. */
function sessionsInWeek(mondayDate) {
  const dates = sessionDatesSet();
  let n = 0;
  for (let i = 0; i < 7; i++) {
    const ds = formatDate(new Date(mondayDate.getFullYear(), mondayDate.getMonth(), mondayDate.getDate() + i));
    if (dates.has(ds)) n++;
  }
  return n;
}

/** Sessions logged in the current calendar month. */
function sessionsThisMonth() {
  const ym = state.ui.today.slice(0, 7);
  let n = 0;
  for (const d of sessionDatesSet()) if (d.startsWith(ym)) n++;
  return n;
}

/**
 * Consecutive Mon–Sun weeks (ending at the most recent active week) that each
 * hold at least one session. A current week with no session yet does not break
 * the streak — it is counted from last week so a fresh week never reads as zero.
 */
function trainingWeekStreak() {
  const dates = sessionDatesSet();
  if (!dates.size) return 0;

  const weekHasSession = mon => {
    for (let i = 0; i < 7; i++) {
      const ds = formatDate(new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i));
      if (dates.has(ds)) return true;
    }
    return false;
  };

  let mon = getMondayOf(new Date());
  if (!weekHasSession(mon)) mon = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() - 7);

  let streak = 0;
  while (weekHasSession(mon)) {
    streak++;
    mon = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() - 7);
  }
  return streak;
}

// Module 5 (Model A) — a "shortfall" is training fewer sessions in a week than
// the weekly target, summed over the last N COMPLETE Mon–Sun weeks. The specific
// weekday is irrelevant; only the weekly count matters. Purely factual — the app
// states the shortfall, it does not judge whether it was acceptable.
const CONSISTENCY_LOOKBACK_WEEKS = 4;

/**
 * Total session shortfall over the last N complete weeks (the current, still
 * in-progress week is excluded — the user may still train later this week).
 * Each week contributes `max(0, target − sessions)`; a week over target adds 0,
 * never a negative to bank. Zero target ⇒ zero shortfall.
 */
function recentWeeklyShortfall() {
  const target = weeklyTrainingTarget();
  if (target <= 0) return 0;

  const currentMonday = getMondayOf(new Date());
  let total = 0;
  for (let w = 1; w <= CONSISTENCY_LOOKBACK_WEEKS; w++) {
    const mon = new Date(
      currentMonday.getFullYear(), currentMonday.getMonth(), currentMonday.getDate() - 7 * w
    );
    total += Math.max(0, target - sessionsInWeek(mon));
  }
  return total;
}

/**
 * The next thing the plan calls for: today's session if it is a training day
 * that isn't finished yet, otherwise the next training day within two weeks.
 * Returns null when nothing is scheduled (all rest / no plan).
 */
function findNextSession() {
  const finishedMap = state.meta[FINISHED_KEY]?.value ?? {};
  for (let i = 0; i < 14; i++) {
    const date = dateStrPlus(state.ui.today, i);
    const { dayPlan, allExercises } = resolveExercisesForDate(date);
    if (!allExercises.length) continue;               // rest day
    if (i === 0 && finishedMap[date]) continue;       // today already done → look ahead
    return { date, dayPlan, exercises: allExercises, offset: i };
  }
  return null;
}

/** Exercises actually logged (done) on a date, resolved to names. */
function loggedExercisesOnDate(date) {
  const ids = [...new Set(
    state.logs.filter(l => l.date === date && l.done).map(l => l.exerciseId)
  )];
  return ids.map(id => ({ id, name: getExerciseName(id) }));
}

/** The most recent past/today date that has a logged session. */
function findMostRecentSession() {
  const dates = [...sessionDatesSet()].filter(d => d <= state.ui.today).sort();
  const date = dates[dates.length - 1];
  if (!date) return null;
  const { dayPlan } = resolveExercisesForDate(date);
  return { date, dayPlan, exercises: loggedExercisesOnDate(date) };
}

// ── HUB SECTION BUILDERS ─────────────────────────────────────────────────────

/** Relative label for the next-session date. */
function nextSessionWhen(offset, date) {
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  if (offset < 7)   return DAY_NAMES_LONG[dayIndexOf(date)];
  return friendlyDateLabel(date);
}

function buildHubNextUp() {
  const next = findNextSession();

  if (next) {
    const { date, dayPlan, exercises, offset } = next;
    const when = nextSessionWhen(offset, date);
    const name = dayPlan?.sessionName || 'Training session';
    const shown = exercises.slice(0, 4);
    const rest = exercises.length - shown.length;
    const chips = shown
      .map(ex => `<span class="hub-chip">${escHtml(ex.name)}</span>`)
      .join('') + (rest > 0 ? `<span class="hub-chip hub-chip-more">+${rest}</span>` : '');
    const cta = offset === 0 ? 'Start session' : 'Preview session';

    return `
      <button class="card hub-card hub-next" data-hub-action="open-session" data-date="${escHtml(date)}">
        <div class="hub-next-head">
          <span class="hub-eyebrow">${escHtml(when)} · Next up</span>
          <span class="hub-next-count">${exercises.length} exercises</span>
        </div>
        <h2 class="hub-next-title">${escHtml(name)}</h2>
        <div class="hub-chips">${chips}</div>
        <span class="hub-next-cta">${cta}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="9 18 15 12 9 6"/></svg>
        </span>
      </button>`;
  }

  // Nothing scheduled — recap the most recent session, or invite plan setup.
  const recent = findMostRecentSession();
  if (recent) {
    const shown = recent.exercises.slice(0, 4);
    const rest = recent.exercises.length - shown.length;
    const chips = shown
      .map(ex => `<span class="hub-chip">${escHtml(ex.name)}</span>`)
      .join('') + (rest > 0 ? `<span class="hub-chip hub-chip-more">+${rest}</span>` : '');
    return `
      <button class="card hub-card hub-next hub-next-rest" data-hub-action="open-session" data-date="${escHtml(recent.date)}">
        <div class="hub-next-head">
          <span class="hub-eyebrow">Rest day · Last session</span>
          <span class="hub-next-count">${escHtml(friendlyDateLabel(recent.date))}</span>
        </div>
        <h2 class="hub-next-title">${escHtml(recent.dayPlan?.sessionName || 'Session')}</h2>
        <div class="hub-chips">${chips}</div>
        <span class="hub-next-cta">Review
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="9 18 15 12 9 6"/></svg>
        </span>
      </button>`;
  }

  return `
    <button class="card hub-card hub-next hub-next-empty" data-hub-action="open-plan">
      <span class="hub-eyebrow">Welcome to FitTrack</span>
      <h2 class="hub-next-title">Set up your weekly plan</h2>
      <p class="hub-next-sub">Assign sessions to your training days, then log them as you go.</p>
      <span class="hub-next-cta">Build your plan
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="9 18 15 12 9 6"/></svg>
      </span>
    </button>`;
}

function buildHubConsistency() {
  const thisWeek = sessionsThisWeek();
  const streak   = trainingWeekStreak();
  const month    = sessionsThisMonth();

  // Seven compact dots mirroring the week strip's status colours.
  const dots = state.ui.weekDates.map(d => {
    const status = getDayStatus(d);
    return `<span class="hub-dot hub-dot-${status}" title="${escHtml(friendlyDateLabel(d))}"></span>`;
  }).join('');

  // Module 5 (Model A) — weekly shortfall over the last few complete weeks. A
  // week-level fact, not tied to any weekday; shown only when the total is > 0
  // (hit target every week ⇒ no line). The current week never contributes.
  const shortfall = recentWeeklyShortfall();
  const gapsRow = shortfall > 0 ? `
      <div class="hub-gaps">
        <span class="hub-gaps-count">${shortfall} session${shortfall === 1 ? '' : 's'} short</span>
        <span class="hub-gaps-detail">last ${CONSISTENCY_LOOKBACK_WEEKS} weeks</span>
      </div>` : '';

  return `
    <div class="card hub-card hub-consistency">
      <div class="hub-stat-row">
        <div class="hub-stat">
          <span class="hub-stat-value">${thisWeek}</span>
          <span class="hub-stat-label">This week</span>
        </div>
        <div class="hub-stat">
          <span class="hub-stat-value">${streak}<span class="hub-stat-unit">wk</span></span>
          <span class="hub-stat-label">Streak</span>
        </div>
        <div class="hub-stat">
          <span class="hub-stat-value">${month}</span>
          <span class="hub-stat-label">This month</span>
        </div>
      </div>
      <div class="hub-week-dots" role="img" aria-label="${thisWeek} sessions logged this week">${dots}</div>
      ${gapsRow}
    </div>`;
}

function buildHubBody(days) {
  if (!days.length) {
    return `
      <button class="card hub-card hub-body-empty" data-hub-action="import">
        <div class="hub-body-empty-icon" aria-hidden="true">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 17l5.5-6 4 4L21 6"/><path d="M15 6h6v6"/></svg>
        </div>
        <div class="hub-body-empty-text">
          <span class="hub-card-title">Body composition</span>
          <span class="hub-body-empty-sub">Import a Fitdays export to track weight, body fat and recomposition.</span>
        </div>
        <span class="hub-body-empty-cta">Import</span>
      </button>`;
  }

  const latest = days[days.length - 1];
  const prev   = days.length > 1 ? days[days.length - 2] : null;
  const since  = prev?.date ?? null;

  // Freshness line — display only: whole days since the most recent reading,
  // stated as a fact and accented only once it passes the stale threshold. It
  // never judges the gap, extrapolates across it, or discounts the chart.
  const daysAgo = daysBetweenDates(latest.date, state.ui.today);
  const staleReading = daysAgo >= BODY_COMP_STALE_DAYS;
  const freshnessLabel = daysAgo <= 0 ? 'Last reading today'
    : daysAgo === 1 ? 'Last reading yesterday'
    : `Last reading ${daysAgo} days ago`;

  return `
    <div class="card hub-card hub-body">
      <div class="hub-card-head">
        <span class="hub-card-title">Body composition</span>
        <span class="hub-card-meta">${escHtml(bcLongDate(latest.date))}</span>
      </div>
      <p class="hub-body-freshness${staleReading ? ' hub-body-freshness-stale' : ''}">${escHtml(freshnessLabel)}</p>
      <div class="hub-body-figures">
        <div class="hub-figure">
          <span class="hub-figure-label">Weight</span>
          <span class="hub-figure-value">${bcFmt(latest.weight)}<span class="hub-figure-unit">kg</span></span>
          ${bcDeltaBadge(latest.weight, prev?.weight, 1, 'kg', since)}
        </div>
        <div class="hub-figure">
          <span class="hub-figure-label">Body fat</span>
          <span class="hub-figure-value">${bcFmt(latest.bodyFat)}<span class="hub-figure-unit">%</span></span>
          ${bcDeltaBadge(latest.bodyFat, prev?.bodyFat, 1, '%', since)}
        </div>
      </div>
      <div class="hub-body-split">
        <div class="hub-split-item">
          <span class="bc-swatch bc-swatch-lean" aria-hidden="true"></span>
          <span class="hub-split-label">Lean</span>
          <span class="hub-split-value">${bcFmt(latest.leanMass)} kg</span>
          ${bcDeltaBadge(latest.leanMass, prev?.leanMass, 1, 'kg', null)}
        </div>
        <div class="hub-split-item">
          <span class="bc-swatch bc-swatch-fat" aria-hidden="true"></span>
          <span class="hub-split-label">Fat</span>
          <span class="hub-split-value">${bcFmt(latest.fatMass)} kg</span>
          ${bcDeltaBadge(latest.fatMass, prev?.fatMass, 1, 'kg', null)}
        </div>
      </div>
    </div>`;
}

function buildHubPRs() {
  // Module 1 — records on the spec metric: estimated-1RM for compounds, top
  // weight for isolation, longest hold for timed work. Computed in insights.js.
  const prs = computeRecentPRs(state, { today: state.ui.today });
  const inner = prs.length
    ? prs.map(pr => `
        <div class="hub-pr-row">
          <span class="hub-pr-name">${escHtml(pr.name)}</span>
          <span class="hub-pr-value">${escHtml(pr.display.value)}${
            pr.display.note ? ` <span class="hub-pr-metric">${escHtml(pr.display.note)}</span>` : ''
          }</span>
          <span class="hub-pr-date">${escHtml(friendlyDateLabel(pr.date))}</span>
        </div>`).join('')
    : `<p class="hub-pr-empty">No records in the last month. Log a heavy set to start setting them.</p>`;

  return `
    <div class="card hub-card hub-prs">
      <div class="hub-card-head">
        <span class="hub-card-title">Recent PRs</span>
        ${prs.length ? '<span class="hub-card-meta">last 30 days</span>' : ''}
      </div>
      <div class="hub-pr-list">${inner}</div>
    </div>`;
}

/**
 * Module 2 — exercises with no progression-metric gain across the threshold
 * window. A factual flag only: which lift, how many sessions flat, and since
 * when. No suggestion — that reading is Claude's job. Renders nothing (and so
 * stays out of the way) when there is nothing to flag.
 */
function buildHubPlateaus() {
  const flags = computePlateaus(state);
  if (!flags.length) return '';

  const rows = flags.map(f => `
    <div class="hub-pr-row hub-plateau-row">
      <span class="hub-pr-name">${escHtml(f.name)}</span>
      <span class="hub-plateau-flag">no ${escHtml(f.metricLabel)} gain</span>
      <span class="hub-pr-date">${f.sessions} sessions</span>
    </div>`).join('');

  return `
    <div class="card hub-card hub-plateaus">
      <div class="hub-card-head">
        <span class="hub-card-title">Plateaus</span>
        <span class="hub-card-meta">no recent gain</span>
      </div>
      <div class="hub-pr-list">${rows}</div>
    </div>`;
}

/**
 * Addition 6 — a quiet "last backup" recency card. Its only computation is
 * (today − lastBackupDate) in whole days, compared against LAST_BACKUP_STALE_DAYS.
 * Neutral by default; the days count takes an attention accent only once stale;
 * a first-run invitation when nothing has ever been backed up. It states the
 * fact — never a command — and tapping it runs the export.
 */
function buildHubLastBackup() {
  const last = state.meta[LAST_BACKUP_KEY]?.value;

  // First run — no backup ever recorded: a calm invitation, like other empty
  // states, not a warning.
  if (!last) {
    return `
      <button class="card hub-card hub-backup" data-hub-action="export">
        <div class="hub-card-head">
          <span class="hub-card-title">Backup</span>
        </div>
        <p class="hub-backup-line">No backup yet — tap to save an off-device copy.</p>
      </button>`;
  }

  const days  = daysBetweenDates(last, state.ui.today);
  const stale = days >= LAST_BACKUP_STALE_DAYS;
  const label = days <= 0 ? 'Last backup today'
    : days === 1 ? 'Last backup yesterday'
    : `Last backup ${days} days ago`;

  return `
    <button class="card hub-card hub-backup" data-hub-action="export">
      <div class="hub-card-head">
        <span class="hub-card-title">Backup</span>
        <span class="hub-card-meta">${escHtml(friendlyDateLabel(last))}</span>
      </div>
      <p class="hub-backup-line${stale ? ' hub-backup-stale' : ''}">${escHtml(label)}</p>
    </button>`;
}

function buildHubQuickActions() {
  const action = (act, label, path) => `
    <button class="hub-action" data-hub-action="${act}">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>
      <span>${label}</span>
    </button>`;

  return `
    <div class="hub-actions">
      ${action('log', 'Log session', '<path d="M12 5v14"/><path d="M5 12h14"/>')}
      ${action('import', 'Import scale', '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>')}
      ${action('export', 'Back up', '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>')}
    </div>`;
}

function renderHub() {
  const host = document.getElementById('hub-content');
  if (!host) return;

  const days = toDailySeries(state.bodyComposition);

  host.innerHTML =
    buildHubNextUp() +
    buildHubConsistency() +
    buildHubBody(days) +
    buildHubPRs() +
    buildHubPlateaus() +
    buildHubLastBackup() +
    buildHubQuickActions();

  wireHub();
}

/** Delegated wiring for every hub card and quick action. */
function wireHub() {
  const host = document.getElementById('hub-content');
  host.querySelectorAll('[data-hub-action]').forEach(el => {
    el.addEventListener('click', () => {
      switch (el.dataset.hubAction) {
        case 'open-session':
          state.ui.viewedDate = el.dataset.date || state.ui.today;
          state.ui.expandedExerciseId = null;
          switchView('today');
          break;
        case 'open-plan':  switchView('plan');     break;
        case 'open-body':  switchView('body');     break;
        case 'log':
          state.ui.viewedDate = state.ui.today;
          switchView('today');
          break;
        case 'import':     document.getElementById('bc-import-input')?.click(); break;
        case 'export':     handleExport();         break;
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  TODAY TAB — RENDER
// ─────────────────────────────────────────────────────────────────────────────

function renderToday() {
  stopDurationTimer(); // the timed row's DOM is about to be rebuilt
  const viewDate = state.ui.viewedDate || state.ui.today;
  const isFutureDate = viewDate > state.ui.today;
  const { dayPlan, activeEx, extras, allExercises } = resolveExercisesForDate(viewDate);
  const hasContent = activeEx.length > 0 || extras.length > 0;
  // dayPlan is null on a rest day (no routine assigned/rescheduled here) — but
  // "Train anyway" adds a session-scoped extra to a rest day WITHOUT a routine,
  // so hasContent alone must decide isRest. Gating on dayPlan too (the old
  // condition) hid that added exercise forever: it was correctly written to
  // swaps_<date> (which is why re-adding it said "already in this session"),
  // it just never rendered.
  const isRest   = !hasContent;
  const finished = !!(state.meta[FINISHED_KEY]?.value?.[viewDate]);

  // Viewing-a-different-date banner
  const banner = document.getElementById('viewing-date-banner');
  if (viewDate === state.ui.today) {
    banner.hidden = true;
  } else {
    banner.hidden = false;
    document.getElementById('viewing-date-text').textContent =
      `Viewing ${friendlyDateLabel(viewDate)}${isFutureDate ? ' (upcoming)' : ''}`;
  }

  const sessionOverview = document.getElementById('session-overview');
  const restDayCard     = document.getElementById('rest-day-card');
  const noPlanCard      = document.getElementById('no-plan-card');
  const exerciseStack   = document.getElementById('exercise-stack');
  const finishRow       = document.getElementById('finish-session-row');
  const addExerciseRow  = document.getElementById('add-exercise-row');

  if (!state.plan) {
    sessionOverview.hidden  = true;
    restDayCard.hidden      = true;
    noPlanCard.hidden       = false;
    exerciseStack.innerHTML = '';
    finishRow.hidden        = true;
    addExerciseRow.hidden   = true;
    document.getElementById('reschedule-bar').hidden = true;
    return;
  }

  renderRescheduleBar(viewDate);

  if (isRest) {
    sessionOverview.hidden  = true;
    restDayCard.hidden      = false;
    noPlanCard.hidden       = true;
    exerciseStack.innerHTML = '';
    finishRow.hidden        = true;
    addExerciseRow.hidden   = true;
    document.getElementById('train-anyway-btn').hidden = isFutureDate;
    return;
  }

  restDayCard.hidden = true;
  noPlanCard.hidden  = true;

  // Session progress counters
  sessionOverview.hidden = false;
  // dayPlan is null when the date has no routine (a rest day carrying only
  // session-scoped extras from "Train anyway") — its exercises still need a
  // session header.
  document.getElementById('session-name').textContent =
    dayPlan?.sessionName || 'Extra Session';

  // Session-level note (one per training day, keyed by date in meta). Populated
  // from the viewed date so a past session shows that day's note; the input's
  // dataset.date tells the (once-wired) blur handler which key to write.
  const sessionNoteInput = document.getElementById('session-note-input');
  sessionNoteInput.value = state.meta[`sessionNote_${viewDate}`]?.value ?? '';
  sessionNoteInput.dataset.date = viewDate;
  sessionNoteInput.disabled = isFutureDate;

  const completedCount = allExercises.filter(ex =>
    isExerciseComplete(ex.id, viewDate, ex.sets)
  ).length;
  const totalCount = allExercises.length;

  document.getElementById('session-progress-text').textContent =
    `${completedCount} / ${totalCount} exercises`;
  document.getElementById('session-progress-bar').style.width =
    totalCount > 0 ? `${Math.round((completedCount / totalCount) * 100)}%` : '0%';

  // Rebuild exercise cards — read-only for future dates, nothing to log yet.
  // Exercises the routine pairs into a superset are wrapped together under one
  // label, so "do these back-to-back" is visible while training rather than
  // only while planning. One-off session extras never join a pair.
  const units = supersetUnits(activeEx);
  let stackHTML = '';
  for (const unit of units) {
    const cards = unit
      .map(i => buildExerciseCardHTML(activeEx[i], viewDate, { readOnly: isFutureDate }))
      .join('');
    stackHTML += unit.length > 1
      ? `<div class="ss-group">${SUPERSET_LABEL_HTML}${cards}</div>`
      : cards;
  }
  stackHTML += extras
    .map(ex => buildExerciseCardHTML(ex, viewDate, { readOnly: isFutureDate }))
    .join('');
  exerciseStack.innerHTML = stackHTML;
  wireExerciseCards(allExercises, viewDate);

  // Show finish button if any sets are done and session isn't already finished
  const doneLogsOnDate = state.logs.filter(l => l.date === viewDate && l.done);
  finishRow.hidden = finished || isFutureDate || doneLogsOnDate.length === 0;

  // Session-level "add exercise" action — not available for rest/future/no-plan
  addExerciseRow.hidden = isFutureDate;
  document.getElementById('add-exercise-btn').onclick = () => handleAddExercise(viewDate);
}

// ─────────────────────────────────────────────────────────────────────────────
//  TODAY TAB — EXERCISE CARD HTML BUILDER
// ─────────────────────────────────────────────────────────────────────────────

function buildExerciseCardHTML(ex, date, { readOnly = false } = {}) {
  const unit      = ex.unit ?? 'reps';
  const loadType  = ex.loadType ?? getExerciseLoadType(ex.id) ?? (unit === 'seconds' ? 'timed' : 'reps');
  const isTimed   = loadType === 'timed';
  const isSeconds = isTimed; // effort is measured in seconds for timed work
  const effortUnit = isTimed ? 'seconds' : 'reps';
  // Per-type load column: weighted logs external weight, bodyweight an optional
  // added load, assisted the machine assistance. Timed and rep-only work show
  // no load column at all — reusing the `weight` field per its loadType.
  const LOAD_COLUMNS = {
    weighted:   { label: 'kg',     placeholder: 'kg',  aria: 'Weight kg' },
    bodyweight: { label: '+kg',    placeholder: '+kg', aria: 'Added load kg' },
    assisted:   { label: 'Assist', placeholder: '−kg', aria: 'Assistance kg' },
  };
  const loadCol   = LOAD_COLUMNS[loadType] ?? null;
  const hasLoad   = !!loadCol;
  const rowVariant = hasLoad ? '' : (isTimed ? ' set-row-timed' : ' set-row-repsonly');
  const headVariant = hasLoad ? '' : (isTimed ? ' sets-header-timed' : ' sets-header-repsonly');
  const prevLogs  = getRecentLogsForExercise(ex.id, date);
  const pr        = getExercisePR(state, ex.id, { name: ex.name, unit, loadType });
  const complete  = isExerciseComplete(ex.id, date, ex.sets);
  const expanded  = state.ui.expandedExerciseId === ex.id;

  // PR metric matches the hub: e1RM for compounds, top weight for isolation,
  // longest hold for timed work — resolved centrally in insights.js.
  const prBadge = pr
    ? `<span class="ex-pr-badge">PR&nbsp;${escHtml(pr.display.value)}${
        pr.display.note ? `&nbsp;${escHtml(pr.display.note)}` : ''
      }</span>`
    : '';

  const originTag = ex.isAdded
    ? '<span class="ex-origin-tag">Added</span>'
    : ex.isSwap
      ? '<span class="ex-origin-tag">Swapped</span>'
      : '';

  const disabledAttr = readOnly ? 'disabled' : '';

  // The "Previous" reference reads per loadType: weighted 'kg×reps', bodyweight
  // '+kg×reps' (or bare reps when unloaded), assisted '−kg×reps', timed '45s',
  // rep-only bare reps.
  const prevRef = (prev) => {
    if (!prev) return '—';
    const r = prev.reps ?? '?';
    if (isTimed) return formatEffort(prev.reps, 'seconds');
    if (loadType === 'weighted')   return `${prev.weight ?? '?'}×${r}`;
    if (loadType === 'bodyweight') return prev.weight != null ? `+${prev.weight}×${r}` : `${r} reps`;
    if (loadType === 'assisted')   return prev.weight != null ? `−${prev.weight}×${r}` : `${r} reps`;
    return `${r} reps`;
  };

  const setsRows = Array.from({ length: ex.sets }, (_, i) => {
    const log   = getExistingLog(date, ex.id, i);
    const prev  = prevLogs.find(l => l.setIndex === i);
    const done  = log?.done ?? false;

    // Timed sets get a start/stop timer that fills the seconds input
    const timerBtn = isTimed ? `
        <button class="set-timer"
                aria-label="Start timer for set ${i + 1}"
                aria-pressed="false"
                data-ex-id="${escHtml(ex.id)}" data-set-index="${i}"
                ${disabledAttr}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <polygon points="6 4 20 12 6 20"/>
          </svg>
        </button>` : '';

    // Load input only for loaded types (weighted / bodyweight / assisted).
    const loadInput = hasLoad ? `
        <input class="set-input set-weight"
               type="number" inputmode="decimal" step="0.5" min="0"
               placeholder="${escHtml(loadCol.placeholder)}"
               value="${log?.weight ?? ''}"
               aria-label="${escHtml(loadCol.aria)}, set ${i + 1}"
               data-field="weight" data-ex-id="${escHtml(ex.id)}" data-set-index="${i}"
               ${disabledAttr} />` : '';

    // Previous-session reference lives OUTSIDE the input grid now: a quiet line
    // above the inputs, given full row width so "80 × 8 last time" is never
    // crushed to an ellipsis. Absent history renders nothing (no em-dash column).
    const prevLine = prev
      ? `<span class="set-prev-label">last: ${escHtml(prevRef(prev))}</span>`
      : '';

    return `
      <div class="set-entry">
        ${prevLine}
        <div class="set-row${rowVariant}${done ? ' set-logged' : ''}"
             data-ex-id="${escHtml(ex.id)}" data-set-index="${i}">
        <span class="set-num">${i + 1}</span>
        ${loadInput}
        <input class="set-input set-reps"
               type="number" inputmode="numeric" min="1"
               placeholder="${escHtml(String(ex.reps))}"
               value="${log?.reps ?? ''}"
               aria-label="${isTimed ? 'Seconds' : 'Reps'}, set ${i + 1}"
               data-field="reps" data-ex-id="${escHtml(ex.id)}" data-set-index="${i}"
               ${disabledAttr} />
        <input class="set-input set-rpe"
               type="number" inputmode="decimal" step="0.5" min="${RPE_MIN}" max="${RPE_MAX}"
               placeholder="RPE"
               value="${log?.rpe ?? ''}"
               aria-label="RPE (optional), set ${i + 1}"
               data-field="rpe" data-ex-id="${escHtml(ex.id)}" data-set-index="${i}"
               ${disabledAttr} />
        ${timerBtn}
        <button class="set-check"
                aria-label="Mark set ${i + 1} done"
                aria-pressed="${done}"
                data-ex-id="${escHtml(ex.id)}" data-set-index="${i}"
                ${disabledAttr}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2.5"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </button>
        </div>
      </div>`;
  }).join('');

  // Notes from set-0 log entry
  const notesVal = state.logs.find(
    l => l.exerciseId === ex.id && l.date === date && l.setIndex === 0
  )?.notes ?? '';

  // What the routine's progression rule calls for this session, and the reason
  // in plain words. Read-only: it fills an empty input when a set is checked
  // (see handleSetCheck) and never overwrites anything already typed or logged.
  const rx = readOnly ? null : prescriptionForExercise(ex, date);
  const rxLabel = rx ? prescriptionLabel(rx, ex) : '';
  const prescriptionBlock = (rx && rx.kind !== 'off' && rxLabel)
    ? `<div class="rx-hint rx-${rx.kind}">
         <span class="rx-target">${escHtml(rxLabel)}</span>
         <span class="rx-why">${escHtml(rx.why ?? '')}</span>
       </div>`
    : '';

  const metaBlock = (ex.muscles || ex.cue)
    ? `<div class="exercise-meta-block">
        ${ex.muscles ? `<span class="exercise-muscles">${escHtml(ex.muscles)}</span>` : ''}
        ${ex.cue     ? `<p class="exercise-cue">${escHtml(ex.cue)}</p>`               : ''}
       </div>`
    : '';

  // Reference + progress detail — offered only when there's something to show
  // (a mapped reference entry or logged history). Unmapped, un-logged exercises
  // simply get no button — correct, not an error.
  const detailBtn = hasExerciseDetail(ex.id)
    ? `<button class="exercise-detail-btn" data-ex-id="${escHtml(ex.id)}" data-ex-name="${escHtml(ex.name)}">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9"/><line x1="12" y1="10" x2="12" y2="16"/>
          <circle cx="12" cy="7.5" r="0.6" fill="currentColor"/></svg>
        Reference &amp; progress
      </button>`
    : '';

  const actionsRow = readOnly ? '' : `
        <div class="exercise-actions-row">
          <button class="btn-ghost remove-ex-btn"
                  data-ex-id="${escHtml(ex.id)}"
                  data-ex-name="${escHtml(ex.name)}">
            ✕ Remove from session
          </button>
        </div>`;

  const cardHTML = `
    <div class="card exercise-card${complete ? ' exercise-complete' : ''}"
         data-exercise-id="${escHtml(ex.id)}">
      <button class="exercise-header" aria-expanded="${expanded}">
        <span class="exercise-done-check">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="3"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </span>
        <span class="exercise-name">${escHtml(ex.name)}</span>
        <span class="exercise-summary">${ex.sets}×${escHtml(formatEffort(ex.reps, effortUnit))}</span>
        ${originTag}
        ${prBadge}
        <svg class="chevron-icon" width="16" height="16" viewBox="0 0 24 24"
             fill="none" stroke="currentColor" stroke-width="2.5"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      <div class="exercise-body${expanded ? ' expanded' : ''}">
        ${metaBlock}
        ${prescriptionBlock}
        ${detailBtn}
        <div class="sets-table">
          <div class="sets-table-header${headVariant}">
            <span>Set</span>
            ${hasLoad ? `<span>${escHtml(loadCol.label)}</span>` : ''}
            <span>${isTimed ? 'Sec' : 'Reps'}</span><span>RPE</span>${isTimed ? '<span></span>' : ''}<span></span>
          </div>
          ${setsRows}
        </div>
        <div class="exercise-notes-row">
          <input class="notes-input"
                 type="text"
                 placeholder="Notes (optional)"
                 value="${escHtml(notesVal)}"
                 aria-label="Notes for ${escHtml(ex.name)}"
                 data-ex-id="${escHtml(ex.id)}"
                 ${disabledAttr} />
        </div>
        ${actionsRow}
      </div>
    </div>`;

  // Read-only (future) dates aren't editable, so they aren't swipeable either.
  if (readOnly) return cardHTML;

  // Swipe-to-delete: the card sits above a delete action revealed by a
  // left-swipe. The same delete is also reachable via the in-card button and
  // the plan editor, so the gesture is never the only way to remove.
  return `
    <div class="exercise-swipe" data-exercise-id="${escHtml(ex.id)}">
      <div class="exercise-swipe-action" aria-hidden="true">
        <button class="swipe-delete-btn"
                tabindex="-1"
                aria-label="Delete ${escHtml(ex.name)} from this session"
                data-ex-id="${escHtml(ex.id)}"
                data-ex-name="${escHtml(ex.name)}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
          <span>Delete</span>
        </button>
      </div>
      ${cardHTML}
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  TODAY TAB — WIRE EXERCISE CARD EVENTS
// ─────────────────────────────────────────────────────────────────────────────

function wireExerciseCards(exercises, date) {
  const stack = document.getElementById('exercise-stack');

  // Accordion toggle — direct manipulation, no re-render
  stack.querySelectorAll('.exercise-header').forEach(header => {
    header.addEventListener('click', () => {
      const card   = header.closest('.exercise-card');
      const exId   = card.dataset.exerciseId;
      const body   = card.querySelector('.exercise-body');
      const isOpen = header.getAttribute('aria-expanded') === 'true';

      if (!isOpen) {
        // Close any currently open card
        stack.querySelectorAll('.exercise-header[aria-expanded="true"]').forEach(h => {
          h.setAttribute('aria-expanded', 'false');
          h.closest('.exercise-card')
           .querySelector('.exercise-body')
           .classList.remove('expanded');
        });
        header.setAttribute('aria-expanded', 'true');
        body.classList.add('expanded');
        state.ui.expandedExerciseId = exId;
      } else {
        header.setAttribute('aria-expanded', 'false');
        body.classList.remove('expanded');
        state.ui.expandedExerciseId = null;
      }
    });
  });

  // Restore or auto-assign expanded card
  if (state.ui.expandedExerciseId) {
    const card = stack.querySelector(
      `.exercise-card[data-exercise-id="${state.ui.expandedExerciseId}"]`
    );
    if (card) {
      card.querySelector('.exercise-header').setAttribute('aria-expanded', 'true');
      card.querySelector('.exercise-body').classList.add('expanded');
    }
  } else {
    // Auto-open the first incomplete exercise
    for (const ex of exercises) {
      if (!isExerciseComplete(ex.id, date, ex.sets)) {
        const card = stack.querySelector(`.exercise-card[data-exercise-id="${ex.id}"]`);
        if (card) {
          card.querySelector('.exercise-header').setAttribute('aria-expanded', 'true');
          card.querySelector('.exercise-body').classList.add('expanded');
          state.ui.expandedExerciseId = ex.id;
        }
        break;
      }
    }
  }

  // Set check buttons — targeted DOM update only, no full re-render
  stack.querySelectorAll('.set-check').forEach(btn => {
    btn.addEventListener('click', () =>
      handleSetCheck(
        btn.dataset.exId,
        parseInt(btn.dataset.setIndex, 10),
        date
      )
    );
  });

  // Stopwatch buttons on seconds-based sets
  stack.querySelectorAll('.set-timer').forEach(btn => {
    btn.addEventListener('click', () => handleDurationTimerClick(btn, date));
  });

  // Reference & progress detail — opens the read-only overlay
  stack.querySelectorAll('.exercise-detail-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openExerciseDetail(btn.dataset.exId, btn.dataset.exName);
    });
  });

  // Weight / reps inputs — persist on blur so re-renders don't lose values
  stack.querySelectorAll('.set-input').forEach(input => {
    input.addEventListener('blur', () => {
      const exId     = input.dataset.exId;
      const setIndex = parseInt(input.dataset.setIndex, 10);
      const field    = input.dataset.field;
      const raw      = input.value.trim();
      if (!raw) return;
      const num = parseFloat(raw);
      if (isNaN(num) || num < 0) return;
      if (field === 'rpe') {
        // Store only within the sane RPE domain, snapped to 0.5. Out-of-range
        // input is silently not stored — never an error, and blank stays valid.
        if (num < RPE_MIN || num > RPE_MAX) return;
        writeLog(date, exId, setIndex, { rpe: Math.round(num * 2) / 2 });
        return;
      }
      const val = field === 'reps' ? Math.round(num) : num;
      writeLog(date, exId, setIndex, { [field]: val });
    });
  });

  // Notes — persist on blur against set-index 0
  stack.querySelectorAll('.notes-input').forEach(input => {
    input.addEventListener('blur', () => {
      const exId = input.dataset.exId;
      if (!input.value.trim() && !getExistingLog(date, exId, 0)) return;
      writeLog(date, exId, 0, { notes: input.value.trim() });
    });
  });

  // Remove-from-session buttons (non-swipe control) and swipe delete actions
  stack.querySelectorAll('.remove-ex-btn, .swipe-delete-btn').forEach(btn => {
    btn.addEventListener('click', () =>
      handleRemoveExercise(btn.dataset.exId, btn.dataset.exName, date)
    );
  });

  // Left-swipe reveal on each card
  stack.querySelectorAll('.exercise-swipe').forEach(wireSwipeToDelete);
}

/**
 * Wires a single card's left-swipe reveal. Pointer Events cover both touch and
 * mouse. Only a clearly horizontal drag past the reveal width opens the delete
 * action; a mostly-vertical drag scrolls the page, and a plain tap still falls
 * through to the accordion. A swipe that opened suppresses the trailing click.
 */
function wireSwipeToDelete(wrap) {
  const card       = wrap.querySelector('.exercise-card');
  const REVEAL     = 88;   // px — width of the delete action
  const AXIS_LOCK  = 10;   // px moved before we commit to an axis
  let startX = 0, startY = 0, dragging = false, axis = null, base = 0, swiped = false;

  const setX = x => { card.style.transform = `translateX(${x}px)`; };
  const openCard  = () => { setX(-REVEAL); wrap.classList.add('swipe-open'); };
  const closeCard = () => { setX(0); wrap.classList.remove('swipe-open'); };

  card.addEventListener('pointerdown', e => {
    if (e.target.closest('input, select, textarea')) return; // let fields work
    startX = e.clientX; startY = e.clientY;
    base = wrap.classList.contains('swipe-open') ? -REVEAL : 0;
    dragging = true; axis = null; swiped = false;
    card.style.transition = 'none';
  });

  card.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (axis === null) {
      if (Math.abs(dx) < AXIS_LOCK && Math.abs(dy) < AXIS_LOCK) return;
      axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (axis === 'x') { try { card.setPointerCapture(e.pointerId); } catch {} }
    }
    if (axis !== 'x') return;         // vertical → leave scrolling alone
    e.preventDefault();
    const next = Math.max(-REVEAL, Math.min(0, base + dx));
    setX(next);
    if (Math.abs(next) > 4) swiped = true;
  });

  const finish = () => {
    if (!dragging) return;
    dragging = false;
    card.style.transition = '';
    if (axis === 'x') {
      const open = (parseFloat(card.style.transform.replace(/[^-\d.]/g, '')) || 0) <= -REVEAL / 2;
      open ? openCard() : closeCard();
    }
  };
  card.addEventListener('pointerup', finish);
  card.addEventListener('pointercancel', finish);

  // Swallow the click that a swipe would otherwise deliver to the accordion.
  card.addEventListener('click', e => {
    if (swiped) { e.preventDefault(); e.stopPropagation(); swiped = false; }
  }, true);
}

// ─────────────────────────────────────────────────────────────────────────────
//  TODAY TAB — EVENT HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

async function handleSetCheck(exerciseId, setIndex, date) {
  const log     = getExistingLog(date, exerciseId, setIndex);
  const wasDone = log?.done ?? false;
  const newDone = !wasDone;

  const { allExercises: allPlannedEx } = resolveExercisesForDate(date);
  const exDef = allPlannedEx.find(e => e.id === exerciseId);
  const loadType = getExerciseLoadType(exerciseId)
    ?? (getExerciseUnit(exerciseId) === 'seconds' ? 'timed' : 'reps');
  // Weight is a meaningful, repeating input only for these two types; for
  // bodyweight/reps/timed the `weight` field is optional load (or unused), so
  // it must not be auto-filled — that would re-leak a prior value into it.
  const loadIsMeaningful = loadType === 'weighted' || loadType === 'assisted';

  // Read the live DOM inputs before saving so unsaved keystrokes aren't lost
  const setRow = document.querySelector(
    `.set-row[data-ex-id="${exerciseId}"][data-set-index="${setIndex}"]`
  );
  const wRaw = setRow?.querySelector('.set-weight')?.value;
  const rRaw = setRow?.querySelector('.set-reps')?.value;
  let wVal = wRaw ? parseFloat(wRaw) || log?.weight || null : log?.weight ?? null;
  let rVal = rRaw ? parseInt(rRaw)   || log?.reps   || null : log?.reps   ?? null;

  // Checking a set with empty inputs auto-fills from the previous session
  // (falling back to the plan's rep target) — most sets repeat last week's
  // numbers, and a null weight would break PRs, volume, and history.
  if (newDone) {
    const prevLogs = getRecentLogsForExercise(exerciseId, date);
    const prev = prevLogs.find(p => p.setIndex === setIndex)
      ?? prevLogs[prevLogs.length - 1]
      ?? null;
    // A set already done today outranks last session — it reflects today's
    // actual working weight (and covers first-ever sessions with no history)
    const sameDaySets = state.logs
      .filter(l => l.exerciseId === exerciseId && l.date === date && l.done && l.setIndex !== setIndex)
      .sort((a, b) => a.setIndex - b.setIndex);
    const sameDay = sameDaySets[sameDaySets.length - 1] ?? null;
    // The progression rule sits BETWEEN today's own sets and last session: a
    // set already done today still wins (it is what is actually on the bar),
    // but otherwise the rule's number beats simply repeating last week.
    const rx = exDef ? prescriptionForExercise(exDef, date) : null;
    const rxWeight = (rx && rx.kind !== 'off' && rx.kind !== 'first') ? rx.weight : null;
    const rxReps   = (rx && rx.kind !== 'off' && rx.kind !== 'first') ? rx.reps   : null;
    if (wVal == null && loadIsMeaningful) wVal = sameDay?.weight ?? rxWeight ?? prev?.weight ?? null;
    if (rVal == null) rVal = sameDay?.reps ?? rxReps ?? prev?.reps ?? (parseInt(exDef?.reps, 10) || null);
  }

  await writeLog(date, exerciseId, setIndex, { weight: wVal, reps: rVal, done: newDone });

  // Start the rest countdown the moment a set is marked done
  if (newDone) startRestTimer();
  else stopRestTimer();

  // Immediate PB surfacing — check the moment a set is marked done. A record is
  // rankable whenever the effort (reps or seconds) is present; weight is only
  // required for weighted work, which checkForNewPB handles per loadType.
  let isPR = false;
  if (newDone && rVal != null) {
    const pbMessage = await checkForNewPB(state, exerciseId, getExerciseName(exerciseId), loadType, date);
    if (pbMessage) { isPR = true; showToast(pbMessage, 4000); }
  }

  // Targeted DOM update — avoids clearing any other set's live input values
  if (setRow) {
    setRow.classList.toggle('set-logged', newDone);
    const checkBtn = setRow.querySelector('.set-check');
    if (checkBtn) checkBtn.setAttribute('aria-pressed', String(newDone));

    // Show any auto-filled values so the user sees what was logged
    if (newDone) {
      const wInput = setRow.querySelector('.set-weight');
      const rInput = setRow.querySelector('.set-reps');
      if (wInput && !wInput.value && wVal != null) wInput.value = wVal;
      if (rInput && !rInput.value && rVal != null) rInput.value = rVal;

      // Feedback for the single most-repeated action: a crisp haptic tap and a
      // one-shot confirming settle on the row (removed after so a later full
      // re-render never replays it). A PR earns a distinctly stronger moment —
      // a double-tap and one cyan glow pulse. Un-checking gets neither.
      haptic(isPR ? [15, 40, 15] : 15);
      setRow.classList.add('set-just-logged');
      setTimeout(() => setRow.classList.remove('set-just-logged'), 220);
      if (isPR) {
        setRow.classList.add('set-pr-flash');
        setTimeout(() => setRow.classList.remove('set-pr-flash'), 420);
      }
    }
  }

  // Update exercise card's overall completion marker
  const totalSets = exDef?.sets ?? setIndex + 1;
  const complete  = isExerciseComplete(exerciseId, date, totalSets);
  const card = document.querySelector(`.exercise-card[data-exercise-id="${exerciseId}"]`);
  if (card) card.classList.toggle('exercise-complete', complete);

  // Update session progress bar
  const completedCount = allPlannedEx.filter(ex =>
    isExerciseComplete(ex.id, date, ex.sets)
  ).length;
  const totalCount = allPlannedEx.length;
  document.getElementById('session-progress-text').textContent =
    `${completedCount} / ${totalCount} exercises`;
  document.getElementById('session-progress-bar').style.width =
    totalCount > 0 ? `${Math.round((completedCount / totalCount) * 100)}%` : '0%';

  // Show finish button as soon as any set is logged
  const doneLogsToday = state.logs.filter(l => l.date === date && l.done);
  const finished = !!(state.meta[FINISHED_KEY]?.value?.[date]);
  const finishRow = document.getElementById('finish-session-row');
  if (finishRow) finishRow.hidden = finished || doneLogsToday.length === 0;

  // Week strip may transition from 'today' → 'inprogress'
  renderWeekStrip();
}

async function handleFinishSession(date) {
  const doneLogs = state.logs.filter(l => l.date === date && l.done);
  if (!doneLogs.length) {
    showToast('Log at least one set before finishing.');
    return;
  }

  const finishedDoc = state.meta[FINISHED_KEY] ?? { key: FINISHED_KEY, value: {} };
  finishedDoc.value[date] = true;
  await put('meta', finishedDoc);
  state.meta[FINISHED_KEY] = finishedDoc;

  stopRestTimer();
  document.getElementById('finish-session-row').hidden = true;
  renderWeekStrip();
  showToast(
    date === state.ui.today
      ? 'Session complete! Great work.'
      : `${friendlyDateLabel(date)} marked complete.`
  );
}

/**
 * Every exercise definition ever created — recurring plan (archived
 * included, so long-gone exercises still autocomplete) plus all session-
 * scoped swap/add extras across every date. Deduplicated by name
 * (case-insensitive): the first definition seen per name wins, so an
 * exercise logged many times appears exactly once. Sorted A→Z.
 */
function buildKnownExerciseList() {
  const seen = new Map(); // lowercased name → definition
  const consider = ex => {
    const key = ex.name?.trim().toLowerCase();
    if (!key || key === UNNAMED_EXERCISE_PLACEHOLDER.toLowerCase()) return;
    if (!seen.has(key)) seen.set(key, ex);
  };
  for (const ex of allPlanExercises(state.plan)) consider(ex);
  for (const key in state.meta) {
    if (!key.startsWith('swaps_')) continue;
    for (const ex of state.meta[key]?.value ?? []) consider(ex);
  }
  // Backfilled orphans are re-selectable too — but archived ones stay hidden.
  for (const reg of Object.values(getRegistry())) {
    if (reg.archived) continue;
    consider({ id: reg.id, name: reg.name, sets: reg.sets ?? 3, reps: reg.reps ?? '8', unit: reg.unit ?? 'reps', muscles: '', cue: '' });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Ranked exercise suggestions for a typed query — the single source of truth
 * for both the session add dialog and the plan editor's exercise rows. Draws
 * from the vendored library (matched on name + aliases, carrying loadType,
 * defaultUnit and muscles) and the user's previously-used exercises (carrying
 * their id, so history re-attaches). Deduped by name: a previously-used
 * exercise wins over the library entry of the same name, preserving its id and
 * history. Ranked exact → prefix → mid-string, then alphabetical.
 */
function exerciseSuggestionProvider(query) {
  const q = normalizeExName(query);
  if (!q) return [];

  const rankOf = (text) => {
    const n = normalizeExName(text);
    const i = n.indexOf(q);
    return i < 0 ? Infinity : (n === q ? 0 : i === 0 ? 1 : 2);
  };
  const firstMuscle = (m) => (m ?? '').split('·')[0].trim();
  const hintOf = (muscle, loadType) => [muscle, loadType].filter(Boolean).join(' · ');

  const byName = new Map();

  // Previously-used exercises first — they carry an id (and thus history).
  for (const k of buildKnownExerciseList()) {
    const r = rankOf(k.name);
    if (r === Infinity) continue;
    const loadType = getExerciseLoadType(k.id);
    byName.set(normalizeExName(k.name), {
      name: k.name,
      hint: hintOf(firstMuscle(k.muscles), loadType) || `${k.sets}×${formatEffort(k.reps, k.unit ?? 'reps')}`,
      def: { id: k.id, name: k.name, unit: k.unit ?? 'reps', sets: k.sets, reps: k.reps, loadType, muscles: k.muscles ?? '', source: 'known' },
      _rank: r,
    });
  }

  // Library entries — added only when a same-named known exercise isn't present.
  for (const e of EXERCISE_LIBRARY) {
    let r = rankOf(e.name);
    for (const a of e.aliases ?? []) r = Math.min(r, rankOf(a));
    if (r === Infinity) continue;
    const key = normalizeExName(e.name);
    if (byName.has(key)) continue; // known one wins (keeps id/history)
    byName.set(key, {
      name: e.name,
      hint: hintOf(e.primaryMuscle, e.loadType),
      def: {
        id: null, name: e.name,
        unit: e.defaultUnit === 'seconds' ? 'seconds' : 'reps',
        sets: null, reps: null,
        loadType: e.loadType,
        muscles: [e.primaryMuscle, ...(e.secondaryMuscles ?? [])].filter(Boolean).join(' · '),
        source: 'library',
      },
      _rank: r,
    });
  }

  return [...byName.values()].sort((a, b) => a._rank - b._rank || a.name.localeCompare(b.name));
}

/**
 * Attaches a type-ahead dropdown to an exercise-name input — the one picker
 * implementation, used at both entry points (session dialog + plan editor).
 * `provider(query)` returns ranked { name, hint, def } suggestions; `onSelect`
 * receives { def } for a chosen suggestion or { isNew: true, name } for the
 * free-entry "add as custom" path. Keyboard (↑/↓/Enter/Esc) and touch both
 * work; the list opens upward when there isn't room below; `container` must be
 * position:relative so the list anchors to the field.
 */
function attachExerciseAutocomplete(input, { provider, onSelect, container, limit = 8 }) {
  container = container || input.parentElement;
  const list = document.createElement('div');
  list.className = 'autocomplete-list';
  list.hidden = true;
  container.appendChild(list);

  let items = [];
  let active = -1;

  const close = () => {
    list.hidden = true; list.innerHTML = ''; items = []; active = -1;
    input.setAttribute('aria-expanded', 'false');
  };

  const setActive = (i) => {
    active = i;
    list.querySelectorAll('.autocomplete-item').forEach((el, idx) => {
      const on = idx === active;
      el.classList.toggle('autocomplete-item-active', on);
      if (on) el.scrollIntoView({ block: 'nearest' });
    });
  };

  const pick = (i) => {
    const item = items[i];
    if (!item) return;
    if (item.isNew) onSelect({ isNew: true, name: item.name });
    else { input.value = item.name; onSelect({ def: item.def }); }
    close();
  };

  const render = () => {
    const q = input.value.trim();
    if (!q) return close();
    const matches = provider(q).slice(0, limit);
    const exact = matches.some(m => normalizeExName(m.name) === normalizeExName(q));
    items = matches.map(m => ({ ...m, isNew: false }));
    if (!exact) items.push({ isNew: true, name: q }); // free-entry affordance

    list.innerHTML = items.map((m, i) => m.isNew
      ? `<button type="button" class="autocomplete-item autocomplete-item-new" data-i="${i}">No match — add “${escHtml(m.name)}” as custom</button>`
      : `<button type="button" class="autocomplete-item" data-i="${i}">
           <span class="autocomplete-item-name">${escHtml(m.name)}</span>
           ${m.hint ? `<span class="autocomplete-item-meta">${escHtml(m.hint)}</span>` : ''}
         </button>`).join('');
    active = -1;
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');

    // Open upward when the list wouldn't fit below (e.g. keyboard up on phone).
    const rect = input.getBoundingClientRect();
    const roomBelow = window.innerHeight - rect.bottom;
    list.classList.toggle('autocomplete-up', roomBelow < 200 && rect.top > roomBelow);

    list.querySelectorAll('.autocomplete-item').forEach(el => {
      el.addEventListener('mousedown', e => e.preventDefault()); // keep input focus
      el.addEventListener('click', () => pick(parseInt(el.dataset.i, 10)));
    });
  };

  input.addEventListener('input', render);
  input.addEventListener('focus', () => { if (input.value.trim()) render(); });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown')    { e.preventDefault(); setActive(Math.min(active + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(active - 1, 0)); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(active); }
    else if (e.key === 'Escape')  { close(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 150)); // let a click land first
}

/**
 * Adds a session-scoped exercise to a date's session (not the recurring
 * plan). Typing filters the library + previously known exercises; picking a
 * known one reattaches its definition (same id, so unit, history and PB data
 * carry over); picking a library one creates a new exercise already typed to
 * its loadType/unit. Unmatched names create a genuinely new custom exercise.
 */
function handleAddExercise(date) {
  const known = buildKnownExerciseList();
  let selected = null; // known definition picked from the list, or null = create new

  showFormDialog(
    'Add an exercise to this session.',
    [
      { name: 'name', label: 'Exercise name', placeholder: 'Type to search…' },
      { name: 'sets', label: 'Sets', type: 'number', inputmode: 'numeric', value: '3' },
      { name: 'unit', label: 'Target unit', options: [
          { value: 'reps',    label: 'Reps (count)' },
          { value: 'seconds', label: 'Seconds (hold)' },
        ], value: 'reps' },
      { name: 'reps', label: 'Reps target', value: '8' },
    ],
    async ({ name, sets, unit, reps }) => {
      if (!name) return;
      const chosenUnit = unit === 'seconds' ? 'seconds' : 'reps';

      // Typed text that exactly matches a known exercise attaches it even
      // without an explicit tap — never create a duplicate record by name
      const match = selected?.name.toLowerCase() === name.toLowerCase()
        ? selected
        : known.find(k => k.name.toLowerCase() === name.toLowerCase()) ?? null;

      const { allExercises } = resolveExercisesForDate(date);
      if (match && allExercises.some(e => e.id === match.id)) {
        showToast(`"${match.name}" is already in this session.`);
        return;
      }

      const newEx = match
        ? {
            id:         match.id, // reuse — history and PBs stay attached
            name:       match.name,
            sets:       parseInt(sets, 10) || match.sets || 3,
            reps:       reps || match.reps || '8',
            unit:       match.unit ?? 'reps',
            muscles:    match.muscles ?? '',
            cue:        match.cue ?? '',
            isAdded:    true,
            originalId: null,
          }
        : {
            id:         generateId('added'),
            name,
            sets:       parseInt(sets, 10) || 3,
            reps:       reps || (chosenUnit === 'seconds' ? '30' : '8'),
            unit:       chosenUnit,
            muscles:    '',
            cue:        '',
            isAdded:    true,
            originalId: null,
          };

      const swapsKey = `swaps_${date}`;
      const bucket   = state.meta[swapsKey] ?? { key: swapsKey, value: [] };
      bucket.value.push(newEx);
      await put('meta', bucket);
      state.meta[swapsKey] = bucket;

      renderToday();
      renderWeekStrip();
      showToast(match ? `Added "${newEx.name}" (existing exercise).` : `Added "${newEx.name}".`);
    },
    'Add'
  );

  // Autocomplete: the shared type-ahead under the name input (same component
  // the plan editor uses). Suggestions come from the library + previously-used
  // exercises; picking a library entry sets the right unit (a Plank comes in as
  // seconds), a known entry re-attaches by id.
  const wrap       = document.getElementById('dialog-inputs');
  const nameInput  = wrap.querySelector('[data-field="name"]');
  const setsInput  = wrap.querySelector('[data-field="sets"]');
  const unitSelect = wrap.querySelector('[data-field="unit"]');
  const repsInput  = wrap.querySelector('[data-field="reps"]');

  // Keep the reps-target label honest as the unit changes (Reps ↔ Seconds).
  const syncUnitLabel = unit => {
    repsInput.closest('.dialog-field').querySelector('.dialog-input-label')
      .textContent = unit === 'seconds' ? 'Seconds target' : 'Reps target';
  };
  unitSelect.addEventListener('change', () => syncUnitLabel(unitSelect.value));

  attachExerciseAutocomplete(nameInput, {
    provider: exerciseSuggestionProvider,
    container: nameInput.closest('.dialog-field'),
    onSelect: (sel) => {
      if (sel.isNew) { selected = null; return; }
      const def = sel.def;
      nameInput.value  = def.name;
      unitSelect.value = def.unit === 'seconds' ? 'seconds' : 'reps';
      syncUnitLabel(unitSelect.value);
      if (def.source === 'known') {
        // Re-attach the full known definition (keeps id, history, and cue).
        selected = known.find(k => k.id === def.id) ?? def;
        setsInput.value = String(def.sets ?? 3);
        repsInput.value = String(def.reps ?? '8');
      } else {
        selected = null; // library entry → new exercise, typed by name + unit
      }
    },
  });

  // Typing after a pick invalidates it.
  nameInput.addEventListener('input', () => { selected = null; });
}

/**
 * Removes an exercise from a single date's session without touching the
 * recurring weekly plan. Plan-sourced exercises are hidden via a
 * session-scoped removal list; added/swapped extras are deleted outright.
 */
async function handleRemoveExercise(exerciseId, exerciseName, date) {
  // Make the confirmation explicit when today's session already has logged sets
  // for this exercise — those historical logs are kept, only this day's
  // instance is removed, but the user should know before committing.
  const loggedToday = state.logs.filter(
    l => l.exerciseId === exerciseId && l.date === date && l.done
  ).length;
  const warning = loggedToday > 0
    ? ` You've logged ${loggedToday} set${loggedToday === 1 ? '' : 's'} for it today — those logs are kept in your history, only today's session removes it.`
    : '';

  showDialog(`Remove "${exerciseName}" from this session?${warning}`, async () => {
    const { extras } = resolveExercisesForDate(date);
    const extraEx  = extras.find(e => e.id === exerciseId);

    if (extraEx) {
      const swapsKey = `swaps_${date}`;
      const bucket   = state.meta[swapsKey] ?? { key: swapsKey, value: [] };
      bucket.value   = bucket.value.filter(e => e.id !== exerciseId);
      await put('meta', bucket);
      state.meta[swapsKey] = bucket;

      // Removing a swap's substitute restores the original it replaced
      if (extraEx.isSwap && extraEx.originalId) {
        await unremoveId(date, extraEx.originalId);
      }
    } else {
      await addRemovedId(date, exerciseId);
    }

    renderToday();
    renderWeekStrip();
    showToast(`Removed "${exerciseName}" from this session.`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  PROGRESS TAB
// ─────────────────────────────────────────────────────────────────────────────

// Bodyweight moved to the Body tab, which draws it from imported Fitdays
// readings. The old chart here was fed by the manual weight prompt that no
// longer exists, so it would only ever have shown a frozen history.
// ═════════════════════════════════════════════════════════════════════════════
//  STATS TAB — the analytics hub
//
//  Everything that answers "how is it going" in one place: four headline
//  counts, the activity heatmap, the muscle map, weekly volume, per-exercise
//  progress, and the recent sessions. The activity heatmap and the muscle map
//  used to sit on the hub; they belong here, and the hub stays a landing view.
//  Every figure is the same deterministic read of plan + logs it always was —
//  the one exception is the muscle map's Strength reading, which states on its
//  own face that it applies a detraining model (see heatmaps.js).
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The muscles string for an exercise definition. Definitions carry one when
 * they came from the seed or the library picker; anything typed in freehand
 * does not, so fall back to a name match against the vendored library — the
 * same match getExerciseLoadType already trusts for typing.
 */
function resolveExerciseMuscles(ex) {
  if (ex?.muscles) return ex.muscles;
  const match = ex?.name ? matchLibraryEntry(ex.name) : null;
  if (!match) return '';
  return [match.primaryMuscle, ...(match.secondaryMuscles ?? [])].filter(Boolean).join(' · ');
}

/** Four headline counts. Plain reads of the same session set the hub uses. */
function buildStatTiles() {
  const days     = toDailySeries(state.bodyComposition);
  const weighIns = days.filter(d => d.weight != null);
  const cutoff   = dateStrPlus(state.ui.today, -30);
  const recent   = weighIns.filter(d => d.date >= cutoff);
  const delta30  = recent.length > 1 ? recent[recent.length - 1].weight - recent[0].weight : null;

  const tile = (icon, label, value, extraClass = '', action = '') => `
    <${action ? 'button' : 'div'} class="stat-tile${extraClass ? ' ' + extraClass : ''}"${action ? ` data-hub-action="${action}"` : ''}>
      <span class="stat-tile-label">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>
        ${label}
      </span>
      <span class="stat-tile-value">${value}</span>
    </${action ? 'button' : 'div'}>`;

  const ICON_DUMBBELL = '<path d="M6.5 6.5v11"/><path d="M17.5 6.5v11"/><path d="M3 9v6"/><path d="M21 9v6"/><path d="M6.5 12h11"/>';
  const ICON_CALENDAR = '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>';
  const ICON_FLAME    = '<path d="M12 2c1 4 4 5 4 9a4 4 0 0 1-8 0c0-1.5.6-2.4 1.2-3.2C10 6.7 12 5 12 2z"/><path d="M8.2 12A6 6 0 0 0 12 22a6 6 0 0 0 3.8-10"/>';
  const ICON_SCALE    = '<path d="M12 3v18"/><path d="M5 8h14"/><path d="M5 8 2 15h6z"/><path d="M19 8l3 7h-6z"/>';

  const streak = trainingWeekStreak();

  return [
    tile(ICON_DUMBBELL, 'Sessions',   sessionDatesSet().size),
    tile(ICON_CALENDAR, 'This month', sessionsThisMonth()),
    tile(ICON_FLAME,    'Week streak', streak),
    tile(ICON_SCALE,    'Weight 30d',
      delta30 == null ? '—' : `${delta30 > 0 ? '+' : ''}${bcFmt(delta30)}<span class="stat-tile-unit">kg</span>`,
      'stat-tile-sm', 'open-body'),
  ].join('');
}

/**
 * The most recent training days, newest first — date, session name, and what
 * was actually logged. Tapping one opens that date in the day view.
 */
const RECENT_SESSION_LIMIT = 6;

function buildRecentSessions() {
  const dates = [...sessionDatesSet()].filter(d => d <= state.ui.today).sort().reverse()
    .slice(0, RECENT_SESSION_LIMIT);
  if (!dates.length) {
    return '<p class="chart-empty">Finish a session to see it here.</p>';
  }

  return dates.map(date => {
    const logs = state.logs.filter(l => l.date === date && l.done && l.reps != null);
    const exercises = new Set(logs.map(l => canonicalExerciseId(l.exerciseId))).size;
    // Tonnage counts weighted load only, for the same reason the volume chart
    // does: bodyweight and timed work have no meaningful kilograms.
    const tonnage = logs.reduce((sum, l) =>
      getExerciseLoadType(canonicalExerciseId(l.exerciseId)) === 'weighted' && l.weight && l.reps
        ? sum + l.weight * l.reps : sum, 0);
    const name = sessionTypeForDate(date);
    const bits = [`${exercises} exercise${exercises === 1 ? '' : 's'}`, `${logs.length} set${logs.length === 1 ? '' : 's'}`];
    if (tonnage > 0) bits.push(`${(tonnage / 1000).toFixed(1)}t`);

    return `
      <button class="recent-session-row" data-hub-action="open-session" data-date="${date}">
        <span class="recent-session-main">
          <span class="recent-session-name">${escHtml(name)}</span>
          <span class="recent-session-meta">${escHtml(bits.join(' · '))}</span>
        </span>
        <span class="recent-session-date">${escHtml(friendlyDateLabel(date))}</span>
      </button>`;
  }).join('');
}

/** Paints the muscle-map card into its slot and wires its controls. */
function renderMuscleMap() {
  const host = document.getElementById('stats-muscle-map');
  if (!host) return;

  host.innerHTML = buildMuscleMapCard(state, {
    today: state.ui.today,
    ui: state.ui.muscleMap,
    resolveMuscles: resolveExerciseMuscles,
  });

  // Tab / window segments and muscle taps. All three only change view state,
  // so each just re-renders this one card — never the whole tab.
  host.querySelectorAll('[data-map-control]').forEach(btn => {
    btn.addEventListener('click', () => {
      const { mapControl, mapValue } = btn.dataset;
      if (mapControl === 'tab') { state.ui.muscleMap.tab = mapValue; state.ui.muscleMap.hard = false; }
      if (mapControl === 'win') state.ui.muscleMap.win = Number(mapValue);
      if (mapControl === 'hard') state.ui.muscleMap.hard = mapValue === '1';
      state.ui.muscleMap.selected = null; // a new view starts with nothing picked
      renderMuscleMap();
    });
  });

  host.querySelectorAll('[data-muscle]').forEach(path => {
    path.addEventListener('click', () => {
      const slug = path.dataset.muscle;
      state.ui.muscleMap.selected = state.ui.muscleMap.selected === slug ? null : slug;
      renderMuscleMap();
    });
  });
}

function renderStats() {
  document.getElementById('stat-tiles').innerHTML      = buildStatTiles();
  document.getElementById('stats-activity').innerHTML  = buildActivityHeatmapCard(state.logs, { today: state.ui.today });
  document.getElementById('recent-sessions').innerHTML = buildRecentSessions();

  // Weekly volume chart
  const volCard = document.getElementById('volume-chart-card');
  const volData = buildWeeklyVolumeData();
  if (volData.some(w => w.total > 0)) {
    volCard.innerHTML = buildVolumeChartSVG(volData);
  } else {
    volCard.innerHTML =
      '<p class="chart-empty">Complete some weighted sessions to see volume trends.</p>';
  }

  // Exercise history selector
  populateHistorySelect();

  // The body geometry is a ~94 KB dynamic import. Draw the card now (it renders
  // a fixed-height placeholder where the figure goes, so nothing below jumps),
  // then draw it again once the artwork lands.
  renderMuscleMap();
  if (!bodyPathsReady()) {
    loadBodyPaths().then(() => {
      if (state.ui.currentView === 'stats') renderMuscleMap();
    });
  }

  wireStatsActions();
}

/** Delegated wiring for the Stats tab's tappable tiles and session rows. */
function wireStatsActions() {
  document.querySelectorAll('#view-stats [data-hub-action]').forEach(el => {
    el.addEventListener('click', () => {
      switch (el.dataset.hubAction) {
        case 'open-body': switchView('body'); break;
        case 'open-session':
          state.ui.viewedDate = el.dataset.date || state.ui.today;
          state.ui.expandedExerciseId = null;
          switchView('today');
          break;
      }
    });
  });
}

// Deterministic colour slots for session types, assigned in plan-day order.
// Assigned in fixed order and never cycled: a session type past the fourth
// takes the neutral "other" slot rather than a generated hue, so a colour
// always identifies the same entity. See the --chart-* block in styles.css.
const sessionTypeColors = () => [...CHART_COLORS().series, CHART_COLORS().other];

/** The plan's session name for the weekday a date falls on, or 'Other'. */
function sessionTypeForDate(dateStr) {
  // Reads the date's EFFECTIVE routine, so a rescheduled session is labelled
  // with what was actually trained rather than with what the week planned.
  const name = dayForDate(dateStr).routine?.name?.trim();
  return name || 'Other';
}

/**
 * Module 4 — weekly working-set volume, split by session type. Volume counts
 * only `weighted` load (weight × reps): bodyweight/assisted/timed/rep work has
 * no meaningful tonnage, and this also keeps any leaked bodyweight out of the
 * totals. Last 10 ISO weeks, Mon-anchored.
 */
function buildWeeklyVolumeData() {
  const today = new Date();
  const weeks = Array.from({ length: 10 }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (9 - i) * 7);
    return {
      weekStr: isoWeekStr(d),
      label:   axisDateLabel(getMondayOf(d)), // 'Jun 15' — matches every other chart axis
      byType:  {},
      total:   0,
    };
  });

  for (const log of state.logs) {
    if (!log.done || !log.weight || !log.reps) continue;
    // Resolve through the alias map so a fragmented movement reads its loadType
    // under one canonical id — matching every other read path (PRs, plateaus,
    // history, "Previous"). Weekly totals are unchanged: volume is weight×reps
    // regardless of id, and aliased ids share the canonical's loadType.
    const exId = canonicalExerciseId(log.exerciseId);
    if (getExerciseLoadType(exId) !== 'weighted') continue;
    const slot = weeks.find(w => w.weekStr === isoWeekStr(parseDate(log.date)));
    if (!slot) continue;
    const type = sessionTypeForDate(log.date);
    const vol  = log.weight * log.reps;
    slot.byType[type] = (slot.byType[type] ?? 0) + vol;
    slot.total += vol;
  }
  return weeks;
}

/** Ordered session types present in the data — plan-day order first, extras last. */
function orderedSessionTypes(weeks) {
  const planTypes = [...new Set(
    routinesOf(state.plan).map(r => r.name?.trim()).filter(Boolean)
  )];
  const dataTypes = [...new Set(weeks.flatMap(w => Object.keys(w.byType)))];
  return [
    ...planTypes.filter(t => dataTypes.includes(t)),
    ...dataTypes.filter(t => !planTypes.includes(t)),
  ];
}

function buildVolumeChartSVG(weeks) {
  const W = 320, H = 160;
  const P = { top: 16, right: 12, bottom: 28, left: 48 };
  const cW = W - P.left - P.right;
  const cH = H - P.top  - P.bottom;
  const n  = weeks.length;

  const types    = orderedSessionTypes(weeks);
  const palette  = sessionTypeColors();
  const colorOf  = t => {
    const i = types.indexOf(t);
    return (i >= 0 && i < palette.length - 1) ? palette[i] : palette[palette.length - 1];
  };
  const maxVol   = Math.max(...weeks.map(w => w.total), 1);
  const barW     = Math.max(Math.floor(cW / n) - 4, 4);
  const gap      = Math.floor((cW - barW * n) / (n - 1 || 1));

  // Each week is one stacked bar: a segment per session type, bottom-up.
  const bars = weeks.map((w, i) => {
    const x = P.left + i * (barW + gap);
    if (w.total <= 0) {
      return `<rect x="${x.toFixed(1)}" y="${(P.top + cH - 2).toFixed(1)}"
                    width="${barW}" height="2" rx="1" fill="${CHART_COLORS().grid}"/>`;
    }
    let yCursor = P.top + cH;
    return types.map(t => {
      const vol = w.byType[t] ?? 0;
      if (vol <= 0) return '';
      const segH = (vol / maxVol) * cH;
      yCursor -= segH;
      // A 2px gap in the surface colour separates one session type from the
      // next. Butted-together fills make a stacked bar read as a single block
      // with colour changes in it; a hairline of background makes each segment
      // a countable object. Only inset when the segment can spare the height,
      // so a thin segment is never shaved out of existence.
      const inset = segH > 6 ? 2 : 0;
      return `<rect x="${x.toFixed(1)}" y="${yCursor.toFixed(1)}"
                    width="${barW}" height="${(segH - inset).toFixed(1)}"
                    fill="${colorOf(t)}" opacity="0.9"/>`;
    }).join('');
  }).join('');

  const topTonne = (maxVol / 1000).toFixed(1);
  const midTonne = (maxVol / 2000).toFixed(1);

  const legend = types.length
    ? `<div class="volume-legend">${types.map(t =>
        `<span class="volume-legend-item"><span class="volume-legend-dot" style="background:${colorOf(t)}"></span>${escHtml(t)}</span>`
      ).join('')}</div>`
    : '';

  return `
    ${legend}
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"
         style="width:100%;display:block;overflow:visible"
         role="img" aria-label="Weekly training volume by session type">
      <line x1="${P.left}" y1="${P.top}" x2="${P.left}" y2="${P.top + cH}"
            stroke="${CHART_COLORS().grid}" stroke-width="1"/>
      <line x1="${P.left}" y1="${P.top + cH}" x2="${P.left + cW}" y2="${P.top + cH}"
            stroke="${CHART_COLORS().grid}" stroke-width="1"/>
      ${bars}
      <g font-size="10" fill="${CHART_COLORS().axis}" font-family="Inter,system-ui,sans-serif">
        <text x="${(P.left - 5).toFixed(1)}" y="${P.top.toFixed(1)}"
              dominant-baseline="middle" text-anchor="end">${topTonne}t</text>
        <text x="${(P.left - 5).toFixed(1)}" y="${(P.top + cH * 0.5).toFixed(1)}"
              dominant-baseline="middle" text-anchor="end">${midTonne}t</text>
        <text x="${P.left.toFixed(1)}"           y="${H - 4}" text-anchor="middle">${weeks[0]?.label ?? ''}</text>
        <text x="${(P.left + cW).toFixed(1)}" y="${H - 4}" text-anchor="middle">${weeks[n - 1]?.label ?? ''}</text>
      </g>
    </svg>`;
}

/**
 * Module 3 — a small, deterministic line chart of one exercise's progression
 * metric (per loadType), one point per logged session. Straight segments
 * between real points: no smoothing, nothing hidden. Matches the volume chart's
 * house palette. Assumes at least two points.
 */
function buildProgressionChartSVG(series) {
  const pts = series.points;
  const n   = pts.length;
  const W = 320, H = 160;
  const P = { top: 16, right: 12, bottom: 28, left: 44 };
  const cW = W - P.left - P.right;
  const cH = H - P.top  - P.bottom;

  const vals   = pts.map(p => p.value);
  const dataLo = Math.min(...vals);
  const dataHi = Math.max(...vals);
  // A perfectly flat run still needs vertical room to draw a line through.
  let lo = dataLo, hi = dataHi;
  if (lo === hi) { lo -= 1; hi += 1; }
  const span = hi - lo;

  const x = i => P.left + (i / (n - 1)) * cW;
  const y = v => P.top + cH - ((v - lo) / span) * cH;

  const linePts = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const dots = pts.map((p, i) =>
    `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="2.5" fill="${CHART_COLORS().accent}"/>`).join('');

  const fmt = v => Number.isInteger(v) ? String(v) : v.toFixed(1);
  const firstLabel = axisDateLabel(parseDate(pts[0].date));
  const lastLabel  = axisDateLabel(parseDate(pts[n - 1].date));

  return `
    <div class="progression-caption">${escHtml(series.metricLabel)}${series.lowerIsBetter ? ' · lower is better' : ''}</div>
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"
         style="width:100%;display:block;overflow:visible" role="img"
         aria-label="${escHtml(series.metricLabel)} across ${n} sessions">
      <line x1="${P.left}" y1="${P.top}" x2="${P.left}" y2="${P.top + cH}"
            stroke="${CHART_COLORS().grid}" stroke-width="1"/>
      <line x1="${P.left}" y1="${P.top + cH}" x2="${P.left + cW}" y2="${P.top + cH}"
            stroke="${CHART_COLORS().grid}" stroke-width="1"/>
      <polyline points="${linePts}" fill="none" stroke="${CHART_COLORS().accent}" stroke-width="2"
                stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
      <g font-size="10" fill="${CHART_COLORS().axis}" font-family="Inter,system-ui,sans-serif">
        <text x="${(P.left - 5).toFixed(1)}" y="${P.top.toFixed(1)}"
              dominant-baseline="middle" text-anchor="end">${fmt(dataHi)}</text>
        <text x="${(P.left - 5).toFixed(1)}" y="${(P.top + cH).toFixed(1)}"
              dominant-baseline="middle" text-anchor="end">${fmt(dataLo)}</text>
        <text x="${P.left.toFixed(1)}"           y="${H - 4}" text-anchor="middle">${escHtml(firstLabel)}</text>
        <text x="${(P.left + cW).toFixed(1)}" y="${H - 4}" text-anchor="middle">${escHtml(lastLabel)}</text>
      </g>
    </svg>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  BODY TAB — FITDAYS IMPORT
// ─────────────────────────────────────────────────────────────────────────────

/** Show or clear the inline error under the Body tab's import control. */
function setBodyCompError(message) {
  const el = document.getElementById('bc-error');
  if (!el) return;
  el.textContent = message ?? '';
  el.hidden = !message;
}

/**
 * Reads the selected Fitdays export, stores whatever is new, and reports what
 * happened. Failures surface inline on the page rather than as a toast — an
 * import error needs to stay on screen long enough to act on.
 */
async function handleFitdaysImport(event) {
  const file = event.target.files?.[0];
  event.target.value = ''; // reset immediately so the same file can be re-picked
  if (!file) return;

  setBodyCompError(null);

  const btn = document.getElementById('bc-import-btn');
  if (btn) btn.disabled = true;

  try {
    const result = await importFitdaysFile(file);
    state.bodyComposition = await loadBodyComposition();
    renderBodyTab(state.bodyComposition);
    showToast(importSummaryMessage(result));
  } catch (err) {
    console.error('[FitTrack] Fitdays import failed:', err);
    setBodyCompError(err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function populateHistorySelect() {
  const sel        = document.getElementById('history-exercise-select');
  const currentVal = sel.value;

  // All exerciseIds with at least one done log, collapsed onto their canonical
  // id so a movement whose history spans several ids appears once, current-name.
  const loggedIds = [...new Set(
    state.logs.filter(l => l.done).map(l => canonicalExerciseId(l.exerciseId))
  )];

  sel.innerHTML = '<option value="">— Select an exercise —</option>' +
    loggedIds.map(id => {
      const name     = getExerciseName(id);
      const selected = id === currentVal ? ' selected' : '';
      return `<option value="${escHtml(id)}"${selected}>${escHtml(name)}</option>`;
    }).join('');

  if (!sel._wired) {
    sel.addEventListener('change', () => renderExerciseHistory(sel.value));
    sel._wired = true;
  }

  if (currentVal) renderExerciseHistory(currentVal);
}

function renderExerciseHistory(exerciseId) {
  const list = document.getElementById('history-list');
  const prog = document.getElementById('history-progression');
  if (!exerciseId) { list.innerHTML = ''; prog.innerHTML = ''; return; }

  // Group done logs by date — aliased source ids merge into this exercise.
  const target = canonicalExerciseId(exerciseId);
  const byDate = {};
  for (const log of state.logs) {
    if (canonicalExerciseId(log.exerciseId) !== target || !log.done) continue;
    if (!byDate[log.date]) byDate[log.date] = [];
    byDate[log.date].push(log);
  }

  const dates = Object.keys(byDate).sort().reverse();
  if (!dates.length) {
    list.innerHTML = '<p class="chart-empty">No history yet for this exercise.</p>';
    prog.innerHTML = '';
    return;
  }

  const unit      = getExerciseUnit(exerciseId);
  const loadType  = getExerciseLoadType(exerciseId) ?? (unit === 'seconds' ? 'timed' : 'reps');

  // Module 3 — per-exercise progression trend (needs at least two sessions).
  const series = computeExerciseSeries(state, exerciseId, { name: getExerciseName(exerciseId), unit, loadType });
  prog.innerHTML = series.points.length >= 2 ? buildProgressionChartSVG(series) : '';
  // The PR is a session-level record on this exercise's metric (per loadType);
  // mark the session that holds it, resolved centrally in insights.js.
  const prEntry   = getExercisePR(state, exerciseId, { name: getExerciseName(exerciseId), unit, loadType });

  // Module 7 — sessions where the metric dropped vs the one before. Direction-
  // aware: for assisted (lower is better) an increase is the regression. Used
  // only to decide WHERE to co-locate a note — the app never reads the note's
  // meaning or infers a cause; that stays with Claude.
  const dropDates = new Set();
  for (let i = 1; i < series.points.length; i++) {
    const cur = series.points[i].value, prev = series.points[i - 1].value;
    const regressed = series.lowerIsBetter ? cur > prev : cur < prev;
    if (regressed) dropDates.add(series.points[i].date);
  }

  list.innerHTML = dates.map(dateStr => {
    const entries  = byDate[dateStr];
    const totalSets = entries.length;
    // Each session summarises on its own metric — no kg where load isn't the
    // point (a bodyweight pull-up reads in reps, not the weight field).
    const maxReps = Math.max(...entries.map(l => l.reps ?? 0));
    let valueTxt;
    if (loadType === 'timed') {
      valueTxt = `best ${maxReps}s · ${totalSets} sets`;
    } else if (loadType === 'weighted') {
      const maxWt   = Math.max(...entries.map(l => l.weight ?? 0));
      const avgReps = totalSets
        ? Math.round(entries.reduce((s, l) => s + (l.reps ?? 0), 0) / totalSets)
        : 0;
      valueTxt = `${maxWt}kg × ${avgReps} · ${totalSets} sets`;
    } else if (loadType === 'assisted') {
      const assists = entries.map(l => l.weight).filter(w => w != null);
      valueTxt = assists.length
        ? `${Math.min(...assists)}kg assist · ${totalSets} sets`
        : `${maxReps} reps · ${totalSets} sets`;
    } else { // bodyweight or rep-only — headline is reps
      valueTxt = `${maxReps} reps · ${totalSets} sets`;
    }
    const prTag = (prEntry && dateStr === prEntry.date) ? '<span class="history-row-pr">PR</span>' : '';

    // Module 7 — on a session where the metric dropped, show its note verbatim
    // beside the number. Note and number are co-located; nothing is interpreted.
    const note = entries.find(l => l.notes && l.notes.trim())?.notes.trim();
    const noteRow = (dropDates.has(dateStr) && note) ? `
      <div class="history-note">
        <span class="history-note-flag" title="Metric dropped this session" aria-hidden="true">↓</span>
        <span class="history-note-text">${escHtml(note)}</span>
      </div>` : '';

    return `
      <div class="history-entry">
        <div class="history-row">
          <span class="history-row-date">${friendlyDateLabel(dateStr)}</span>
          <span class="history-row-value">${valueTxt}</span>
          ${prTag}
        </div>${noteRow}
      </div>`;
  }).join('');
}

// ═════════════════════════════════════════════════════════════════════════════
//  EXERCISE REFERENCE — shared panel + Browse Library (Step 4a shell / 4b)
//
//  Presentation over the vendored open dataset (free-exercise-db). Pure display
//  of facts — target muscles, equipment, mechanic, verbatim instructions, and
//  the start/finish demo frames. No coaching, no inference. The same panel
//  builder serves both the browse library (remote, lazy images) and, later, the
//  per-plan-exercise detail (locally vendored images), so the two never drift.
// ═════════════════════════════════════════════════════════════════════════════

// Phone-first cap on how many browse rows render at once. Text rows are cheap,
// but 600+ accordions is not; the count line tells the user to narrow.
const LIBRARY_RENDER_CAP = 200;

let _libraryWired = false; // one-time filter population + listener wiring

/** 'body only' → 'Body only'; 'olympic weightlifting' → 'Olympic weightlifting'. */
function refLabel(s) {
  const str = String(s ?? '').trim();
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

/** Comma-joined, capitalised muscle list, or '—' when empty. */
function refMuscleList(arr) {
  const list = (arr ?? []).map(refLabel).filter(Boolean);
  return list.length ? list.join(', ') : '—';
}

/**
 * The two demonstration frames (start / finish) as a tap-to-toggle figure.
 * `mode` picks the image source: 'remote' lazy-loads from the GitHub raw base
 * (browse library) and degrades to a text placeholder offline/on error;
 * 'local' points at the vendored copies under data/exercise-images (plan
 * exercises, fully offline). A failed image reveals the placeholder beneath it
 * — a row's text never waits on a picture.
 */
function refFramesHTML(entry, mode) {
  const imgs = entry.images ?? [];
  if (imgs.length < 1) return '';
  const srcFor = (rel) =>
    mode === 'local' ? `./data/exercise-images/${rel}` : referenceImageUrl(rel);

  const frame = (rel, cls, alt) => rel
    ? `<img class="ref-frame ${cls}" src="${escHtml(srcFor(rel))}" alt="${escHtml(alt)}"
            loading="lazy" decoding="async"
            onerror="this.classList.add('ref-frame-failed')" />`
    : '';

  return `
    <figure class="ref-frames" data-ref-frames aria-label="Exercise demonstration">
      <div class="ref-frame-placeholder" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
        <span>Image loads online</span>
      </div>
      ${frame(imgs[0], 'ref-frame-0', 'Start position')}
      ${frame(imgs[1], 'ref-frame-1', 'Finish position')}
      ${imgs[1] ? `<button type="button" class="ref-frames-toggle" data-ref-frames-toggle>
        <span class="ref-frames-dot ref-frames-dot-0"></span>
        <span class="ref-frames-dot ref-frames-dot-1"></span>
        Start · Finish</button>` : ''}
    </figure>`;
}

/**
 * The read-only reference panel for one dataset entry: target muscles,
 * equipment, mechanic, demo frames, and the verbatim instruction steps
 * (public domain). `imageMode` = 'remote' | 'local'. Shows a small confidence
 * note only when the caller passes a non-high match, so a hand-reviewed guess
 * is honest about itself.
 */
function buildReferencePanelHTML(entry, { imageMode = 'remote', confidence = 'high' } = {}) {
  if (!entry) return '';
  const steps = (entry.instructions ?? []).filter(s => s && s.trim());
  const meta = [];
  if (entry.equipment) meta.push(`<span class="ref-chip">${escHtml(refLabel(entry.equipment))}</span>`);
  if (entry.mechanic)  meta.push(`<span class="ref-chip">${escHtml(refLabel(entry.mechanic))}</span>`);
  if (entry.level)     meta.push(`<span class="ref-chip">${escHtml(refLabel(entry.level))}</span>`);

  const lowConfNote = (confidence && confidence !== 'high')
    ? `<p class="ref-confidence">Reference match is ${escHtml(confidence)} confidence — verify it fits your movement.</p>`
    : '';

  return `
    <div class="ref-panel">
      ${lowConfNote}
      ${refFramesHTML(entry, imageMode)}
      <div class="ref-muscles">
        <div class="ref-muscle-row">
          <span class="ref-muscle-label">Primary</span>
          <span class="ref-muscle-val">${escHtml(refMuscleList(entry.primaryMuscles))}</span>
        </div>
        <div class="ref-muscle-row">
          <span class="ref-muscle-label">Secondary</span>
          <span class="ref-muscle-val">${escHtml(refMuscleList(entry.secondaryMuscles))}</span>
        </div>
      </div>
      ${meta.length ? `<div class="ref-chips">${meta.join('')}</div>` : ''}
      ${steps.length ? `
        <ol class="ref-steps">
          ${steps.map(s => `<li>${escHtml(s)}</li>`).join('')}
        </ol>` : ''}
      <p class="ref-source">Reference: free-exercise-db (public domain)</p>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  BROWSE LIBRARY (Step 4b)
// ─────────────────────────────────────────────────────────────────────────────

function renderLibrary() {
  if (!_libraryWired) wireLibrary();
  applyLibraryFilter();
}

/** One-time: fill the filter dropdowns from the loaded dataset and wire input. */
function wireLibrary() {
  const { muscles, equipment, categories } = getReferenceFacets();

  const muscleSel = document.getElementById('lib-filter-muscle');
  for (const m of muscles) {
    muscleSel.insertAdjacentHTML('beforeend',
      `<option value="${escHtml(m)}">${escHtml(refLabel(m))}</option>`);
  }

  const equipSel = document.getElementById('lib-filter-equipment');
  for (const e of equipment) {
    equipSel.insertAdjacentHTML('beforeend',
      `<option value="${escHtml(e)}">${escHtml(refLabel(e))}</option>`);
  }

  // Category: grouped lifting default first, then All, then each specific one.
  const catSel = document.getElementById('lib-filter-category');
  catSel.insertAdjacentHTML('beforeend',
    `<option value="lifting" selected>Strength / Powerlifting / Olympic</option>` +
    `<option value="all">All categories</option>` +
    categories.map(c => `<option value="${escHtml(c)}">${escHtml(refLabel(c))}</option>`).join(''));

  const search = document.getElementById('lib-search');
  search.addEventListener('input', debounceLibraryFilter);
  muscleSel.addEventListener('change', applyLibraryFilter);
  equipSel.addEventListener('change', applyLibraryFilter);
  catSel.addEventListener('change', applyLibraryFilter);

  // Delegated: expand/collapse a row, and toggle its demo frames.
  const list = document.getElementById('lib-list');
  list.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-ref-frames-toggle]');
    if (toggle) {
      toggle.closest('[data-ref-frames]')?.classList.toggle('showing-finish');
      return;
    }
    const head = e.target.closest('.lib-row-head');
    if (head) toggleLibraryRow(head);
  });

  _libraryWired = true;
}

let _libFilterTimer = null;
function debounceLibraryFilter() {
  clearTimeout(_libFilterTimer);
  _libFilterTimer = setTimeout(applyLibraryFilter, 160);
}

/** Reads the controls, filters the dataset, and renders the (capped) rows. */
function applyLibraryFilter() {
  const query     = document.getElementById('lib-search').value;
  const muscle    = document.getElementById('lib-filter-muscle').value;
  const equipment = document.getElementById('lib-filter-equipment').value;
  const category  = document.getElementById('lib-filter-category').value;

  const matches = filterReference({ query, muscle, equipment, category });
  const shown   = matches.slice(0, LIBRARY_RENDER_CAP);

  const countEl = document.getElementById('lib-count');
  if (!matches.length) {
    countEl.textContent = 'No exercises match those filters.';
  } else if (matches.length > shown.length) {
    countEl.textContent = `Showing ${shown.length} of ${matches.length} — search or filter to narrow.`;
  } else {
    countEl.textContent = `${matches.length} exercise${matches.length === 1 ? '' : 's'}`;
  }

  const list = document.getElementById('lib-list');
  list.innerHTML = shown.map(buildLibraryRowHTML).join('');
}

/** A collapsed browse row — text only, so it renders instantly and offline. */
function buildLibraryRowHTML(entry) {
  const sub = [refLabel(entry.primaryMuscles?.[0]), refLabel(entry.equipment)]
    .filter(Boolean).join(' · ');
  return `
    <div class="lib-row" data-ref-id="${escHtml(entry.id)}">
      <button type="button" class="lib-row-head" aria-expanded="false">
        <span class="lib-row-text">
          <span class="lib-row-name">${escHtml(entry.name)}</span>
          <span class="lib-row-meta">${escHtml(sub || '—')}</span>
        </span>
        <svg class="chevron-icon" width="16" height="16" viewBox="0 0 24 24"
             fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      <div class="lib-row-body" hidden></div>
    </div>`;
}

/** Expand/collapse one browse row; builds its panel (with images) on first open. */
function toggleLibraryRow(head) {
  const row  = head.closest('.lib-row');
  const body = row.querySelector('.lib-row-body');
  const open = head.getAttribute('aria-expanded') === 'true';

  if (open) {
    head.setAttribute('aria-expanded', 'false');
    body.hidden = true;
    return;
  }
  // Build the panel lazily the first time — this is when remote images start.
  if (!body.dataset.built) {
    const entry = getReferenceById(row.dataset.refId);
    body.innerHTML = entry ? buildReferencePanelHTML(entry, { imageMode: 'remote' }) : '';
    body.dataset.built = '1';
  }
  head.setAttribute('aria-expanded', 'true');
  body.hidden = false;
}

// ─────────────────────────────────────────────────────────────────────────────
//  EXERCISE DETAIL (Step 4a + 4c) — read-only reference + per-exercise progress
//
//  A tap-to-open overlay on a plan exercise: the shared reference panel (local
//  vendored images, so it works fully offline) plus a deterministic progress
//  view. The progress metric follows the reference `mechanic` where the app can
//  do so WITHOUT fabricating a record: a weighted compound trends estimated 1RM
//  (Epley), a weighted isolation trends session volume. Anything not externally
//  loaded (bodyweight / timed / rep / assisted) keeps its loadType metric — a
//  pull-up never gets a phantom kg e1RM. Display only; it never interprets the
//  trend. Intentionally simple: a forerunner the Insights module can absorb.
// ─────────────────────────────────────────────────────────────────────────────

const DETAIL_LAST_N = 6;
const EPLEY_DIVISOR = 30;

function round1(n) { return Math.round(n * 10) / 10; }
function epley1RM(w, r) { return (w == null || r == null || r <= 0) ? null : w * (1 + r / EPLEY_DIVISOR); }

/** Every completed, rep-bearing set for an exercise — aliased history merged. */
function doneSetsForExercise(exId) {
  const target = canonicalExerciseId(exId);
  return state.logs.filter(l => canonicalExerciseId(l.exerciseId) === target && l.done && l.reps != null);
}

/** True when a plan exercise has anything to show in a detail overlay. */
function hasExerciseDetail(exId) {
  return !!referenceForExerciseId(exId) || doneSetsForExercise(exId).length > 0;
}

/**
 * The progress series for the detail chart. mechanic (from the reference entry,
 * or null when unmapped) chooses e1RM vs volume for WEIGHTED work only; all
 * other loadTypes defer to the app's canonical loadType series so no kg is ever
 * invented. Same shape as insights.computeExerciseSeries.
 */
function buildDetailSeries(exId, mechanic, loadType) {
  if (loadType !== 'weighted') {
    return computeExerciseSeries(state, exId, {
      name: '', unit: getExerciseUnit(exId), loadType,
    });
  }
  const sets  = doneSetsForExercise(exId);
  const dates = [...new Set(sets.map(s => s.date))].sort();
  const byDate = d => sets.filter(s => s.date === d);

  if (mechanic === 'isolation') {
    const points = dates.map(d => ({
      date: d,
      value: round1(byDate(d).reduce((a, s) => a + (s.weight ?? 0) * (s.reps ?? 0), 0)),
    })).filter(p => p.value > 0);
    return { loadType, metricLabel: 'Volume (kg)', lowerIsBetter: false, points };
  }
  // compound, or weighted-but-unmapped → estimated 1RM
  const points = dates.map(d => {
    const best = Math.max(...byDate(d).map(s => epley1RM(s.weight, s.reps) ?? 0));
    return { date: d, value: round1(best) };
  }).filter(p => p.value > 0);
  return { loadType, metricLabel: 'Est. 1RM (kg)', lowerIsBetter: false, points };
}

/** Compact last-N session rows for the detail view (newest first). */
function buildDetailSessionsHTML(exId, loadType) {
  const sets = doneSetsForExercise(exId);
  const byDate = {};
  for (const s of sets) (byDate[s.date] ??= []).push(s);
  const dates = Object.keys(byDate).sort().reverse().slice(0, DETAIL_LAST_N);
  if (!dates.length) return '';

  const rows = dates.map(d => {
    const es = byDate[d];
    const n  = es.length;
    const maxReps = Math.max(...es.map(s => s.reps ?? 0));
    let val;
    if (loadType === 'timed') val = `best ${maxReps}s · ${n} sets`;
    else if (loadType === 'weighted') {
      const maxWt = Math.max(...es.map(s => s.weight ?? 0));
      const avg   = Math.round(es.reduce((a, s) => a + (s.reps ?? 0), 0) / n);
      val = `${maxWt}kg × ${avg} · ${n} sets`;
    } else if (loadType === 'assisted') {
      const assists = es.map(s => s.weight).filter(w => w != null);
      val = assists.length ? `${Math.min(...assists)}kg assist · ${n} sets` : `${maxReps} reps · ${n} sets`;
    } else val = `${maxReps} reps · ${n} sets`;
    return `<div class="detail-session-row">
      <span class="detail-session-date">${escHtml(friendlyDateLabel(d))}</span>
      <span class="detail-session-val">${escHtml(val)}</span></div>`;
  }).join('');

  return `<div class="detail-sessions">${rows}</div>`;
}

/** The progress block: chart (≥2 points), PB line, and last-N sessions. */
function buildExerciseProgressHTML(exId, name, mechanic) {
  const unit     = getExerciseUnit(exId);
  const loadType = getExerciseLoadType(exId) ?? (unit === 'seconds' ? 'timed' : 'reps');
  const series   = buildDetailSeries(exId, mechanic, loadType);
  const pr       = getExercisePR(state, exId, { name, unit, loadType });

  if (!series.points.length) {
    return `<div class="detail-section">
      <h3 class="detail-h">Progress</h3>
      <p class="detail-empty">No logged history yet for this exercise.</p>
    </div>`;
  }

  const chart = series.points.length >= 2
    ? buildProgressionChartSVG(series)
    : '<p class="detail-empty">One session logged — the trend line needs at least two.</p>';

  const prLine = pr ? `<div class="detail-pb">
      <span class="detail-pb-label">PB</span>
      <span class="detail-pb-val">${escHtml(pr.display.value)}${pr.display.note ? ' ' + escHtml(pr.display.note) : ''}</span>
      <span class="detail-pb-when">${escHtml(friendlyDateLabel(pr.date))}</span>
    </div>` : '';

  return `<div class="detail-section">
    <h3 class="detail-h">Progress</h3>
    ${prLine}
    <div class="detail-chart">${chart}</div>
    ${buildDetailSessionsHTML(exId, loadType)}
  </div>`;
}

/** Full overlay content: reference panel (if mapped) + progress. */
function buildExerciseDetailContent(exId, name) {
  const ref = referenceForExerciseId(exId);
  const refBlock = ref
    ? `<div class="detail-section">
         <h3 class="detail-h">Reference</h3>
         ${buildReferencePanelHTML(ref.entry, { imageMode: 'local', confidence: ref.confidence })}
       </div>`
    : `<div class="detail-section">
         <p class="detail-empty">No reference match for this exercise — showing progress only.</p>
       </div>`;
  return refBlock + buildExerciseProgressHTML(exId, name, ref?.entry?.mechanic ?? null);
}

function openExerciseDetail(exId, name) {
  const overlay = document.getElementById('exercise-detail-overlay');
  const title   = document.getElementById('exercise-detail-title');
  const body    = document.getElementById('exercise-detail-body');
  title.textContent = name || getExerciseName(exId);
  body.innerHTML    = buildExerciseDetailContent(exId, name || getExerciseName(exId));
  overlay.hidden = false;
  document.body.classList.add('detail-open');
}

function closeExerciseDetail() {
  document.getElementById('exercise-detail-overlay').hidden = true;
  document.body.classList.remove('detail-open');
}

// ═════════════════════════════════════════════════════════════════════════════
//  PLAN TAB — routines, the week that points at them, and one-off reschedules
//
//  The model lives in plan.js (see its header for why routines replaced seven
//  private day lists). This section owns the writes, the DOM and the wiring.
//
//  There is no Save button any more. Every edit here persists the moment it is
//  made, which is what lets a bottom sheet close on a tap instead of leaving
//  the tab in a half-edited state you could navigate away from and lose.
// ═════════════════════════════════════════════════════════════════════════════

/** The "Superset" label that heads a paired group in the day view. */
const SUPERSET_LABEL_HTML = `
  <div class="superset-label">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/>
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>
    Superset
  </div>`;

/**
 * The next prescription for one exercise on one date. `before: date` means only
 * sessions STRICTLY EARLIER than this one are read — otherwise checking a set
 * today would feed back into today's own suggestion.
 */
function prescriptionForExercise(ex, date) {
  return nextPrescription(state.logs, ex, dayForDate(date).routine, {
    canon: canonicalExerciseId,
    before: date,
  });
}

/** States what a DATE trains and offers the one-off reschedule. */
function renderRescheduleBar(date) {
  const bar = document.getElementById('reschedule-bar');
  const txt = document.getElementById('reschedule-text');
  if (!bar) return;

  const day = dayForDate(date);
  bar.hidden = false;
  txt.innerHTML = day.overridden
    ? `<strong>${escHtml(day.routine?.name ?? 'Rest')}</strong> <span class="reschedule-changed">· moved here</span>`
    : `<strong>${escHtml(day.routine?.name ?? 'Rest day')}</strong> <span class="reschedule-sub">· from your weekly plan</span>`;

  const btn = document.getElementById('reschedule-btn');
  btn.onclick = () => openRescheduleSheet(date);
}

/** Writes the plan document and mirrors it back into state. The single writer. */
async function savePlan() {
  if (!state.plan) return;
  await put('plan', state.plan);
}

/**
 * Stamps an exercise into the orphan registry as archived, so a routine (or a
 * single exercise) can be deleted without its logged history losing its name.
 * getExerciseDef already falls back to the registry, so nothing else changes.
 */
async function archiveExerciseToRegistry(ex) {
  if (!ex?.id || !ex.name) return;
  await upsertRegistryEntry(ex.id, {
    name: ex.name,
    unit: ex.unit ?? 'reps',
    sets: ex.sets ?? 3,
    reps: ex.reps ?? '8',
    loadType: ex.loadType,
    muscles: ex.muscles ?? '',
    archived: true,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  MIGRATION — v1 (seven private day lists) → v2 (routines + week)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs once, on the first load after this feature ships. Exercise objects move
 * across by reference with their ids untouched, so not one logged set is
 * affected; the archived exercises the old day lists carried are stamped into
 * the registry so their history keeps resolving a name.
 */
async function migratePlanToRoutines() {
  if (!state.plan || state.plan.routines) return;

  const result = migrateToRoutines(state.plan, { newId: generateId, glyphFor: guessGlyph });
  if (!result) return;

  for (const ex of result.orphaned) await archiveExerciseToRegistry(ex);

  state.plan = result.plan;
  await savePlan();
  console.info('[FitTrack] plan migrated to routines:', result.plan.routines.length);
}

/** The effective routine for one date — the per-date override, else the week. */
function dayForDate(date) {
  return resolveDay(state.plan, state.meta, date, dayIndexOf(date));
}

/** Sets (or clears, with `null`) the one-off routine override for one date. */
async function setDayOverride(date, value) {
  const key = dayPlanKey(date);
  if (value == null) {
    if (state.meta[key]) {
      await del('meta', key);
      delete state.meta[key];
    }
    return;
  }
  const doc = { key, value };
  await put('meta', doc);
  state.meta[key] = doc;
}

// ─────────────────────────────────────────────────────────────────────────────
//  BOTTOM SHEET — one reusable surface for every picker below
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Opens the shared bottom sheet. `onMount` receives the body element, so each
 * caller wires only its own controls. Sheets stack conceptually but not in the
 * DOM: opening a second one replaces the first, which is the behaviour a
 * "rule → pick a rule → back" flow wants anyway.
 */
function openSheet(title, html, onMount) {
  const overlay = document.getElementById('sheet-overlay');
  const body    = document.getElementById('sheet-body');
  document.getElementById('sheet-title').textContent = title;
  body.innerHTML = html;
  overlay.classList.remove('overlay-closing');
  overlay.hidden = false;
  document.body.classList.add('sheet-open');
  onMount?.(body);
}

function closeSheet() {
  const overlay = document.getElementById('sheet-overlay');
  if (overlay.hidden) return;
  closeOverlayAnimated(overlay, () => {
    overlay.hidden = true;
    document.getElementById('sheet-body').innerHTML = '';
    document.body.classList.remove('sheet-open');
  });
}

/** A tappable sheet row: optional leading icon, title, subtitle, trailing tick. */
function sheetRowHTML({ icon = '', title, sub = '', checked = false, action = '', value = '', danger = false }) {
  return `
    <button class="sheet-row${danger ? ' sheet-row-danger' : ''}" type="button"
            data-sheet-action="${escHtml(action)}" data-value="${escHtml(value)}">
      ${icon ? `<span class="routine-icon">${icon}</span>` : ''}
      <span class="sheet-row-main">
        <span class="sheet-row-title">${escHtml(title)}</span>
        ${sub ? `<span class="sheet-row-sub">${escHtml(sub)}</span>` : ''}
      </span>
      ${checked ? '<span class="sheet-row-check">✓</span>' : ''}
    </button>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  THUMBNAILS — the small demo frame beside an exercise row
// ─────────────────────────────────────────────────────────────────────────────

const THUMB_PLACEHOLDER = `
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
    <path d="m21 15-5-5L5 21"/></svg>`;

/**
 * The reference entry behind a plan exercise: the id stamped when it was picked
 * from the library wins, otherwise the authored id-map. Never fuzzy-matched.
 */
function referenceForPlanExercise(ex) {
  if (ex?.refId) {
    const entry = getReferenceById(ex.refId);
    // `imageMode: 'remote'` because only the exercises reachable through the
    // AUTHORED id-map have their frames vendored under data/exercise-images.
    // Guessing local for the rest would 404 once per picker row.
    if (entry) return { entry, confidence: 'high', imageMode: 'remote' };
  }
  if (!ex?.id) return null;
  // Also try the canonical id: a movement whose history was reunified under a
  // newer id still has its reference mapped under one of them.
  const mapped = referenceForExerciseId(ex.id) ?? referenceForExerciseId(canonicalExerciseId(ex.id));
  return mapped ? { ...mapped, imageMode: 'local' } : null;
}

/**
 * A thumbnail that tries the locally vendored frame first and falls back to the
 * remote one exactly once — the twenty plan exercises with vendored images stay
 * fully offline, everything else loads when there is a network and quietly
 * shows the placeholder when there is not.
 */
function exerciseThumbHTML(ex) {
  const ref = referenceForPlanExercise(ex);
  const rel = ref?.entry?.images?.[0];
  if (!rel) return THUMB_PLACEHOLDER;
  const remote = referenceImageUrl(rel);
  const src = ref.imageMode === 'local' ? `./data/exercise-images/${rel}` : remote;
  return `<img class="ex-thumb-img" src="${escHtml(src)}" alt=""
       loading="lazy" decoding="async" data-remote="${escHtml(remote)}"
       onerror="if(this.dataset.remote&&this.src!==this.dataset.remote){this.src=this.dataset.remote}else{this.remove()}" />`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PLAN TAB — RENDER
// ─────────────────────────────────────────────────────────────────────────────

function renderPlan() {
  const week = document.getElementById('plan-week');
  const list = document.getElementById('plan-routines');
  if (!week || !list) return;

  week.innerHTML = buildWeekScheduleHTML(state.plan);
  list.innerHTML = buildRoutineListHTML(state.plan);

  week.querySelectorAll('[data-plan-action="assign-day"]').forEach(btn => {
    btn.addEventListener('click', () => openDayAssignSheet(Number(btn.dataset.day)));
  });
  list.querySelectorAll('[data-plan-action="open-routine"]').forEach(btn => {
    btn.addEventListener('click', () => openRoutineEditor(btn.dataset.routine));
  });

  const newBtn = document.getElementById('new-routine-btn');
  if (newBtn && !newBtn._wired) {
    newBtn.addEventListener('click', createRoutine);
    newBtn._wired = true;
  }
}

/** Creates an empty routine and drops straight into its editor. */
async function createRoutine() {
  const routine = {
    id: generateId('rt'),
    name: 'New routine',
    glyph: DEFAULT_GLYPH,
    prog: 'linear',
    exercises: [],
  };
  state.plan.routines = [...routinesOf(state.plan), routine];
  await savePlan();
  openRoutineEditor(routine.id);
}

/** Assigns a routine (or rest) to one weekday of the recurring plan. */
function openDayAssignSheet(dayIdx) {
  const current = state.plan?.week?.[dayIdx] ?? null;

  const rows =
    sheetRowHTML({
      icon: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
               <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`,
      title: 'Rest day', checked: !current, action: 'assign', value: '',
    }) +
    routinesOf(state.plan).map(r => sheetRowHTML({
      icon: glyphSvg(r.glyph, 17),
      title: r.name,
      sub: exCountLabel(activeExercises(r).length),
      checked: current === r.id,
      action: 'assign', value: r.id,
    })).join('');

  openSheet(PLAN_DAY_NAMES[dayIdx], rows, (body) => {
    body.querySelectorAll('[data-sheet-action="assign"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        state.plan.week = { ...(state.plan.week ?? {}), [dayIdx]: btn.dataset.value || null };
        await savePlan();
        closeSheet();
        renderPlan();
        renderWeekStrip();
        const picked = routineById(state.plan, btn.dataset.value);
        showToast(picked ? `${PLAN_DAY_NAMES[dayIdx]}: ${picked.name}` : `${PLAN_DAY_NAMES[dayIdx]} is a rest day`);
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  RESCHEDULE ONE DATE — the "I was ill on Wednesday" escape hatch
//
//  Writes a single `dayPlan_<date>` meta key. The weekly plan is not touched,
//  so next Wednesday is unaffected; clearing the override puts the date back
//  under the week. This is deliberately a DIFFERENT surface from the weekday
//  assignment above: one changes every week, the other changes one day.
// ─────────────────────────────────────────────────────────────────────────────

function openRescheduleSheet(date) {
  const day = dayForDate(date);
  const currentId = day.overridden ? (day.isRest ? DAY_REST : day.routine?.id) : null;

  const intro = `
    <p class="sheet-note">
      Weekly plan: <strong>${escHtml(day.weekly?.name ?? 'Rest')}</strong>${
        day.overridden ? ' <span class="sheet-note-changed">· changed for this day</span>' : ''
      }<br />
      Sick, missed a day, or fewer gym days this week? Pick what to train instead —
      your weekly plan stays as it is.
    </p>`;

  const rows =
    (day.overridden ? sheetRowHTML({
      icon: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
               <polyline points="1 4 1 10 7 10"/><path d="M3.5 15a9 9 0 1 0 2.1-9.4L1 10"/></svg>`,
      title: 'Follow the weekly plan',
      sub: day.weekly ? day.weekly.name : 'Rest',
      action: 'reschedule', value: '__clear__',
    }) : '') +
    sheetRowHTML({
      icon: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
               <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`,
      title: 'Rest day', checked: currentId === DAY_REST, action: 'reschedule', value: DAY_REST,
    }) +
    routinesOf(state.plan).map(r => sheetRowHTML({
      icon: glyphSvg(r.glyph, 17),
      title: r.name,
      sub: exCountLabel(activeExercises(r).length),
      checked: currentId === r.id,
      action: 'reschedule', value: r.id,
    })).join('');

  openSheet(friendlyDateLabel(date), intro + rows, (body) => {
    body.querySelectorAll('[data-sheet-action="reschedule"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const v = btn.dataset.value;
        await setDayOverride(date, v === '__clear__' ? null : v);
        closeSheet();
        renderToday();
        renderWeekStrip();
        renderHubIfVisible();
        showToast(
          v === '__clear__' ? 'Back to the weekly plan'
            : v === DAY_REST ? `${friendlyDateLabel(date)} set to rest`
            : `${routineById(state.plan, v)?.name} planned for ${friendlyDateLabel(date)}`
        );
      });
    });
  });
}

/** Repaints the hub only when it is the visible tab (cheap guard, used above). */
function renderHubIfVisible() {
  if (state.ui.currentView === 'hub') renderHub();
}

// ─────────────────────────────────────────────────────────────────────────────
//  ROUTINE EDITOR
// ─────────────────────────────────────────────────────────────────────────────

function currentRoutine() {
  return routineById(state.plan, state.ui.editingRoutineId);
}

function openRoutineEditor(routineId) {
  state.ui.editingRoutineId = routineId;
  switchView('routine');
}

function renderRoutine() {
  const routine = currentRoutine();
  if (!routine) { switchView('plan'); return; }

  const nameInput = document.getElementById('routine-name-input');
  if (document.activeElement !== nameInput) nameInput.value = routine.name;
  document.getElementById('routine-glyph-btn').innerHTML = glyphSvg(routine.glyph, 18);
  document.getElementById('routine-progression').innerHTML = buildProgressionRowHTML(routine);

  renderRoutineExercises(routine);
  renderRoutineCoverage(routine);
  wireRoutineEditor(routine);
}

function renderRoutineExercises(routine) {
  const host = document.getElementById('routine-exercises');
  const list = activeExercises(routine);

  if (!list.length) {
    host.innerHTML = `
      <div class="plan-empty">
        <p class="plan-empty-title">No exercises yet.</p>
        <p class="plan-empty-sub">Add your first one below.</p>
      </div>`;
    return;
  }

  const units = supersetUnits(list);
  const firstOfPair = new Set(units.filter(u => u.length > 1).map(u => u[0]));
  const inPair = new Set(units.filter(u => u.length > 1).flat());

  host.innerHTML = `<div class="routine-ex-list">${list.map((ex, i) =>
    buildRoutineExerciseRowHTML(ex, i, {
      thumbHtml: exerciseThumbHTML(ex),
      linkedAbove: i > 0 && !!ex.sg && list[i - 1].sg === ex.sg,
      inSuperset: inPair.has(i),
      first: firstOfPair.has(i),
    })).join('')}</div>`;
}

/**
 * The coverage card. The body geometry is a dynamic import, so the card draws
 * its placeholder first and repaints once the artwork lands — the same two-pass
 * the Stats tab uses.
 */
function renderRoutineCoverage(routine) {
  const host = document.getElementById('routine-coverage');
  const load = routineLoad(routine, resolveExerciseMuscles);
  host.innerHTML = buildRoutineCoverageHTML(routine, buildLoadBodyMap(load));
  if (!bodyPathsReady()) {
    loadBodyPaths().then(() => {
      if (state.ui.currentView === 'routine' && currentRoutine()?.id === routine.id) {
        renderRoutineCoverage(currentRoutine());
      }
    });
  }
}

function wireRoutineEditor(routine) {
  const host = document.getElementById('view-routine');

  // Exercise rows — config, reorder, superset link.
  host.querySelectorAll('[data-plan-action]').forEach(el => {
    el.addEventListener('click', async () => {
      const i = Number(el.dataset.index);
      const list = activeExercises(currentRoutine());
      switch (el.dataset.planAction) {
        case 'config-exercise':  openExerciseConfigSheet(list[i], i); break;
        case 'move-up':          await moveRoutineExercise(i, -1); break;
        case 'move-down':        await moveRoutineExercise(i, 1);  break;
        case 'toggle-link':      await toggleSuperset(i); break;
        case 'routine-progression': openProgressionSheet(null); break;
      }
    });
  });

  // One-time wiring for the controls that live in the static markup.
  if (host._wired) return;
  host._wired = true;

  document.getElementById('routine-back-btn').addEventListener('click', () => switchView('plan'));

  document.getElementById('routine-name-input').addEventListener('input', debounce(async (e) => {
    const r = currentRoutine();
    if (!r) return;
    r.name = e.target.value.trim() || 'Routine';
    await savePlan();
  }, 400));

  document.getElementById('routine-glyph-btn').addEventListener('click', openGlyphPicker);
  document.getElementById('routine-add-ex-btn').addEventListener('click', () =>
    openExercisePicker(def => openExerciseConfigSheet(def, null)));
  document.getElementById('routine-delete-btn').addEventListener('click', deleteRoutine);
}

/** Trailing-edge debounce, so a name typed character by character saves once. */
function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** The index of the nth ACTIVE exercise inside the routine's full array. */
function activeIndexToReal(routine, activeIdx) {
  let seen = -1;
  for (let i = 0; i < routine.exercises.length; i++) {
    if (routine.exercises[i].archived) continue;
    if (++seen === activeIdx) return i;
  }
  return -1;
}

async function moveRoutineExercise(activeIdx, dir) {
  const routine = currentRoutine();
  const list = activeExercises(routine);
  const target = activeIdx + dir;
  if (target < 0 || target >= list.length) return;

  const a = activeIndexToReal(routine, activeIdx);
  const b = activeIndexToReal(routine, target);
  const ex = routine.exercises;
  [ex[a], ex[b]] = [ex[b], ex[a]];
  cleanupSupersets(activeExercises(routine));

  await savePlan();
  renderRoutine();
}

/** Links or unlinks an exercise with the one above it into a superset. */
async function toggleSuperset(activeIdx) {
  if (activeIdx < 1) return;
  const routine = currentRoutine();
  const list = activeExercises(routine);
  const cur = list[activeIdx], prev = list[activeIdx - 1];

  if (cur.sg && prev.sg && cur.sg === prev.sg) {
    delete cur.sg;
  } else {
    const gid = prev.sg || `sg_${generateId('s')}`;
    prev.sg = gid;
    cur.sg = gid;
  }
  cleanupSupersets(list);

  await savePlan();
  renderRoutine();
}

async function deleteRoutine() {
  const routine = currentRoutine();
  if (!routine) return;

  showDialog(
    `Delete "${routine.name}"? Any day it is assigned to becomes a rest day. Logged history is kept.`,
    async () => {
      for (const ex of routine.exercises ?? []) await archiveExerciseToRegistry(ex);

      state.plan.routines = routinesOf(state.plan).filter(r => r.id !== routine.id);
      const week = { ...(state.plan.week ?? {}) };
      for (const k in week) if (week[k] === routine.id) week[k] = null;
      state.plan.week = week;
      await savePlan();

      // One-off overrides pointing at it are dropped too, so a past date does
      // not silently fall back to a routine the user just deleted.
      for (const key of Object.keys(state.meta)) {
        if (key.startsWith('dayPlan_') && state.meta[key]?.value === routine.id) {
          await del('meta', key);
          delete state.meta[key];
        }
      }

      state.ui.editingRoutineId = null;
      switchView('plan');
      renderWeekStrip();
      showToast(`"${routine.name}" deleted.`);
    },
    { confirmLabel: 'Delete' }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  ROUTINE ICON PICKER
// ─────────────────────────────────────────────────────────────────────────────

function openGlyphPicker() {
  const routine = currentRoutine();
  const grid = `<div class="glyph-grid">${Object.keys(GLYPHS).map(name => `
    <button class="glyph-option${glyphOf(routine.glyph) === name ? ' is-on' : ''}" type="button"
            data-glyph="${name}" aria-label="Icon: ${name}">${glyphSvg(name, 20)}</button>`).join('')}</div>`;

  openSheet('Routine icon', grid, (body) => {
    body.querySelectorAll('[data-glyph]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const r = currentRoutine();
        r.glyph = btn.dataset.glyph;
        await savePlan();
        closeSheet();
        renderRoutine();
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  PROGRESSION RULE PICKER
//
//  `exercise` null → the routine's own default. Otherwise the per-exercise
//  override, which additionally offers "follow the routine".
// ─────────────────────────────────────────────────────────────────────────────

function openProgressionSheet(exerciseDraft, onPick) {
  const routine = currentRoutine();
  const mode = exerciseDraft ? loggingModeOf(exerciseDraft) : 'reps';
  const allowed = POLICIES_FOR[mode] ?? ['off'];
  const current = exerciseDraft ? (exerciseDraft.prog ?? '') : (routine?.prog || 'linear');

  const followRow = exerciseDraft ? sheetRowHTML({
    title: `Follow the routine (${POLICY_NAME[routine?.prog || 'linear']})`,
    sub: 'Whatever this routine is set to, including later changes.',
    checked: !current, action: 'policy', value: '',
  }) : '';

  const rows = allowed.map(p => sheetRowHTML({
    title: POLICY_NAME[p], sub: POLICY_DESC[p],
    checked: current === p, action: 'policy', value: p,
  })).join('');

  openSheet('Progression', followRow + rows, (body) => {
    body.querySelectorAll('[data-sheet-action="policy"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const v = btn.dataset.value;
        if (exerciseDraft) {
          closeSheet();
          onPick?.(v);
          return;
        }
        currentRoutine().prog = v || 'linear';
        await savePlan();
        closeSheet();
        renderRoutine();
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  EXERCISE PICKER
//
//  Two sources, in this order: exercises the user has ALREADY logged (picking
//  one reuses its id, so history and PBs stay attached), then the vendored
//  open reference dataset. That order is the whole point — a fresh id for a
//  movement already in the log would silently fork its history.
// ─────────────────────────────────────────────────────────────────────────────

const PICKER_LIMIT = 40;

function openExercisePicker(onPick) {
  const html = `
    <input type="search" class="lib-search sheet-search" id="picker-search"
           placeholder="Search exercises…" aria-label="Search exercises" autocomplete="off" />
    <div class="sheet-list" id="picker-results"></div>`;

  openSheet('Add exercise', html, (body) => {
    const input = body.querySelector('#picker-search');
    const out   = body.querySelector('#picker-results');

    const paint = () => {
      const q = input.value.trim();
      out.innerHTML = buildPickerResultsHTML(q);
      out.querySelectorAll('[data-pick-known]').forEach(btn => {
        btn.addEventListener('click', () => {
          const def = buildKnownExerciseList().find(e => e.id === btn.dataset.pickKnown);
          if (def) onPick(planExerciseFromKnown(def));
        });
      });
      out.querySelectorAll('[data-pick-ref]').forEach(btn => {
        btn.addEventListener('click', () => {
          const entry = getReferenceById(btn.dataset.pickRef);
          if (entry) onPick(planExerciseFromReference(entry));
        });
      });
    };

    input.addEventListener('input', debounce(paint, 140));
    paint();
    input.focus();
  });
}

function buildPickerResultsHTML(query) {
  const q = query.toLowerCase();
  const known = buildKnownExerciseList()
    .filter(e => !q || e.name.toLowerCase().includes(q))
    .slice(0, 8);

  const refs = filterReference({ query, category: 'lifting' }).slice(0, PICKER_LIMIT);

  const knownBlock = known.length ? `
    <h4 class="sheet-group-label">Your exercises</h4>
    ${known.map(e => `
      <button class="sheet-row" type="button" data-pick-known="${escHtml(e.id)}">
        <span class="routine-ex-thumb">${exerciseThumbHTML(e)}</span>
        <span class="sheet-row-main">
          <span class="sheet-row-title">${escHtml(e.name)}</span>
          <span class="sheet-row-sub">${escHtml(e.muscles || 'Keeps its logged history')}</span>
        </span>
      </button>`).join('')}` : '';

  const refBlock = refs.length ? `
    <h4 class="sheet-group-label">Exercise library</h4>
    ${refs.map(entry => `
      <button class="sheet-row" type="button" data-pick-ref="${escHtml(entry.id)}">
        <span class="routine-ex-thumb">${exerciseThumbHTML({ refId: entry.id })}</span>
        <span class="sheet-row-main">
          <span class="sheet-row-title">${escHtml(entry.name)}</span>
          <span class="sheet-row-sub">${escHtml([refLabel(entry.primaryMuscles?.[0]), refLabel(entry.equipment)].filter(Boolean).join(' · '))}</span>
        </span>
      </button>`).join('')}` : '';

  if (!knownBlock && !refBlock) {
    return `<p class="mm-empty">Nothing matches "${escHtml(query)}".</p>`;
  }
  return knownBlock + refBlock;
}

/** A plan exercise built from one the user has logged before — id preserved. */
function planExerciseFromKnown(def) {
  return {
    id: def.id,
    name: def.name,
    sets: def.sets ?? 3,
    reps: def.reps ?? '8',
    unit: def.unit ?? 'reps',
    loadType: def.loadType ?? getExerciseLoadType(def.id) ?? undefined,
    muscles: def.muscles ?? resolveExerciseMuscles(def),
    cue: def.cue ?? '',
  };
}

/**
 * A plan exercise built from a reference entry. The loadType comes from the
 * vendored library when the name matches (the authoritative source), and only
 * falls back to an equipment reading when it does not — "body only" is a
 * bodyweight movement, and that is a fact about the equipment, not a guess.
 */
function planExerciseFromReference(entry) {
  const lib = matchLibraryEntry(entry.name);
  const loadType = lib?.loadType
    ?? (entry.equipment === 'body only' ? 'bodyweight' : 'weighted');
  return {
    id: generateId('ex'),
    refId: entry.id,
    name: entry.name,
    sets: 3,
    reps: '8',
    unit: 'reps',
    loadType,
    muscles: [...(entry.primaryMuscles ?? []), ...(entry.secondaryMuscles ?? [])].join(' · '),
    cue: '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  EXERCISE CONFIG SHEET
//
//  Edits a DRAFT copy and only writes it on Save, so backing out of the sheet
//  cannot half-apply a change. `index` null means "not in the routine yet".
// ─────────────────────────────────────────────────────────────────────────────

function stepperHTML(field, label, value, { step = 1, min = 0 } = {}) {
  return `
    <div class="stepper-field">
      <span class="stepper-label">${escHtml(label)}</span>
      <div class="stepper" data-stepper="${field}" data-step="${step}" data-min="${min}">
        <button class="stepper-btn" type="button" data-delta="-1" aria-label="Decrease ${escHtml(label)}">−</button>
        <input class="stepper-value" type="number" inputmode="decimal" step="${step}" min="${min}"
               value="${escHtml(String(value))}" aria-label="${escHtml(label)}" />
        <button class="stepper-btn" type="button" data-delta="1" aria-label="Increase ${escHtml(label)}">+</button>
      </div>
    </div>`;
}

function toggleRowHTML(field, title, sub, on, iconPath) {
  return `
    <div class="config-toggle-row">
      <span class="routine-icon routine-icon-sm">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPath}</svg>
      </span>
      <span class="config-toggle-text">
        <span class="config-toggle-title">${escHtml(title)}</span>
        <span class="config-toggle-sub">${escHtml(sub)}</span>
      </span>
      <button class="settings-toggle" type="button" role="switch" aria-checked="${on}"
              data-config-toggle="${field}" aria-label="${escHtml(title)}">
        <span class="settings-toggle-knob"></span>
      </button>
    </div>`;
}

function openExerciseConfigSheet(source, index) {
  const routine = currentRoutine();
  const draft = { ...source };
  draft.sets = Number(draft.sets) || 3;
  draft.weight = Number(draft.weight) || 0;

  const render = () => {
    const isTimed = draft.loadType === 'timed' || draft.unit === 'seconds';
    const isBw    = draft.loadType === 'bodyweight';
    const ref     = referenceForPlanExercise(draft);
    const effortLabel = isTimed ? 'Seconds' : 'Reps';
    const effortVal   = String(draft.reps ?? (isTimed ? '30' : '8'));

    const chips = ref ? [refLabel(ref.entry.primaryMuscles?.[0]), refLabel(ref.entry.equipment)]
      .filter(Boolean).map(c => `<span class="mm-chip">${escHtml(c)}</span>`).join('') : '';

    const policy = policyFor(draft, routine);
    const ruleLabel = draft.prog
      ? POLICY_NAME[draft.prog]
      : `Follow the routine (${POLICY_NAME[routine?.prog || 'linear']})`;
    const stepUnit = loggingModeOf(draft) === 'time' ? 's' : 'kg';

    return `
      ${ref ? refFramesHTML(ref.entry, ref.imageMode ?? 'remote') : ''}
      ${chips ? `<div class="mm-chips config-chips">${chips}</div>` : ''}

      <div class="segmented config-mode" role="tablist">
        <button class="segmented-btn${!isTimed ? ' is-on' : ''}" type="button" data-mode="reps" role="tab" aria-selected="${!isTimed}">Reps</button>
        <button class="segmented-btn${isTimed ? ' is-on' : ''}" type="button" data-mode="time" role="tab" aria-selected="${isTimed}">Time</button>
      </div>

      <div class="stepper-row">
        ${stepperHTML('sets', 'Sets', draft.sets, { step: 1, min: 1 })}
        ${stepperHTML('reps', effortLabel, effortVal, { step: 1, min: 1 })}
        ${!isTimed ? stepperHTML('weight', 'Weight (kg)', draft.weight, { step: 0.5, min: 0 }) : ''}
      </div>

      <div class="config-toggles">
        ${toggleRowHTML('bodyweight', 'Bodyweight', 'Ask for a weight on every set.', isBw,
          '<circle cx="12" cy="4.5" r="1.8"/><path d="M12 7v6"/><path d="M6 9l6 2 6-2"/><path d="M12 13l-3 8"/><path d="M12 13l3 8"/>')}
        ${toggleRowHTML('perSide', 'Reps per side', 'For lunges, single-arm rows and the like.', !!draft.perSide,
          '<path d="M8 7 4 11l4 4"/><path d="M16 7l4 4-4 4"/><path d="M4 11h16"/>')}
      </div>

      <h4 class="sheet-group-label">Progression</h4>
      <button class="plan-row plan-row-setting" type="button" data-config-rule>
        <span class="plan-row-title">Rule</span>
        <span class="plan-row-value">${escHtml(ruleLabel)}</span>
        ${CONFIG_CHEVRON}
      </button>
      <p class="plan-section-note">${escHtml(POLICY_DESC[policy])}</p>
      ${policy !== 'off' ? `<div class="stepper-row stepper-row-single">
        ${stepperHTML('inc', `Step (${stepUnit})`, incrementFor(draft), { step: 0.5, min: 0.5 })}
      </div>` : ''}

      <button class="btn-primary btn-block" type="button" data-config-save>Save</button>
      ${index != null ? `<button class="btn-danger btn-block" type="button" data-config-remove>Remove from routine</button>` : ''}`;
  };

  const mount = (body) => {
    body.innerHTML = render();

    body.querySelectorAll('[data-ref-frames-toggle]').forEach(btn => {
      btn.addEventListener('click', () => btn.closest('[data-ref-frames]')?.classList.toggle('ref-frames-show-1'));
    });

    // Reps ↔ Time. Switching to Time makes it a timed exercise; switching back
    // restores a loaded type rather than leaving it in limbo.
    body.querySelectorAll('[data-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        const toTime = btn.dataset.mode === 'time';
        draft.unit = toTime ? 'seconds' : 'reps';
        draft.loadType = toTime ? 'timed' : (draft.loadType === 'timed' ? 'weighted' : draft.loadType);
        if (toTime && !/^\d/.test(String(draft.reps))) draft.reps = '30';
        draft.prog = ''; // the old rule may not be legal in the new mode
        mount(body);
      });
    });

    body.querySelectorAll('.stepper').forEach(st => {
      const input = st.querySelector('.stepper-value');
      const field = st.dataset.stepper;
      const step  = Number(st.dataset.step);
      const min   = Number(st.dataset.min);
      const commit = (v) => {
        const n = Math.max(min, Math.round(v / step) * step);
        const clean = Number(n.toFixed(2));
        input.value = String(clean);
        if (field === 'reps') draft.reps = String(clean);
        else draft[field] = clean;
      };
      st.querySelectorAll('.stepper-btn').forEach(btn => {
        btn.addEventListener('click', () => commit((Number(input.value) || 0) + Number(btn.dataset.delta) * step));
      });
      input.addEventListener('change', () => commit(Number(input.value) || min));
    });

    body.querySelectorAll('[data-config-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const field = btn.dataset.configToggle;
        if (field === 'bodyweight') {
          draft.loadType = draft.loadType === 'bodyweight' ? 'weighted' : 'bodyweight';
          draft.prog = '';
        } else {
          draft.perSide = !draft.perSide;
        }
        mount(body);
      });
    });

    body.querySelector('[data-config-rule]')?.addEventListener('click', () => {
      openProgressionSheet(draft, (v) => {
        draft.prog = v;
        openExerciseConfigSheetWith(draft, index, source);
      });
    });

    body.querySelector('[data-config-save]')?.addEventListener('click', async () => {
      await commitExerciseDraft(draft, index);
      closeSheet();
    });

    body.querySelector('[data-config-remove]')?.addEventListener('click', () => {
      closeSheet();
      confirmRemoveExercise(index);
    });
  };

  openSheet(draft.name, '', mount);
}

/** Reopens the config sheet on an in-progress draft (after the rule picker). */
function openExerciseConfigSheetWith(draft, index) {
  openExerciseConfigSheet(draft, index);
}

/** Writes a finished draft into the routine — appending, or replacing in place. */
async function commitExerciseDraft(draft, index) {
  const routine = currentRoutine();
  if (!routine) return;

  const entry = { ...draft };
  if (!entry.prog) delete entry.prog;      // "" means follow the routine
  if (!entry.perSide) delete entry.perSide;
  if (!(entry.weight > 0)) delete entry.weight;
  entry.sets = Number(entry.sets) || 3;
  entry.reps = String(entry.reps ?? '8');
  entry.archived = false;

  if (index == null) {
    routine.exercises = [...(routine.exercises ?? []), entry];
  } else {
    const real = activeIndexToReal(routine, index);
    // The superset id belongs to the POSITION, not to the exercise, so it is
    // carried over rather than taken from the draft.
    entry.sg = routine.exercises[real]?.sg;
    if (!entry.sg) delete entry.sg;
    routine.exercises[real] = entry;
  }

  await savePlan();
  renderRoutine();
}

function confirmRemoveExercise(index) {
  const routine = currentRoutine();
  const ex = activeExercises(routine)[index];
  if (!ex) return;

  showDialog(
    `Remove "${ex.name}" from ${routine.name}? Its logged history is kept.`,
    async () => {
      await archiveExerciseToRegistry(ex);
      const real = activeIndexToReal(routine, index);
      routine.exercises.splice(real, 1);
      cleanupSupersets(activeExercises(routine));
      await savePlan();
      renderRoutine();
      showToast(`"${ex.name}" removed.`);
    },
    { confirmLabel: 'Remove' }
  );
}

const CONFIG_CHEVRON = `<svg class="row-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none"
     stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
     aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>`;
// ─────────────────────────────────────────────────────────────────────────────
//  DATA TAB
// ─────────────────────────────────────────────────────────────────────────────

function renderData() {
  showAppVersion();
  renderStorageStatus();
  // Serialise a fresh snapshot now so Back up can call share() synchronously.
  prepareBackupSnapshot();

  // Surface the orphan-naming card only when there is something to name.
  const orphanCount = findOrphanExerciseIds().length;
  const card = document.getElementById('orphan-review-card');
  const btn  = document.getElementById('review-orphans-btn');
  if (card && btn) {
    card.hidden = orphanCount === 0;
    btn.textContent = `Name ${orphanCount} unnamed exercise${orphanCount === 1 ? '' : 's'}`;
  }
}

/**
 * Ask the active service worker for its CACHE_VERSION and show it as the app
 * version. The SW's constant is the single source of truth (see its `message`
 * handler); the page never hardcodes a number. When no SW controls the page yet
 * — first load before activation, or a browser without service workers — the
 * readout is left blank rather than showing a fake/stale version.
 */
async function showAppVersion() {
  const el = document.getElementById('app-version');
  if (!el) return;
  el.textContent = (await requestServiceWorkerVersion()) ?? '';
}

/** The active SW's CACHE_VERSION via a MessageChannel round-trip, or null. */
function requestServiceWorkerVersion() {
  return new Promise((resolve) => {
    const sw = navigator.serviceWorker?.controller;
    if (!sw) { resolve(null); return; }

    const channel = new MessageChannel();
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    channel.port1.onmessage = (e) => done(e.data?.version ?? null);
    // Guard against a SW that never answers so the readout can't hang blank.
    setTimeout(() => done(null), 1000);

    try {
      sw.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
    } catch {
      done(null);
    }
  });
}

/**
 * Unobtrusive read-out of whether the browser granted persistent storage.
 *
 * `navigator.storage.persist()` is requested once at startup; this only reports
 * the answer. Persistence exempts IndexedDB from automatic eviction under
 * storage pressure — it does NOT survive a deliberate "clear cookies and site
 * data" or a PWA uninstall. The real second copy is the JSON export kept
 * somewhere off-device; treat IndexedDB as a local cache, not the only record.
 */
async function renderStorageStatus() {
  const dot  = document.getElementById('storage-status-dot');
  const text = document.getElementById('storage-status-text');
  if (!dot || !text) return;

  if (!navigator.storage?.persisted) {
    dot.className = 'storage-status-dot storage-status-unknown';
    text.textContent = 'This browser cannot report storage protection.';
    return;
  }

  try {
    const persisted = await navigator.storage.persisted();
    dot.className = `storage-status-dot ${persisted ? 'storage-status-on' : 'storage-status-off'}`;
    text.textContent = persisted
      ? 'Storage protected from automatic eviction. Keep exporting anyway.'
      : 'Storage protection isn’t confirmed on this browser. Keep an off-device backup.';
  } catch {
    dot.className = 'storage-status-dot storage-status-unknown';
    text.textContent = 'Storage protection state unavailable.';
  }
}

/**
 * Serialises the whole app into the portable snapshot the roadmap treats as the
 * real source of truth. IndexedDB is only a cache of this — a wiped app can be
 * rebuilt whole from a snapshot alone (see the restore path and PHASE1 test).
 * Same format the download and Web Share paths both emit.
 */
async function buildBackupPayload() {
  const [planDoc, allLogs, allBw, allMeta, allBodyComp] = await Promise.all([
    get('plan', PLAN_DOC_ID),
    getAll('logs'),
    getAll('bodyweight'),
    getAll('meta'),
    getAll('bodyComposition'),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    version:    2,
    plan:       planDoc,
    logs:       allLogs,
    bodyweight: allBw,
    meta:       allMeta,
    // Raw Fitdays readings exactly as imported — no daily collapse, no
    // derived series, no session pairing. The analysis layer derives what it
    // needs from these; raw is the source of truth.
    bodyComposition: allBodyComp,
  };
}

/**
 * The most recent snapshot, serialised and ready to hand to the share sheet.
 * Built asynchronously when the Data tab opens (see `prepareBackupSnapshot`) so
 * that the Back-up tap can call `navigator.share()` SYNCHRONOUSLY.
 *
 * This is the crux of getting "Save to Drive" to work on Chrome Android: Web
 * Share requires transient user activation, and `await`-ing anything (like an
 * IndexedDB read) before `share()` breaks the activation chain — Chrome then
 * rejects the call with `NotAllowedError: Permission denied` and we fall back to
 * a plain download. Nothing on the Data tab mutates data between opening it and
 * tapping Back up, so a snapshot prepared on tab-open is still current at tap.
 */
let preparedBackup = null; // { file, json, dateStr } | null

/**
 * Serialise the current snapshot AND pre-build the shareable File ahead of time,
 * off-gesture. Pre-creating the File means the Back-up tap does the absolute
 * minimum synchronous work before `navigator.share()` — just reads a variable —
 * giving the tap's user activation the best possible chance of surviving.
 */
async function prepareBackupSnapshot() {
  try {
    const payload = await buildBackupPayload();
    const json    = JSON.stringify(payload, null, 2);
    const dateStr = todayStr();
    preparedBackup = { file: pickShareableFile(json, dateStr), json, dateStr };
  } catch (err) {
    console.error('[FitTrack] Could not prepare backup snapshot:', err);
    preparedBackup = null;
  }
}

/**
 * Back the data up off-device. On a phone that can share files, this hands the
 * JSON snapshot to the system share sheet, where "Save to Drive" is one tap away
 * — giving the data a durable home outside wipeable browser storage. Everywhere
 * the file-share API is absent (most desktops) it falls back to a plain file
 * download. This share hand-off is the app's ONLY network interaction: no Drive
 * API, no OAuth, no credentials — the OS moves the file, not us.
 *
 * MUST stay synchronous up to the `navigator.share()` call — no `await` before
 * it — or Chrome Android voids the tap's user activation and throws
 * NotAllowedError. All the async work already happened in `prepareBackupSnapshot`;
 * here we only touch the in-memory `preparedBackup`.
 */
function handleExport() {
  const snap = preparedBackup;

  // Snapshot not ready yet (tab opened and tapped in the same instant): we can't
  // share outside the gesture, so just build and download.
  if (!snap) {
    buildBackupPayload()
      .then(p => downloadBackup(JSON.stringify(p, null, 2), todayStr()))
      .catch(err => {
        console.error('[FitTrack] Backup failed:', err);
        showToast('Backup failed — see console.');
      });
    return;
  }

  const { file, json, dateStr } = snap;

  if (file) {
    // Share the file ONLY — no title/text. Some Android share targets reject a
    // files payload that also carries title/text with NotAllowedError even when
    // canShare() said yes, so we send the leanest possible payload.
    navigator.share({ files: [file] })
      .then(() => { recordBackupDate(); showToast('Backup ready — save it to Drive.'); })
      .catch(err => {
        // A cancelled share sheet is not an error — leave the user be.
        if (err?.name === 'AbortError') return;
        console.error('[FitTrack] Share failed, falling back to download:', err);
        downloadBackup(json, dateStr);
      });
    return;
  }

  // No shareable file (e.g. desktop) — download the snapshot instead.
  downloadBackup(json, dateStr);
}

/**
 * The snapshot as a File the platform will actually accept for sharing, or null
 * if it can't share files at all.
 *
 * Chrome's Web Share file-type allowlist is the catch here: `application/json`
 * is NOT on it, so sharing a JSON-typed file makes `canShare` return false and
 * silently drops us to a download with no "Save to Drive" sheet — exactly the
 * bug this fixes. The allowlist is matched on MIME type, and `text/plain` IS on
 * it, so we present the snapshot as text/plain. We keep the `.json` filename
 * first (carried through since the check is MIME- not extension-based) and fall
 * back to a `.txt` name only for any build that additionally gates on extension.
 */
function pickShareableFile(json, dateStr) {
  if (!navigator.canShare) return null;
  const candidates = [
    new File([json], `fittrack-${dateStr}.json`, { type: 'text/plain' }),
    new File([json], `fittrack-${dateStr}.txt`,  { type: 'text/plain' }),
  ];
  return candidates.find(f => navigator.canShare({ files: [f] })) ?? null;
}

/** Save the snapshot as a real .json download — the fallback when sharing is absent. */
function downloadBackup(json, dateStr) {
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href:     url,
    download: `fittrack-${dateStr}.json`,
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  recordBackupDate();
  showToast('Backup downloaded.');
}

/**
 * Stamp today as the last-backup date after a successful share or download.
 * Not called on an aborted share or a failure. Written as a normal meta record
 * so it round-trips through the JSON snapshot. Idempotent within a day (no
 * repeated writes), and refreshes the hub card if it's mounted.
 */
async function recordBackupDate() {
  const today = todayStr();
  if (state.meta[LAST_BACKUP_KEY]?.value === today) return; // already stamped today
  const doc = { key: LAST_BACKUP_KEY, value: today };
  try {
    await put('meta', doc);
    state.meta[LAST_BACKUP_KEY] = doc;
    if (document.getElementById('hub-content')) renderHub();
  } catch (err) {
    console.error('[FitTrack] Could not record backup date:', err);
  }
}

/** Records from `list` whose `keyField` value isn't already in `have`. */
function dedupeNew(list, keyField, have) {
  const seen  = new Set();
  const fresh = [];
  for (const rec of list) {
    const k = rec?.[keyField];
    if (k == null || have.has(k) || seen.has(k)) continue;
    seen.add(k);
    fresh.push(rec);
  }
  return fresh;
}

/** Plain-language outcome for a restore, matching the Fitdays import voice. */
function restoreSummaryMessage({ sessions, readings, present }) {
  const parts = [];
  if (sessions > 0) parts.push(`${sessions} new session${sessions === 1 ? '' : 's'}`);
  if (readings > 0) parts.push(`${readings} new body-composition reading${readings === 1 ? '' : 's'}`);

  if (!parts.length) {
    return present > 0
      ? `Already up to date — all ${present} record${present === 1 ? '' : 's'} were already present.`
      : 'Nothing to restore from that backup.';
  }

  let msg = `Restored ${parts.join(' and ')}.`;
  if (present > 0) msg += ` ${present} record${present === 1 ? '' : 's'} already present.`;
  return msg;
}

/**
 * Restore from a snapshot by MERGING it into what's already here — never wiping
 * first. Training sessions and body-composition readings are append-only and
 * keyed deterministically (log id / reading datetime), so a record already
 * present is left untouched: restoring an OLDER snapshot can't delete newer
 * local data, and restoring a NEWER one can't create duplicates — the same
 * dedupe-on-key idiom the Fitdays import uses.
 *
 * Plan and settings are current config, not accumulating history, so they're
 * restored (overwritten) from the snapshot. That overwrite is exactly what lets
 * a wiped app — where startup has just seeded a default plan — come back whole
 * from a snapshot alone.
 */
async function handleImport(event) {
  const file = event.target.files?.[0];
  event.target.value = ''; // reset immediately so the same file can be re-selected
  if (!file) return;

  showDialog(
    `Restore from "${file.name}"? New sessions and readings are added to what you already have — nothing is deleted. Your plan and settings are restored from the file.`,
    async () => {
      try {
        const text    = await file.text();
        const payload = JSON.parse(text);

        // Structure-only guard: a valid backup needs a plan and a logs array.
        // `version` is deliberately NOT required — buildBackupPayload stamps
        // v2, but the merge below tolerates v1/version-less files (absent
        // `bodyComposition`/`meta` simply contribute nothing), so an older or
        // hand-edited export must still restore.
        if (!payload.plan || !Array.isArray(payload.logs)) {
          throw new Error('Unrecognised FitTrack backup format.');
        }

        // Keys already in each append-only store — anything present is kept as-is.
        const [logKeys, bcKeys, bwKeys] = await Promise.all([
          getAllKeys('logs'),
          getAllKeys('bodyComposition'),
          getAllKeys('bodyweight'),
        ]);
        const freshLogs = dedupeNew(payload.logs            ?? [], 'id',       new Set(logKeys));
        const freshBc   = dedupeNew(payload.bodyComposition ?? [], 'datetime', new Set(bcKeys));
        const freshBw   = dedupeNew(payload.bodyweight      ?? [], 'date',     new Set(bwKeys));

        // Plan + settings: restore (overwrite). Records: write only the new ones.
        // `bodyComposition`/`meta` are absent from v1 backups — those simply
        // contribute nothing rather than failing.
        await Promise.all([
          put('plan', payload.plan),
          ...(payload.meta ?? []).map(m => put('meta', m)),
          putMany('logs', freshLogs),
          putMany('bodyComposition', freshBc),
          putMany('bodyweight', freshBw),
        ]);

        await loadState();
        await dropRetiredMeta();
        // A backup written before routines existed carries a v1 plan; bring it
        // forward exactly as a first load would, or the Plan tab reads empty.
        await migratePlanToRoutines();
        await migrateExerciseUnits();
        await migrateInclineDbLabel();
        await migrateExerciseLoadTypes();
        state.ui.viewedDate = state.ui.today;
        render();

        // "sessions" counts distinct new training days; the dedupe is per-set,
        // so this is the human-readable unit, never an overcount.
        const present =
          ((payload.logs?.length            ?? 0) - freshLogs.length) +
          ((payload.bodyComposition?.length ?? 0) - freshBc.length)  +
          ((payload.bodyweight?.length      ?? 0) - freshBw.length);
        showToast(restoreSummaryMessage({
          sessions: new Set(freshLogs.map(l => l.date)).size,
          readings: freshBc.length,
          present,
        }), 4000);
      } catch (err) {
        console.error('[FitTrack] Restore failed:', err);
        showToast(`Restore failed: ${err.message}`);
      }
    },
    { confirmLabel: 'Restore', danger: false }
  );
}

async function handleClearData() {
  // IndexedDB is a wipeable cache; the only durable copy is the off-device JSON
  // snapshot. So offer a one-tap backup (the existing export) before the
  // destructive confirm. "Back up first" runs the export and leaves this dialog
  // open; declining it still lands on the same delete confirm below.
  showDialog(
    'Delete ALL workouts, logs, body-composition readings, and settings? This cannot be undone. Back up first if you want an off-device copy.',
    async () => {
      try {
        await Promise.all([
          clear('plan'),
          clear('logs'),
          clear('bodyweight'),
          clear('meta'),
          clear('bodyComposition'),
        ]);

        state.plan                  = null;
        state.logs                  = [];
        state.bodyComposition       = [];
        state.meta                  = {};
        state.ui.expandedExerciseId = null;
        state.ui.viewedDate         = state.ui.today;

        await seedIfFirstRun();
        render();
        showToast('All data cleared.');
      } catch (err) {
        console.error('[FitTrack] Clear failed:', err);
        showToast('Failed to clear data.');
      }
    },
    { confirmLabel: 'Clear All Data', extraAction: { label: 'Back up first', onClick: handleExport } }
  );
}
