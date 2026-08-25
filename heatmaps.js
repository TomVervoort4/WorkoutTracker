/**
 * heatmaps.js — FitTrack · Activity Heatmap & Muscle Map
 *
 * Two display-only modules in the spirit of insights.js and
 * PHASE4-CONVERGENCE.md. Both live on the Stats tab.
 *
 *   Module A — Activity heatmap: a GitHub-style grid, one cell per day, shaded
 *   by how many completed sets were logged that day. Every number is a plain
 *   count the user could verify by hand.
 *
 *   Module B — Muscle map: an anatomical front/back body diagram with three
 *   readings of the same eighteen regions.
 *
 *       Balance  — effective sets per muscle in the chosen window. A COUNT.
 *       Fatigue  — how recently each muscle was trained. A DATE DIFFERENCE,
 *                  put on a 0–1 scale by one stated constant (RECOVERY_DAYS).
 *       Strength — retained strength since a muscle was last trained. This one
 *                  is a MODEL, not a fact: it applies a detraining curve
 *                  (GRACE_DAYS / RETENTION_HALF_LIFE_DAYS / RETENTION_FLOOR) to
 *                  each exercise's estimated 1RM. The card says so on its face,
 *                  and every constant behind it is in the TUNABLES block below.
 *
 *   Attribution rule (stated once, applies everywhere): a completed set counts
 *   1.0 toward the FIRST muscle named in that exercise's `muscles` field and
 *   0.4 toward each other — see muscles.js, which owns the vocabulary, the
 *   weighting and the shade scales. Before this the map credited a whole set to
 *   the primary muscle alone, so a push day drew a bright chest and dark
 *   triceps.
 *
 * The body diagram itself is vendored artwork (vendor/body-paths.js, MuscleMap
 * by Melih Colpan, MIT — see that file's header). It is ~94 KB and only the
 * Stats tab shows it, so it is fetched by dynamic import on first use rather
 * than riding along with the app shell.
 *
 * Pure compute + HTML/SVG-string builders, no DOM queries — the same division
 * bodycomp.js already uses. The card is interactive, but its UI state (which
 * tab, which window, which muscle is selected) is owned by app.js and passed
 * in: this file renders it and never reads or writes it.
 */

import { canonId, getExercisePR } from './insights.js';
import {
  MUSCLES, INERT, MUSCLE_NAME,
  musclesOfField, loadOf, levelsOf, levelsFromScore, rankOf,
} from './muscles.js';

// ─────────────────────────────────────────────────────────────────────────────
//  TUNABLES — every magic number lives here, nowhere inline
// ─────────────────────────────────────────────────────────────────────────────

const ACTIVITY_WEEKS_DEFAULT = 53;  // ≈ a full year of columns, GitHub-style

/**
 * Fatigue: days from "trained today" back to "fully recovered". A muscle's
 * fatigue is the straight line between those two, so the reading is nothing
 * more than "how long ago", drawn. Four days is the usual outer edge of
 * soreness for a hard session and matches the app's own 48–72h assumption
 * elsewhere; a different number moves every shade together, which is the point
 * of keeping it here.
 */
const RECOVERY_DAYS = 4;

const FATIGUE_THRESHOLDS = [
  { at: 0,    level: 0 },
  { at: 0.15, level: 1 },
  { at: 0.25, level: 2 },
  { at: 0.40, level: 3 },
  { at: 0.55, level: 4 },
];

/**
 * Retained strength. Strength does not fall the moment training stops: there is
 * a grace period during which nothing measurable is lost, then a slow decay
 * toward a floor well above zero (a trained lifter does not return to untrained
 * after a lay-off). These three numbers ARE the model — it is an assumption
 * about detraining, not a measurement of it.
 */
const GRACE_DAYS                 = 14;   // no measurable loss inside this
const RETENTION_HALF_LIFE_DAYS   = 60;   // then halves the remaining margin every N days
const RETENTION_FLOOR            = 0.5;  // and never falls below this

const STRENGTH_THRESHOLDS = [
  { at: RETENTION_FLOOR, level: 0 },
  { at: 0.625,           level: 1 },
  { at: 0.750,           level: 2 },
  { at: 0.875,           level: 3 },
  { at: 1,               level: 4 },
];

/** Fatigue score bands, for the word shown next to a selected muscle. */
const READY_BELOW      = 0.25;
const RECOVERING_BELOW = 0.50;

/** How many muscles get a bar under the balance map before the list stops. */
const BALANCE_TOP_N = 4;

/** Which body the vendored geometry draws. The artwork ships male and female;
 *  FitTrack has no such setting, so it always draws the male figure. */
const BODY_FIGURE = 'male';

const ACTIVITY_MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** The window options the map offers, in order. `days: 0` means all time. */
const MAP_WINDOWS = [
  { days: 7,  label: 'Week' },
  { days: 30, label: '30d'  },
  { days: 90, label: '90d'  },
  { days: 0,  label: 'All'  },
];

const MAP_TABS = [
  { id: 'balance',  label: 'Muscle balance' },
  { id: 'fatigue',  label: 'Fatigue'        },
  { id: 'strength', label: 'Strength'       },
];

// ─────────────────────────────────────────────────────────────────────────────
//  SMALL LOCAL UTILITIES (kept local — no app.js deps, mirrors insights.js)
// ─────────────────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
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

/** Whole days from `fromStr` to `toStr`, both 'YYYY-MM-DD'. Negative if later. */
function daysBetween(fromStr, toStr) {
  const [y1, m1, d1] = fromStr.split('-').map(Number);
  const [y2, m2, d2] = toStr.split('-').map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((b - a) / 86400000);
}

/** 0 = Monday … 6 = Sunday, for a date string "YYYY-MM-DD". */
function dayOfWeekMondayFirst(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const js = new Date(y, m - 1, d).getDay(); // JS: 0 = Sunday … 6 = Saturday
  return (js + 6) % 7;
}

const round1 = (n) => Math.round(n * 10) / 10;

/** Drops a trailing ".0" so "4 sets" doesn't read "4.0 sets". */
const fmtSets = (n) => {
  const v = round1(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};

// ─────────────────────────────────────────────────────────────────────────────
//  MODULE A — ACTIVITY HEATMAP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a `weeks`-column × 7-row grid (Monday-first rows) ending on the week
 * that contains `today`. Each cell carries the completed-set count for that
 * date and a 0–4 shading level scaled off the busiest day in the window; days
 * after `today` get level -1 and are not rendered as data, only as empty grid
 * space — this is what keeps "today" always landing in the last column
 * regardless of which weekday it falls on.
 */
function computeActivityHeatmap(logs, { today, weeks = ACTIVITY_WEEKS_DEFAULT } = {}) {
  const setsPerDay = new Map();
  for (const l of logs) {
    if (!l.done || l.reps == null) continue; // same "completed set" gate insights.js uses
    setsPerDay.set(l.date, (setsPerDay.get(l.date) ?? 0) + 1);
  }

  const thisWeekMonday = addDays(today, -dayOfWeekMondayFirst(today));
  const start = addDays(thisWeekMonday, -(weeks - 1) * 7);

  const counts = [...setsPerDay.values()];
  const max = counts.length ? Math.max(...counts) : 0;

  const levelOf = (n) => {
    if (!n || !max) return 0;
    const frac = n / max;
    if (frac > 0.75) return 4;
    if (frac > 0.5)  return 3;
    if (frac > 0.25) return 2;
    return 1;
  };

  const weeksOut = [];
  let cursor = start;
  let activeDays = 0;
  for (let w = 0; w < weeks; w++) {
    const col = [];
    for (let d = 0; d < 7; d++) {
      const inFuture = cursor > today;
      const count = setsPerDay.get(cursor) ?? 0;
      if (!inFuture && count > 0) activeDays++;
      col.push({ date: cursor, count, level: inFuture ? -1 : levelOf(count) });
      cursor = addDays(cursor, 1);
    }
    weeksOut.push(col);
  }

  return { weeks: weeksOut, today, activeDays, maxPerDay: max };
}

/** The Less→More swatch strip, shared by the activity grid and the balance map. */
function buildLevelLegend() {
  return `
    <div class="heatmap-legend">
      <span>Less</span>
      <span class="heatmap-cell level-0"></span>
      <span class="heatmap-cell level-1"></span>
      <span class="heatmap-cell level-2"></span>
      <span class="heatmap-cell level-3"></span>
      <span class="heatmap-cell level-4"></span>
      <span>More</span>
    </div>`;
}

/** Renders the Activity card in the existing card house style. */
function buildActivityHeatmapCard(logs, { today, weeks = ACTIVITY_WEEKS_DEFAULT } = {}) {
  const { weeks: cols, activeDays } = computeActivityHeatmap(logs, { today, weeks });

  let cellsHtml = '';
  let lastMonth = '';
  cols.forEach((col, w) => {
    const monthNum = col[0].date.slice(5, 7);
    if (monthNum !== lastMonth) {
      lastMonth = monthNum;
      cellsHtml += `<span class="heatmap-month" style="grid-column:${w + 1};grid-row:1">${ACTIVITY_MONTH_LABELS[Number(monthNum) - 1]}</span>`;
    }
    col.forEach((cell, d) => {
      if (cell.level < 0) {
        cellsHtml += `<span class="heatmap-cell heatmap-empty" style="grid-column:${w + 1};grid-row:${d + 2}"></span>`;
      } else {
        const label = `${cell.date} · ${cell.count} set${cell.count === 1 ? '' : 's'}`;
        cellsHtml += `<span class="heatmap-cell level-${cell.level}" style="grid-column:${w + 1};grid-row:${d + 2}" title="${escHtml(label)}"></span>`;
      }
    });
  });

  return `
    <div class="card hub-card hub-activity-heatmap">
      <div class="hub-card-head">
        <span class="hub-card-title">Activity</span>
        <span class="hub-card-meta">${activeDays} training day${activeDays === 1 ? '' : 's'} · last ${weeks} weeks</span>
      </div>
      <div class="heatmap-scroll">
        <div class="heatmap-grid" style="grid-template-columns:repeat(${cols.length}, 11px)">${cellsHtml}</div>
      </div>
      ${buildLevelLegend()}
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MODULE B — MUSCLE MAP · THE VENDORED GEOMETRY
// ─────────────────────────────────────────────────────────────────────────────

let BODY_PATHS = null;   // resolved geometry, once
let BODY_PENDING = null; // in-flight import, so concurrent callers share one

/**
 * Loads the body geometry, once. Resolves to null if the vendored file is
 * missing or unparseable — every caller then simply draws no diagram rather
 * than throwing on the Stats tab.
 */
async function loadBodyPaths() {
  if (BODY_PATHS) return BODY_PATHS;
  BODY_PENDING = BODY_PENDING || import('./vendor/body-paths.js')
    .then((m) => { BODY_PATHS = m.default; return BODY_PATHS; })
    .catch((err) => {
      console.warn('[FitTrack] body geometry not loaded:', err?.message ?? err);
      return null;
    });
  return BODY_PENDING;
}

/** Whether the geometry is already in memory (so a render can draw it now). */
const bodyPathsReady = () => BODY_PATHS != null;

// ─────────────────────────────────────────────────────────────────────────────
//  MODULE B — THE EXERCISE CATALOG THE MAP READS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The same three sources insights.js's own buildExerciseCatalog reads (plan,
 * per-session swaps, the orphan registry) — plus `muscles` and `loadType`,
 * which insights.js doesn't carry because it doesn't need them. Duplicated
 * rather than imported on purpose, matching insights.js's own "self-contained,
 * no app.js deps" note.
 *
 * `resolveMuscles` is app.js's hook for exercises stored WITHOUT a muscles
 * string (anything typed in freehand through "+ Add exercise"): app.js can
 * still match the name against the vendored library, which this file has no
 * business reaching into.
 */
function buildMuscleCatalog(plan, meta, resolveMuscles) {
  const catalog = new Map();
  const add = (ex) => {
    if (!ex?.id || !ex.name) return;
    const cid = canonId(ex.id);
    if (catalog.has(cid)) return;
    const field = (resolveMuscles ? resolveMuscles(ex) : ex.muscles) || ex.muscles || '';
    catalog.set(cid, {
      id: cid,
      name: ex.name,
      unit: ex.unit ?? 'reps',
      loadType: ex.loadType ?? null,
      weights: musclesOfField(field),
    });
  };

  if (plan) {
    for (const day of plan.days ?? []) {
      for (const ex of (day.exercises ?? [])) add(ex);
    }
  }
  for (const key in meta) {
    if (!key.startsWith('swaps_')) continue;
    for (const ex of (meta[key]?.value ?? [])) add(ex);
  }
  const registry = meta?.exerciseRegistry?.value ?? {};
  for (const id in registry) add(registry[id]);

  return catalog;
}

/** Completed sets only — the same gate insights.js uses everywhere. */
const isCompletedSet = (l) => !!l.done && l.reps != null;

// ─────────────────────────────────────────────────────────────────────────────
//  MODULE B — READING 1 · BALANCE (effective sets per muscle)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Effective sets per muscle over a window, plus which of the eighteen regions
 * got none. `withinDays: 0` means all time. Counts and a set difference — both
 * facts, neither a judgement.
 */
function computeMuscleBalance(state, { today, withinDays = 30, catalog } = {}) {
  const cat = catalog ?? buildMuscleCatalog(state.plan, state.meta);
  const cutoff = withinDays > 0 ? addDays(today, -withinDays + 1) : null;

  const items = [];
  let sessionDates = new Set();
  for (const l of state.logs) {
    if (!isCompletedSet(l)) continue;
    if (l.date > today) continue;
    if (cutoff && l.date < cutoff) continue;
    const ex = cat.get(canonId(l.exerciseId));
    if (!ex) continue;
    sessionDates.add(l.date);
    items.push({ weights: ex.weights, sets: 1 });
  }

  const load = loadOf(items);
  const { worked, missed } = rankOf(load);
  return {
    load,
    levels: levelsOf(load),
    worked,
    missed,
    maxLoad: worked.length ? load[worked[0]] : 0,
    sessionDays: sessionDates.size,
    windowDays: withinDays,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  MODULE B — READING 2 · FATIGUE (how recently each muscle was trained)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The most recent date each muscle took ANY load — primary or supporting.
 * All-time, never windowed: "when did I last train this" has no window.
 */
function lastTrainedByMuscle(state, { today, catalog } = {}) {
  const cat = catalog ?? buildMuscleCatalog(state.plan, state.meta);
  const last = {};
  for (const l of state.logs) {
    if (!isCompletedSet(l) || l.date > today) continue;
    const ex = cat.get(canonId(l.exerciseId));
    if (!ex) continue;
    for (const slug in ex.weights) {
      if (!last[slug] || l.date > last[slug]) last[slug] = l.date;
    }
  }
  return last;
}

/** Fatigue on a 0–1 scale from a whole number of days since training. */
function fatigueFromDays(days) {
  if (!Number.isFinite(days) || days < 0) return 0;
  return Math.max(0, Math.min(1, 1 - days / RECOVERY_DAYS));
}

/** The word a fatigue score reads as. */
function fatigueStatus(score) {
  if (!(score > 0) || score < READY_BELOW) return 'Ready';
  return score <= RECOVERING_BELOW ? 'Recovering' : 'Fatigued';
}

/**
 * Per-muscle fatigue: nothing but (today − last trained), put on a 0–1 scale.
 * Muscles never trained have no date and score 0 — they read "Ready", which is
 * true in the only sense this card claims.
 */
function computeMuscleFatigue(state, { today, catalog } = {}) {
  const last = lastTrainedByMuscle(state, { today, catalog });
  const score = {};
  const daysSince = {};
  for (const m of MUSCLES) {
    if (!last[m]) { score[m] = 0; daysSince[m] = null; continue; }
    const d = daysBetween(last[m], today);
    daysSince[m] = d;
    score[m] = fatigueFromDays(d);
  }
  return {
    score,
    daysSince,
    lastTrained: last,
    levels: levelsFromScore(score, FATIGUE_THRESHOLDS),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  MODULE B — READING 3 · STRENGTH (retained, since last trained)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The detraining curve. Flat through GRACE_DAYS, then the margin above
 * RETENTION_FLOOR halves every RETENTION_HALF_LIFE_DAYS. This is the one number
 * on the whole Stats tab that is modelled rather than counted; see the module
 * header.
 */
function retentionFromDays(days) {
  if (!Number.isFinite(days) || days < 0) return 1;
  if (days <= GRACE_DAYS) return 1;
  const decayed = Math.pow(2, -(days - GRACE_DAYS) / RETENTION_HALF_LIFE_DAYS);
  return RETENTION_FLOOR + (1 - RETENTION_FLOOR) * decayed;
}

/** The most recent completed-set date for one exercise, or null. */
function lastDoneDate(logs, exerciseId, today) {
  let last = null;
  for (const l of logs) {
    if (!isCompletedSet(l) || l.date > today) continue;
    if (canonId(l.exerciseId) !== exerciseId) continue;
    if (!last || l.date > last) last = l.date;
  }
  return last;
}

/**
 * Retained strength per muscle: the retention curve applied to the number of
 * days since that muscle last took load. Muscles never trained get no score at
 * all (undefined), so they draw at level 0 and are simply absent from the list
 * rather than reading as "at the floor".
 */
function computeMuscleStrength(state, { today, catalog } = {}) {
  const last = lastTrainedByMuscle(state, { today, catalog });
  const score = {};
  for (const m of MUSCLES) {
    if (!last[m]) continue;
    score[m] = retentionFromDays(daysBetween(last[m], today));
  }
  return {
    score,
    lastTrained: last,
    levels: levelsFromScore(score, STRENGTH_THRESHOLDS),
  };
}

/**
 * The weighted exercises that train one muscle, each with its estimated 1RM,
 * how long since it was last trained, and that estimate carried through the
 * retention curve. Only `weighted` work has an e1RM, so bodyweight, assisted
 * and timed exercises are absent by construction rather than shown at zero.
 */
function strengthExercisesFor(state, muscleSlug, { today, catalog } = {}) {
  const cat = catalog ?? buildMuscleCatalog(state.plan, state.meta);
  const rows = [];
  for (const ex of cat.values()) {
    const weight = ex.weights[muscleSlug];
    if (!weight) continue;
    if (ex.loadType !== 'weighted') continue;
    const pr = getExercisePR(state, ex.id, { name: ex.name, unit: ex.unit, loadType: ex.loadType });
    if (!pr) continue;
    const lastDate = lastDoneDate(state.logs, ex.id, today);
    const decay = lastDate ? retentionFromDays(daysBetween(lastDate, today)) : RETENTION_FLOOR;
    rows.push({
      id: ex.id,
      name: ex.name,
      role: weight >= 1 ? 'primary' : 'secondary',
      est: round1(pr.value),
      estDate: pr.date,
      lastDate,
      decay,
      current: round1(pr.value * decay),
    });
  }
  return rows.sort((a, b) => b.current - a.current || a.name.localeCompare(b.name));
}

// ─────────────────────────────────────────────────────────────────────────────
//  MODULE B — THE SVG BODY DIAGRAM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One view (front or back) of the figure. Inert parts draw first as a plain
 * silhouette; muscles draw on top, each carrying its shade level, its own
 * `data-muscle` slug for app.js to wire a tap to, and a <title> so a hover or a
 * screen reader gets the name without tapping.
 */
function buildBodyView(view, geometry, levels, selected, labelOf) {
  const parts = geometry.p ?? {};

  const sil = INERT.flatMap((slug) => (parts[slug] ?? [])
    .map((d) => `<path class="body-filler" d="${d}" />`)).join('');

  const muscles = MUSCLES.flatMap((slug) => (parts[slug] ?? []).map((d) => {
    const level = levels[slug] ?? 0;
    const isSel = selected === slug ? ' is-selected' : '';
    const title = labelOf ? labelOf(slug) : (MUSCLE_NAME[slug] ?? slug);
    return `<path class="body-region level-${level}${isSel}" d="${d}" data-muscle="${slug}"><title>${escHtml(title)}</title></path>`;
  })).join('');

  return `<svg viewBox="${geometry.vb}" class="body-figure" role="img"
       aria-label="${view === 'front' ? 'Front' : 'Back'} muscle map">${sil}${muscles}</svg>`;
}

/**
 * The front/back pair. Renders a fixed-height placeholder while the geometry is
 * still loading, so nothing below it jumps when the artwork lands.
 */
function buildBodyMap(levels, { selected = null, variant = '', labelOf = null } = {}) {
  if (!BODY_PATHS) return `<div class="body-map-placeholder" aria-hidden="true"></div>`;
  const g = BODY_PATHS[BODY_FIGURE] ?? BODY_PATHS.male;
  if (!g) return `<div class="body-map-placeholder" aria-hidden="true"></div>`;
  return `
    <div class="body-map${variant ? ' ' + variant : ''}">
      ${buildBodyView('front', g.front, levels, selected, labelOf)}
      ${buildBodyView('back',  g.back,  levels, selected, labelOf)}
    </div>`;
}

// ── Legends ──────────────────────────────────────────────────────────────────

function buildFatigueLegend() {
  return `
    <div class="heatmap-legend map-legend-fatigue" aria-label="Fatigue scale">
      <span>Fatigued</span><span class="heatmap-cell level-4"></span>
      <span>Recovering</span><span class="heatmap-cell level-2"></span>
      <span>Ready</span><span class="heatmap-cell level-0"></span>
    </div>`;
}

function buildStrengthLegend() {
  return `
    <div class="heatmap-legend map-legend-strength" aria-label="Retained strength scale">
      <span>1 <span class="map-legend-dim">full</span></span>
      <span class="heatmap-cell level-4"></span>
      <span class="heatmap-cell level-3"></span>
      <span class="heatmap-cell level-2"></span>
      <span class="heatmap-cell level-1"></span>
      <span class="heatmap-cell level-0"></span>
      <span>${RETENTION_FLOOR} <span class="map-legend-dim">floor</span></span>
    </div>`;
}

// ── Shared little row/segment builders ───────────────────────────────────────

function buildSegmented(name, options, current) {
  const btns = options.map(o => `
    <button type="button" class="segmented-btn${o.value === current ? ' is-on' : ''}"
            role="tab" aria-selected="${o.value === current}"
            data-map-control="${name}" data-map-value="${o.value}">${escHtml(o.label)}</button>`).join('');
  return `<div class="segmented" role="tablist">${btns}</div>`;
}

/** name · bar · value, the row shape used under every reading. */
function buildMuscleRow(label, { barPct = null, value = '', bold = false, barStyle = '' } = {}) {
  const bar = barPct == null
    ? ''
    : `<span class="mm-bar"><i style="width:${Math.max(0, Math.min(100, Math.round(barPct)))}%${barStyle ? ';' + barStyle : ''}"></i></span>`;
  return `
    <div class="mm-row">
      <span class="mm-name">${bold ? `<b>${escHtml(label)}</b>` : escHtml(label)}</span>
      ${bar}
      <span class="mm-value">${value}</span>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MODULE B — THE CARD
// ─────────────────────────────────────────────────────────────────────────────

function buildBalancePanel(state, { today, ui, catalog }) {
  const win = MAP_WINDOWS.find(w => w.days === ui.win) ?? MAP_WINDOWS[1];
  const b = computeMuscleBalance(state, { today, withinDays: win.days, catalog });

  const head = `
    <div class="mm-head">
      <h3 class="mm-title">Muscle balance <span class="mm-sub">· by sets worked</span></h3>
    </div>`;

  const windows = buildSegmented('win', MAP_WINDOWS.map(w => ({ value: w.days, label: w.label })), win.days);

  if (!b.sessionDays) {
    return head + windows + `<p class="mm-empty">No completed sets in this period yet.</p>`;
  }

  const sel = ui.selected;
  const selRow = sel
    ? `<div class="mm-row-selected">${buildMuscleRow(MUSCLE_NAME[sel] ?? sel, {
        value: b.load[sel] ? `${fmtSets(b.load[sel])} sets` : 'not trained',
        bold: true,
      })}</div>`
    : '';

  const topRows = sel ? '' : b.worked.slice(0, BALANCE_TOP_N).map(m => buildMuscleRow(
    MUSCLE_NAME[m] ?? m,
    { barPct: (b.load[m] / b.maxLoad) * 100, value: `${fmtSets(b.load[m])} sets` },
  )).join('');

  const missed = b.missed.length
    ? `<h4 class="mm-section">Not trained in this period</h4>
       <div class="mm-chips">${b.missed.map(m =>
          `<span class="mm-chip is-missed">${escHtml(MUSCLE_NAME[m] ?? m)}</span>`).join('')}</div>`
    : `<p class="mm-note">Every muscle group got some work in this period.</p>`;

  return head + windows +
    buildBodyMap(b.levels, {
      selected: sel,
      labelOf: m => `${MUSCLE_NAME[m] ?? m}: ${fmtSets(b.load[m] ?? 0)} sets`,
    }) +
    buildLevelLegend() + selRow + topRows + missed;
}

function buildFatiguePanel(state, { today, ui, catalog }) {
  const f = computeMuscleFatigue(state, { today, catalog });
  const sel = ui.selected;

  const selRow = sel
    ? `<div class="mm-row-selected">${buildMuscleRow(MUSCLE_NAME[sel] ?? sel, {
        value: f.daysSince[sel] == null
          ? 'never trained'
          : `${fatigueStatus(f.score[sel])} · ${f.daysSince[sel] === 0 ? 'today' : `${f.daysSince[sel]}d ago`}`,
        bold: true,
      })}</div>`
    : '';

  return `
    <div class="mm-head">
      <h3 class="mm-title">Fatigue <span class="mm-sub">· by days since trained</span></h3>
    </div>` +
    buildBodyMap(f.levels, {
      selected: sel,
      variant: 'map-fatigue',
      labelOf: m => `${MUSCLE_NAME[m] ?? m}: ${f.daysSince[m] == null ? 'never trained'
        : f.daysSince[m] === 0 ? 'trained today' : `${f.daysSince[m]} day${f.daysSince[m] === 1 ? '' : 's'} ago`}`,
    }) +
    buildFatigueLegend() +
    `<p class="mm-note">Fatigue is nothing but how recently each muscle was trained, drawn — full ${RECOVERY_DAYS} days after a session, flat before then. High means rest.</p>` +
    selRow;
}

function buildStrengthPanel(state, { today, ui, catalog }) {
  const s = computeMuscleStrength(state, { today, catalog });
  const sel = ui.selected;

  const trained = MUSCLES.filter(m => s.score[m] != null);
  const faded = trained.filter(m => s.score[m] < 1);

  let detail;
  if (sel) {
    const rows = strengthExercisesFor(state, sel, { today, catalog });
    detail = `<h4 class="mm-section">Exercises · ${escHtml(MUSCLE_NAME[sel] ?? sel)}</h4>` + (rows.length
      ? rows.map(r => `
          <div class="mm-row mm-row-tall">
            <span class="mm-name mm-name-stacked">
              <span class="mm-name-line">${escHtml(r.name)}<span class="mm-role"> ${r.role}</span></span>
              <span class="mm-name-meta">Est. 1RM: ${r.est} kg · ${escHtml(r.estDate)}</span>
            </span>
            <span class="mm-bar"><i style="width:100%;background:linear-gradient(to right, var(--color-accent) ${Math.round(r.decay * 100)}%, var(--color-surface-2) ${Math.round(r.decay * 100)}%)"></i></span>
            <span class="mm-value">${r.current} kg<span class="mm-value-dim"> · ${Math.round(r.decay * 100)}%</span></span>
          </div>`).join('')
      : `<p class="mm-empty">No weighted exercise with an estimated 1RM for this muscle yet.</p>`);
  } else {
    detail = `<p class="mm-note">Tap a muscle to see its exercises.</p>` +
      faded.map(m => buildMuscleRow(MUSCLE_NAME[m] ?? m, {
        barPct: s.score[m] * 100,
        value: `${Math.round(s.score[m] * 100)}%`,
      })).join('');
  }

  return `
    <div class="mm-head">
      <h3 class="mm-title">Strength <span class="mm-sub">· retained since last trained</span></h3>
    </div>` +
    buildBodyMap(s.levels, {
      selected: sel,
      variant: 'map-strength',
      labelOf: m => `${MUSCLE_NAME[m] ?? m}: ${s.score[m] == null ? 'never trained' : Math.round(s.score[m] * 100) + '% retained'}`,
    }) +
    buildStrengthLegend() +
    `<p class="mm-note">A model, not a measurement: nothing is assumed lost for ${GRACE_DAYS} days, then the margin above ${RETENTION_FLOOR} halves every ${RETENTION_HALF_LIFE_DAYS} days. Train it again to reset it.</p>` +
    detail;
}

/**
 * The muscle-map card: three readings of the same figure behind one tab strip.
 * `ui` is app.js's own { tab, win, selected } — this file never mutates it.
 */
function buildMuscleMapCard(state, { today, ui = {}, resolveMuscles = null } = {}) {
  const view = {
    tab: MAP_TABS.some(t => t.id === ui.tab) ? ui.tab : 'balance',
    win: MAP_WINDOWS.some(w => w.days === ui.win) ? ui.win : 30,
    selected: ui.selected ?? null,
  };

  const catalog = buildMuscleCatalog(state.plan, state.meta, resolveMuscles);
  const opts = { today, ui: view, catalog };

  const tabs = buildSegmented('tab', MAP_TABS.map(t => ({ value: t.id, label: t.label })), view.tab);
  const panel = view.tab === 'fatigue'  ? buildFatiguePanel(state, opts)
              : view.tab === 'strength' ? buildStrengthPanel(state, opts)
              :                           buildBalancePanel(state, opts);

  return `<div class="card hub-card hub-muscle-map" id="muscle-map-card">${tabs}${panel}</div>`;
}

export {
  computeActivityHeatmap,
  buildActivityHeatmapCard,
  loadBodyPaths,
  bodyPathsReady,
  buildMuscleCatalog,
  computeMuscleBalance,
  computeMuscleFatigue,
  computeMuscleStrength,
  strengthExercisesFor,
  fatigueFromDays,
  retentionFromDays,
  fatigueStatus,
  buildMuscleMapCard,
  MAP_TABS,
  MAP_WINDOWS,
};
