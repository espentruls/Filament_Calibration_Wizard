# X2D Dual-Nozzle Enhancement Plan

Goal: make PerfectFit fully useful for the Bambu Lab X2D (2026, dual-nozzle), whose
auxiliary (right) nozzle is bowden-fed from a rear-mounted extruder, is NOT covered by
Bambu's automatic Flow Dynamics calibration, and ships with defaults that ooze/string
for many third-party filaments.

Research base (verified 2026-07-20 against wiki.bambulab.com, blog.bambulab.com,
forum.bambulab.com, github.com/bambulab/BambuStudio; details in the session research
reports):

- X2D architecture: main (left) nozzle = direct drive on the toolhead; auxiliary
  (right) nozzle = remote stepper at the rear panel feeding through a PTFE tube.
  Aux limits: 200 mm/s, 1000 mm/s²; no TPU; nozzle sizes must match main; ~4 mm Z
  loss while aux prints. (wiki: x2d/manual/auxiliary-extruder-intro, x2d-faq)
- X2D temperature limits: 300 °C max nozzle temperature (both hotends are
  identical), 120 °C max heatbed. (verified 2026-07-26 against the official spec —
  bambulab.com/en-us/x2d/specs and store.bblcdn.com .../X2D_spec.pdf; also
  wiki x2d-intro "300 °C hotend")
- Automatic Flow Dynamics (K) calibrates the MAIN hotend only; the aux hotend must be
  calibrated manually in Bambu Studio (Developer Mode → PA calibration, "remote
  extruder" pattern, range 0–1 step 0.02). Aux K is typically 0.5–1.0 (PETG example
  ~0.72) vs direct-drive 0–0.1. (x2d-faq; call-3d.com remote-extruder guide)
- K values are stored ON THE PRINTER keyed to filament+nozzle (assignable per AMS
  slot); flow ratio is stored in the slicer filament preset. Manual K only applies
  when the pre-print calibration gear is set to "Off". (calibration_pa)
- Retraction is per-extruder: machine profiles store per-extruder arrays
  (X2D defaults: main 0.8 mm, aux 2 mm). Filament presets can override per-extruder
  via Setting Overrides → "Direct Drive Extruder" / "Bowden Extruder". KNOWN BUG
  BambuStudio #10404: an unset ("nil") bowden override silently falls back to the
  MAIN default (0.8 mm) — under-retracting the aux nozzle. Community tuning: start
  2 mm, raise in ~0.5 mm steps, most land 2–4 mm (up to 6).
- Idle-nozzle ooze root cause: on toolchange Bambu Studio emits `M104 T? S0`
  (pre-cool to ~60 °C) then reheats; the thermal cycle causes a pressure spike and
  ooze (worst with PETG). No official standby-temp field yet; mitigations are prime
  tower, ramming/precool params (Developer Mode, BS 2.5+), and (advanced) holding
  160–180 °C via machine g-code templates. (forum thread 233923; parameter/prime-tower)
- X2D filament presets carry four per-path variants (normal / HF / bowdennormal /
  bowdenHF); dual-nozzle preset values are per-extruder arrays.
- Bambu's canonical calibration order for custom filament: Temperature → Flow Rate →
  Flow Dynamics (K) → Retraction → Max Volumetric Speed. (bambu-studio/Calibration)

## Changes

### 1. Data model (`src/types.ts`, `src/export/backup.ts`, `src/storage/*`)
- `PrinterProfile.nozzles?: NozzleProfile[]` — optional array; absent = legacy
  single-nozzle profile (no forced migration). `NozzleProfile`: `label`
  ("Main (direct drive)" / "Auxiliary (bowden)"), `feed: 'direct' | 'bowden'`,
  `maxSpeed?`, `maxAccel?`, `notes?`.
- `CalibrationProject.nozzleIndex?: number` — which physical nozzle the project
  calibrates (default 0). Shown as a badge everywhere the project name appears.
- Backup schema: accept + preserve the new optional fields (bump schema version,
  migration defaults them; round-trip test).

### 2. Known-printer template (`src/ui/printers.ts` or data module)
- "Bambu Lab X2D" quick-fill: two nozzles pre-configured (main: direct, aux: bowden,
  200 mm/s / 1000 mm/s² noted), maxNozzleTemp 300, extruderType per nozzle.

### 3. Nozzle-aware suggestions (`src/logic/ranges.ts`)
- Range suggestion functions take the project's target nozzle: aux/bowden nozzle →
  PA range 0–1 step 0.02 (per Bambu remote-extruder guidance), retraction suggestion
  2–6 mm start 2; main keeps direct-drive ranges. (The generic bowden branch exists —
  align its step values with the X2D-specific guidance.)

### 4. X2D-aware instructions (`src/data/slicers.ts`)
- Bambu Studio entry additions:
  - Dual-nozzle machines show a nozzle-selection step in the calibration dialogs —
    pick the nozzle the project targets; run flow dynamics per nozzle.
  - Manual K only applies with the pre-print calibration gear set to "Off"; auto K
    values are intentionally higher than manual pattern K — do not compare scales.
  - saveTo guidance for dual-nozzle presets: values are per-extruder arrays / the
    Setting Overrides "Bowden Extruder" column; explicitly set the bowden retraction
    override (bug #10404 — unset falls back to 0.8 mm main default).
  - Aux constraints callout: 200 mm/s cap, no flexibles, nozzle sizes must match.

### 5. New guidance step: dual-nozzle ooze control (`src/data/calibrations.ts`,
`src/ui/testForms.ts`, `src/data/slicers.ts`)
- New optional calibration step `ooze-control`, offered when the printer profile has
  ≥2 nozzles (or manually addable): a structured checklist + verification print:
  1. Dry filament check (moisture = #1 non-obvious ooze cause).
  2. Enable prime tower; per-filament prime volumes.
  3. Verify bowden retraction override is SET (not nil) — #10404 guard.
  4. Manual aux K calibrated (link to the PA step targeting the aux nozzle).
  5. Developer-Mode anti-ooze params (ramming length, precool temp, post-ramming
     travel) for leaky pairings (PETG on aux).
  6. Idle-nozzle standby explanation (M104 S0 cycle) + advanced g-code note.
  - Result fields: prime tower on/off + volumes, aux retraction chosen, remaining
    ooze assessment (good/acceptable/bad), notes.
- Wire a TestController in `testForms.ts`; instructions for Bambu (+ a minimal Orca
  variant); add to step-order handling WITHOUT breaking existing projects
  (`stepOrder` migration must not inject it into legacy projects).

### 6. Profile wizard (`src/ui/profileWizard.ts`)
- Default `targetExtruderIndex` from the project's `nozzleIndex`.
- When the target is a bowden/aux nozzle on a Bambu dual-nozzle preset:
  - patch `filament_retraction_length` at the aux index (existing per-index machinery)
    and surface the #10404 note;
  - note that PA/K for Bambu printers lives on the printer (gear "Off" caveat) even
    though the preset field is patched for completeness.

### 7. Tests
- ranges: aux nozzle PA/retraction suggestions; template sanity.
- backup: round-trip of nozzles/nozzleIndex; legacy import unaffected.
- generator: aux-index default from project nozzleIndex (fixture:
  bambu-user-full-pctg-dualnozzle.json).
- data: ooze-control step has a controller + slicer instructions (the
  Record<CalibrationId, ...> types enforce most of this at compile time).

## Order of work
1. Data model + backup migration (foundation).
2. Ranges + printer template.
3. slicers.ts content + calibrations.ts ooze-control + testForms controller.
4. Profile wizard integration.
5. Full suite + build + review pass; CHANGELOG + README.

Out of scope (for now): talking to the printer (K cannot be pushed via API by this
app), auto-detecting the X2D from Bambu Studio configs, VFA scoring step.
