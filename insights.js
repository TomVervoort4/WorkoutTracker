/**
 * insights.js — FitTrack · Rule-Based Insights Engine
 *
 * Deterministic, fully client-side analysis of existing session/exercise
 * logs, bodyweight entries, and session notes already stored via db.js.
 * No network calls, no ML — pure arithmetic and comparisons against
 * stored history. The tracker reports facts; it does not coach.
 */

import { put } from './db.js';

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIG — every tunable threshold lives here
// ─────────────────────────────────────────────────────────────────────────────

const EPLEY_REPS_DIVISOR = 30; // e1RM = weight * (1 + reps / 30)

// Module 1 — progression
const PROGRESSION_TRAILING_SESSIONS = 4;   // compare latest vs avg of up to this many prior sessions
const PROGRESSION_TRAILING_MIN      = 3;   // minimum prior sessions required to produce a card
const PROGRESSION_FLAT_PCT          = 0.01; // +/- this fraction of the trailing avg counts as "holding"

// Module 2 — plateau detection
const COMPOUND_PLATEAU_SESSIONS  = 3; // consecutive unchanged sessions before flagging
const ISOLATION_PLATEAU_SESSIONS = 4;
const PLATEAU_SUGGESTIONS = [
  'increase load',
  'increase reps within your target range',
  'check technique/form on this lift',
];

// Module 3 — personal bests
const RECENT_PB_LIST_LIMIT = 10;

// Module 4 — weekly volume by session type (dayIndex: 0=Mon, 2=Wed, 4=Fri)
const SESSION_TYPE_DAY_INDEXES = [0, 2, 4];
const SESSION_TYPE_FALLBACK_LABELS = {
  0: 'Upper Heavy Base',
  2: 'Upper Moderate + Core',
  4: 'Lower + Cuff Prehab',
};
const WEEKLY_VOLUME_DROP_PCT  = 0.15; // week-over-week drop beyond this flags undertraining
const WEEKLY_VOLUME_SPIKE_PCT = 0.25; // week-over-week rise beyond this flags overreach

// Module 5 — consistency / gap tracking
const CONSISTENCY_WINDOW_DAYS      = 14;
const CONSISTENCY_PLANNED_SESSIONS = 6; // 3/week x 2 weeks

// Module 6 — bodyweight vs strength trend
const BW_TREND_MIN_ENTRIES        = 4;
const BW_TREND_MAX_ENTRIES        = 6;
const BW_FLAT_THRESHOLD_KG        = 0.5;  // window delta below this counts as "flat"
const STRENGTH_FLAT_THRESHOLD_PCT = 0.02; // window e1RM change below this counts as "flat"

// Module 7 — context-aware regression
const CONTEXT_KEYWORDS = ['shoot', 'gig', 'event']; // configurable free-text tags in session notes
const CONTEXT_LOOKBACK_DAYS = 3; // how many days before a regression/gap to scan for a tagged note

// Exercise classification — compounds get e1RM tracking, everything else gets volume tracking
const COMPOUND_NAME_KEYWORDS = [
  'bench press', 'squat', 'overhead press', 'romanian deadlift', 'deadlift',
  'pull-up', 'pullup', 'pull up', 'lat pulldown', 'row', 'leg press',
];
const ISOLATION_NAME_KEYWORDS = [
  'curl', 'pushdown', 'push-down', 'face pull', 'calf raise',
  'external rotation', 'rear delt', 'fly', 'pull-apart', 'pull apart', 'raise',
];

const RECENT_PBS_KEY      = 'recentPBs';
const INSIGHTS_DISMISSED_KEY = 'insightsDismissedCardIds';

const MONTH_NAMES_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// ─────────────────────────────────────────────────────────────────────────────
//  SMALL LOCAL UTILITIES (kept self-contained — insights.js has no app.js deps)
// ─────────────────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function localDayIndexOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const js = new Date(y, m - 1, d).getDay(); // 0=Sun
  return js === 0 ? 6 : js - 1; // 0=Mon ... 6=Sun
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

function mondayKeyOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dow = date.getDay();
  date.setDate(date.getDate() + (dow === 0 ? -6 : 1 - dow));
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function friendlyDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${MONTH_NAMES_SHORT[m - 1]} ${d}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  EXERCISE CLASSIFICATION
// ─────────────────────────────────────────────────────────────────────────────

/** Compounds get e1RM-based tracking; everything else gets volume-based tracking. */
function isCompoundExercise(name) {
  const n = (name ?? '').toLowerCase();
  if (ISOLATION_NAME_KEYWORDS.some(k => n.includes(k))) return false;
  if (COMPOUND_NAME_KEYWORDS.some(k => n.includes(k))) return true;
  return false;
}

/** Builds an id -> {id, name, isCompound} map from the plan and all session-scoped extras. */
function buildExerciseCatalog(plan, meta) {
  const catalog = new Map();

  if (plan) {
    for (const day of plan.days) {
      for (const ex of (day.exercises ?? [])) {
        if (!ex.name) continue;
        catalog.set(ex.id, { id: ex.id, name: ex.name, isCompound: isCompoundExercise(ex.name) });
      }
    }
  }

  for (const key in meta) {
    if (!key.startsWith('swaps_')) continue;
    for (const extra of (meta[key]?.value ?? [])) {
      if (!extra.name) continue;
      catalog.set(extra.id, { id: extra.id, name: extra.name, isCompound: isCompoundExercise(extra.name) });
    }
  }

  return catalog;
}

// ─────────────────────────────────────────────────────────────────────────────
//  METRIC HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function epley1RM(weight, reps) {
  if (weight == null || reps == null || reps <= 0) return null;
  return weight * (1 + reps / EPLEY_REPS_DIVISOR);
}

function doneSetsFor(logs, exerciseId, date) {
  return logs.filter(l =>
    l.exerciseId === exerciseId && l.date === date && l.done &&
    l.weight != null && l.reps != null
  );
}

function distinctDoneDatesFor(logs, exerciseId) {
  return [...new Set(
    logs.filter(l => l.exerciseId === exerciseId && l.done && l.weight != null && l.reps != null)
      .map(l => l.date)
  )].sort();
}

function topSet(sets) {
  if (!sets.length) return null;
  return sets.reduce((best, s) => (s.weight > (best?.weight ?? -Infinity) ? s : best), null);
}

/** Top-set e1RM for compounds, total session volume for everything else. */
function sessionMetric(sets, isCompound) {
  if (!sets.length) return null;
  if (isCompound) {
    const top = topSet(sets);
    const value = epley1RM(top.weight, top.reps);
    if (value == null) return null;
    return { value, weight: top.weight, reps: top.reps };
  }
  const value = sets.reduce((sum, s) => sum + s.weight * s.reps, 0);
  return { value, weight: null, reps: null };
}

/** One metric entry per session date an exercise was logged, oldest first. */
function sessionsWithMetric(logs, exerciseId, isCompound) {
  return distinctDoneDatesFor(logs, exerciseId)
    .map(date => {
      const metric = sessionMetric(doneSetsFor(logs, exerciseId, date), isCompound);
      return metric && { date, ...metric };
    })
    .filter(Boolean);
}

function getAllTimeBestMetric(logs, exerciseId, isCompound, excludeDate = null) {
  let best = null;
  for (const session of sessionsWithMetric(logs, exerciseId, isCompound)) {
    if (session.date === excludeDate) continue;
    if (best == null || session.value > best.value) best = session;
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
//  SESSION NOTES (module 7 input) — free-text notes are stored per exercise
//  per date (log setIndex 0); we treat all of a date's notes as that
//  session's free text for keyword matching.
// ─────────────────────────────────────────────────────────────────────────────

function getSessionNoteText(logs, date) {
  return logs
    .filter(l => l.date === date && l.notes?.trim())
    .map(l => l.notes.trim())
    .join(' | ');
}

function matchedContextKeyword(text) {
  const lower = (text ?? '').toLowerCase();
  return CONTEXT_KEYWORDS.find(k => lower.includes(k)) ?? '';
}

/** Looks for a tagged session note on `date` or up to CONTEXT_LOOKBACK_DAYS before it. */
function findContextNoteNear(logs, date) {
  for (let i = 0; i <= CONTEXT_LOOKBACK_DAYS; i++) {
    const d = addDays(date, -i);
    const text = getSessionNoteText(logs, d);
    if (matchedContextKeyword(text)) return { date: d, text };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MODULE 3 — PB DETECTION (called immediately after a set is saved)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks whether the set(s) just logged for `exerciseId` on `date` produced
 * a new all-time-best session metric, and if so records it to the
 * recent-PBs list and returns a display message for an immediate toast.
 * Returns null when it isn't a new PB.
 */
async function checkForNewPB(state, exerciseId, exerciseName, date) {
  const isCompound = isCompoundExercise(exerciseName);
  const todayMetric = sessionMetric(doneSetsFor(state.logs, exerciseId, date), isCompound);
  if (!todayMetric) return null;

  const prevBest = getAllTimeBestMetric(state.logs, exerciseId, isCompound, date);
  if (prevBest && todayMetric.value <= prevBest.value) return null;

  const message = isCompound
    ? `New PB: ${exerciseName} e1RM ${todayMetric.value.toFixed(1)}kg (${todayMetric.weight}kg x ${todayMetric.reps})`
    : `New PB: ${exerciseName} session volume ${Math.round(todayMetric.value)}kg`;

  const entry = {
    id: `${exerciseId}_${date}`,
    exerciseId,
    exerciseName,
    date,
    isCompound,
    value: todayMetric.value,
    weight: todayMetric.weight,
    reps: todayMetric.reps,
    message,
  };

  const doc = state.meta[RECENT_PBS_KEY] ?? { key: RECENT_PBS_KEY, value: [] };
  doc.value = [entry, ...doc.value.filter(e => e.id !== entry.id)].slice(0, RECENT_PB_LIST_LIMIT);
  await put('meta', doc);
  state.meta[RECENT_PBS_KEY] = doc;

  return message;
}

function computePBCards(meta) {
  const list = meta[RECENT_PBS_KEY]?.value ?? [];
  return list.map(entry => ({
    id: `pb_${entry.id}`,
    title: entry.exerciseName,
    tone: 'pb',
    text: entry.message,
    date: entry.date,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
//  MODULE 1 — PER-EXERCISE PROGRESSION
// ─────────────────────────────────────────────────────────────────────────────

function computeProgressionCards(catalog, logs) {
  const cards = [];

  for (const ex of catalog.values()) {
    const sessions = sessionsWithMetric(logs, ex.id, ex.isCompound);
    if (sessions.length < PROGRESSION_TRAILING_MIN + 1) continue;

    const latest = sessions[sessions.length - 1];
    const priorWindow = sessions.slice(-1 - PROGRESSION_TRAILING_SESSIONS, -1);
    const priorAvg = priorWindow.reduce((s, x) => s + x.value, 0) / priorWindow.length;
    const delta = latest.value - priorAvg;
    const deltaPct = priorAvg ? delta / priorAvg : 0;

    const tone = deltaPct > PROGRESSION_FLAT_PCT ? 'progressing'
      : deltaPct < -PROGRESSION_FLAT_PCT ? 'regressing'
      : 'holding';

    const sign = delta >= 0 ? '+' : '';
    const text = ex.isCompound
      ? `${ex.name} e1RM: ${latest.value.toFixed(1)}kg, ${sign}${delta.toFixed(1)}kg vs your last ${priorWindow.length} sessions`
      : `${ex.name} volume: ${Math.round(latest.value)}kg, ${sign}${Math.round(delta)}kg vs your last ${priorWindow.length} sessions`;

    cards.push({
      id: `progression_${ex.id}_${latest.date}`,
      title: ex.name,
      tone,
      text,
      date: latest.date,
    });
  }

  return cards.sort((a, b) => b.date.localeCompare(a.date));
}

// ─────────────────────────────────────────────────────────────────────────────
//  MODULE 2 — PLATEAU DETECTION
// ─────────────────────────────────────────────────────────────────────────────

function countPlateauStreak(sessions, isCompound) {
  let streak = 1;
  for (let i = sessions.length - 1; i > 0; i--) {
    const a = sessions[i];
    const b = sessions[i - 1];
    const same = isCompound ? (a.weight === b.weight && a.reps === b.reps) : (a.value === b.value);
    if (!same) break;
    streak++;
  }
  return streak;
}

function computePlateauCards(catalog, logs) {
  const cards = [];

  for (const ex of catalog.values()) {
    const sessions = sessionsWithMetric(logs, ex.id, ex.isCompound);
    const needed = ex.isCompound ? COMPOUND_PLATEAU_SESSIONS : ISOLATION_PLATEAU_SESSIONS;
    if (sessions.length < needed) continue;

    const streak = countPlateauStreak(sessions, ex.isCompound);
    if (streak < needed) continue;

    const suggestion = PLATEAU_SUGGESTIONS[(streak - needed) % PLATEAU_SUGGESTIONS.length];
    const latest = sessions[sessions.length - 1];
    const stateDesc = ex.isCompound
      ? `${latest.weight}kg x ${latest.reps}`
      : `${Math.round(latest.value)}kg volume`;

    cards.push({
      id: `plateau_${ex.id}_${latest.date}_${streak}`,
      title: ex.name,
      tone: 'holding',
      text: `${ex.name}: no change for ${streak} sessions (${stateDesc}). Suggestion: ${suggestion}.`,
      date: latest.date,
    });
  }

  return cards.sort((a, b) => b.date.localeCompare(a.date));
}

// ─────────────────────────────────────────────────────────────────────────────
//  MODULE 4 — WEEKLY VOLUME BY SESSION TYPE
// ─────────────────────────────────────────────────────────────────────────────

function computeWeeklyVolumeCards(plan, logs) {
  const cards = [];

  for (const dayIdx of SESSION_TYPE_DAY_INDEXES) {
    const label = plan?.days?.[dayIdx]?.sessionName || SESSION_TYPE_FALLBACK_LABELS[dayIdx];

    const byWeek = {};
    for (const l of logs) {
      if (!l.done || l.weight == null || l.reps == null) continue;
      if (localDayIndexOf(l.date) !== dayIdx) continue;
      const wk = mondayKeyOf(l.date);
      byWeek[wk] = (byWeek[wk] ?? 0) + l.weight * l.reps;
    }

    const weeks = Object.keys(byWeek).sort();
    if (weeks.length < 2) continue;

    const lastWeek = weeks[weeks.length - 1];
    const prevWeek = weeks[weeks.length - 2];
    const lastVol = byWeek[lastWeek];
    const prevVol = byWeek[prevWeek];
    if (!prevVol) continue;

    const pctChange = (lastVol - prevVol) / prevVol;
    let tone = 'info';
    let flag = '';
    if (pctChange <= -WEEKLY_VOLUME_DROP_PCT) {
      tone = 'regressing';
      flag = ' — possible undertraining signal';
    } else if (pctChange >= WEEKLY_VOLUME_SPIKE_PCT) {
      tone = 'holding';
      flag = ' — possible overreach signal';
    }

    const sign = pctChange >= 0 ? '+' : '';
    cards.push({
      id: `volume_${dayIdx}_${lastWeek}`,
      title: label,
      tone,
      text: `${label}: ${Math.round(lastVol)}kg this week vs ${Math.round(prevVol)}kg last week (${sign}${Math.round(pctChange * 100)}%)${flag}`,
      date: lastWeek,
    });
  }

  return cards.sort((a, b) => b.date.localeCompare(a.date));
}

// ─────────────────────────────────────────────────────────────────────────────
//  MODULE 5 — CONSISTENCY / GAP TRACKING
// ─────────────────────────────────────────────────────────────────────────────

function computeConsistencyCards(logs, todayStr) {
  const start = addDays(todayStr, -(CONSISTENCY_WINDOW_DAYS - 1));
  const doneDates = new Set(
    logs.filter(l => l.done && l.date >= start && l.date <= todayStr).map(l => l.date)
  );
  const count = doneDates.size;
  if (count >= CONSISTENCY_PLANNED_SESSIONS) return [];

  return [{
    id: `consistency_${todayStr}`,
    title: 'Session consistency',
    tone: count === 0 ? 'regressing' : 'holding',
    text: `${count} of ${CONSISTENCY_PLANNED_SESSIONS} planned sessions completed in the last ${CONSISTENCY_WINDOW_DAYS} days.`,
    date: todayStr,
  }];
}

// ─────────────────────────────────────────────────────────────────────────────
//  MODULE 6 — BODYWEIGHT VS STRENGTH TREND
// ─────────────────────────────────────────────────────────────────────────────

function computeBodyweightStrengthCards(bodyweight, catalog, logs) {
  const mondayEntries = bodyweight
    .filter(b => localDayIndexOf(b.date) === 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (mondayEntries.length < BW_TREND_MIN_ENTRIES) return [];

  const windowEntries = mondayEntries.slice(-BW_TREND_MAX_ENTRIES);
  const bwFirst = windowEntries[0].kg;
  const bwLast = windowEntries[windowEntries.length - 1].kg;
  const bwDelta = bwLast - bwFirst;
  const bwDirection = Math.abs(bwDelta) < BW_FLAT_THRESHOLD_KG ? 'flat' : (bwDelta > 0 ? 'up' : 'down');

  const windowStart = windowEntries[0].date;
  const windowEnd = windowEntries[windowEntries.length - 1].date;

  const deltas = [];
  for (const ex of catalog.values()) {
    if (!ex.isCompound) continue;
    const sessions = sessionsWithMetric(logs, ex.id, true)
      .filter(s => s.date >= windowStart && s.date <= windowEnd);
    if (sessions.length < 2) continue;
    const first = sessions[0].value;
    const last = sessions[sessions.length - 1].value;
    if (!first) continue;
    deltas.push((last - first) / first);
  }
  if (!deltas.length) return [];

  const avgPct = deltas.reduce((s, x) => s + x, 0) / deltas.length;
  const strengthDirection = Math.abs(avgPct) < STRENGTH_FLAT_THRESHOLD_PCT ? 'flat' : (avgPct > 0 ? 'up' : 'down');

  let summary;
  if (bwDirection === 'flat' && strengthDirection === 'flat') {
    summary = 'Bodyweight flat, strength flat — plateau across both.';
  } else if (bwDirection === 'up' && strengthDirection !== 'down') {
    summary = 'Bodyweight up, strength flat/up — recomp or gain likely working.';
  } else if (bwDirection === 'down' && strengthDirection === 'down') {
    summary = 'Bodyweight down, strength down — possible underfueling.';
  } else if (bwDirection === 'down') {
    summary = 'Bodyweight down, strength flat/up — fat loss with strength preserved.';
  } else {
    summary = `Bodyweight ${bwDirection}, strength ${strengthDirection}.`;
  }

  const bwSign = bwDelta >= 0 ? '+' : '';
  const pctSign = avgPct >= 0 ? '+' : '';
  return [{
    id: `bwstrength_${windowEnd}`,
    title: 'Bodyweight vs strength',
    tone: 'info',
    text: `${summary} (bodyweight ${bwSign}${bwDelta.toFixed(1)}kg, compound e1RM ${pctSign}${Math.round(avgPct * 100)}% over last ${windowEntries.length} Monday check-ins)`,
    date: windowEnd,
  }];
}

// ─────────────────────────────────────────────────────────────────────────────
//  MODULE 7 — CONTEXT-AWARE REGRESSION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mutates progression/consistency cards in place: a regression or gap that
 * immediately follows a tagged session note (weekend shoot, gig, etc.) is
 * relabeled as expected fatigue instead of a red flag. Returns the separate
 * "context noted" cards surfaced for transparency.
 */
function applyContextAwareLabeling(progressionCards, consistencyCards, logs) {
  const contextCards = [];
  const seenContextDates = new Set();

  const noteContextCard = (ctx) => {
    if (seenContextDates.has(ctx.date)) return;
    seenContextDates.add(ctx.date);
    contextCards.push({
      id: `context_${ctx.date}`,
      title: 'Tagged event noted',
      tone: 'info',
      text: `Session note on ${friendlyDate(ctx.date)} references a tagged event ("${matchedContextKeyword(ctx.text)}"). Nearby regressions or missed sessions are labeled as expected fatigue rather than flagged.`,
      date: ctx.date,
    });
  };

  for (const card of progressionCards) {
    if (card.tone !== 'regressing') continue;
    const ctx = findContextNoteNear(logs, card.date);
    if (!ctx) continue;
    card.tone = 'info';
    card.text += ` — labeled as expected fatigue (tagged session note near ${friendlyDate(ctx.date)}), not a red flag.`;
    noteContextCard(ctx);
  }

  for (const card of consistencyCards) {
    const ctx = findContextNoteNear(logs, card.date);
    if (!ctx) continue;
    card.tone = 'info';
    card.text += ` A tagged event near ${friendlyDate(ctx.date)} may explain part of the gap.`;
    noteContextCard(ctx);
  }

  return contextCards;
}

// ─────────────────────────────────────────────────────────────────────────────
//  DISMISS PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────

async function dismissCard(state, cardId) {
  const doc = state.meta[INSIGHTS_DISMISSED_KEY] ?? { key: INSIGHTS_DISMISSED_KEY, value: [] };
  if (!doc.value.includes(cardId)) doc.value.push(cardId);
  await put('meta', doc);
  state.meta[INSIGHTS_DISMISSED_KEY] = doc;
}

// ─────────────────────────────────────────────────────────────────────────────
//  RENDER
// ─────────────────────────────────────────────────────────────────────────────

function buildCardHTML(card) {
  const dateTag = card.date ? `<span class="insight-card-subtext">${escHtml(friendlyDate(card.date))}</span>` : '';
  return `
    <div class="card insight-card" data-card-id="${escHtml(card.id)}">
      <button class="insight-card-header" aria-expanded="false">
        <span class="insight-card-tone insight-tone-${card.tone}"></span>
        <span class="insight-card-title">${escHtml(card.title)}</span>
        <svg class="chevron-icon" width="16" height="16" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      <div class="insight-card-body">
        <p class="insight-card-text">${escHtml(card.text)}${dateTag}</p>
      </div>
      <button class="insight-card-dismiss" aria-label="Dismiss insight" data-card-id="${escHtml(card.id)}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>`;
}

function buildGroupHTML(title, moduleKey, cards) {
  if (!cards.length) return '';
  return `
    <div class="insights-group" data-module="${moduleKey}">
      <h3 class="insights-group-title">${escHtml(title)}</h3>
      ${cards.map(buildCardHTML).join('')}
    </div>`;
}

function wireInsightsInteractions(container, emptyEl, state) {
  container.querySelectorAll('.insight-card-header').forEach(header => {
    header.addEventListener('click', () => {
      const body = header.nextElementSibling;
      const expanded = header.getAttribute('aria-expanded') === 'true';
      header.setAttribute('aria-expanded', String(!expanded));
      body.classList.toggle('expanded', !expanded);
    });
  });

  container.querySelectorAll('.insight-card-dismiss').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await dismissCard(state, btn.dataset.cardId);

      const cardEl = btn.closest('.insight-card');
      const group = cardEl?.closest('.insights-group');
      cardEl?.remove();
      if (group && !group.querySelector('.insight-card')) group.remove();
      if (!container.querySelector('.insight-card')) emptyEl.hidden = false;
    });
  });
}

/** Computes every insight module and renders the Insights tab. */
function renderInsightsTab(state) {
  const container = document.getElementById('insights-groups');
  const emptyEl = document.getElementById('insights-empty');
  if (!container || !emptyEl) return;

  const catalog = buildExerciseCatalog(state.plan, state.meta);
  const dismissed = new Set(state.meta[INSIGHTS_DISMISSED_KEY]?.value ?? []);

  const pbCards = computePBCards(state.meta);
  const progressionCards = computeProgressionCards(catalog, state.logs);
  const plateauCards = computePlateauCards(catalog, state.logs);
  const volumeCards = computeWeeklyVolumeCards(state.plan, state.logs);
  const consistencyCards = computeConsistencyCards(state.logs, state.ui.today);
  const bwStrengthCards = computeBodyweightStrengthCards(state.bodyweight, catalog, state.logs);
  const contextCards = applyContextAwareLabeling(progressionCards, consistencyCards, state.logs);

  const groups = [
    ['Personal Bests', 'pb', pbCards],
    ['Progression', 'progression', progressionCards],
    ['Plateaus', 'plateau', plateauCards],
    ['Weekly Volume', 'volume', volumeCards],
    ['Consistency', 'consistency', consistencyCards],
    ['Bodyweight vs Strength', 'bodyweight', bwStrengthCards],
    ['Context Notes', 'context', contextCards],
  ];

  let anyVisible = false;
  const html = groups.map(([title, key, cards]) => {
    const visible = cards.filter(c => !dismissed.has(c.id));
    if (visible.length) anyVisible = true;
    return buildGroupHTML(title, key, visible);
  }).join('');

  container.innerHTML = html;
  emptyEl.hidden = anyVisible;

  wireInsightsInteractions(container, emptyEl, state);
}

export { renderInsightsTab, checkForNewPB, isCompoundExercise };
