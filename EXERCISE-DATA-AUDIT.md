# FitTrack — Exercise Data Audit

**Source:** `fittrack-2026-08-13.json` export (258 log records, 29 meta docs, 3 body-comp readings).
**Generated:** 2026-08-13. **Method:** deterministic enumeration replicating the app's own identity resolution (`plan.days` → `swaps_<date>` → `exerciseRegistry`, plus both log formats and log-stamped names). No data was modified — every correction below is a **proposal for your review only**. Nothing here is applied to logged history.

---

## 1. Summary

- **54 distinct exercise identities** were found across the plan, session swaps/adds, the orphan registry, and the logs.
- **20** are in the current plan and now carry a rich reference panel (see `data/exercise-map.json`).
- **The dominant issue is history fragmentation, not bad data.** Your Monday/Wednesday plan was rebuilt with **new ids** (`ex_msp…`), while years of history sit under **retired ids** (`ex_seed_…`, `swap_…`, `added_…`). The same real exercise is scattered across 2–3 ids, so several current plan items show an **empty progress view** even though the movement has plenty of logged history under a different id.
- **No destructive problems.** No logs are corrupt or unreadable. The quirks are: stale/mislabeled metadata, a few empty "done" sets, and three archived exercises whose names were reduced to the placeholder "Archived exercise".
- Both log formats were handled: 258 flat per-set records (the format actually in use) plus defensive handling for the nested `exercises[].sets[]` shape (none present in this export).

---

## 2. Findings

### F1 — History fragmentation (the big one)

Sixteen real movements are split across multiple ids. The current plan item (marked `[PLAN]`) is often the id with the **least** history, because it was created fresh when the plan was rebuilt:

| Real exercise | Plan id (history) | Other ids holding the real history |
|---|---|---|
| **Bicep Curl** | `ex_msp8679f_xpxuo` (0 sess) | `ex_seed_incline_db` — **7 sess / 21 sets** |
| **Bench Press** | `ex_msp84vme_937va` (0 sess) | `ex_seed_bench_press` (4), `swap_mrp3n6ua_4h7ll` (1) |
| **Tricep Pushdown** | `ex_msp86m5c_or2dm` (0 sess) | `ex_seed_tri_pushdown` — 3 sess / 10 sets |
| **Pull-up** | `ex_msp85597_4oy2u` (0 sess) | `added_msnojlgk_hnq2r` (1) |
| **Hammer curl** | `ex_msp7zfa0_w404t` (1) | `ex_seed_lat_pulldown` (5), `added_mrdutkz1_m62t3` (1) |
| **Face pull** | `ex_msp7z18a_gwo08` (1) | `ex_seed_cable_row` (2), `added_mrdut5t9_h8oll` (1) |
| **Plank** | `ex_msp7zz14_330jh` (1) | `added_mrduudc3_g9rsx` (2), `ex_seed_db_curl` (1) |
| **Incline DB press** | `ex_msp7xrks_m4f5k` (1) | `added_mrdurrg0_h4ch5` (1) |
| **Leg Press** | `ex_seed_leg_press` (2) | `added_mr25gb32_lu83u` (1), `added_mraqrkpu_mcieo` (1) |
| **Back Squat** | `ex_seed_squat` (0 done) | `added_mraqqex0_lsgf8` (1) |
| **Romanian Deadlift** | `ex_seed_rdl` (1) | `added_mraqqwvc_rebse` (1) |
| **Hanging Leg Raise** | `ex_msp83ssa_f0170` (1) | `added_msnpgtqs_y49qk` (1) |

Also split, with no current plan slot: **Lat Pulldown** (`ex_seed_pullup` 5 + `added_mr25m4lx_tzt0s` 1), **Cable/machine row** (`ex_seed_db_ohp` 5 + `added_mrduspd0_en0lg` 1), **Incline Bench Press** (`swap_mr9d3qu9_vq8s2` + `swap_ms3h71zd_kmv2f`), **Tricep Extension** (`added_mrdx5pc1_tf8b4` 4 + `added_mrqg0rl9_xo9i5` 1).

> **Why it happens:** the app keys history to the exercise **id**, forever (correct — it protects your logs). But "add exercise" and "swap" both mint a *new* id each session, and rebuilding the plan minted new ids too. So the same movement accumulates several ids.
> **RESOLVED (2026-08-13):** an authored **id-alias map** ([`data/exercise-aliases.json`](data/exercise-aliases.json)) now reunites this history at *read* time — progress, PB, the "Previous" column, hub PRs, and the history selector all read one merged series per movement. Logs are never rewritten; removing an alias instantly un-merges it, and the export stays pristine (the map is a vendored file, never IndexedDB). Only same-movement, load-type-compatible merges are included; the deliberately-excluded cases (Lat Pulldown ≠ Pull-up, Incline Barbell ≠ Incline Dumbbell, Tricep Extension ≠ Pushdown, DB Shoulder Press ≠ Barbell OHP, Rear Delt Fly ≠ Band Pull-Apart, ambiguous "Basic Squat") stay separate by design. Two merges are flagged `medium` for your review: "Cable/machine row" → Seated Cable Row (`ex_seed_db_ohp`, `added_mrduspd0_en0lg`).

### F2 — Mislabeled muscle strings (copy-paste shift in the Wednesday rebuild)

Four current plan exercises carry muscle strings that belong to a *different* movement — a classic paste-shift:

| Exercise | Stored `muscles` | Should be (per reference) |
|---|---|---|
| **Bicep Curl** `ex_msp8679f_xpxuo` | `Upper Chest · Front Delt` | Biceps · Brachialis |
| **Seated Cable Row** `ex_msp7y3g3_qbflc` | `Front Delt · Triceps · Lateral Delt` | Middle back · Lats · Biceps |
| **Face pull** `ex_msp7z18a_gwo08` | `Lats · Rhomboids · Biceps` | Shoulders (rear delt) · Traps |
| **Hammer curl** `ex_msp7zfa0_w404t` | `Lats · Biceps · Teres Major` | Biceps · Forearms |

**Bench Press** and **Pull-up** have empty `muscles`.

> **No action needed for display:** the reference panel reads muscles from the free-exercise-db entry (the correct authority), so these wrong strings never surface in the new panel. They remain in your plan data untouched. **Proposal:** fix the stored strings in the Plan editor at your leisure — cosmetic, affects only the small muscle caption on the plan card.

### F3 — Archived exercises with lost names (3 orphans)

| App id | Stored name | Real identity (from seed lineage) | History |
|---|---|---|---|
| `ex_seed_bb_row` | "Archived exercise" | **Barbell Row** | 3 sess / 12 sets |
| `ex_seed_ohp` | "Archived exercise" | **Overhead Press** (an older OHP, superseded by the current one) | 2 sess / 8 sets |
| `ex_seed_db_bench` | "Archived exercise" | **DB Bench Press** | 1 sess / 3 sets |

These resolve to the literal placeholder "Archived exercise". History is intact and still counts; only the label is gone.
> **Proposal:** rename them via **Data → Name unnamed exercises** to the identities above so their history reads clearly. They stay archived. No reference panel renders for archived items (correct).

### F4 — Repurposed slots (id says one thing, logs another)

- `ex_seed_incline_db` → logged as **Bicep Curl** (already documented in code; id deliberately preserved). Its stored muscles still say "Upper Chest · Front Delt" — see F2.
- `ex_seed_db_ohp` → logged as **Cable/machine row**; `ex_seed_lat_pulldown` → **Hammer curl**; `ex_seed_pullup` → **Lat Pulldown**; `ex_seed_cable_row` → **Face pull**; `ex_seed_db_curl` → **Plank**. These are swap slots reusing an old seed id under a new name — harmless, but they're why an id's name won't match its "seed" meaning.

> **No action:** the app resolves the *current* name correctly in every case. Noted only so the id names don't mislead you later.

### F5 — Minor data-quality notes (no action required)

- **Empty "done" sets:** `ex_seed_bench_press` on 2026-06-29 has two sets marked done with `weight 0 / reps 0` (sets 2–3). They're inert — the metric helpers ignore 0/0 — but you may want to delete them. One set carries the note *"Decline bench press"*.
- **Untyped `loadType`:** 8 session-only ids have no `loadType` (e.g. `added_mrdx5pc1_tf8b4` "Tricep Extension", `added_mr25f021_soowf` "Basic Squat", `swap_mr9e30qy_lbho0`). The app treats these conservatively as rep-based (never fabricates a kg record), so this is safe; typing them is optional.
- **Ambiguous names in the wild:** "Pull Down" (`added_mrp494l9_fzx95`) is almost certainly a Lat Pulldown; "Basic Squat" a Back Squat; "Shoulder Press"/"Seated Dumbbell Overhead Press" the same movement under two ids. Not mapped (they're history-only, no panel).

---

## 3. Full enumeration

Proposed reference ids apply to the current plan only (panels render on plan cards). History-only ids intentionally get no reference panel — correct behaviour, not an error.

<!-- BEGIN GENERATED TABLE -->

#### 1 · Current plan (gets reference panel)  (20)
| Stored label | App id | Proposed reference id | Conf | Sess/Sets |
|---|---|---|---|---|
| Leg Press | `ex_seed_leg_press` | `Leg_Press` | high | 2/3 |
| Back Squat | `ex_seed_squat` | `Barbell_Squat` | high | 1/0 |
| Cable Fly | `ex_msp7yf90_i9qvf` | `Cable_Crossover` | high | 1/3 |
| Face pull | `ex_msp7z18a_gwo08` | `Face_Pull` | high | 1/3 |
| Hammer curl | `ex_msp7zfa0_w404t` | `Hammer_Curls` | high | 1/3 |
| Hanging Leg Raise | `ex_msp83ssa_f0170` | `Hanging_Leg_Raise` | high | 1/3 |
| Incline dumbbell press | `ex_msp7xrks_m4f5k` | `Incline_Dumbbell_Press` | high | 1/4 |
| Plank | `ex_msp7zz14_330jh` | `Plank` | high | 1/3 |
| Romanian Deadlift | `ex_seed_rdl` | `Romanian_Deadlift` | high | 1/3 |
| Seated Cable Row | `ex_msp7y3g3_qbflc` | `Seated_Cable_Rows` | high | 1/4 |
| Band External Rotation | `ex_seed_ext_rot` | `External_Rotation_with_Band` | high | 0/0 |
| Band Pull-Apart | `ex_seed_pull_apart` | `Band_Pull_Apart` | high | 0/0 |
| Bench Press | `ex_msp84vme_937va` | `Barbell_Bench_Press_-_Medium_Grip` | high | 0/0 |
| Bicep Curl | `ex_msp8679f_xpxuo` | `Dumbbell_Bicep_Curl` | high | 0/0 |
| Calf Raise | `ex_seed_calf_raise` | `Standing_Calf_Raises` | high | 0/0 |
| Chest-Supported Row | `ex_msp85wtj_2dnqm` | `Leverage_Iso_Row` | medium | 0/0 |
| Leg Curl | `ex_seed_leg_curl` | `Lying_Leg_Curls` | medium | 0/0 |
| Overhead Press | `ex_msp85iik_wuqp6` | `Standing_Military_Press` | high | 0/0 |
| Pull-up | `ex_msp85597_4oy2u` | `Pullups` | high | 0/0 |
| Tricep Pushdown | `ex_msp86m5c_or2dm` | `Triceps_Pushdown` | high | 0/0 |

#### 2 · Archived (history retained)  (3)
| Stored label | App id | Proposed reference id | Conf | Sess/Sets |
|---|---|---|---|---|
| Archived exercise | `ex_seed_bb_row` | — (none) | n/a | 3/12 |
| Archived exercise | `ex_seed_ohp` | — (none) | n/a | 2/8 |
| Archived exercise | `ex_seed_db_bench` | — (none) | n/a | 1/3 |

#### 3 · Retired seed id (carries history)  (8)
| Stored label | App id | Proposed reference id | Conf | Sess/Sets |
|---|---|---|---|---|
| Bicep Curl | `ex_seed_incline_db` | — (none) | n/a | 7/21 |
| Cable/machine row | `ex_seed_db_ohp` | — (none) | n/a | 5/16 |
| Hammer curl | `ex_seed_lat_pulldown` | — (none) | n/a | 5/12 |
| Lat Pulldown | `ex_seed_pullup` | — (none) | n/a | 5/12 |
| Bench Press | `ex_seed_bench_press` | — (none) | n/a | 4/15 |
| Tricep Pushdown | `ex_seed_tri_pushdown` | — (none) | n/a | 3/10 |
| Face pull | `ex_seed_cable_row` | — (none) | n/a | 2/6 |
| Plank | `ex_seed_db_curl` | — (none) | n/a | 1/3 |

#### 4 · Session swap (carries history)  (4)
| Stored label | App id | Proposed reference id | Conf | Sess/Sets |
|---|---|---|---|---|
| Bench Press | `swap_mrp3n6ua_4h7ll` | — (none) | n/a | 1/4 |
| Incline Bench Press | `swap_mr9d3qu9_vq8s2` | — (none) | n/a | 1/4 |
| Incline Bench Press | `swap_ms3h71zd_kmv2f` | — (none) | n/a | 1/4 |
| Seated Dumbbell Overhead Press | `swap_mr9e30qy_lbho0` | — (none) | n/a | 1/4 |

#### 5 · Session add (carries history)  (19)
| Stored label | App id | Proposed reference id | Conf | Sess/Sets |
|---|---|---|---|---|
| Tricep Extension | `added_mrdx5pc1_tf8b4` | — (none) | n/a | 4/16 |
| Shoulder Press | `added_ms6a8n2j_s2j0n` | — (none) | n/a | 3/11 |
| Dumbbell Reverse Fly | `added_mslqbhjr_g271t` | — (none) | n/a | 2/6 |
| Plank | `added_mrduudc3_g9rsx` | — (none) | n/a | 2/6 |
| Back Squat | `added_mraqqex0_lsgf8` | — (none) | n/a | 1/4 |
| Basic Squat | `added_mr25f021_soowf` | — (none) | n/a | 1/3 |
| Cable/machine row | `added_mrduspd0_en0lg` | — (none) | n/a | 1/4 |
| Dumbbell Tricep Extension | `added_mrqg0rl9_xo9i5` | — (none) | n/a | 1/3 |
| Face pull | `added_mrdut5t9_h8oll` | — (none) | n/a | 1/3 |
| Hammer curl | `added_mrdutkz1_m62t3` | — (none) | n/a | 1/3 |
| Hanging Leg Raises | `added_msnpgtqs_y49qk` | — (none) | n/a | 1/3 |
| Incline dumbbell press | `added_mrdurrg0_h4ch5` | — (none) | n/a | 1/3 |
| Lat Pulldown | `added_mr25m4lx_tzt0s` | — (none) | n/a | 1/4 |
| Leg Press | `added_mr25gb32_lu83u` | — (none) | n/a | 1/3 |
| Leg Press | `added_mraqrkpu_mcieo` | — (none) | n/a | 1/3 |
| Pull Down | `added_mrp494l9_fzx95` | — (none) | n/a | 1/4 |
| Pull-up | `added_msnojlgk_hnq2r` | — (none) | n/a | 1/3 |
| Rear Delt Fly | `added_mraqw5kx_6j3iq` | — (none) | n/a | 1/4 |
| Romanian Deadlift | `added_mraqqwvc_rebse` | — (none) | n/a | 1/3 |
<!-- END GENERATED TABLE -->

---

## 4. Unmapped / needs review

**Mapped with lower confidence — verify the variant fits your movement:**

- **Chest-Supported Row** `ex_msp85wtj_2dnqm` → `Leverage_Iso_Row` *(medium — a chest-supported machine row; swap to `Dumbbell_Incline_Row` if you use the DB version).*
- **Leg Curl** `ex_seed_leg_curl` → `Lying_Leg_Curls` *(medium — the stored name doesn't say lying vs. seated; change to `Seated_Leg_Curl` if that's your machine).*

**Deliberately unmapped (render no reference panel — correct):**

- All **archived** items (F3) and all **history-only** `ex_seed_*` / `swap_*` / `added_*` ids. They never show a plan detail panel, so a reference match would be unused.

**Recommended follow-ups (out of scope for this display layer, offered as separate work):**

1. ~~Id-alias map to reunite fragmented history (F1)~~ — **DONE**, see F1 above (`data/exercise-aliases.json`).
2. Rename the three "Archived exercise" orphans (F3) via the existing Data-tab flow.
3. Optionally correct the four shifted muscle strings (F2) in the Plan editor.

*All proposals are advisory. This audit changed no logs, no plan, and no export.*
