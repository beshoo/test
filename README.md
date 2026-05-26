# Premix Insulin — Basal Reconciliation: Full Study & Implementation Plan

**Status:** Design proposal
**Scope:** Patients using premixed insulin (Mix 70/30, 50/50, 75/25). Does not change separate rapid+basal flows.
**Audience:** Backend (Laravel/Filament), Flutter client, clinical reviewer.

---

## 1. What the platform already does (verified)

### 1.1 Premix is modelled as "gross up the rapid dose by the rapid fraction"

`global_configs` (category `mix_types`) stores the **rapid fraction** of each premix:

| mix_type | rapid fraction (`rf`) | basal fraction (`1 − rf`) |
|---|---|---|
| Rapid | 1.0 | 0.0 |
| Mix 70/30 | 0.30 | 0.70 |
| Mix 50/50 | 0.50 | 0.50 |
| Mix 75/25 | 0.25 | 0.75 |

Read via `ConfigService::getMixFraction($mixType)` → `GlobalConfig::getMixFractionByLabel()`.

In **`MealLogService`** (both the single-item path ~L253–340 and the aggregated path ~L1300–1411), when the patient is on a mix:

```php
// Correction dose (Column J) and ΔUnits suggested (Column T)
if ($rapidFraction !== null && $rapidFraction > 0 && $rapidFraction < 1) {
    $correctionDose   = $correctionDose   / $rapidFraction;
    $deltaUnitsSuggested = $baseDeltaUnits / $rapidFraction;
}
```

**Meaning:** the number shown to a mix patient is *total premix units to inject*, sized so the **rapid component inside it** equals the rapid the patient actually needs. The basal component `dose × (1 − rf)` rides along incidentally.

> This matches the user's worked example exactly: separate-insulin total rapid = 2.8 U; same patient on 50/50 is told to inject `2.8 / 0.5 = 5.6 U`, of which 2.8 is rapid and 2.8 is basal.

The effective-ICR / effective-ISF grossing for mix is defined in `Config.csv` rows 125–126 (`Effective ICR/ISF for dosing`) using the same rapid-fraction `VLOOKUP`. The carb dose (`bolus_carbs_dose`) is computed as `carbs / periodIcr` and the mix scaling is expected to come through the **effective ICR** rather than a second division — confirm the period ICR passed in is already the effective (grossed) one before relying on this in reconciliation math.

> ⚠️ **CORRECTION (verified 2026-05-26 — see §7 Audit Findings):** the assumption above is FALSE in the current code. The effective ICR/ISF (Config rows 125–126) is **not implemented anywhere in PHP** — nothing reads it. The carb dose stays `carbs / periodIcr` with **no** rapid-fraction grossing, while `correction_dose` and `delta_units` ARE divided by `rf`. The result is that mix meal totals are wrong today (the user's own 2.8 U ⇒ 50/50 should be 5.6 U; the code produces ≈3.47 U). **This must be fixed (§7 C1) before any reconciliation math sums `total_dose_with_iob`.**

### 1.2 Basal recommendation is mix-aware for *tuning*, but does not subtract premix-delivered basal

- `UserCalculationService::calculateForUser()` computes the **daily basal target**:
  - `basal_dose = round(TDD × basal_percent, 1)` (or LADA equivalent).
  - For mix users it *also* computes `total_mix_dose_for_basal = basal_dose / rapidFraction`, `am_mix_dose`, `pm_mix_dose`, `rapid_fraction`, `basal_fraction`, `am_mix_percent`, `pm_mix_percent` (Config rows 39–51). **This is a static split of the day into AM/PM premix shots — it is not driven by what the patient actually injected at meals.**
- `BasalLogService` converts a basal "Δ units" from morning-vs-target error and **divides by `(1 − rf)`** for mix (Column M, `delta_basal_units_theoretical`), because for a mix patient one premix unit only moves fasting BG via its basal portion.
- `RobustAutoTuneService::calculateBasal()` recommends `suggested_new_basal` from eligible nights' bedtime→morning delta.

**The gap (exactly as the user states):** there is **no component that tracks the cumulative basal already delivered through premix *meal* doses during the day and reconciles it against the daily basal target.** Each meal dose silently delivers `dose × (1 − rf)` of basal that nothing counts.

### 1.3 Where dose numbers are surfaced

- Per meal: `MealLogService::getMealGroups()` → `enrichAggregatedMealWithIob()` produces `total_dose`, `total_dose_with_iob`, `correction_dose`, `bolus_carbs_dose`, `actual_dose`, plus bilingual `stacking_warning_text`. Exposed by `MealLogController` (`API_MEAL_LOGGING.md`).
- Per night/basal: `BasalLogController` + `BasalLogController::basalDoseHint()` (`/basal-logs/basal-dose-hint`) returns the suggested basal value (default vs robust-autotune) for the basal form.
- Aggregated day: `DailyLogService` (one row per meal group).

These are the natural seams: a **new "premix basal reconciliation" endpoint** parallels `basalDoseHint`, and a per-meal `mix_breakdown` block parallels the existing IOB enrichment.

### 1.4 Key data we can rely on

- `meal_logs.actual_dose` (and `meal_periods.actual_dose`) = premix units actually injected at a meal → its basal portion = `actual_dose × (1 − rf)`.
- `meal_logs.total_dose` / `total_dose_with_iob` = recommended premix units → planned basal portion.
- `meal_logs.actual_correction_units_est`, `actual_bolus_units_est` already split a taken dose into correction vs carb parts (for IOB). We can split into rapid vs basal the same way.
- `meal_logs.override_snapshot` already freezes per-meal config; we should **freeze `mix_type` + `rapid_fraction` into the snapshot too** so historical reconciliation is replay-safe.
- `basal_logs` is one row per day (unique on `user_id, log_date`) — the right home for the day's reconciled residual.

---

## 2. The clinical/maths model

Let:

- `rf` = rapid fraction of the patient's mix (e.g. 0.5 for 50/50). `bf = 1 − rf`.
- `B_target` = daily basal requirement (U) = `UserCalculationService.basal_dose`, or RobustAutoTune `suggested_new_basal` once enough eligible nights exist (mirror `basalDoseHint` precedence).
- For each premix dose *i* on the day with injected units `D_i`:
  - rapid delivered `R_i = D_i × rf`
  - **basal delivered `Bd_i = D_i × bf`**
- Cumulative basal delivered so far: `B_delivered = Σ Bd_i`.
- **Residual basal: `B_residual = max(0, B_target − B_delivered)`.**

### 2.1 The unavoidable-rapid problem at the final dose

To deliver `B_residual` more basal using the same premix, the patient must inject:

```
D_needed = B_residual / bf        // premix units to complete basal
R_forced = D_needed × rf          // = B_residual × rf / bf  → unavoidable rapid
```

That `R_forced` rapid will drop BG unless matched by carbs. Using the active period ICR (effective ICR for mix) `ICR_p`:

```
carbs_needed_g = R_forced × ICR_p          // grams to offset the forced rapid
```

(Plus, if BG is below target at that time, *more* carbs; if above target, the forced rapid can be partly "credited" as correction — see §2.3.)

**Worked check (user's example, 50/50, bf=0.5, rf=0.5):**
`B_residual = 7.2` → `D_needed = 7.2/0.5 = 14.4 U`; `R_forced = 14.4×0.5 = 7.2 U`; evening ICR 12 → `carbs = 7.2×12 = 86.4 g`. ✅ Matches the user's target output.

### 2.2 Why we must also cap / split (safety)

`carbs_needed_g` grows linearly with `B_residual`. For a 50/50 mix, completing 7.2 U basal forces 86 g carbs at bedtime — clinically often unacceptable (large nocturnal carb load, hypo-then-rebound risk). So the system must not *only* compute the carb offset; it must **classify** the residual and recommend a strategy:

| Residual band | Forced rapid | Recommended strategy |
|---|---|---|
| Small (≤ `safe_forced_rapid_u`, default 1–2 U) | small | Complete with premix + the computed small carb snack. |
| Medium | moderate | Offer the carb-offset option **and** flag "consider a small dedicated basal top-up if available". |
| Large (carbs > `max_bedtime_carbs_g`, default from Config row 76 = 50 g) | large | **Do not** recommend completing basal via premix. Recommend (a) tolerating partial basal underdelivery tonight, and/or (b) supplemental **pure basal** insulin (`B_residual` U, no carbs) if the patient has any, and/or (c) redistributing tomorrow's AM/PM premix split. |

This directly answers the user's discussion questions: we do **all three** — compute the carb-offset, allow capped completion, and recommend split/supplemental basal above a safety threshold — chosen by band rather than picking one globally.

### 2.3 BG-aware refinement (optional, recommended)

At the final dose we usually know the current/bedtime BG. Fold it in so we don't double-count:

```
correction_credit_u = max(0, (BG_now − target) / ISF_p)   // rapid the patient "needed" anyway
net_excess_rapid_u  = max(0, R_forced − correction_credit_u)
carbs_needed_g      = net_excess_rapid_u × ICR_p
+ if BG_now < night_low_threshold: add hypo-treatment carbs (Config row 76 logic, already in BasalLogService honey_carbs)
```

This reuses thresholds the app already has (`target_bg`, `night_low_threshold`, `max_carbs_for_low`, `bedtime_target_bg`).

---

## 3. Proposed implementation

### 3.1 New service: `PremixReconciliationService`

`app/Services/PremixReconciliationService.php`. Pure calculation, mirrors the static style of `ConfigService`/`RobustAutoTuneService`.

```php
final class PremixReconciliationService
{
    /**
     * Reconcile basal delivered via premix meal doses vs the daily basal target.
     *
     * @param  bool  $usePlanned  true = use recommended doses (total_dose_with_iob),
     *                             false = use actual injected (actual_dose). Default true for
     *                             forward planning; false for end-of-day review.
     * @return array  bilingual, ready for API/UI (see §3.3 shape)
     */
    public static function reconcileForDay(User $user, string $date, ?string $finalPeriod = null, ?float $bgNowMmol = null, bool $usePlanned = true): array;

    /** Convenience: today in the user's timezone. */
    public static function reconcileToday(User $user, ?float $bgNowMmol = null, bool $usePlanned = true): array;
}
```

**Algorithm:**
1. Guard: if `! $user->mix_basal` or `rf` not in `(0,1)` → return `{ applicable: false }` (separate-insulin patients are unaffected).
2. `rf = getMixFraction($user->mix_type)`, `bf = 1 - rf`.
3. `B_target` = mirror `BasalLogController::basalDoseHint()` precedence: RobustAutoTune `basal_last_n.suggested_new_basal` when `eligible_count ≥ min_eligible_n_basal`, else `UserCalculationService.basal_dose`. Return which source was used.
4. Pull the day's meal groups (`MealLogService::getMealGroups($user, null, $date)`). For each group with a header-for-dosing row, take `D_i = usePlanned ? total_dose_with_iob : actual_dose`. `Bd_i = D_i × bf`. Sum → `B_delivered`. Keep a per-period breakdown.
5. `B_residual = max(0, B_target − B_delivered)`.
6. `D_needed = bf > 0 ? B_residual / bf : null`; `R_forced = D_needed × rf`.
7. Resolve `ICR_p`, `ISF_p` for `finalPeriod` (default `night_snack`) via `UserCalculationService`/`ConfigService` effective values. If `bgNowMmol` given, apply §2.3 to get `net_excess_rapid_u`; else `net_excess_rapid_u = R_forced`.
8. `carbs_needed_g = round(net_excess_rapid_u × ICR_p)`.
9. **Classify band** (§2.2) using `safe_forced_rapid_u` and `max_bedtime_carbs_g` (new global_config keys; defaults reuse Config row 76 = 50 g for the carb cap). Produce `strategy` + bilingual messages.
10. Return the full structured result (§3.3).

**No double counting:** this service *reports*; it does not mutate meal doses. Meal doses are already correctly grossed-up for rapid. The only new persisted value is the day's residual on `basal_logs` (§3.4).

### 3.2 Config keys to add (migration, like `2026_01_30_...add_..._to_global_configs`)

| key | default | meaning |
|---|---|---|
| `premix_reconciliation_enabled` | `1` | feature flag |
| `premix_safe_forced_rapid_u` | `1.5` | ≤ this forced rapid ⇒ "small" band (complete via premix) |
| `premix_max_bedtime_carbs_g` | `50` | carbs above this ⇒ "large" band (discourage completion). Reuses Config row 76 intent. |
| `premix_final_period_default` | `night_snack` | period whose ICR/ISF is used for the final-dose offset |

All read through `ConfigService` with the documented fallback pattern, and overridable per patient via `MedicalOverrideService` (doctor > patient > global), consistent with existing readers.

### 3.3 API surface

Two endpoints, matching existing conventions in `routes/api.php` (JWT group, `*/me` aliases):

```php
// Day reconciliation (forward-planning or review)
Route::get('/users/{user}/premix-reconciliation', [PremixReconciliationController::class, 'show']);
Route::get('/premix-reconciliation/me', [PremixReconciliationController::class, 'me']);
```

Query params: `date` (default today, user tz), `final_period` (default config), `bg` + `bg_unit` (optional bedtime BG for §2.3), `basis=planned|actual` (default `planned`).

**Response shape (bilingual, mirrors `basalDoseHint` + meal-log style):**

```json
{
  "success": true,
  "data": {
    "applicable": true,
    "mix_type": "Mix 50/50",
    "rapid_fraction": 0.5,
    "basal_fraction": 0.5,
    "basal_target_u": 13.0,
    "basal_target_source": "default_basal",      // or "robust_autotune"
    "basal_delivered_u": 5.8,
    "basal_residual_u": 7.2,
    "per_period": [
      { "period": "breakfast", "injected_u": 5.6, "basal_delivered_u": 2.8, "basis": "planned" },
      { "period": "lunch",     "injected_u": 6.0, "basal_delivered_u": 3.0, "basis": "planned" }
    ],
    "final_dose": {
      "period": "night_snack",
      "premix_units_to_complete_basal_u": 14.4,
      "forced_rapid_u": 7.2,
      "correction_credit_u": 0.0,
      "net_excess_rapid_u": 7.2,
      "icr_used": 12.0,
      "isf_used": 60.0,
      "carbs_needed_g": 86
    },
    "strategy": "discourage_premix_completion",   // complete_with_premix | offer_carb_offset | discourage_premix_completion
    "hypo_risk": "high",                          // low | moderate | high
    "messages": {
      "en": "You still need ~7.2 U of basal today. Completing this with your 50/50 mix means injecting 14.4 U, which forces 7.2 U of rapid and ~86 g of carbs to stay safe — too much for bedtime. Prefer a dedicated basal top-up of 7.2 U if available, or accept slightly higher fasting tomorrow and rebalance your AM/PM mix.",
      "ar": "ما زلت بحاجة إلى نحو 7.2 وحدة قاعدي اليوم. إكمالها عبر ميكس 50/50 يعني حقن 14.4 وحدة، ما يفرض 7.2 وحدة سريع و~86غ كربوهيدرات لتفادي الهبوط — وهي كمية كبيرة قبل النوم. يُفضّل جرعة قاعدي مستقلة 7.2 وحدة إن توفّرت، أو قبول ارتفاع صباحي بسيط مع إعادة توزيع ميكس الصباح/المساء."
    }
  }
}
```

When `applicable=false` the client simply hides the card (separate-insulin or no mix type).

### 3.4 Persistence (optional but recommended)

Add nullable columns to `basal_logs` (already one row/day): `premix_basal_delivered_u`, `premix_basal_residual_u`, `premix_final_carbs_g`, `premix_strategy`. Populate when the basal-log day row is created/updated, so:
- `RobustAutoTuneService` and reports can later see the residual without recomputing.
- The basal auto-tune can eventually learn from "residual carried" patterns.

This keeps reconciliation auditable next to the existing `eligible_night` / `delta_basal_units_theoretical` data.

### 3.5 Snapshot change

In `MealLogService` add `mix_type` and `rapid_fraction` to the `override_snapshot` array (§1.4). One-line addition next to the existing `period_icr`/`period_isf` freeze; makes historical reconciliation replay-safe when a patient later switches mix type.

---

## 4. UI / UX (Flutter client)

Two surfaces, both **read-only cards** (no new inputs required beyond an optional bedtime BG the app already collects):

### 4.1 Per-meal hint (lightweight)
On the meal-log result card for mix patients, under the existing dose line, add a muted sub-line:
> *Includes ~2.8 U basal (50% of 5.6 U mix).* / *تتضمّن ~2.8 وحدة قاعدي (50٪ من 5.6 وحدة ميكس).*

Pure presentation from `injected_u × bf`; needs no new endpoint (client can compute from `rapid_fraction` already available, or read `mix_breakdown` if we add it to the meal payload).

### 4.2 End-of-day "Basal completion" card
Shown on the basal-log / day screen for mix patients, fed by `/premix-reconciliation/me`:

```
┌─ Basal completion (50/50 mix) ──────────────────────────┐
│ Daily basal target        13.0 U                        │
│ Delivered via meals       5.8 U  (breakfast 2.8 · lunch 3.0) │
│ Still needed              7.2 U                          │
│ ───────────────────────────────────────────────────────│
│ ⚠ High hypo risk to finish with mix                     │
│ To get 7.2 U basal you'd inject 14.4 U mix → 7.2 U rapid│
│ → eat ~86 g carbs. That's a lot for bedtime.            │
│ Better: take 7.2 U pure basal if you have it, or accept │
│ a slightly higher morning reading and rebalance AM/PM.  │
│ [ Show carb-offset option ]                             │
└─────────────────────────────────────────────────────────┘
```

- Color/severity from `hypo_risk` (reuse the app's existing green/amber/red severity styling from `DailyLogService` dose-evaluation).
- The `[Show carb-offset option]` expander reveals the precise `14.4 U mix → 86 g carbs` path for patients who choose it.
- Bilingual strings come straight from `messages.en/ar`.

### 4.3 Inputs needed from the user
- **None mandatory.** The card works off existing logged meals + profile.
- **Optional:** current/bedtime BG (already a field on the basal log) sharpens the carb number via §2.3.
- **Optional toggle:** "Plan (use recommended doses)" vs "Review (use what I injected)" → maps to `basis=planned|actual`.

---

## 5. Answers to the discussion questions

1. **Is the conceptual direction correct?** Yes. Tracking cumulative basal fraction across premix doses, computing residual, and translating the unavoidable rapid at completion into a carb requirement is sound and matches your worked example to the decimal. The one addition: make it **BG-aware** (§2.3) and **banded** (§2.2) rather than always prescribing the carb offset.
2. **Cap completion vs tolerate underdelivery?** Do both, by band. Small residuals → complete via premix + small snack. Large residuals → explicitly recommend tolerating partial underdelivery overnight (with a "fasting may run higher tomorrow" note) rather than forcing a big carb load.
3. **Recommend split / supplemental pure basal above a threshold?** Yes — that's the "large" band's primary recommendation: supplemental **pure basal** (`B_residual` U, zero forced rapid, zero carbs) when available, and/or rebalancing the AM/PM premix split (`am_mix_percent`/`pm_mix_percent` already computed) so less basal is left for the last shot.
4. **UI representation?** A single bilingual "Basal completion" card (§4.2) showing: target, delivered (with per-meal breakdown), residual, the forced-rapid + carb cost of completing via premix, a clear severity flag, and the recommended strategy — with the carb-offset path behind an expander so it's available but not the default for risky amounts.

---

## 6. Suggested build order

1. `PremixReconciliationService` (pure logic) + unit tests covering the user's 50/50 example and 70/30, 75/25, plus residual=0 and BG-aware cases.
2. Config-key migration (§3.2).
3. `override_snapshot` mix fields (§3.5).
4. Controller + routes + `API_PREMIX_RECONCILIATION.md` (follow `API_BASAL_LOGGING.md` format).
5. `basal_logs` persistence columns (§3.4) + populate on save.
6. Flutter cards (§4) once the endpoint is stable.

No existing separate-insulin behaviour changes; everything is gated behind `mix_basal` + `rf ∈ (0,1)` + the feature flag.

---

## 7. Audit Findings (pre-implementation review — 2026-05-26)

**Reviewer note:** Full clinical + engineering + safety audit of the *current* code before building the feature. **Conclusion: the design in §1–§6 is sound and the algebra is verified to the decimal, but it depends on code paths that are currently buggy. Those bugs must be fixed before reconciliation is built, but NOT before clinical (Dr) sign-off, because fixing them changes the dose numbers shown to mix patients.**

**Current exposure (verified):** there are **0 mix patients** in the database today (10 users total, none with `mix_basal = true`). So none of the bugs below affect a live patient *right now* — they are latent until the first mix patient is onboarded. **Decision: make no PHP changes yet; fix C1+C2 (and only then build the feature) as one reviewed change before the first real mix patient.** Separate-insulin patients never enter these code paths (all gated behind `rf ∈ (0,1)`).

### 7.1 Critical — must fix before reconciliation

- **C1 — Carb (bolus) dose is not grossed up by rapid fraction.**
  In `MealLogService::calculateMealLog()` (~L338) and `calculateAggregatedMeal()` (~L1409), `correction_dose` and `delta_units_suggested` are divided by `rf`, but `bolus_carbs_dose = totalEffectiveCarbs / periodIcr` is **not**. The "effective ICR/ISF" of Config rows 125–126 is not implemented in PHP (grep: no `getEffectiveIcr`/`effective_icr`).
  *Effect:* mix totals are wrong. User's example (50/50, ICR 16, ISF 70, 40 g, pre 144 mg/dL, target 110): expected total **5.6 U**, code produces **≈3.47 U** → under-doses carb cover (post-meal highs) AND understates delivered basal, which is exactly the sum the reconciliation relies on (`total_dose_with_iob`).
  *Fix (pick ONE, never both — double-gross risk):* (A) gross the carb dose too: `bolusCarbsDose = (carbs/periodIcr) / rf`; or (B) implement effective ICR/ISF (`periodIcr*rf`, `periodIsf*rf`), divide by those, and REMOVE the separate `/rf` on correction/ΔUnits. Option A matches the rest of the existing code. This is a **clinical dosing decision** → defer to the Dr discussion. Pin the 2.8 ⇒ 5.6 example as a regression test.

- **C2 — Rapid IOB counts the full premix shot as rapid.**
  In `calculateIobFromPriorDoses()` (~L796): `activeRapidIob += takenDose * factor` uses the full premix `actual_dose`. For a 50/50 patient a 6 U premix dose adds 6 U rapid IOB instead of 3 U.
  *Effect:* over-states active rapid → over-suppresses the next correction (mix patient runs high), and feeds the `actual_correction_units_est` / `actual_bolus_units_est` split the reconciliation plans to reuse.
  *Fix:* rapid IOB for a mix dose = `takenDose × rf × factor`; the basal portion does not belong in rapid IOB.

- **C3 — Forced-rapid carb cap reuses the hypo-rescue ceiling.**
  Plan §3.2 defaults `premix_max_bedtime_carbs_g = 50` from Config row 76, but row 76 (`max_carbs_for_low`) is the *hypo-treatment* ceiling, not a "safe planned bedtime snack." 50 g of planned bedtime carbs to enable an injection is itself a large nocturnal load with rebound/overnight-hypo risk.
  *Fix:* separate, lower default (≈30 g); and add an absolute hypo floor — never recommend completing basal via premix when bedtime BG < `lower_acceptable_bedtime_bg` (85 mg/dL), regardless of band.

- **C4 — `total_dose_with_iob` is not a clean "premix units" number until C1 is fixed.** The reconciliation's `Bd_i = D_i × bf` (algorithm step 4) will sum wrong values until C1 lands.

### 7.2 Engineering notes for the build

- **E1 — Duplicated dosing logic.** The single-item (~L253–533) and aggregated (~L1212–1568) paths re-implement correction/carb/ΔUnits independently; the C1 bug exists in both. Extract ONE shared gross-up helper (`computeDoseColumns()`) and have both meal paths + the new service use it, so they can't drift.
- **E2 — `basal_logs` write path.** `BasalLogController::store()` returns 422 on a second insert for the same `(user_id, log_date)`. Reconciliation write-back (§3.4) must update the existing row, not create.
- **E3 — Snapshot freeze (already in §3.5) is a prerequisite, not optional** — without freezing `mix_type` + `rapid_fraction`, a patient switching 50/50→70/30 retro-corrupts history.
- **E4 — "The day" must be resolved in `users.timezone`** (reuse the service's TZ memo) so a post-midnight night_snack isn't split across two reconciliation rows.

### 7.3 Clinical notes for the build

- **CS1 — Night-snack correction cap ordering.** The cap (`3×rf`) is applied *before* the `/rf` gross-up today, so the effective premix cap is ~3 U — correct. The C1 fix must preserve this ordering; add a test.
- **CS2 — Basal *tuning* is already mix-aware** (`BasalLogService` divides the fasting-error ΔUnits by `1−rf`, ~L113–122). Confirms the gap is purely meal-delivered basal accounting, exactly what this feature targets. The tuning side needs no change.
- **CS3 — Hypo threshold inconsistency.** Meal eval hard-codes 70 mg/dL (~L102) while `night_low_threshold` is configurable (60). Reconciliation's BG-aware gating (§2.3) must use the configurable threshold, and the two should be reconciled.
- **CS4 — Basis default.** The end-of-day completion card (which recommends a real injection) must default to `basis=actual`; `planned` is only safe for daytime forecasting. Skipped/unlogged meals make the wrong basis either over- or under-deliver basal.

### 7.4 Verified-correct items (no change needed)

- Reconciliation algebra (§2): `B_residual`, `D_needed`, `R_forced`, `carbs_needed` — all correct given a correct `bf` and delivered sum. User's case reproduces exactly (7.2 → 14.4 U → 7.2 U rapid → 86.4 g).
- `B_target` precedence (§3.1) matches the live `BasalLogController::basalDoseHint()` (robust-autotune when `eligible_count ≥ min_eligible_n_basal`, else `UserCalculationService.basal_dose`) — reuse that method, don't re-derive.
- `applicable:false` gating for `rf ∉ (0,1)` is correct; keep the `bf=0` division guard as the first check.

### 7.5 Required tests (when built)

Gross-up parity (2.8 ⇒ 5.6 for 50/50; 9.33 for 70/30; 11.2 for 75/25) · mix rapid-IOB (6 U 50/50 ⇒ 3 U rapid IOB) · two-meal reconciliation (residual 7.2, carbs 86, band=discourage) · `bf=0` ⇒ `applicable:false` · skipped meal actual-vs-planned · BG below night-low ⇒ hard-stop · post-midnight night_snack day assignment · second-meal `basal_logs` update (no 422).

### 7.6 Deployment note

Fixing C1/C2 will change the dose numbers shown to mix patients (carb-heavy meals roughly double — a correction of an unsafe under-dose). With 0 mix patients today this is currently zero-impact; once patients exist, recalc via the existing `recalculateMealLog` snapshot-replay path and consider clinician-gating active patients.
