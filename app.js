/**
 * app.js  —  FitTrack · Application Engine  (Part 1 of 2)
 *
 * Contains: constants, date utilities, global state, seed data,
 * DB↔state sync, render dispatch, navigation, header, week strip,
 * and init(). All tab renders and event handlers follow in Part 2.
 */

import { get, put, del, getAll, clear } from './db.js';
import { renderInsightsTab, checkForNewPB } from './insights.js';

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const DAY_NAMES_LONG  = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const DAY_NAMES_SHORT = ['M','T','W','T','F','S','S'];
const MONTH_NAMES     = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

const PLAN_DOC_ID          = 'weekly-plan';
const FINISHED_KEY         = 'finishedSessions';

// Meta keys from retired features (streak counter, fixed-Monday bodyweight
// prompt) — silently deleted from the DB on load, never written again.
const RETIRED_META_KEYS = ['streak', 'bwPromptDate'];

// Shown for any exercise record whose name is missing or was never
// migrated off its internal id (see migrateUnnamedExercises()).
const UNNAMED_EXERCISE_PLACEHOLDER = 'Unnamed exercise';

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

/** Returns true if dateStr is before todayStr. */
function isPast(dateStr) {
  return dateStr < state.ui.today;
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

  /** All bodyweight entries from 'bodyweight' store, sorted date-asc. */
  bodyweight: [],

  /**
   * Map of key → record from the 'meta' store.
   * Keys in use: FINISHED_KEY, plus per-date `swaps_<date>` / `removed_<date>`.
   */
  meta: {},

  /** Transient UI state — never written to IndexedDB. */
  ui: {
    currentView: 'today',         // 'today' | 'progress' | 'plan' | 'insights' | 'data'
    today: '',                    // 'YYYY-MM-DD'
    weekDates: [],                // [Mon … Sun] date strings for current week
    todayDayIndex: 0,             // 0=Mon … 6=Sun
    viewedDate: '',               // 'YYYY-MM-DD' — date shown in the Today/day-view tab
    expandedExerciseId: null,     // exercise ID whose accordion is open, or null
    planDirty: false,             // Plan tab has edits not yet saved to the DB
    _dialogConfirmCallback: null, // pending confirm action
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
  inclineDbPress:       'ex_seed_incline_db',
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
            id: SEED_IDS.inclineDbPress,
            name: 'Incline DB Press',
            sets: 3,
            reps: '8',
            muscles: 'Upper Chest · Front Delt',
            cue: 'Bench at 30°, elbows at 75°, full stretch at bottom, squeeze at top.',
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

/** Reads all four stores from IndexedDB into `state` in parallel. */
async function loadState() {
  const [planDoc, allLogs, allBw, allMeta] = await Promise.all([
    get('plan', PLAN_DOC_ID),
    getAll('logs'),
    getAll('bodyweight'),
    getAll('meta'),
  ]);

  state.plan       = planDoc ?? null;
  state.logs       = allLogs ?? [];
  state.bodyweight = (allBw ?? []).sort((a, b) => a.date.localeCompare(b.date));

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
  for (const day of state.plan?.days ?? []) {
    for (const ex of day.exercises ?? []) {
      if (ex.unit) continue;
      ex.unit = unitFor(ex);
      planDirty = true;
    }
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
 * One-time repair for swap/added exercise extras stored before the naming
 * bug was fixed: any extra whose `name` is blank or still equal to its
 * internal `id` gets a chance to be renamed, or falls back to a readable
 * placeholder. Self-limiting — once repaired, records no longer match the
 * broken condition, so this is a no-op on subsequent app loads.
 */
async function migrateUnnamedExercises() {
  for (const key in state.meta) {
    if (!key.startsWith('swaps_')) continue;
    const doc = state.meta[key];
    const extras = doc?.value ?? [];
    let dirty = false;

    for (const extra of extras) {
      const isUnnamed = !extra.name?.trim() || extra.name === extra.id;
      if (!isUnnamed) continue;

      const renamed = window.prompt(
        `An exercise is missing its name. Enter a name for it now (or leave blank to label it "${UNNAMED_EXERCISE_PLACEHOLDER}"):`
      );
      extra.name = renamed?.trim() || UNNAMED_EXERCISE_PLACEHOLDER;
      dirty = true;
    }

    if (dirty) {
      await put('meta', doc);
      state.meta[key] = doc;
    }
  }
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
    case 'today':    renderToday();        break;
    case 'progress': renderProgress();     break;
    case 'plan':     renderPlan();         break;
    case 'insights': renderInsightsTab(state); break;
    case 'data':     renderData();         break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  NAVIGATION
// ─────────────────────────────────────────────────────────────────────────────

function switchView(viewName) {
  if (state.ui.currentView === viewName) return;

  // Plan edits only persist on explicit Save — confirm before discarding them
  if (state.ui.currentView === 'plan' && state.ui.planDirty) {
    showDialog('You have unsaved plan changes. Discard them?', () => {
      state.ui.planDirty = false;
      switchView(viewName);
    });
    return;
  }

  state.ui.currentView = viewName;
  state.ui.expandedExerciseId = null; // collapse open accordions on tab change

  document.querySelectorAll('.tab-view').forEach(el => {
    const isTarget = el.id === `view-${viewName}`;
    el.classList.toggle('active', isTarget);
    el.hidden = !isTarget;
  });

  document.querySelectorAll('.nav-tab').forEach(btn => {
    const isActive = btn.dataset.view === viewName;
    btn.classList.toggle('active-tab', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });

  render();
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
 * Returns: 'done' | 'inprogress' | 'today' | 'missed' | 'rest' | 'upcoming'
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

  // Past day
  if (isRestDay) return 'rest';
  const logsOnDay = state.logs.filter(l => l.date === dateStr);
  if (logsOnDay.length > 0) return 'done'; // any logged activity counts
  return 'missed';
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
      status === 'missed'     ? 'day-missed'      : '',
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

async function init() {
  // 0. Ask the browser to protect IndexedDB from eviction under storage
  //    pressure — all training history lives there with no server copy.
  navigator.storage?.persist?.().catch(() => {});

  // 1. Resolve today's position in the calendar
  const today      = todayStr();
  const weekDates  = weekDatesOf(new Date());
  state.ui.today         = today;
  state.ui.weekDates     = weekDates;
  state.ui.todayDayIndex = dayIndexOf(today);
  state.ui.viewedDate    = today;

  // 2. Pull everything out of IndexedDB
  await loadState();

  // 3. Write defaults to the DB on the very first launch
  await seedIfFirstRun();

  // 3b. One-time repair for any pre-existing unnamed swap/added exercises
  await migrateUnnamedExercises();

  // 3c. Drop retired streak / Monday-prompt meta, ensure every exercise
  //     definition has a unit ('reps' | 'seconds')
  await dropRetiredMeta();
  await migrateExerciseUnits();

  // 4. Bottom tab navigation
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // 5. Bodyweight prompt in Today view
  document.getElementById('bw-save-btn').addEventListener('click', handleBwSave);
  document.getElementById('bw-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleBwSave();
  });

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

  // 9. Confirm dialog buttons
  document.getElementById('dialog-cancel-btn').addEventListener('click', closeDialog);
  document.getElementById('dialog-confirm-btn').addEventListener('click', () => {
    if (typeof state.ui._dialogConfirmCallback === 'function') {
      state.ui._dialogConfirmCallback();
    }
    closeDialog();
  });

  // 10. First paint
  render();
}

document.addEventListener('DOMContentLoaded', init);

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
  updateRestTimerDisplay();
  _restTimer.interval = setInterval(() => {
    if (updateRestTimerDisplay() <= 0) {
      stopRestTimer();
      navigator.vibrate?.(200);
      showToast('Rest over — next set!');
    }
  }, 1000);
}

function stopRestTimer() {
  clearInterval(_restTimer.interval);
  _restTimer.interval = null;
  document.getElementById('rest-timer').hidden = true;
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

function showDialog(message, onConfirm) {
  const confirmBtn = document.getElementById('dialog-confirm-btn');
  confirmBtn.textContent = 'Confirm';
  confirmBtn.className   = 'btn-danger';
  document.getElementById('dialog-inputs').hidden = true;
  document.getElementById('dialog-message').textContent = message;
  state.ui._dialogConfirmCallback = onConfirm;
  document.getElementById('dialog-overlay').hidden = false;
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

  document.getElementById('dialog-overlay').hidden = false;
  wrap.querySelector('.dialog-input')?.focus();
}

function closeDialog() {
  document.getElementById('dialog-overlay').hidden = true;
  const wrap = document.getElementById('dialog-inputs');
  wrap.innerHTML = '';
  wrap.hidden = true;
  state.ui._dialogConfirmCallback = null;
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
  const entry    = {
    id,
    date,
    exerciseId,
    setIndex,
    weight:         fields.weight         ?? existing?.weight         ?? null,
    reps:           fields.reps           ?? existing?.reps           ?? null,
    done:           fields.done           ?? existing?.done           ?? false,
    notes:          fields.notes          ?? existing?.notes          ?? '',
    substituteName: fields.substituteName ?? existing?.substituteName ?? null,
  };
  await put('logs', entry);
  const idx = state.logs.findIndex(l => l.id === id);
  if (idx >= 0) state.logs[idx] = entry;
  else state.logs.push(entry);
  return entry;
}

/**
 * Most recent completed logs for an exercise on any date strictly before
 * excludeDate. Requires weight OR reps so duration-only sets (e.g. an
 * unweighted plank hold) still surface as a last-time reference.
 */
function getRecentLogsForExercise(exerciseId, excludeDate) {
  const done = state.logs.filter(l =>
    l.exerciseId === exerciseId &&
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
function getPRForExercise(exerciseId, unit = 'reps') {
  const rankField = unit === 'seconds' ? 'reps' : 'weight';
  const done = state.logs.filter(l =>
    l.exerciseId === exerciseId && l.done && l[rankField] != null
  );
  if (!done.length) return null;
  return done.reduce((best, l) =>
    l[rankField] > (best?.[rankField] ?? -Infinity) ? l : best, null
  );
}

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
  const dayIdx      = dayIndexOf(date);
  const dayPlan     = state.plan?.days[dayIdx] ?? null;
  const removedIds  = state.meta[`removed_${date}`]?.value ?? [];
  const activeEx    = (dayPlan?.exercises ?? [])
    .filter(e => !e.archived && !removedIds.includes(e.id));
  const swapsKey    = `swaps_${date}`;
  const extras      = state.meta[swapsKey]?.value ?? [];
  return { dayPlan, activeEx, extras, allExercises: [...activeEx, ...extras] };
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
  if (state.plan) {
    for (const day of state.plan.days) {
      const ex = day.exercises?.find(e => e.id === exerciseId);
      if (ex) return ex;
    }
  }
  for (const key in state.meta) {
    if (!key.startsWith('swaps_')) continue;
    const extra = state.meta[key]?.value?.find(e => e.id === exerciseId);
    if (extra) return extra;
  }
  return null;
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
  if (state.plan) {
    for (const day of state.plan.days) {
      const ex = day.exercises?.find(e => e.id === exerciseId);
      if (ex?.name) return ex.name;
    }
  }
  for (const key in state.meta) {
    if (!key.startsWith('swaps_')) continue;
    const extra = state.meta[key]?.value?.find(e => e.id === exerciseId);
    if (extra?.name) return extra.name;
  }
  const swapLog = state.logs.find(l => l.exerciseId === exerciseId && l.substituteName);
  if (swapLog?.substituteName) return swapLog.substituteName;

  return UNNAMED_EXERCISE_PLACEHOLDER;
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
  const isRest   = !dayPlan || !hasContent;
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

  // Bodyweight prompt — always about today specifically, never the viewed date
  updateBwPromptVisibility();

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
    return;
  }

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
  document.getElementById('session-name').textContent =
    dayPlan.sessionName || (dayPlan.isRest ? 'Extra Session' : 'Session');

  const completedCount = allExercises.filter(ex =>
    isExerciseComplete(ex.id, viewDate, ex.sets)
  ).length;
  const totalCount = allExercises.length;

  document.getElementById('session-progress-text').textContent =
    `${completedCount} / ${totalCount} exercises`;
  document.getElementById('session-progress-bar').style.width =
    totalCount > 0 ? `${Math.round((completedCount / totalCount) * 100)}%` : '0%';

  // Rebuild exercise cards — read-only for future dates, nothing to log yet
  exerciseStack.innerHTML = allExercises
    .map(ex => buildExerciseCardHTML(ex, viewDate, { readOnly: isFutureDate }))
    .join('');
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
  const isSeconds = unit === 'seconds';
  const prevLogs  = getRecentLogsForExercise(ex.id, date);
  const pr        = getPRForExercise(ex.id, unit);
  const complete  = isExerciseComplete(ex.id, date, ex.sets);
  const expanded  = state.ui.expandedExerciseId === ex.id;

  // Seconds-based PBs rank by longest hold; rep-based by heaviest weight
  const prBadge = pr
    ? `<span class="ex-pr-badge">PR&nbsp;${isSeconds ? `${pr.reps}s` : `${pr.weight}kg`}</span>`
    : '';

  const originTag = ex.isAdded
    ? '<span class="ex-origin-tag">Added</span>'
    : ex.isSwap
      ? '<span class="ex-origin-tag">Swapped</span>'
      : '';

  const disabledAttr = readOnly ? 'disabled' : '';

  const setsRows = Array.from({ length: ex.sets }, (_, i) => {
    const log   = getExistingLog(date, ex.id, i);
    const prev  = prevLogs.find(l => l.setIndex === i);
    // Duration exercises show '45s' (with '20×45s' if the hold was weighted);
    // rep exercises keep the classic 'kg×reps' reference.
    const prevTxt = !prev
      ? '—'
      : isSeconds
        ? (prev.weight != null
            ? `${prev.weight}×${formatEffort(prev.reps, unit)}`
            : formatEffort(prev.reps, unit))
        : `${prev.weight ?? '?'}×${prev.reps ?? '?'}`;
    const done = log?.done ?? false;

    // Duration sets get a start/stop timer that fills the seconds input
    const timerBtn = isSeconds ? `
        <button class="set-timer"
                aria-label="Start timer for set ${i + 1}"
                aria-pressed="false"
                data-ex-id="${escHtml(ex.id)}" data-set-index="${i}"
                ${disabledAttr}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <polygon points="6 4 20 12 6 20"/>
          </svg>
        </button>` : '';

    return `
      <div class="set-row${isSeconds ? ' set-row-seconds' : ''}${done ? ' set-logged' : ''}"
           data-ex-id="${escHtml(ex.id)}" data-set-index="${i}">
        <span class="set-num">${i + 1}</span>
        <span class="set-prev">${escHtml(prevTxt)}</span>
        <input class="set-input set-weight"
               type="number" inputmode="decimal" step="0.5" min="0"
               placeholder="kg"
               value="${log?.weight ?? ''}"
               aria-label="Weight kg, set ${i + 1}"
               data-field="weight" data-ex-id="${escHtml(ex.id)}" data-set-index="${i}"
               ${disabledAttr} />
        <input class="set-input set-reps"
               type="number" inputmode="numeric" min="1"
               placeholder="${escHtml(String(ex.reps))}"
               value="${log?.reps ?? ''}"
               aria-label="${isSeconds ? 'Seconds' : 'Reps'}, set ${i + 1}"
               data-field="reps" data-ex-id="${escHtml(ex.id)}" data-set-index="${i}"
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
      </div>`;
  }).join('');

  // Notes from set-0 log entry
  const notesVal = state.logs.find(
    l => l.exerciseId === ex.id && l.date === date && l.setIndex === 0
  )?.notes ?? '';

  const metaBlock = (ex.muscles || ex.cue)
    ? `<div class="exercise-meta-block">
        ${ex.muscles ? `<span class="exercise-muscles">${escHtml(ex.muscles)}</span>` : ''}
        ${ex.cue     ? `<p class="exercise-cue">${escHtml(ex.cue)}</p>`               : ''}
       </div>`
    : '';

  const actionsRow = readOnly ? '' : `
        <div class="exercise-actions-row">
          <button class="btn-ghost swap-btn"
                  data-ex-id="${escHtml(ex.id)}"
                  data-ex-name="${escHtml(ex.name)}">
            ⇄ Can't do this? Swap it
          </button>
          <button class="btn-ghost remove-ex-btn"
                  data-ex-id="${escHtml(ex.id)}"
                  data-ex-name="${escHtml(ex.name)}">
            ✕ Remove from session
          </button>
        </div>`;

  return `
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
        <span class="exercise-summary">${ex.sets}×${escHtml(formatEffort(ex.reps, unit))}</span>
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
        <div class="sets-table">
          <div class="sets-table-header${isSeconds ? ' sets-header-seconds' : ''}">
            <span>Set</span><span>Previous</span><span>kg</span>
            <span>${isSeconds ? 'Sec' : 'Reps'}</span>${isSeconds ? '<span></span>' : ''}<span></span>
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

  // Mid-workout swap buttons
  stack.querySelectorAll('.swap-btn').forEach(btn => {
    btn.addEventListener('click', () =>
      promptMidWorkoutSwap(btn.dataset.exId, btn.dataset.exName, date)
    );
  });

  // Remove-from-session buttons
  stack.querySelectorAll('.remove-ex-btn').forEach(btn => {
    btn.addEventListener('click', () =>
      handleRemoveExercise(btn.dataset.exId, btn.dataset.exName, date)
    );
  });
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
    if (wVal == null) wVal = sameDay?.weight ?? prev?.weight ?? null;
    if (rVal == null) rVal = sameDay?.reps ?? prev?.reps ?? (parseInt(exDef?.reps, 10) || null);
  }

  await writeLog(date, exerciseId, setIndex, { weight: wVal, reps: rVal, done: newDone });

  // Start the rest countdown the moment a set is marked done
  if (newDone) startRestTimer();
  else stopRestTimer();

  // Immediate PB surfacing — check the moment a set is marked done, not retroactively
  if (newDone && wVal != null) {
    const pbMessage = await checkForNewPB(state, exerciseId, getExerciseName(exerciseId), date);
    if (pbMessage) showToast(pbMessage, 4000);
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

  // Logging today's (and the week's) first set can trigger the weekly
  // bodyweight prompt
  updateBwPromptVisibility();

  // Week strip may transition from 'today' → 'inprogress'
  renderWeekStrip();
}

/**
 * Weekly bodyweight rule (Mon–Sun ISO weeks): the prompt appears on the day
 * the user logs their week's first completed session — whatever weekday that
 * is — and disappears for the rest of the week once a weight is saved.
 * Untrained days never prompt, so a week without sessions gets no prompt.
 */
function bodyweightLoggedThisWeek() {
  const currentWeek = isoWeekStr(parseDate(state.ui.today));
  // Older entries predate the stored `week` field — derive it from the date
  return state.bodyweight.some(b =>
    (b.week ?? isoWeekStr(parseDate(b.date))) === currentWeek
  );
}

function shouldShowBwPrompt() {
  if (bodyweightLoggedThisWeek()) return false;
  // Only on a day actually trained — the week's first logged session
  return state.logs.some(l => l.date === state.ui.today && l.done);
}

function updateBwPromptVisibility() {
  const card = document.getElementById('bw-prompt-card');
  if (card) card.hidden = !shouldShowBwPrompt();
}

async function handleBwSave() {
  const input = document.getElementById('bw-input');
  const kg    = parseFloat(input.value.trim());
  if (isNaN(kg) || kg < 20 || kg > 300) {
    showToast('Enter a valid weight between 20 and 300 kg.');
    return;
  }
  const today = state.ui.today;
  const entry = { date: today, kg, week: isoWeekStr(parseDate(today)) };
  await put('bodyweight', entry);

  const idx = state.bodyweight.findIndex(b => b.date === today);
  if (idx >= 0) state.bodyweight[idx] = entry;
  else state.bodyweight.push(entry);
  state.bodyweight.sort((a, b) => a.date.localeCompare(b.date));

  input.value = '';
  document.getElementById('bw-prompt-card').hidden = true;
  showToast(`Bodyweight ${kg} kg logged.`);
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

function promptMidWorkoutSwap(originalId, originalName, date) {
  showFormDialog(
    `Swap "${originalName}" for another exercise this session.`,
    [{ name: 'name', label: 'Substitute exercise', placeholder: 'e.g. Machine Press' }],
    async ({ name }) => {
      if (!name) return;

      const dayIdx  = dayIndexOf(date);
      const origEx  = state.plan?.days[dayIdx]?.exercises?.find(e => e.id === originalId);
      const swapEx  = {
        id:         generateId('swap'),
        name,
        sets:       origEx?.sets ?? 3,
        reps:       origEx?.reps ?? '8',
        unit:       origEx?.unit ?? 'reps',
        muscles:    '',
        cue:        '',
        isSwap:     true,
        originalId,
      };

      const swapsKey = `swaps_${date}`;
      const swapDoc  = state.meta[swapsKey] ?? { key: swapsKey, value: [] };
      swapDoc.value.push(swapEx);
      await put('meta', swapDoc);
      state.meta[swapsKey] = swapDoc;

      // Fully replace — hide the original from this date's session
      await addRemovedId(date, originalId);

      renderToday();
      renderWeekStrip();
      showToast(`Swapped to "${swapEx.name}".`);
    },
    'Swap'
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
  for (const day of state.plan?.days ?? []) {
    for (const ex of day.exercises ?? []) consider(ex);
  }
  for (const key in state.meta) {
    if (!key.startsWith('swaps_')) continue;
    for (const ex of state.meta[key]?.value ?? []) consider(ex);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Adds a session-scoped exercise to a date's session (not the recurring
 * plan). Typing filters all previously known exercises; picking one
 * reattaches the existing definition — same id, so its unit, history, and
 * PB data carry over. Unmatched names create a genuinely new exercise.
 */
function handleAddExercise(date) {
  const known = buildKnownExerciseList();
  let selected = null; // known definition picked from the list, or null = create new

  showFormDialog(
    'Add an exercise to this session.',
    [
      { name: 'name', label: 'Exercise name', placeholder: 'Type to search…' },
      { name: 'sets', label: 'Sets', type: 'number', inputmode: 'numeric', value: '3' },
      { name: 'reps', label: 'Reps target', value: '8' },
    ],
    async ({ name, sets, reps }) => {
      if (!name) return;

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
            reps:       reps || '8',
            unit:       'reps',
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

  // Autocomplete: filtered suggestion list under the name input
  const wrap      = document.getElementById('dialog-inputs');
  const nameInput = wrap.querySelector('[data-field="name"]');
  const setsInput = wrap.querySelector('[data-field="sets"]');
  const repsInput = wrap.querySelector('[data-field="reps"]');

  const listEl = document.createElement('div');
  listEl.className = 'autocomplete-list';
  listEl.hidden = true;
  nameInput.closest('.dialog-field').appendChild(listEl);

  const renderSuggestions = () => {
    const q = nameInput.value.trim().toLowerCase();
    if (!q) { listEl.hidden = true; listEl.innerHTML = ''; return; }

    const matches   = known.filter(k => k.name.toLowerCase().includes(q)).slice(0, 8);
    const exactHit  = known.some(k => k.name.toLowerCase() === q);

    listEl.innerHTML = matches.map(m => `
      <button type="button" class="autocomplete-item" data-name="${escHtml(m.name)}">
        <span class="autocomplete-item-name">${escHtml(m.name)}</span>
        <span class="autocomplete-item-meta">${m.sets}×${escHtml(formatEffort(m.reps, m.unit ?? 'reps'))}</span>
      </button>`).join('') +
      (exactHit ? '' : `
      <button type="button" class="autocomplete-item autocomplete-item-new" data-new="1">
        + Add new exercise "${escHtml(nameInput.value.trim())}"
      </button>`);
    listEl.hidden = false;

    listEl.querySelectorAll('.autocomplete-item').forEach(item => {
      item.addEventListener('click', () => {
        if (item.dataset.new) {
          selected = null; // explicit new exercise with the typed name
        } else {
          selected = known.find(k => k.name === item.dataset.name) ?? null;
          if (selected) {
            nameInput.value = selected.name;
            setsInput.value = String(selected.sets ?? 3);
            repsInput.value = String(selected.reps ?? '8');
            repsInput.closest('.dialog-field').querySelector('.dialog-input-label')
              .textContent = (selected.unit === 'seconds') ? 'Seconds target' : 'Reps target';
          }
        }
        listEl.hidden = true;
        listEl.innerHTML = '';
      });
    });
  };

  nameInput.addEventListener('input', () => {
    selected = null; // edits invalidate a previous pick
    renderSuggestions();
  });
}

/**
 * Removes an exercise from a single date's session without touching the
 * recurring weekly plan. Plan-sourced exercises are hidden via a
 * session-scoped removal list; added/swapped extras are deleted outright.
 */
async function handleRemoveExercise(exerciseId, exerciseName, date) {
  showDialog(`Remove "${exerciseName}" from this session?`, async () => {
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

function renderProgress() {
  // Bodyweight chart
  const bwCard = document.getElementById('bw-chart-card');
  if (state.bodyweight.length >= 2) {
    bwCard.innerHTML = buildBwChartSVG(state.bodyweight);
  } else {
    bwCard.innerHTML =
      '<p class="chart-empty">No bodyweight data yet. Log your weight on the Today tab.</p>';
  }

  // Weekly volume chart
  const volCard = document.getElementById('volume-chart-card');
  const volData = buildWeeklyVolumeData();
  if (volData.some(w => w.volume > 0)) {
    volCard.innerHTML = buildVolumeChartSVG(volData);
  } else {
    volCard.innerHTML =
      '<p class="chart-empty">Complete some sessions to see volume trends.</p>';
  }

  // Exercise history selector
  populateHistorySelect();
}

function buildWeeklyVolumeData() {
  // Last 10 ISO weeks, Mon-anchored
  const today = new Date();
  const weeks = Array.from({ length: 10 }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (9 - i) * 7);
    return {
      weekStr: isoWeekStr(d),
      label:   formatDate(getMondayOf(d)).slice(5), // 'MM-DD'
      volume:  0,
    };
  });

  for (const log of state.logs) {
    if (!log.done || !log.weight || !log.reps) continue;
    const wk   = isoWeekStr(parseDate(log.date));
    const slot = weeks.find(w => w.weekStr === wk);
    if (slot) slot.volume += log.weight * log.reps;
  }
  return weeks;
}

function buildBwChartSVG(bwData) {
  const data = bwData.slice(-60);
  const W = 320, H = 160;
  const P = { top: 16, right: 12, bottom: 28, left: 44 };
  const cW = W - P.left - P.right;
  const cH = H - P.top  - P.bottom;
  const n  = data.length;

  const weights = data.map(b => b.kg);
  const minW    = Math.min(...weights);
  const maxW    = Math.max(...weights);
  const range   = maxW - minW || 1;

  const toX = i  => P.left + (i / Math.max(n - 1, 1)) * cW;
  const toY = kg => P.top  + cH - ((kg - minW) / range) * cH;

  const pts         = data.map((b, i) => [toX(i), toY(b.kg)]);
  const polylinePts = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const lastPt      = pts[pts.length - 1];

  const areaD = [
    `M ${pts[0][0].toFixed(1)},${(P.top + cH).toFixed(1)}`,
    ...pts.map(([x, y]) => `L ${x.toFixed(1)},${y.toFixed(1)}`),
    `L ${lastPt[0].toFixed(1)},${(P.top + cH).toFixed(1)}`,
    'Z',
  ].join(' ');

  // Three Y-axis reference labels: min, mid, max
  const yLabels = [0, 0.5, 1].map(frac => {
    const kg = minW + frac * range;
    const y  = toY(kg);
    return `<text x="${(P.left - 5).toFixed(1)}" y="${y.toFixed(1)}"
              dominant-baseline="middle" text-anchor="end">${kg.toFixed(1)}</text>`;
  }).join('');

  return `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"
         style="width:100%;display:block;overflow:visible"
         role="img" aria-label="Bodyweight trend chart">
      <defs>
        <linearGradient id="bwGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="#00F0FF" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="#00F0FF" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      <line x1="${P.left}" y1="${P.top}" x2="${P.left}" y2="${P.top + cH}"
            stroke="#21262D" stroke-width="1"/>
      <line x1="${P.left}" y1="${P.top + cH}" x2="${P.left + cW}" y2="${P.top + cH}"
            stroke="#21262D" stroke-width="1"/>
      <path d="${areaD}" fill="url(#bwGrad)"/>
      <polyline points="${polylinePts}" fill="none" stroke="#00F0FF"
                stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${pts[0][0].toFixed(1)}"  cy="${pts[0][1].toFixed(1)}" r="3" fill="#00F0FF"/>
      <circle cx="${lastPt[0].toFixed(1)}"  cy="${lastPt[1].toFixed(1)}" r="4" fill="#00F0FF"/>
      <g font-size="10" fill="#8B949E" font-family="Inter,system-ui,sans-serif">
        ${yLabels}
        <text x="${P.left.toFixed(1)}"          y="${H - 4}" text-anchor="middle">${data[0].date.slice(5)}</text>
        <text x="${(P.left + cW).toFixed(1)}" y="${H - 4}" text-anchor="middle">${data[n - 1].date.slice(5)}</text>
      </g>
    </svg>`;
}

function buildVolumeChartSVG(weeks) {
  const W = 320, H = 160;
  const P = { top: 16, right: 12, bottom: 28, left: 48 };
  const cW = W - P.left - P.right;
  const cH = H - P.top  - P.bottom;
  const n  = weeks.length;

  const maxVol = Math.max(...weeks.map(w => w.volume), 1);
  const barW   = Math.max(Math.floor(cW / n) - 4, 4);
  const gap    = Math.floor((cW - barW * n) / (n - 1 || 1));

  const bars = weeks.map((w, i) => {
    const x  = P.left + i * (barW + gap);
    const bh = w.volume > 0 ? Math.max((w.volume / maxVol) * cH, 3) : 0;
    const y  = P.top + cH - bh;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}"
                  width="${barW}" height="${bh.toFixed(1)}"
                  rx="2" fill="${w.volume > 0 ? '#00F0FF' : '#21262D'}" opacity="0.85"/>`;
  }).join('');

  // Y-axis labels in tonnes for readability
  const topTonne = (maxVol / 1000).toFixed(1);
  const midTonne = (maxVol / 2000).toFixed(1);

  return `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"
         style="width:100%;display:block;overflow:visible"
         role="img" aria-label="Weekly training volume">
      <line x1="${P.left}" y1="${P.top}" x2="${P.left}" y2="${P.top + cH}"
            stroke="#21262D" stroke-width="1"/>
      <line x1="${P.left}" y1="${P.top + cH}" x2="${P.left + cW}" y2="${P.top + cH}"
            stroke="#21262D" stroke-width="1"/>
      ${bars}
      <g font-size="10" fill="#8B949E" font-family="Inter,system-ui,sans-serif">
        <text x="${(P.left - 5).toFixed(1)}" y="${P.top.toFixed(1)}"
              dominant-baseline="middle" text-anchor="end">${topTonne}t</text>
        <text x="${(P.left - 5).toFixed(1)}" y="${(P.top + cH * 0.5).toFixed(1)}"
              dominant-baseline="middle" text-anchor="end">${midTonne}t</text>
        <text x="${P.left.toFixed(1)}"           y="${H - 4}" text-anchor="middle">${weeks[0]?.label ?? ''}</text>
        <text x="${(P.left + cW).toFixed(1)}" y="${H - 4}" text-anchor="middle">${weeks[n - 1]?.label ?? ''}</text>
      </g>
    </svg>`;
}

function populateHistorySelect() {
  const sel        = document.getElementById('history-exercise-select');
  const currentVal = sel.value;

  // All exerciseIds that have at least one done log
  const loggedIds = [...new Set(
    state.logs.filter(l => l.done).map(l => l.exerciseId)
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
  if (!exerciseId) { list.innerHTML = ''; return; }

  // Group done logs by date
  const byDate = {};
  for (const log of state.logs) {
    if (log.exerciseId !== exerciseId || !log.done) continue;
    if (!byDate[log.date]) byDate[log.date] = [];
    byDate[log.date].push(log);
  }

  const dates = Object.keys(byDate).sort().reverse();
  if (!dates.length) {
    list.innerHTML = '<p class="chart-empty">No history yet for this exercise.</p>';
    return;
  }

  const unit      = getExerciseUnit(exerciseId);
  const isSeconds = unit === 'seconds';
  const prEntry   = getPRForExercise(exerciseId, unit);

  list.innerHTML = dates.map(dateStr => {
    const entries  = byDate[dateStr];
    const totalSets = entries.length;
    // Seconds-based sessions summarise as longest hold; rep-based as top weight × avg reps
    let valueTxt, isPR;
    if (isSeconds) {
      const maxDur = Math.max(...entries.map(l => l.reps ?? 0));
      valueTxt = `best ${maxDur}s · ${totalSets} sets`;
      isPR     = prEntry && maxDur === prEntry.reps && dateStr === prEntry.date;
    } else {
      const maxWt   = Math.max(...entries.map(l => l.weight ?? 0));
      const avgReps = totalSets
        ? Math.round(entries.reduce((s, l) => s + (l.reps ?? 0), 0) / totalSets)
        : 0;
      valueTxt = `${maxWt}kg × ${avgReps} · ${totalSets} sets`;
      isPR     = prEntry && maxWt === prEntry.weight && dateStr === prEntry.date;
    }
    const prTag = isPR ? '<span class="history-row-pr">PR</span>' : '';

    return `
      <div class="history-row">
        <span class="history-row-date">${friendlyDateLabel(dateStr)}</span>
        <span class="history-row-value">${valueTxt}</span>
        ${prTag}
      </div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
//  PLAN TAB
// ─────────────────────────────────────────────────────────────────────────────

function renderPlan() {
  const container = document.getElementById('plan-days');
  if (!state.plan) { container.innerHTML = ''; return; }

  container.innerHTML = state.plan.days.map(day => buildPlanDayCardHTML(day)).join('');
  wirePlanInteractions();
  state.ui.planDirty = false; // DOM was just rebuilt from saved state
}

/**
 * One editable exercise row in the plan editor. `ex` may be a plan exercise
 * or a fresh blank stub for newly added rows. The unit toggle cycles
 * reps ↔ sec and is read back from data-unit on save.
 */
function buildPlanExerciseRowHTML(dayIdx, ex) {
  const unit      = ex.unit ?? 'reps';
  const isSeconds = unit === 'seconds';
  return `
    <div class="plan-exercise-row"
         data-day="${dayIdx}" data-ex-id="${escHtml(ex.id)}">
      <input class="plan-ex-name" type="text"
             placeholder="Exercise name"
             value="${escHtml(ex.name)}"
             aria-label="Exercise name"
             data-day="${dayIdx}" data-ex-id="${escHtml(ex.id)}" />
      <input class="plan-ex-sets" type="number" min="1" max="20"
             placeholder="Sets"
             value="${ex.sets}"
             aria-label="Sets"
             data-day="${dayIdx}" data-ex-id="${escHtml(ex.id)}" />
      <input class="plan-ex-reps" type="text"
             placeholder="${isSeconds ? 'Sec' : 'Reps'}"
             value="${escHtml(String(ex.reps))}"
             aria-label="${isSeconds ? 'Seconds target' : 'Reps target'}"
             data-day="${dayIdx}" data-ex-id="${escHtml(ex.id)}" />
      <button class="plan-ex-unit${isSeconds ? ' plan-ex-unit-seconds' : ''}"
              type="button"
              data-unit="${unit}"
              aria-label="Unit: ${isSeconds ? 'seconds' : 'reps'}. Tap to switch."
              data-day="${dayIdx}" data-ex-id="${escHtml(ex.id)}">
        ${isSeconds ? 'sec' : 'reps'}
      </button>
      <button class="plan-ex-remove"
              aria-label="Remove ${escHtml(ex.name || 'exercise')}"
              data-day="${dayIdx}" data-ex-id="${escHtml(ex.id)}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2.5"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="18" y1="6"  x2="6"  y2="18"/>
          <line x1="6"  y1="6"  x2="18" y2="18"/>
        </svg>
      </button>
    </div>`;
}

function buildPlanDayCardHTML(day) {
  const activeEx = (day.exercises ?? []).filter(e => !e.archived);
  const exRows   = activeEx
    .map(ex => buildPlanExerciseRowHTML(day.dayIndex, ex))
    .join('');

  // Day-level bulk actions only make sense when the day has a program
  const hasProgram = activeEx.length > 0 || (day.sessionName ?? '') !== '';
  const dayActions = hasProgram ? `
      <div class="plan-day-actions">
        <button class="btn-ghost plan-move-day-btn" data-day="${day.dayIndex}">
          ⇢ Move day…
        </button>
        <button class="btn-ghost plan-delete-day-btn" data-day="${day.dayIndex}">
          ✕ Delete day
        </button>
      </div>` : '';

  return `
    <div class="card plan-day-card" data-day="${day.dayIndex}">
      <div class="plan-day-header">
        <span class="plan-day-label">${DAY_NAMES_LONG[day.dayIndex]}</span>
        <input class="plan-session-name-input" type="text"
               placeholder="${day.isRest ? 'Rest (leave blank)' : 'e.g. Push Day'}"
               value="${escHtml(day.sessionName ?? '')}"
               aria-label="Session name for ${DAY_NAMES_LONG[day.dayIndex]}"
               data-day="${day.dayIndex}" />
      </div>
      <div class="plan-exercises-list" data-day="${day.dayIndex}">
        ${exRows}
      </div>
      <button class="btn-ghost plan-add-ex-btn" data-day="${day.dayIndex}">
        + Add exercise
      </button>
      ${dayActions}
    </div>`;
}

function wirePlanInteractions() {
  const container = document.getElementById('plan-days');
  document.getElementById('save-plan-btn').onclick = handleSavePlan;

  // Any typing in a plan field marks the tab dirty (delegated, wired once)
  if (!container._dirtyWired) {
    container.addEventListener('input', () => { state.ui.planDirty = true; });
    container._dirtyWired = true;
  }

  // "Add exercise" — inserts a new row directly into the list without rebuilding
  container.querySelectorAll('.plan-add-ex-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const dayIdx = parseInt(btn.dataset.day, 10);
      const list   = container.querySelector(
        `.plan-exercises-list[data-day="${dayIdx}"]`
      );
      const stub = { id: generateId('ex'), name: '', sets: 3, reps: '8', unit: 'reps' };
      list.insertAdjacentHTML('beforeend', buildPlanExerciseRowHTML(dayIdx, stub));
      const row = list.lastElementChild;
      wireRemoveButton(row.querySelector('.plan-ex-remove'));
      wireUnitToggle(row.querySelector('.plan-ex-unit'));
      state.ui.planDirty = true;
      row.querySelector('.plan-ex-name').focus();
    });
  });

  // Remove buttons and unit toggles on pre-existing rows
  container.querySelectorAll('.plan-ex-remove').forEach(btn => wireRemoveButton(btn));
  container.querySelectorAll('.plan-ex-unit').forEach(btn => wireUnitToggle(btn));

  // Day-level bulk actions
  container.querySelectorAll('.plan-delete-day-btn').forEach(btn => {
    btn.addEventListener('click', () => handleDeleteDay(parseInt(btn.dataset.day, 10)));
  });
  container.querySelectorAll('.plan-move-day-btn').forEach(btn => {
    btn.addEventListener('click', () => handleMoveDay(parseInt(btn.dataset.day, 10)));
  });
}

function wireRemoveButton(btn) {
  btn.addEventListener('click', () => {
    btn.closest('.plan-exercise-row')?.remove();
    state.ui.planDirty = true;
  });
}

/** Cycles a plan row's unit button reps ↔ sec; read back via data-unit on save. */
function wireUnitToggle(btn) {
  btn.addEventListener('click', () => {
    const toSeconds = btn.dataset.unit !== 'seconds';
    btn.dataset.unit = toSeconds ? 'seconds' : 'reps';
    btn.textContent  = toSeconds ? 'sec' : 'reps';
    btn.classList.toggle('plan-ex-unit-seconds', toSeconds);
    btn.setAttribute('aria-label', `Unit: ${toSeconds ? 'seconds' : 'reps'}. Tap to switch.`);
    const repsInput = btn.closest('.plan-exercise-row')?.querySelector('.plan-ex-reps');
    if (repsInput) {
      repsInput.placeholder = toSeconds ? 'Sec' : 'Reps';
      repsInput.setAttribute('aria-label', toSeconds ? 'Seconds target' : 'Reps target');
    }
    state.ui.planDirty = true;
  });
}

/**
 * Deletes a full training day's program: every active exercise is soft-
 * archived (so historical logs keep resolving names/PBs) and the day
 * becomes a rest day. Historical logged sets are never touched.
 */
function handleDeleteDay(dayIdx) {
  const dayName = DAY_NAMES_LONG[dayIdx];
  const note = state.ui.planDirty ? ' Unsaved plan edits will be discarded.' : '';
  showDialog(
    `Delete ${dayName}'s entire program? The day becomes a rest day. Logged history is kept.${note}`,
    async () => {
      const days = state.plan.days.map(day => {
        if (day.dayIndex !== dayIdx) return day;
        return {
          ...day,
          sessionName: '',
          isRest: true,
          exercises: (day.exercises ?? []).map(e => ({ ...e, archived: true })),
        };
      });
      const updated = { ...state.plan, days };
      await put('plan', updated);
      state.plan = updated;
      state.ui.planDirty = false;
      renderPlan();
      renderWeekStrip();
      showToast(`${dayName}'s program deleted.`);
    }
  );
}

/**
 * Moves a full day's program to another day (cut & paste): the target day's
 * current program is overwritten — its exercises are soft-archived so
 * historical logs stay resolvable — and the source day becomes empty.
 */
function handleMoveDay(sourceIdx) {
  const sourceName = DAY_NAMES_LONG[sourceIdx];
  const options = state.plan.days
    .filter(d => d.dayIndex !== sourceIdx)
    .map(d => ({
      value: String(d.dayIndex),
      label: DAY_NAMES_LONG[d.dayIndex] +
        (d.isRest ? ' (rest)' : d.sessionName ? ` (${d.sessionName})` : ''),
    }));
  const note = state.ui.planDirty ? ' Unsaved plan edits will be discarded.' : '';

  showFormDialog(
    `Move ${sourceName}'s program to another day? The target day's current program is overwritten and cannot be recovered, and ${sourceName} becomes empty.${note}`,
    [{ name: 'target', label: 'Move to', options }],
    async ({ target }) => {
      const targetIdx = parseInt(target, 10);
      if (isNaN(targetIdx) || targetIdx === sourceIdx) return;

      const days = state.plan.days.map(day => {
        if (day.dayIndex === sourceIdx) {
          // Source is cleared — its exercises (incl. archived) travel with the move
          return { ...day, sessionName: '', isRest: true, exercises: [] };
        }
        if (day.dayIndex === targetIdx) {
          const src = state.plan.days[sourceIdx];
          // Target's previous program is discarded from the schedule but
          // soft-archived so its logged history keeps resolving
          const displaced = (day.exercises ?? []).map(e => ({ ...e, archived: true }));
          return {
            ...day,
            sessionName: src.sessionName,
            isRest: src.isRest,
            exercises: [...(src.exercises ?? []), ...displaced],
          };
        }
        return day;
      });

      const updated = { ...state.plan, days };
      await put('plan', updated);
      state.plan = updated;
      state.ui.planDirty = false;
      renderPlan();
      renderWeekStrip();
      showToast(`Moved ${sourceName}'s program to ${DAY_NAMES_LONG[targetIdx]}.`);
    },
    'Move'
  );
}

async function handleSavePlan() {
  if (!state.plan) return;
  const container  = document.getElementById('plan-days');

  const updatedDays = state.plan.days.map(day => {
    const sessionInput = container.querySelector(
      `.plan-session-name-input[data-day="${day.dayIndex}"]`
    );
    const sessionName = sessionInput?.value.trim() ?? day.sessionName;

    const rows = container.querySelectorAll(
      `.plan-exercise-row[data-day="${day.dayIndex}"]`
    );
    const updatedExercises = [];

    rows.forEach(row => {
      const exId   = row.dataset.exId;
      const name   = row.querySelector('.plan-ex-name')?.value.trim();
      if (!name) return; // skip blank rows

      const sets   = parseInt(row.querySelector('.plan-ex-sets')?.value, 10) || 3;
      const reps   = row.querySelector('.plan-ex-reps')?.value.trim() || '8';
      const unit   = row.querySelector('.plan-ex-unit')?.dataset.unit === 'seconds'
        ? 'seconds' : 'reps';
      const origin = day.exercises?.find(e => e.id === exId);

      updatedExercises.push({
        id:       exId,
        name,
        sets,
        reps,
        unit,
        muscles:  origin?.muscles  ?? '',
        cue:      origin?.cue      ?? '',
        archived: false,
      });
    });

    // Soft-archive exercises removed from the DOM (preserves their log history)
    const domIds   = new Set(updatedExercises.map(e => e.id));
    const archived = (day.exercises ?? [])
      .filter(e => !e.archived && !domIds.has(e.id))
      .map(e => ({ ...e, archived: true }));

    return {
      ...day,
      sessionName,
      isRest: sessionName === '' && updatedExercises.length === 0,
      exercises: [...updatedExercises, ...archived],
    };
  });

  const updated = { ...state.plan, days: updatedDays };
  await put('plan', updated);
  state.plan = updated;
  state.ui.planDirty = false;

  showToast('Plan saved.');
  renderWeekStrip();
}

// ─────────────────────────────────────────────────────────────────────────────
//  DATA TAB
// ─────────────────────────────────────────────────────────────────────────────

function renderData() {
  document.getElementById('app-version').textContent = 'v1.0.0';
}

async function handleExport() {
  try {
    const [planDoc, allLogs, allBw, allMeta] = await Promise.all([
      get('plan', PLAN_DOC_ID),
      getAll('logs'),
      getAll('bodyweight'),
      getAll('meta'),
    ]);

    const payload = {
      exportedAt: new Date().toISOString(),
      version:    1,
      plan:       planDoc,
      logs:       allLogs,
      bodyweight: allBw,
      meta:       allMeta,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a   = Object.assign(document.createElement('a'), {
      href:     url,
      download: `fittrack-${todayStr()}.json`,
    });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Data exported.');
  } catch (err) {
    console.error('[FitTrack] Export failed:', err);
    showToast('Export failed — see console.');
  }
}

async function handleImport(event) {
  const file = event.target.files?.[0];
  event.target.value = ''; // reset immediately so the same file can be re-selected
  if (!file) return;

  showDialog(
    `Import "${file.name}"? This will overwrite ALL current data and cannot be undone.`,
    async () => {
      try {
        const text    = await file.text();
        const payload = JSON.parse(text);

        if (!payload.version || !payload.plan || !Array.isArray(payload.logs)) {
          throw new Error('Unrecognised FitTrack backup format.');
        }

        await Promise.all([
          clear('plan'),
          clear('logs'),
          clear('bodyweight'),
          clear('meta'),
        ]);

        await Promise.all([
          put('plan', payload.plan),
          ...payload.logs.map(l         => put('logs',       l)),
          ...(payload.bodyweight ?? []).map(b => put('bodyweight', b)),
          ...(payload.meta       ?? []).map(m => put('meta',       m)),
        ]);

        await loadState();
        await dropRetiredMeta();
        await migrateExerciseUnits();
        state.ui.viewedDate = state.ui.today;
        render();
        showToast('Data imported successfully.');
      } catch (err) {
        console.error('[FitTrack] Import failed:', err);
        showToast(`Import failed: ${err.message}`);
      }
    }
  );
}

async function handleClearData() {
  showDialog(
    'Delete ALL workouts, logs, bodyweight entries, and settings? This cannot be undone.',
    async () => {
      try {
        await Promise.all([
          clear('plan'),
          clear('logs'),
          clear('bodyweight'),
          clear('meta'),
        ]);

        state.plan                  = null;
        state.logs                  = [];
        state.bodyweight            = [];
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
    }
  );
}
