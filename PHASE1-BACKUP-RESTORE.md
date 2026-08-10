# Phase 1 — Durable Backbone (backup & restore)

Goal of this phase: give FitTrack's data a durable home off-device, and make the
JSON snapshot — not IndexedDB — the conceptual source of truth. IndexedDB becomes
a cache the app can fully rebuild from a snapshot alone.

Nothing here analyses, merges external sources, or coaches. The app only moves
data in and out and serialises/deserialises it.

---

## What shipped

### Back up (export → Drive)
- **Data tab → "Back up"** serialises the whole app to the dated JSON format
  `fittrack-YYYY-MM-DD.json` (training `logs`, `bodyComposition`, `plan`, `meta`,
  legacy `bodyweight`).
- It builds a `File` and, when the platform supports it
  (`navigator.canShare({ files: [file] })`), calls `navigator.share({ files })`.
  On Android this surfaces the system share sheet, where **Save to Drive** is one
  tap away.
- **Fallback:** where file-sharing is unsupported (most desktops), it downloads
  the file — the previous behaviour, unchanged.
- The share hand-off is the app's **only** network interaction. No Google Drive
  API, no OAuth, no credentials in the app — the OS moves the file.
- Dismissing the share sheet (`AbortError`) is treated as a user choice, not an
  error. No silent/auto upload — every backup is user-initiated.

Code: `handleExport` / `buildBackupPayload` / `downloadBackupFile` in `app.js`.

### Restore (import a snapshot — merge, don't clobber)
- **Data tab → "Restore"** reads a FitTrack JSON snapshot and **merges** it into
  the current data. It never wipes first.
- **Append-only record stores** (`logs`, `bodyComposition`, `bodyweight`) are
  deduped on their existing unique key — log `id`, reading `datetime`,
  bodyweight `date` — using the same idiom as the Fitdays import
  (`getAllKeys` → `Set` → filter → `putMany`). A record already present is left
  untouched, so:
  - restoring an **older** snapshot cannot delete newer local data, and
  - restoring a **newer** snapshot cannot create duplicates.
- **Config** (`plan`, `meta`/settings) is *restored* (overwritten) from the
  snapshot. This is deliberate: config is current state, not accumulating
  history, and overwriting it is exactly what lets a freshly-wiped app — which
  has just seeded a default plan on startup — come back whole.
- The outcome is reported plainly, e.g.
  *"Restored 3 new sessions and 4 new body-composition readings. 120 records
  already present."* ("sessions" = distinct new training days.)

Code: `handleImport` / `dedupeNew` / `restoreSummaryMessage` in `app.js`.

### Storage hardening (carried over from Phase 0, confirmed)
- `navigator.storage.persist()` is requested once, guarded and non-blocking, at
  startup (`init`, `app.js`).
- The Data tab shows a status dot reporting whether persistence was granted
  (`renderStorageStatus`, `app.js`). Persistence only exempts IndexedDB from
  automatic eviction — it does **not** survive "clear site data" or a PWA
  uninstall, which is the whole reason the off-device backup exists.

---

## Acceptance test — rebuild from a snapshot alone

This is the test that proves IndexedDB is now a cache, not the only copy. Run it
on the target device (Android Chrome PWA), or in a desktop browser using the
download/upload fallback.

1. **Seed data.** Have at least one logged training session and (if available)
   some imported Fitdays body-composition readings. Note the counts.
2. **Back up.** Data tab → **Back up**. On phone, save the shared file to Drive;
   on desktop, keep the downloaded `fittrack-YYYY-MM-DD.json`.
3. **Wipe.** Clear the site's data (browser Settings → Site settings → Clear
   data / "Clear site data"). This empties IndexedDB — the local-only copy.
4. **Reload.** Open the app again. It should come up empty (default seeded plan,
   no logged history, no readings).
5. **Restore.** Data tab → **Restore** → pick the snapshot from step 2.
6. **Confirm whole.** Training history, body-composition readings, plan, and
   settings all match step 1. The toast reports the restored counts.

**Pass criteria:** after step 6 the app is indistinguishable from before the
wipe — nothing from the snapshot is missing.

### Merge sub-tests (non-destructive guarantee)
- **Older snapshot into newer data:** log a new session *after* taking a backup,
  then restore that older backup. The newer session must survive; the toast
  should report it as already-present / nothing-new for the overlap.
- **Re-restore the same snapshot:** restoring the same file twice must add
  nothing the second time (no duplicates) and report everything already present.

---

## Explicitly out of scope (per the roadmap)
- No automatic/scheduled background upload — restore and backup are always
  user-initiated.
- No Google Drive API / OAuth — the native share sheet handles the Drive
  hand-off; the app holds no credentials.
- No analysis, cross-source merging, or coaching logic.
