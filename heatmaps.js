/**
 * heatmaps.js — FitTrack · Activity & Muscle-Focus Heatmaps
 *
 * Two deterministic, display-only additions, in the spirit of insights.js and
 * PHASE4-CONVERGENCE.md: every number here is a plain count over local logs
 * that the user could verify by hand. Nothing is inferred, graded or advised.
 *
 *   Module A — Activity heatmap: a GitHub-style grid, one cell per day, shaded
 *   by how many completed sets were logged that day. Pure count, no judgement
 *   about whether that count is "enough".
 *
 *   Module B — Muscle focus: which muscle groups got worked in the last N days
 *   (by completed-set count) and which got none. Reuses the exercise's
 *   existing `muscles` display field (e.g. "Lats · Rhomboids · Biceps") the
 *   same way app.js's own exercise-add hint already does — the FIRST listed
 *   muscle is the one a set counts toward. No new data, no new judgement.
 *
 * Self-contained on purpose (same reasoning as insights.js's own note on this
 * split): only `canonId` is imported, to stay in lock-step with the id-alias
 * map app.js already configures on insights.js, so a lift that was renamed or
 * merged onto a new id is still counted correctly here too.
 *
 * Pure compute + HTML-string builders, no DOM queries of its own — the same
 * division bodycomp.js already uses (computes AND renders its own tab), which
 * is why this file also exports `build*Card` functions rather than leaving
 * card assembly to app.js.
 */

import { canonId } from './insights.js';

// ─────────────────────────────────────────────────────────────────────────────
//  TUNABLES — every magic number lives here, nowhere inline
// ─────────────────────────────────────────────────────────────────────────────

const ACTIVITY_WEEKS_DEFAULT      = 53;  // ≈ a full year of columns, GitHub-style
const MUSCLE_WINDOW_DAYS_DEFAULT  = 30;  // matches insights.js's RECENT_PR_WINDOW_DAYS
const MUSCLE_TOP_N_DEFAULT        = 8;   // most-worked groups shown on the card

const ACTIVITY_MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
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

/** 0 = Monday … 6 = Sunday, for a date string "YYYY-MM-DD". */
function dayOfWeekMondayFirst(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const js = new Date(y, m - 1, d).getDay(); // JS: 0 = Sunday … 6 = Saturday
  return (js + 6) % 7;
}

/** The first muscle named in a "Chest · Front Delt · Triceps" display string —
 *  the same convention app.js's own exercise-add hint already uses. */
function firstMuscle(musclesField) {
  return (musclesField ?? '').split('·')[0].trim();
}

// ─────────────────────────────────────────────────────────────────────────────
//  MODULE A — ACTIVITY HEATMAP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a `weeks`-column × 7-row grid (Monday-first rows) ending on the week
 * that contains `today`. Each cell carries the completed-set count for that
 * date and a 0–4 shading level scaled off the busiest day in the window; days
 * after `today` (the tail of the current week) get level -1 and are not
 * rendered as data, only as empty grid space — this is what keeps "today"
 * always landing in the last column regardless of which weekday it falls on.
 *
 * @param {object[]} logs   state.logs — raw records with {date, done, reps}
 * @param {object}   opts
 * @param {string}   opts.today  "YYYY-MM-DD"
 * @param {number}   [opts.weeks]
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

/** Renders the Activity card in the existing hub-card house style. */
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
      <div class="heatmap-legend">
        <span>Less</span>
        <span class="heatmap-cell level-0"></span>
        <span class="heatmap-cell level-1"></span>
        <span class="heatmap-cell level-2"></span>
        <span class="heatmap-cell level-3"></span>
        <span class="heatmap-cell level-4"></span>
        <span>More</span>
      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MODULE B — MUSCLE FOCUS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The same three sources insights.js's own buildExerciseCatalog reads (plan,
 * per-session swaps, the orphan registry) — plus `muscles`, which insights.js
 * doesn't carry because it doesn't need it. Duplicated rather than imported on
 * purpose, matching insights.js's own "self-contained, no app.js deps" note.
 */
function buildMuscleCatalog(plan, meta) {
  const catalog = new Map();
  const add = (ex) => {
    if (!ex?.id || !ex.name) return;
    const cid = canonId(ex.id);
    if (catalog.has(cid)) return;
    catalog.set(cid, { id: cid, name: ex.name, muscle: firstMuscle(ex.muscles) });
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

/**
 * Completed-set counts per primary muscle over the last `withinDays` days,
 * plus which muscles (from the whole catalog, any time) got zero sets in that
 * window. A count and a set difference — both facts, neither a judgement.
 */
function computeMuscleFocus(state, { today, withinDays = MUSCLE_WINDOW_DAYS_DEFAULT, topN = MUSCLE_TOP_N_DEFAULT } = {}) {
  const cutoff = addDays(today, -withinDays);
  const catalog = buildMuscleCatalog(state.plan, state.meta);

  const allMuscles = new Set();
  for (const ex of catalog.values()) {
    if (ex.muscle) allMuscles.add(ex.muscle);
  }

  const setsPerMuscle = new Map();
  for (const l of state.logs) {
    if (!l.done || l.reps == null) continue;
    if (l.date < cutoff || l.date > today) continue;
    const ex = catalog.get(canonId(l.exerciseId));
    if (!ex?.muscle) continue;
    setsPerMuscle.set(ex.muscle, (setsPerMuscle.get(ex.muscle) ?? 0) + 1);
  }

  const trained = [...setsPerMuscle.entries()]
    .map(([name, sets]) => ({ name, sets }))
    .sort((a, b) => b.sets - a.sets || a.name.localeCompare(b.name));

  const untouched = [...allMuscles]
    .filter((m) => !setsPerMuscle.has(m))
    .sort((a, b) => a.localeCompare(b));

  return {
    windowDays: withinDays,
    muscles: trained.slice(0, topN),
    maxSets: trained.length ? trained[0].sets : 0,
    untouched,
  };
}

/** Renders the Muscle focus card in the existing hub-card house style. */
function buildMuscleFocusCard(state, { today, withinDays = MUSCLE_WINDOW_DAYS_DEFAULT, topN = MUSCLE_TOP_N_DEFAULT } = {}) {
  const { muscles, maxSets, untouched, windowDays } = computeMuscleFocus(state, { today, withinDays, topN });

  if (!muscles.length) {
    return `
      <div class="card hub-card hub-muscle-focus">
        <div class="hub-card-head">
          <span class="hub-card-title">Muscle focus</span>
          <span class="hub-card-meta">last ${windowDays} days</span>
        </div>
        <p class="hub-pr-empty">No completed sets in the last ${windowDays} days yet.</p>
      </div>`;
  }

  const bars = muscles.map((m) => `
    <div class="muscle-bar-row">
      <span class="muscle-bar-name">${escHtml(m.name)}</span>
      <div class="muscle-bar-track">
        <div class="muscle-bar-fill" style="width:${maxSets ? Math.round((m.sets / maxSets) * 100) : 0}%"></div>
      </div>
      <span class="muscle-bar-count">${m.sets}</span>
    </div>`).join('');

  const untouchedLine = untouched.length
    ? `<p class="hub-body-freshness">Not trained this window: ${untouched.map(escHtml).join(', ')}</p>`
    : '';

  return `
    <div class="card hub-card hub-muscle-focus">
      <div class="hub-card-head">
        <span class="hub-card-title">Muscle focus</span>
        <span class="hub-card-meta">completed sets · last ${windowDays} days</span>
      </div>
      <div class="muscle-bar-list">${bars}</div>
      ${untouchedLine}
    </div>`;
}

export {
  computeActivityHeatmap,
  computeMuscleFocus,
  buildActivityHeatmapCard,
  buildMuscleFocusCard,
};
