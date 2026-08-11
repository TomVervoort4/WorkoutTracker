# Phase 4 — Convergence Discipline (a rubric, not a build)

Every other phase adds something. **This phase is the one that says no.** It ships
no code. It is the gate every future data source, feature, integration, or
"insight" must pass before it earns a place in FitTrack — so the hub stays a
considered progress instrument and never rots into an everything-drawer of
fragile integrations.

Use this document whenever you (or a future you, or Claude) are tempted to add
something. Run the proposal through the gates below **before** writing any code.
If it can't clear them, it doesn't belong in the app — it belongs in the JSON
export, where Claude can do whatever it wants with it.

---

## The yardstick: the core job

FitTrack exists to do four things, fast, forever, offline:

> **open → see what to do → log fast → export**

Everything in the app is judged against that sentence. A change is worth making
only when it makes one of those four verbs better for a decision the user
actually makes. "It would be neat to see" is not a reason. "I would change what I
do next because of it" is.

## The one governing principle

> **The app displays; Claude analyzes.**

The app is a beautiful, durable, deterministic *presentation layer* over data it
already holds. Any number it shows must be either **(a)** a simple, authored,
deterministic computation over local data that the user could verify by hand, or
**(b)** a value pre-computed by the external analysis layer and merely rendered.
No opaque logic, no live coaching, no auto-adjustment, no inference about *why*.
When in doubt, the app shows; it does not decide.

---

## Hard invariants (auto-reject)

If a proposal breaks any of these, stop. It is out, regardless of how useful it
seems. These are not trade-offs to be weighed — they are the shape of the app.

1. **No build step, no framework.** Vanilla JS only. A dependency that needs
   bundling, transpiling, or a toolchain is rejected on sight.
2. **Fully offline; no runtime network.** The *only* permitted network
   interaction is the user-initiated Google Drive share hand-off (Phase 1). No
   CDN loads, no external APIs, no fonts/scripts/data fetched at runtime. Any
   library is vendored locally (as SheetJS and the exercise library already are).
3. **Deterministic.** Same data in ⇒ same view out. No randomness, no
   network-dependent rendering, no time-of-day surprises beyond "today".
4. **The app never performs the forbidden computations.** It does not pair
   sessions to weigh-ins, filter shoot days, interpolate, judge whether a plateau
   or gap "matters", or make any coaching/causal inference. Those live in the
   analysis layer, always.
5. **No new persistent side-effects the user didn't ask for.** No background
   sync, no auto-upload, no standing rules. Every outward action stays
   user-initiated.
6. **Data stays rebuildable from one JSON snapshot.** Anything added must
   serialise into the existing backup so a wiped device restores whole
   (the Phase 1 guarantee). A source that can't round-trip through the snapshot
   is rejected.

## The rubric (run in order)

A proposal must clear **every** gate. The first failure is the answer.

**Gate 1 — Core-job fit.**
Which of open / see / log / export does this improve, and for *what decision the
user actually makes*? If you can't name the verb and the decision in one
sentence, reject.

**Gate 2 — Subtraction test.**
Could the same need be met by *removing* something, sharpening an existing
surface, or letting Claude handle it via the export instead? Prefer that. Every
new surface is maintained forever; addition is the expensive default.

**Gate 3 — The display/analyze boundary.**
Is the output a fact the user could verify by hand (category **a**), or a value
Claude pre-computed and the app just renders (category **b**)? If it is neither —
if the app would have to *infer, correlate, judge, or adjust* — it is Claude's
job. Reject from the app; note it as an export/analysis-layer capability instead.

**Gate 4 — Determinism & verifiability.**
Can you state the exact rule in one or two sentences, with named constants, such
that the same logs always produce the same result? If the rule needs a model, a
threshold nobody can justify, or "it depends", reject.

**Gate 5 — Durability & offline.**
Does it round-trip through the JSON snapshot, run with no network, and add no
build step or runtime dependency? (See hard invariants — this is the
re-confirmation, applied to *this* proposal specifically.)

**Gate 6 — Cost of the integration over time.**
What breaks it? A source that depends on an external format, an undocumented
export, or a third party's API is fragile by construction. Weigh the maintenance
tail, not just the first version. A fragile integration that feeds a decision
rarely made is the classic everything-drawer trap — reject.

**Gate 7 — Presentation load.**
Does it earn its pixels? The hub is quiet on purpose. A card that shows only when
it has something to say (as the plateau, gaps, and strength/bodyweight cards do)
is preferred to one that's always present. If it can't be quiet, reconsider.

If a proposal clears all seven, it's in — and it should look and behave like the
insights already shipped: one clear message, house style, facts not instructions.

## The app-vs-Claude boundary — the fast test

Most hard calls collapse to one question:

> **Does answering this require judgement, or just arithmetic?**

- **Arithmetic over local data** (a max, a sum, a count, a comparison, an Epley
  estimate, "highest to date", "N sessions since a gain") → the app may do it.
- **Judgement** (why did this happen, does it matter, are these two things
  related, what should you change, is this note an excuse or a cause) → Claude,
  via the export. The app may *co-locate* the raw inputs (as module 7 puts a note
  next to a drop) but must not interpret them.

When you're unsure which side a computation is on, put it on Claude's side. That
error is cheap (the data is in the export anyway); the reverse error — smuggling
inference into the app — is the exact rot this phase exists to prevent.

---

## Worked examples (from this app's real history)

| Proposal | Verdict | Why |
|---|---|---|
| Vendored exercise library + per-exercise `loadType` | **Accept** | Authored reference data, offline, deterministic; fixes phantom PRs by *classifying*, not judging. A pull-up being `bodyweight` is a fact. |
| Epley e1RM for weighted lifts; reps/seconds for others | **Accept** | Simple arithmetic the user could verify; metric chosen by `loadType`, no inference. |
| Plateau flag: "no est-1RM gain in N sessions" | **Accept** | Deterministic count with named thresholds. States a fact. |
| Plateau *suggestion*: "you should deload / increase load" | **Reject** | Prescription. This is exactly what was removed from the legacy engine. |
| Note interpretation: keyword-match "shoot" → relabel a dip as "expected fatigue" | **Reject** | Causal inference. Removed. The compliant version only *co-locates* the note next to the drop (module 7). |
| Bodyweight-adjusted e1RM for loaded pull-ups | **Reject (→ Claude)** | Requires pairing a set to the nearest weigh-in. The app stores reps + added load; Claude computes the adjusted number. |
| Strength & bodyweight on one timeline | **Accept (display-only)** | Two existing series on a shared axis for visual reading. The app draws them; it does **not** compute the correlation or exclude shoot days. |
| Weekly volume, grouped by session type | **Accept** | Sum of weight×reps bucketed by week and plan session name. Pure aggregation; the legacy "undertraining/overreach" flags were dropped. |
| A live nutrition API / wearable HR sync / social feed | **Reject** | Runtime network, fragile external integration, and no clear decision it feeds. Fails gates 5–6 (and usually 1). |

The pattern: **the app got smarter about *what kind of thing* each number is
(`loadType`), and never smarter about *what the numbers mean*.** That is the line
Phase 4 protects.

---

## Decision record (keep the "no"s)

When a proposal is evaluated, record it — a one-line entry is enough, and the
rejections are the valuable ones (they stop the same idea coming back). Suggested
format, appended below over time:

```
YYYY-MM-DD · <proposal> · ACCEPT | REJECT | → CLAUDE · <the gate it turned on>
```

_Log:_
- 2026-08-11 · loadType exercise model + vendored library · ACCEPT · gate 3 (classification is a fact)
- 2026-08-11 · legacy note-interpretation ("expected fatigue") · REJECT · gate 3 (causal inference)
- 2026-08-11 · in-app bodyweight-adjusted e1RM · → CLAUDE · gate 3 (needs session↔weigh-in pairing)
- 2026-08-11 · undertraining/overreach volume flags · REJECT · gate 3 (judgement, not fact)

---

## What this phase is *not*

- **Not a feature freeze.** Things that clear the gates still ship. Discipline is
  a filter, not a wall.
- **Not a limit on Claude.** Heavy analysis, correlation, coaching, and
  cross-source reasoning are welcome — in the analysis layer, over the JSON
  export. Phase 4 keeps that work *out of the app*, not out of the user's hands.
- **Not code.** There is nothing to build or verify here. The deliverable is this
  rubric and the habit of running proposals through it.
