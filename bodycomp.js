/**
 * bodycomp.js  —  FitTrack · Body Composition
 *
 * Import, storage and display of Fitdays scale exports.
 *
 * ARCHITECTURE NOTE — this module stays deliberately dumb.
 * It parses a file, stores the readings verbatim, and draws them. It does not
 * interpolate missing days, pair a reading to a session, filter anything out,
 * or draw a conclusion from the numbers. Weigh-ins land roughly every 1–2 weeks
 * while training runs 3×/week, so most sessions have no same-day weight — that
 * is expected and left alone. Session-to-weight pairing and every other
 * inference happens outside the app, on the JSON export.
 */

import { getAll, getAllKeys, putMany } from './db.js';

// ─────────────────────────────────────────────────────────────────────────────
//  METRIC SCHEMA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The stored metric set, in Fitdays' own column order.
 *
 * `header` is the source column name normalised (lowercased, non-alphanumerics
 * removed) so header matching survives spacing and capitalisation drift.
 * Fitdays' `Cardiac Index` column is intentionally absent — it is dropped on
 * import and never stored.
 */
const METRICS = [
  { key: 'weight',          header: 'weight',          label: 'Weight',           unit: 'kg',   decimals: 1 },
  { key: 'bmi',             header: 'bmi',             label: 'BMI',              unit: '',     decimals: 1 },
  { key: 'bodyFat',         header: 'bodyfat',         label: 'Body fat',         unit: '%',    decimals: 1 },
  { key: 'subcutaneousFat', header: 'subcutaneousfat', label: 'Subcutaneous fat', unit: '%',    decimals: 1 },
  { key: 'heartRate',       header: 'heartrate',       label: 'Heart rate',       unit: 'bpm',  decimals: 0 },
  { key: 'visceralFat',     header: 'visceralfat',     label: 'Visceral fat',     unit: '',     decimals: 1 },
  { key: 'bodyWater',       header: 'bodywater',       label: 'Body water',       unit: '%',    decimals: 1 },
  { key: 'skeletalMuscle',  header: 'skeletalmuscle',  label: 'Skeletal muscle',  unit: '%',    decimals: 1 },
  { key: 'muscleMass',      header: 'musclemass',      label: 'Muscle mass',      unit: 'kg',   decimals: 1 },
  { key: 'boneMass',        header: 'bonemass',        label: 'Bone mass',        unit: 'kg',   decimals: 1 },
  { key: 'protein',         header: 'protein',         label: 'Protein',          unit: '%',    decimals: 1 },
  { key: 'bmr',             header: 'bmr',             label: 'BMR',              unit: 'kcal', decimals: 0 },
  { key: 'bodyAge',         header: 'bodyage',         label: 'Body age',         unit: 'yrs',  decimals: 0 },
];

/** Metrics shown as secondary stat cards — the heroes are handled separately. */
const SECONDARY_METRIC_KEYS = [
  'muscleMass', 'skeletalMuscle', 'visceralFat', 'bodyWater',
  'subcutaneousFat', 'protein', 'boneMass', 'bmi', 'bmr', 'bodyAge', 'heartRate',
];

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// ─────────────────────────────────────────────────────────────────────────────
//  CELL PARSING
// ─────────────────────────────────────────────────────────────────────────────

/** Lowercase + strip non-alphanumerics, so "Body Fat" and "body_fat" match. */
function normaliseHeader(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Zero-pad to two digits. */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Fitdays writes its timestamps as "09:36 Aug.4,2026" (%H:%M %b.%d,%Y).
 * The separator and padding wobble between export paths, so the pattern is
 * kept loose: optional seconds, optional period after the month, any spacing.
 */
const FITDAYS_TIMESTAMP_RE =
  /^(\d{1,2}):(\d{2})(?::\d{2})?\s+([A-Za-z]{3,9})\.?\s*(\d{1,2})\s*,\s*(\d{4})$/;

/** The same timestamp with the date first — seen on some export paths. */
const FITDAYS_TIMESTAMP_RE_ALT =
  /^([A-Za-z]{3,9})\.?\s*(\d{1,2})\s*,\s*(\d{4})\s+(\d{1,2}):(\d{2})(?::\d{2})?$/;

/** Build the stored key pair from wall-clock parts. Returns null if invalid. */
function toStamp(year, monthIndex, day, hour, minute) {
  if (
    !Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11 ||
    !(day >= 1 && day <= 31) || !(hour >= 0 && hour <= 23) ||
    !(minute >= 0 && minute <= 59) || !(year >= 1900 && year <= 2999)
  ) {
    return null;
  }
  const date = `${year}-${pad2(monthIndex + 1)}-${pad2(day)}`;
  return { date, datetime: `${date}T${pad2(hour)}:${pad2(minute)}` };
}

/**
 * Turn an Excel date serial into wall-clock parts.
 * Serials are naive local timestamps, so the epoch maths is done in UTC and the
 * UTC components are then read back as wall-clock values — going through local
 * getters would shift every reading by the timezone offset.
 */
function stampFromExcelSerial(serial) {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const d = new Date(Math.round((serial - 25569) * 86_400_000)); // 25569 = 1970-01-01
  if (isNaN(d.getTime())) return null;
  return toStamp(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes()
  );
}

/**
 * Parse whatever the Date cell turned out to be.
 *
 * The read is pinned to text (`raw:false`), so the expected shape is the
 * "HH:MM Mon.D,YYYY" string. A number (raw Excel serial) or a Date object can
 * still arrive if a future Fitdays build writes a real date cell, so both are
 * handled. Anything else returns null and the row is counted as unreadable —
 * never dropped silently.
 */
function parseReadingStamp(value) {
  if (value == null || value === '') return null;

  if (value instanceof Date) {
    return isNaN(value.getTime())
      ? null
      : toStamp(
          value.getFullYear(), value.getMonth(), value.getDate(),
          value.getHours(), value.getMinutes()
        );
  }

  if (typeof value === 'number') return stampFromExcelSerial(value);

  const text = String(value).trim();
  if (!text) return null;

  let m = FITDAYS_TIMESTAMP_RE.exec(text);
  if (m) {
    const month = MONTHS[m[3].slice(0, 3).toLowerCase()];
    return toStamp(+m[5], month, +m[4], +m[1], +m[2]);
  }

  m = FITDAYS_TIMESTAMP_RE_ALT.exec(text);
  if (m) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return toStamp(+m[3], month, +m[2], +m[4], +m[5]);
  }

  // A bare numeric string is a serial that escaped text formatting
  if (/^\d+(\.\d+)?$/.test(text)) return stampFromExcelSerial(parseFloat(text));

  return null;
}

/**
 * Pull a number out of a Fitdays value cell.
 * Every measurement carries its unit inline ("83.55kg", "26.0%", "1762kcal",
 * "3.1L/min/㎡"); none of those suffixes contain digits, so stripping to the
 * numeric characters is enough. Empty or unparseable cells become null.
 */
function parseNumericCell(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  let s = String(value).replace(/[^\d.,-]/g, '');
  if (!/\d/.test(s)) return null;

  // A lone comma is a decimal separator; commas alongside a dot are thousands
  if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');

  const negative = s.startsWith('-');
  const n = parseFloat(s.replace(/-/g, ''));
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// ─────────────────────────────────────────────────────────────────────────────
//  WORKBOOK PARSING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every Fitdays export path — phone app and web portal alike — hands out a
 * file named `.csv` whose contents are a legacy Excel binary (OLE2/CDFV2,
 * magic bytes D0 CF 11 E0). The extension lies; the bytes are always .xls.
 * So the file is parsed as a workbook, never as text.
 *
 * @param {ArrayBuffer} buffer - Raw bytes of the selected file
 * @returns {{readings: object[], unreadable: number}}
 * @throws {Error} With a message written for the user, not the console
 */
function parseFitdaysWorkbook(buffer) {
  if (typeof XLSX === 'undefined') {
    throw new Error(
      'The spreadsheet reader did not load. Reload FitTrack and try the import again.'
    );
  }

  let rows;
  let headerKeys;
  try {
    const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
    const sheetName = workbook.SheetNames?.[0];
    const sheet = sheetName ? workbook.Sheets[sheetName] : null;
    if (!sheet) {
      throw new Error(
        'That file has no readable sheet in it. Re-export from Fitdays and import the new file.'
      );
    }

    // raw:false keeps every cell as its formatted text, which is what pins the
    // Date column to the "HH:MM Mon.D,YYYY" string rather than a bare serial.
    rows = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: null });
    headerKeys = XLSX.utils.sheet_to_json(sheet, { header: 1, range: 0 })[0] ?? [];
  } catch (err) {
    // A message we wrote above passes through; anything else is SheetJS
    // failing on bytes that are not a workbook at all.
    if (err instanceof Error && /Fitdays|reader did not load/.test(err.message)) throw err;
    console.error('[FitTrack] Fitdays parse failed:', err);
    throw new Error(
      'That file could not be read as a Fitdays export — it may be corrupt, incomplete, ' +
      'or re-saved by another app. Export a fresh copy from Fitdays and import that file directly.'
    );
  }

  // Map normalised column name → the exact key sheet_to_json produced
  const columns = new Map();
  for (const raw of headerKeys) {
    if (raw == null) continue;
    const key = normaliseHeader(raw);
    if (key && !columns.has(key)) columns.set(key, raw);
  }

  const dateColumn = columns.get('date') ?? columns.get('time') ?? columns.get('datetime');
  const hasWeight = columns.has('weight');
  const hasBodyFat = columns.has('bodyfat');

  if (!dateColumn || !hasWeight || !hasBodyFat) {
    const missing = [
      !dateColumn ? 'Date' : null,
      !hasWeight ? 'Weight' : null,
      !hasBodyFat ? 'Body Fat' : null,
    ].filter(Boolean);

    // Nothing recognisable at all: either the wrong file was picked or the
    // bytes are not really a workbook. SheetJS accepts a surprising amount of
    // junk without throwing, so this is where that case actually surfaces.
    const nothingMatched = !METRICS.some(m => columns.has(m.header)) && !dateColumn;
    if (nothingMatched) {
      throw new Error(
        'This file is not a Fitdays export — none of its columns match one, and it may ' +
        'be corrupt or truncated. Export again from Fitdays (Profile → Export data) and ' +
        'import that file directly, without opening or re-saving it first.'
      );
    }

    const plural = missing.length > 1;
    throw new Error(
      `This is not a recognised Fitdays export — the ${missing.join(', ')} ` +
      `column${plural ? 's are' : ' is'} missing. Export again from Fitdays ` +
      '(Profile → Export data) and import that file without opening or re-saving it first.'
    );
  }

  const readings = [];
  let unreadable = 0;

  for (const row of rows) {
    // Blank spacer rows carry no data at all and are not readings
    const isBlank = Object.values(row).every(v => v == null || String(v).trim() === '');
    if (isBlank) continue;

    const stamp = parseReadingStamp(row[dateColumn]);
    if (!stamp) {
      // Counted and reported back, never discarded quietly
      unreadable++;
      continue;
    }

    const reading = { datetime: stamp.datetime, date: stamp.date };
    for (const metric of METRICS) {
      const column = columns.get(metric.header);
      reading[metric.key] = column ? parseNumericCell(row[column]) : null;
    }
    readings.push(reading);
  }

  return { readings, unreadable };
}

// ─────────────────────────────────────────────────────────────────────────────
//  IMPORT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read, parse, dedupe and store a Fitdays export.
 *
 * Fitdays exports the full history every time, so a fortnightly import overlaps
 * heavily with the last one. `datetime` is the unique key: readings already in
 * the store are skipped, so re-importing the same range is a no-op rather than
 * a duplicate storm.
 *
 * @param {File} file - The file the user picked
 * @returns {Promise<{added:number, duplicates:number, unreadable:number}>}
 */
async function importFitdaysFile(file) {
  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (err) {
    console.error('[FitTrack] Could not read selected file:', err);
    throw new Error(
      'That file could not be opened. Pick the export again from your file manager.'
    );
  }

  const { readings, unreadable } = parseFitdaysWorkbook(buffer);

  if (!readings.length) {
    throw new Error(
      unreadable > 0
        ? `None of the ${unreadable} row${unreadable === 1 ? '' : 's'} in that file had a readable ` +
          'date. Export again from Fitdays without changing the file, and import it as exported.'
        : 'That export has no readings in it. Take a measurement in Fitdays, then export again.'
    );
  }

  const existing = new Set(await getAllKeys('bodyComposition'));
  const seen = new Set();
  const fresh = [];

  for (const reading of readings) {
    if (existing.has(reading.datetime) || seen.has(reading.datetime)) continue;
    seen.add(reading.datetime);
    fresh.push(reading);
  }

  await putMany('bodyComposition', fresh);

  return {
    added: fresh.length,
    duplicates: readings.length - fresh.length,
    unreadable,
  };
}

/** All stored readings, oldest first. */
async function loadBodyComposition() {
  const all = await getAll('bodyComposition');
  return (all ?? []).sort((a, b) => a.datetime.localeCompare(b.datetime));
}

// ─────────────────────────────────────────────────────────────────────────────
//  DISPLAY DERIVATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collapse the raw readings to one point per day for trend clarity.
 *
 * Render-time only — the stored readings are never touched. Same-day
 * measurements are averaged per metric, ignoring nulls, so a metric missing
 * from one reading of the day does not drag the day's value down.
 *
 * Fat and lean mass are derived here too: they are what makes recomposition
 * legible, and weight alone hides it.
 */
function toDailySeries(readings) {
  const byDate = new Map();

  for (const reading of readings) {
    if (!byDate.has(reading.date)) byDate.set(reading.date, []);
    byDate.get(reading.date).push(reading);
  }

  const days = [...byDate.entries()].map(([date, group]) => {
    const point = { date, readingCount: group.length };

    for (const metric of METRICS) {
      const values = group
        .map(r => r[metric.key])
        .filter(v => typeof v === 'number' && Number.isFinite(v));
      point[metric.key] = values.length
        ? values.reduce((sum, v) => sum + v, 0) / values.length
        : null;
    }

    point.fatMass = point.weight != null && point.bodyFat != null
      ? point.weight * (point.bodyFat / 100)
      : null;
    point.leanMass = point.weight != null && point.fatMass != null
      ? point.weight - point.fatMass
      : null;

    return point;
  });

  return days.sort((a, b) => a.date.localeCompare(b.date));
}

// ─────────────────────────────────────────────────────────────────────────────
//  FORMATTING
// ─────────────────────────────────────────────────────────────────────────────

const EM_DASH = '—';

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Fixed-decimal number, or an em dash when the value is missing. */
function fmt(value, decimals = 1) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(decimals)
    : EM_DASH;
}

/** 'Aug 4' from 'YYYY-MM-DD'. */
function shortDate(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${MONTH_LABELS[m - 1]} ${d}`;
}

/** 'Aug 4, 2026' from 'YYYY-MM-DD'. */
function longDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${MONTH_LABELS[m - 1]} ${d}, ${y}`;
}

/** Local-midnight epoch ms for 'YYYY-MM-DD' — the chart's x scale. */
function dateValue(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/**
 * Change between two points as a small directional badge.
 *
 * Deliberately monochrome: a drop in weight is not automatically good and a
 * rise in muscle mass is not automatically earned. Direction is stated, the
 * reading of it is left to the analysis layer.
 */
function deltaBadge(current, previous, decimals, unit, sinceDate) {
  if (
    typeof current !== 'number' || !Number.isFinite(current) ||
    typeof previous !== 'number' || !Number.isFinite(previous)
  ) {
    return '';
  }

  const diff = current - previous;
  const magnitude = Math.abs(diff).toFixed(decimals);
  const isFlat = parseFloat(magnitude) === 0;
  const arrow = isFlat ? '±' : diff > 0 ? '▲' : '▼';
  const since = sinceDate ? ` <span class="bc-delta-since">since ${escHtml(shortDate(sinceDate))}</span>` : '';

  return `<span class="bc-delta">
    <span class="bc-delta-arrow" aria-hidden="true">${arrow}</span>${magnitude}${escHtml(unit)}${since}
  </span>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  RECOMPOSITION CHART
// ─────────────────────────────────────────────────────────────────────────────

const CHART = {
  W: 340, H: 216,
  pad: { top: 18, right: 38, bottom: 26, left: 38 },
  /**
   * Minimum kg window. Without a floor, a two-reading history with a 100 g
   * difference would render as a dramatic cliff.
   */
  minSpanKg: 2,
  /** Draw a dot per reading only while they stay countable. */
  maxDots: 24,
};

/**
 * Fat mass and lean mass on one chart — the page's whole point.
 *
 * Lean sits near 60 kg and fat near 20 kg, so a shared axis would flatten fat
 * against the floor and hide exactly the movement worth seeing. Instead both
 * series get the same kg-per-pixel scale and their own vertical offset: each is
 * centred on its own midpoint, so the two slopes stay directly comparable and
 * their divergence is the shape you read. The left axis is labelled in lean kg,
 * the right in fat kg, at the same gridlines.
 */
function buildRecompChartSVG(days) {
  const points = days.filter(d => d.fatMass != null && d.leanMass != null);
  if (points.length < 2) return null;

  const { W, H, pad } = CHART;
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;

  const lean = points.map(p => p.leanMass);
  const fat = points.map(p => p.fatMass);

  const spanOf = arr => Math.max(...arr) - Math.min(...arr);
  const span = Math.max(spanOf(lean), spanOf(fat), CHART.minSpanKg) * 1.25;
  const centreOf = arr => (Math.max(...arr) + Math.min(...arr)) / 2;
  const leanCentre = centreOf(lean);
  const fatCentre = centreOf(fat);

  const tMin = dateValue(points[0].date);
  const tMax = dateValue(points[points.length - 1].date);
  const tRange = tMax - tMin || 1;

  const toX = d => pad.left + ((dateValue(d) - tMin) / tRange) * cW;
  const toY = (value, centre) => pad.top + cH / 2 - ((value - centre) / span) * cH;

  const series = [
    { key: 'lean', values: lean, centre: leanCentre, cssClass: 'bc-line-lean' },
    { key: 'fat', values: fat, centre: fatCentre, cssClass: 'bc-line-fat' },
  ].map(s => {
    const coords = points.map((p, i) => [toX(p.date), toY(s.values[i], s.centre)]);
    return { ...s, coords };
  });

  const gridFractions = [0, 0.5, 1];
  const gridlines = gridFractions.map(f => {
    const y = pad.top + f * cH;
    return `<line class="bc-grid" x1="${pad.left}" y1="${y.toFixed(1)}"
                  x2="${(pad.left + cW).toFixed(1)}" y2="${y.toFixed(1)}"/>`;
  }).join('');

  // Same gridline, two scales: lean kg on the left, fat kg on the right
  const axisLabels = gridFractions.map(f => {
    const y = pad.top + f * cH;
    const offset = (0.5 - f) * span;
    return `
      <text class="bc-axis bc-axis-lean" x="${pad.left - 6}" y="${y.toFixed(1)}"
            text-anchor="end" dominant-baseline="middle">${(leanCentre + offset).toFixed(1)}</text>
      <text class="bc-axis bc-axis-fat" x="${(pad.left + cW + 6).toFixed(1)}" y="${y.toFixed(1)}"
            text-anchor="start" dominant-baseline="middle">${(fatCentre + offset).toFixed(1)}</text>`;
  }).join('');

  const paths = series.map(s => {
    const d = s.coords.map(([x, y], i) =>
      `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)},${y.toFixed(1)}`
    ).join(' ');
    // pathLength="1" lets the draw-in animation run off a fixed dash length
    // without measuring the geometry in JS.
    return `<path class="bc-line ${s.cssClass}" d="${d}" pathLength="1"/>`;
  }).join('');

  const dots = points.length <= CHART.maxDots
    ? series.map(s =>
        s.coords.map(([x, y]) =>
          `<circle class="bc-dot ${s.cssClass}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.4"/>`
        ).join('')
      ).join('')
    : '';

  const endDots = series.map(s => {
    const [x, y] = s.coords[s.coords.length - 1];
    return `<circle class="bc-dot-end ${s.cssClass}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4"/>`;
  }).join('');

  const first = points[0];
  const last = points[points.length - 1];
  const summary =
    `Fat mass and lean mass from ${longDate(first.date)} to ${longDate(last.date)}. ` +
    `Lean mass ${fmt(first.leanMass)} to ${fmt(last.leanMass)} kilograms. ` +
    `Fat mass ${fmt(first.fatMass)} to ${fmt(last.fatMass)} kilograms.`;

  return `
    <svg class="bc-chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"
         role="img" aria-label="${escHtml(summary)}">
      ${gridlines}
      ${paths}
      ${dots}
      ${endDots}
      <g class="bc-axis-group">
        ${axisLabels}
        <text class="bc-axis" x="${pad.left}" y="${H - 6}" text-anchor="start">${escHtml(shortDate(first.date))}</text>
        <text class="bc-axis" x="${(pad.left + cW).toFixed(1)}" y="${H - 6}" text-anchor="end">${escHtml(shortDate(last.date))}</text>
      </g>
    </svg>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PAGE RENDER
// ─────────────────────────────────────────────────────────────────────────────

function buildEmptyState() {
  return `
    <div class="card bc-empty">
      <svg class="bc-empty-icon" width="40" height="40" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="1.4" stroke-linecap="round"
           stroke-linejoin="round" aria-hidden="true">
        <path d="M3 17l5.5-6 4 4L21 6"/>
        <path d="M15 6h6v6"/>
      </svg>
      <p class="bc-empty-title">No body-composition data yet</p>
      <p class="bc-empty-sub">
        Import your first Fitdays export to see your body-composition trend.
      </p>
      <button class="btn-primary" id="bc-import-btn-empty" type="button">
        Import Fitdays data
      </button>
      <p class="bc-empty-hint">
        Fitdays exports a file ending in <code>.csv</code> that is really an Excel
        file. Import it exactly as exported — no need to convert it.
      </p>
    </div>`;
}

/** Latest reading, its two hero numbers, and the lean/fat split. */
function buildHero(days) {
  const latest = days[days.length - 1];
  const previous = days.length > 1 ? days[days.length - 2] : null;
  const sinceDate = previous?.date ?? null;

  const fatShare = latest.weight && latest.fatMass != null
    ? (latest.fatMass / latest.weight) * 100
    : null;

  const splitBar = fatShare != null
    ? `<div class="bc-split-bar" role="img"
            aria-label="Lean mass ${fmt(latest.leanMass)} kilograms, fat mass ${fmt(latest.fatMass)} kilograms">
         <span class="bc-split-lean" style="width:${(100 - fatShare).toFixed(1)}%"></span>
         <span class="bc-split-fat" style="width:${fatShare.toFixed(1)}%"></span>
       </div>`
    : '';

  return `
    <div class="card bc-hero">
      <div class="bc-hero-head">
        <span class="bc-hero-date">${escHtml(longDate(latest.date))}</span>
        ${latest.readingCount > 1
          ? `<span class="bc-hero-note">mean of ${latest.readingCount} readings</span>`
          : ''}
      </div>

      <div class="bc-hero-figures">
        <div class="bc-figure">
          <span class="bc-figure-label">Weight</span>
          <span class="bc-figure-value">${fmt(latest.weight)}<span class="bc-figure-unit">kg</span></span>
          ${deltaBadge(latest.weight, previous?.weight, 1, 'kg', sinceDate)}
        </div>
        <div class="bc-figure bc-figure-fat">
          <span class="bc-figure-label">Body fat</span>
          <span class="bc-figure-value">${fmt(latest.bodyFat)}<span class="bc-figure-unit">%</span></span>
          ${deltaBadge(latest.bodyFat, previous?.bodyFat, 1, '%', sinceDate)}
        </div>
      </div>

      ${splitBar}

      <div class="bc-split-legend">
        <div class="bc-split-item">
          <span class="bc-swatch bc-swatch-lean" aria-hidden="true"></span>
          <span class="bc-split-label">Lean mass</span>
          <span class="bc-split-value">${fmt(latest.leanMass)} kg</span>
          ${deltaBadge(latest.leanMass, previous?.leanMass, 1, 'kg', null)}
        </div>
        <div class="bc-split-item">
          <span class="bc-swatch bc-swatch-fat" aria-hidden="true"></span>
          <span class="bc-split-label">Fat mass</span>
          <span class="bc-split-value">${fmt(latest.fatMass)} kg</span>
          ${deltaBadge(latest.fatMass, previous?.fatMass, 1, 'kg', null)}
        </div>
      </div>
    </div>`;
}

function buildChartCard(days) {
  const svg = buildRecompChartSVG(days);

  const body = svg
    ? `${svg}
       <p class="bc-chart-note">
         Both series share one kilogram-per-pixel scale on separate offsets, so the
         two slopes are directly comparable.
       </p>`
    : `<p class="bc-chart-empty">
         One weigh-in so far. Import again after your next measurement to see the trend.
       </p>`;

  return `
    <div class="card bc-chart-card">
      <div class="bc-chart-head">
        <h3 class="bc-chart-title">Recomposition</h3>
        <div class="bc-legend">
          <span class="bc-legend-item"><span class="bc-swatch bc-swatch-lean" aria-hidden="true"></span>Lean</span>
          <span class="bc-legend-item"><span class="bc-swatch bc-swatch-fat" aria-hidden="true"></span>Fat</span>
        </div>
      </div>
      ${body}
    </div>`;
}

function buildSecondaryGrid(days) {
  const latest = days[days.length - 1];
  const previous = days.length > 1 ? days[days.length - 2] : null;

  const cards = SECONDARY_METRIC_KEYS.map(key => {
    const metric = METRICS.find(m => m.key === key);
    if (!metric) return '';

    const value = latest[key];

    return `
      <div class="bc-stat">
        <span class="bc-stat-label">${escHtml(metric.label)}${metric.unit ? ` (${escHtml(metric.unit)})` : ''}</span>
        <span class="bc-stat-value">${fmt(value, metric.decimals)}</span>
        ${deltaBadge(value, previous?.[key], metric.decimals, '', null)}
      </div>`;
  }).join('');

  return `
    <div class="section-header bc-section-header">
      <h3 class="section-title bc-subsection-title">Latest detail</h3>
    </div>
    <div class="bc-stat-grid">${cards}</div>`;
}

function buildFooter(readings, days) {
  const latest = readings[readings.length - 1];
  return `
    <p class="bc-footer">
      ${readings.length} reading${readings.length === 1 ? '' : 's'} across
      ${days.length} day${days.length === 1 ? '' : 's'} · latest
      ${escHtml(longDate(latest.date))} at ${escHtml(latest.datetime.slice(11))}
    </p>`;
}

/**
 * Paint the body-composition tab.
 * Display only — nothing here infers, pairs or fills in anything.
 *
 * @param {object[]} readings - Raw stored readings, oldest first
 */
function renderBodyTab(readings) {
  const host = document.getElementById('bc-content');
  if (!host) return;

  // Avoid two identical import actions on the empty page: the centered
  // empty-state CTA is the single control while empty; the header button
  // returns once there's data (so further imports stay reachable).
  const headerImportBtn = document.getElementById('bc-import-btn');
  if (headerImportBtn) headerImportBtn.hidden = !readings.length;

  if (!readings.length) {
    host.innerHTML = buildEmptyState();
    document
      .getElementById('bc-import-btn-empty')
      ?.addEventListener('click', () => document.getElementById('bc-import-input')?.click());
    return;
  }

  const days = toDailySeries(readings);

  host.innerHTML =
    buildHero(days) +
    buildChartCard(days) +
    buildSecondaryGrid(days) +
    buildFooter(readings, days);
}

/** Wording for the post-import confirmation, in the app's own voice. */
function importSummaryMessage({ added, duplicates, unreadable }) {
  const parts = [`Added ${added} reading${added === 1 ? '' : 's'}`];

  if (duplicates > 0) parts.push(`skipped ${duplicates} already imported`);
  if (unreadable > 0) {
    parts.push(
      `${unreadable} row${unreadable === 1 ? '' : 's'} could not be read (unrecognised date format)`
    );
  }

  return `${parts.join(', ')}.`;
}

export {
  importFitdaysFile,
  loadBodyComposition,
  renderBodyTab,
  importSummaryMessage,
  // Exported for the JSON export path and any future reuse
  parseFitdaysWorkbook,
  toDailySeries,
  METRICS,
  // Exported so the Hub dashboard renders the signature recomposition chart and
  // formats body-comp figures identically to the Body page — one house style.
  buildRecompChartSVG,
  fmt,
  deltaBadge,
  shortDate,
  longDate,
};
