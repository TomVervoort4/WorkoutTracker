/**
 * plan.js — FitTrack · routines, the week schedule, and per-date rescheduling
 *
 * THE MODEL CHANGE THIS FILE EXISTS FOR. The plan used to be seven days, each
 * owning its own private list of exercises. "Push Day" was not a thing you
 * could hold — it was a name typed into Monday. Moving it to Thursday meant
 * cutting and pasting exercises between days, and training it twice a week
 * meant maintaining two copies that drifted apart.
 *
 * Now a ROUTINE is the object:
 *
 *     plan.routines  [{ id, name, glyph, prog, exercises: [...] }]
 *     plan.week      { 0: routineId | null, … 6: null }   0 = Monday
 *
 * The week merely POINTS at routines. Assigning the same routine to two days
 * is one routine trained twice, not two copies. Renaming it renames it
 * everywhere. Exercise ids are untouched by any of this, so every logged set
 * keeps resolving exactly as before — see migrateToRoutines, which is careful
 * about that above all else.
 *
 * ON TOP OF THE WEEK, ONE-OFF OVERRIDES. `dayPlan_<date>` meta keys hold a
 * single date's decision — a routine id, or the string 'rest'. Absent means
 * "whatever the weekly plan says". This is what makes "I was ill on Wednesday,
 * do legs on Thursday instead" a two-tap change that does NOT edit the weekly
 * plan, and does not survive into next week. Same per-date convention the app
 * already uses for `swaps_<date>` and `removed_<date>`.
 *
 * Pure compute + HTML-string builders, no DOM queries and no persistence —
 * the same division heatmaps.js and bodycomp.js already use. app.js owns
 * `state`, the writes, and every event listener.
 */

import { musclesOfField, loadOf, rankOf, MUSCLE_NAME } from './muscles.js';
import { POLICY_NAME } from './progression.js';

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const PLAN_VERSION = 2;

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** The per-date override key for one ISO date. */
const dayPlanKey = (date) => `dayPlan_${date}`;

/** The sentinel a per-date override uses to mean "rest, whatever the week says". */
const REST = 'rest';

// ─────────────────────────────────────────────────────────────────────────────
//  GLYPHS — the little icon on a routine
//
//  A fixed, named set rather than free emoji: they render identically on every
//  platform, inherit the accent colour, and cannot arrive as an unrenderable
//  codepoint from an imported backup.
// ─────────────────────────────────────────────────────────────────────────────

const GLYPHS = {
  dumbbell:  '<path d="M6.5 6.5v11"/><path d="M17.5 6.5v11"/><path d="M3 9v6"/><path d="M21 9v6"/><path d="M6.5 12h11"/>',
  push:      '<path d="M4 12h4"/><path d="M16 12h4"/><rect x="8" y="8" width="8" height="8" rx="2"/>',
  pull:      '<path d="M12 21V11"/><path d="M5 4l7 7 7-7"/><path d="M4 4h16"/>',
  legs:      '<path d="M9 3v7l-1 11"/><path d="M15 3v7l1 11"/><path d="M9 3h6"/>',
  run:       '<circle cx="13" cy="4.5" r="1.8"/><path d="M11 21l2-6-3-3 1-4 3 3 3 1"/><path d="M8 12l2-4"/><path d="M6 21l3-5"/>',
  heart:     '<path d="M20.8 8.6a5 5 0 0 0-8.8-2.3A5 5 0 0 0 3.2 8.6c0 5 8.8 10.4 8.8 10.4s8.8-5.4 8.8-10.4z"/>',
  flame:     '<path d="M12 2c1 4 4 5 4 9a4 4 0 0 1-8 0c0-1.5.6-2.4 1.2-3.2C10 6.7 12 5 12 2z"/><path d="M8.2 12A6 6 0 0 0 12 22a6 6 0 0 0 3.8-10"/>',
  bolt:      '<polygon points="13 2 4 14 11 14 10 22 20 10 13 10"/>',
  stretch:   '<circle cx="12" cy="4.5" r="1.8"/><path d="M12 7v6"/><path d="M6 9l6 2 6-2"/><path d="M12 13l-3 8"/><path d="M12 13l3 8"/>',
  core:      '<ellipse cx="12" cy="12" rx="5" ry="8"/><path d="M7 10h10"/><path d="M7 14h10"/>',
  back:      '<path d="M12 3v18"/><path d="M7 6l5 3 5-3"/><path d="M6 12l6 3 6-3"/>',
  clock:     '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};

const DEFAULT_GLYPH = 'dumbbell';

const glyphOf = (name) => GLYPHS[name] ? name : DEFAULT_GLYPH;

/** One glyph as an inline SVG, at `size` px. */
function glyphSvg(name, size = 18) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
     stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPHS[glyphOf(name)]}</svg>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  SMALL LOCAL UTILITIES (no app.js deps — see the module note)
// ─────────────────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const CHEVRON = `<svg class="row-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none"
     stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
     aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>`;

const CHECK = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
     stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
     <polyline points="20 6 9 17 4 12"/></svg>`;

const exCountLabel = (n) => `${n} exercise${n === 1 ? '' : 's'}`;

// ─────────────────────────────────────────────────────────────────────────────
//  MODEL QUERIES — every one takes the plan, none reads global state
// ─────────────────────────────────────────────────────────────────────────────

const routinesOf = (plan) => plan?.routines ?? [];

const routineById = (plan, id) => routinesOf(plan).find(r => r.id === id) ?? null;

/** A routine's exercises in training order, archived ones excluded. */
const activeExercises = (routine) => (routine?.exercises ?? []).filter(e => !e.archived);

/** Every exercise across every routine, archived included (name resolution). */
function allPlanExercises(plan) {
  return routinesOf(plan).flatMap(r => r.exercises ?? []);
}

/** The routine the WEEKLY plan assigns to a weekday index (0 = Monday). */
const routineForDayIndex = (plan, dayIndex) => routineById(plan, plan?.week?.[dayIndex] ?? null);

/**
 * What a specific date actually trains, and why. A per-date override wins over
 * the weekly plan; `overridden` says which of the two the caller is looking at,
 * so the UI can be honest that a day has been changed.
 */
function resolveDay(plan, meta, date, dayIndex) {
  const override = meta?.[dayPlanKey(date)]?.value;
  const weekly = routineForDayIndex(plan, dayIndex);
  if (override === undefined || override === null || override === '') {
    return { routine: weekly, weekly, overridden: false, isRest: !weekly };
  }
  if (override === REST) return { routine: null, weekly, overridden: true, isRest: true };
  const picked = routineById(plan, override);
  // An override pointing at a routine that has since been deleted is not an
  // error state to surface — it simply falls back to the weekly plan.
  if (!picked) return { routine: weekly, weekly, overridden: false, isRest: !weekly };
  return { routine: picked, weekly, overridden: true, isRest: false };
}

// ─────────────────────────────────────────────────────────────────────────────
//  SUPERSETS
//
//  Two adjacent exercises sharing an `sg` id are performed back-to-back. The
//  grouping is positional on purpose: reordering an exercise out of a pair
//  breaks the pair, which is what someone dragging it away means.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Splits an exercise list into units — a run of adjacent same-`sg` entries, or
 * a single exercise. Returns arrays of indices.
 */
function supersetUnits(exercises) {
  const units = [];
  let cur = [];
  exercises.forEach((e, i) => {
    if (cur.length && e.sg && exercises[cur[cur.length - 1]].sg === e.sg) {
      cur.push(i);
      return;
    }
    if (cur.length) units.push(cur);
    cur = [i];
  });
  if (cur.length) units.push(cur);
  return units;
}

/**
 * Drops `sg` ids that no longer group anything — a pair broken by a reorder or
 * a deletion leaves two lone exercises still carrying a group id, which would
 * silently re-pair them if one moved back. Mutates in place.
 */
function cleanupSupersets(exercises) {
  const counts = new Map();
  supersetUnits(exercises).forEach(unit => {
    if (unit.length > 1) counts.set(exercises[unit[0]].sg, unit.length);
  });
  exercises.forEach(e => { if (e.sg && !counts.has(e.sg)) delete e.sg; });
  return exercises;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MIGRATION — v1 (seven private day lists) → v2 (routines + week)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rebuilds a v1 plan as routines + a week map. Returns
 * `{ plan, orphaned }` — `orphaned` being the archived exercises the old day
 * lists carried, which the caller stamps into the exercise registry so their
 * logged history keeps resolving a name.
 *
 * TWO INVARIANTS, both about not losing history:
 *   1. Exercise objects are carried across BY REFERENCE, ids untouched. No log
 *      record is rewritten, and none needs to be.
 *   2. Two days whose session name AND exercise-id list both match become ONE
 *      routine assigned twice — that is the same session trained twice a week,
 *      which is exactly what the new model is for. Anything less identical
 *      stays two routines, because merging them would silently edit a plan.
 */
function migrateToRoutines(plan, { newId, glyphFor }) {
  if (!plan || plan.routines) return null; // already v2, or nothing to migrate

  const routines = [];
  const week = {};
  const orphaned = [];
  const byKey = new Map();

  for (const day of plan.days ?? []) {
    const idx = day.dayIndex;
    const active = (day.exercises ?? []).filter(e => !e.archived);
    for (const e of (day.exercises ?? [])) if (e.archived) orphaned.push(e);

    if (!active.length) { week[idx] = null; continue; }

    const name = (day.sessionName ?? '').trim() || `${DAY_NAMES[idx]} session`;
    const key = `${name.toLowerCase()}|${active.map(e => e.id).join(',')}`;

    let routine = byKey.get(key);
    if (!routine) {
      routine = {
        id: newId('rt'),
        name,
        glyph: glyphFor ? glyphFor(name) : DEFAULT_GLYPH,
        prog: 'linear',
        exercises: active,
      };
      byKey.set(key, routine);
      routines.push(routine);
    }
    week[idx] = routine.id;
  }

  for (let i = 0; i < 7; i++) if (week[i] === undefined) week[i] = null;

  const migrated = { ...plan, version: PLAN_VERSION, routines, week };
  delete migrated.days; // the seven private lists are gone, not kept in parallel

  return { plan: migrated, orphaned };
}

/** A sensible starting glyph from a routine's name. Cosmetic only. */
function guessGlyph(name) {
  const n = String(name ?? '').toLowerCase();
  if (/pull|row|back|lat/.test(n)) return 'pull';
  if (/push|press|chest|bench/.test(n)) return 'push';
  if (/leg|squat|lower|glute|quad/.test(n)) return 'legs';
  if (/cardio|run|condition/.test(n)) return 'run';
  if (/core|abs|trunk/.test(n)) return 'core';
  if (/mobility|stretch|prehab|rehab/.test(n)) return 'stretch';
  if (/upper/.test(n)) return 'dumbbell';
  if (/full|total/.test(n)) return 'bolt';
  return DEFAULT_GLYPH;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PLAN TAB — HTML BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

/** The routine tag shown on a week row: glyph + name, or a plain "Rest". */
function routineTag(routine, { overridden = false } = {}) {
  if (!routine) return `<span class="routine-tag routine-tag-rest">Rest</span>`;
  return `<span class="routine-tag${overridden ? ' routine-tag-changed' : ''}">${glyphSvg(routine.glyph, 13)}${escHtml(routine.name)}</span>`;
}

/** The seven weekday rows. `dayIndex` order is Monday-first, as everywhere. */
function buildWeekScheduleHTML(plan) {
  const rows = DAY_NAMES.map((label, idx) => {
    const routine = routineForDayIndex(plan, idx);
    return `
      <button class="plan-row" data-plan-action="assign-day" data-day="${idx}">
        <span class="plan-row-title">${label}</span>
        ${routineTag(routine)}
        ${CHEVRON}
      </button>`;
  }).join('');

  return `<div class="plan-list">${rows}</div>`;
}

/** The routine library, or a first-run invitation when there is none. */
function buildRoutineListHTML(plan) {
  const routines = routinesOf(plan);
  if (!routines.length) {
    return `
      <div class="plan-empty">
        <p class="plan-empty-title">No routines yet.</p>
        <p class="plan-empty-sub">Create one with <strong>+ New</strong> — then assign it to the days you train it.</p>
      </div>`;
  }

  return `<div class="plan-list">${routines.map(r => `
    <button class="plan-row plan-row-routine" data-plan-action="open-routine" data-routine="${escHtml(r.id)}">
      <span class="routine-icon">${glyphSvg(r.glyph, 17)}</span>
      <span class="plan-row-main">
        <span class="plan-row-title">${escHtml(r.name)}</span>
        <span class="plan-row-sub">${exCountLabel(activeExercises(r).length)}</span>
      </span>
      ${CHEVRON}
    </button>`).join('')}</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ROUTINE EDITOR — HTML BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

/** "4 × 8", "3 × 30s", "4 × 8 @ 60 kg", "3 × 10 / side". */
function exerciseLine(ex) {
  const isTimed = ex.loadType === 'timed' || ex.unit === 'seconds';
  const effort = isTimed ? `${ex.reps}s` : `${ex.reps}`;
  let line = `${ex.sets} × ${effort}`;
  if (ex.weight > 0) line += ` @ ${ex.weight} kg`;
  if (ex.perSide) line += ' / side';
  return line;
}

/**
 * One exercise row in the routine editor: thumbnail, name, prescription line,
 * a superset link to the row above, and the two reorder buttons.
 * `thumbHtml` is supplied by app.js, which owns reference-image resolution.
 */
function buildRoutineExerciseRowHTML(ex, i, { thumbHtml = '', linkedAbove = false, inSuperset = false, first = false }) {
  const linkBtn = i > 0 ? `
    <button class="routine-ex-link${linkedAbove ? ' is-on' : ''}" type="button"
            data-plan-action="toggle-link" data-index="${i}"
            aria-pressed="${linkedAbove}"
            aria-label="${linkedAbove ? 'Break superset with the exercise above' : 'Superset with the exercise above'}">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/>
        <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>
    </button>` : '';

  const ssLabel = first ? `
    <div class="superset-label">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/>
        <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>
      Superset
    </div>` : '';

  return `${ssLabel}
    <div class="routine-ex-row${inSuperset ? ' in-superset' : ''}" data-index="${i}">
      <button class="routine-ex-main" type="button" data-plan-action="config-exercise" data-index="${i}">
        <span class="routine-ex-thumb">${thumbHtml}</span>
        <span class="routine-ex-text">
          <span class="routine-ex-name">${escHtml(ex.name)}</span>
          <span class="routine-ex-line">${escHtml(exerciseLine(ex))}</span>
        </span>
      </button>
      <div class="routine-ex-controls">
        ${linkBtn}
        <div class="routine-ex-moves">
          <button class="routine-ex-move" type="button" data-plan-action="move-up" data-index="${i}" aria-label="Move ${escHtml(ex.name)} up">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="6 15 12 9 18 15"/></svg>
          </button>
          <button class="routine-ex-move" type="button" data-plan-action="move-down" data-index="${i}" aria-label="Move ${escHtml(ex.name)} down">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9"/></svg>
          </button>
        </div>
      </div>
    </div>`;
}

/**
 * "What this session hits" — the routine's planned coverage, so a gap shows up
 * while you are building it rather than after a month of training around it.
 * The load is per PLANNED sets, not logged ones: this is what the session
 * would do, which is the only question a plan editor can answer.
 * `bodyMapHtml` comes from heatmaps.js via app.js.
 */
function buildRoutineCoverageHTML(routine, bodyMapHtml) {
  const load = routineLoad(routine);
  const { worked } = rankOf(load);
  if (!worked.length) return '';

  return `
    <div class="card hub-card routine-coverage">
      <div class="hub-card-head">
        <span class="hub-card-title">What this session hits</span>
      </div>
      ${bodyMapHtml}
      <div class="mm-chips">
        ${worked.slice(0, 6).map(m => `<span class="mm-chip">${escHtml(MUSCLE_NAME[m] ?? m)}</span>`).join('')}
      </div>
    </div>`;
}

/** Effective sets per muscle a routine WOULD produce, from its planned sets. */
function routineLoad(routine, resolveMuscles = null) {
  return loadOf(activeExercises(routine).map(ex => ({
    weights: musclesOfField((resolveMuscles ? resolveMuscles(ex) : ex.muscles) || ex.muscles || ''),
    sets: Number(ex.sets) || 1,
  })));
}

/** The routine editor's progression summary row. */
function buildProgressionRowHTML(routine) {
  const policy = routine?.prog || 'linear';
  return `
    <button class="plan-row plan-row-setting" data-plan-action="routine-progression">
      <span class="routine-icon routine-icon-sm">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="3 17 9 11 13 15 21 7"/><polyline points="15 7 21 7 21 13"/></svg>
      </span>
      <span class="plan-row-title">Progression</span>
      <span class="plan-row-value">${escHtml(POLICY_NAME[policy] ?? policy)}</span>
      ${CHEVRON}
    </button>`;
}

export {
  PLAN_VERSION,
  DAY_NAMES,
  REST,
  dayPlanKey,
  GLYPHS,
  DEFAULT_GLYPH,
  glyphOf,
  glyphSvg,
  guessGlyph,
  escHtml as escapePlanHtml,
  CHEVRON,
  CHECK,
  exCountLabel,
  routinesOf,
  routineById,
  activeExercises,
  allPlanExercises,
  routineForDayIndex,
  resolveDay,
  supersetUnits,
  cleanupSupersets,
  migrateToRoutines,
  routineTag,
  buildWeekScheduleHTML,
  buildRoutineListHTML,
  exerciseLine,
  buildRoutineExerciseRowHTML,
  buildRoutineCoverageHTML,
  routineLoad,
  buildProgressionRowHTML,
};
