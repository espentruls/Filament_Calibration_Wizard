# Changelog

## 1.2.0 - Unreleased

Dual-nozzle (Bambu Lab X2D) support plus a round of bug fixes found while
reviewing the 1.1.3 profile installer. Research base for all X2D content:
[docs/X2D_ENHANCEMENT_PLAN.md](docs/X2D_ENHANCEMENT_PLAN.md) (verified
2026-07-20 against wiki.bambulab.com, forum.bambulab.com, and the
BambuStudio GitHub tracker).

### Added — Bambu Lab X2D / dual-nozzle support

- **Printer profiles can describe multiple physical nozzles** (label + feed path, optional speed/acceleration caps), with a one-click "Bambu Lab X2D" template: direct-drive main nozzle + bowden-fed auxiliary (200 mm/s / 1000 mm/s² caps), 300 °C max nozzle temperature.
- **Per-nozzle calibration projects.** On multi-nozzle printers the new-project flow asks which nozzle the project calibrates; the chosen nozzle is shown as a small badge next to the project name on the dashboard and project page.
- **Nozzle-aware test ranges.** A bowden-fed auxiliary nozzle gets the remote-extruder pressure-advance range (0–1, step 0.02 — typical aux K 0.5–1.0 vs 0–0.1 direct drive) and a 2–6 mm retraction suggestion starting at the 2 mm machine default in 0.5 mm steps, with an explicit warning about Bambu Studio bug #10404 (an unset "Bowden Extruder" override silently falls back to the 0.8 mm main default). Main-nozzle and single-nozzle projects keep their existing ranges.
- **New optional "Dual-Nozzle Ooze Control" step**, added automatically when a project calibrates the aux/bowden nozzle (legacy and main-nozzle projects are untouched): dry-filament check, prime tower + per-filament prime volumes, the #10404 override guard, a pointer to manual aux K calibration, the Developer-Mode ramming/precooling/post-ramming-travel parameters, the idle-nozzle standby explanation (Bambu Studio emits M104 S0 on toolchange; the reheat pressure spike causes the ooze), and the advanced note about holding ~160–180 °C via the change-filament G-code. Result entry records prime tower state, aux retraction, and a good/acceptable/bad ooze assessment.
- **Dual-nozzle Bambu Studio instructions**: the nozzle selector in the calibration dialogs, the fact that K values live ON the printer keyed to filament + nozzle (per AMS slot) while flow ratio lives in the preset, the pre-print calibration gear "Off" caveat for manual K, the warning that automatic K on eddy-current machines (X2D/H2D family) is intentionally higher than manual pattern K, Setting Overrides "Bowden Extruder" guidance for per-extruder preset arrays, and the aux constraints callout (200 mm/s, no flexibles, matching nozzle sizes, ~4 mm Z loss, supports-oriented).
- **Profile wizard**: the target tool for multi-extruder presets now defaults to the project's calibrated nozzle, and the preview surfaces the #10404 note plus the printer-side-K "gear Off" note when targeting the bowden/aux index of a Bambu preset.
- **Backup schema v3**: printer nozzle lists and project nozzle indexes survive export/import; legacy backups import unchanged (no ooze-control step is ever injected into an existing project's plan).

### Fixed

- **Bambu clones of user presets no longer fail validation.** The regenerated `filament_id` (introduced in 1.1.3 to un-hide clones) is now treated as an expected identity change instead of tripping the "unexpected change" installation blocker.
- **Companion values follow per-extruder targeting.** `enable_pressure_advance` was previously written to every extruder; on dual-nozzle presets the un-calibrated nozzle no longer silently gets pressure advance enabled.
- **Array padding is recorded honestly.** When a short per-extruder array is widened to the preset's extruder count without changing the target value, the change list now records the padded slot (before: none) instead of a fake before→after pair — and no longer trips the drift check.
- **Temperature-tower clamping keeps a usable range.** When a material's suggested tower exceeds the printer's max nozzle temperature, the clamped suggestion now keeps a ≥20 °C descending span instead of collapsing.
- **Import/migration defaults `stepOrder` and `steps`** for projects saved without them, instead of importing broken projects.
- **Profile wizard restarts cleanly after recalibration.** A finished install no longer shows a stale success screen when the project changed afterwards, and a "Create another profile" action was added.
- **TPU/flexible range fixes**: bowden + flexible now keeps the wide bowden PA band together with the flexible warning; a printer profile's saved retraction range can no longer push TPU past the flexible-safe cap, nor produce a descending range when the cap undercuts the profile's start.
- **Range validation counts float samples like the generator** (epsilon fix — 0→0.3 step 0.1 counts 4 samples, not 3).
- **Bambu Studio docs link** updated to the current wiki calibration page.

## 1.1.3 - 2026-07-20

Patch release fixing two profile-installer bugs found while using the 1.1.0
build with Bambu Studio. See [docs/RELEASE_NOTES_1.1.3.md](docs/RELEASE_NOTES_1.1.3.md).

### Fixed

- **Installed Bambu profiles now appear in the slicer.** In 1.1.0 a profile installed for a signed-in Bambu account was written correctly but never showed up in the filament list. Cause: when signed in, Bambu Studio dedupes filament presets by `filament_id`, so a clone that kept its parent's `filament_id` was hidden behind the cloud-synced parent it was cloned from. Confirmed directly in Bambu Studio 2.7.x — a copy with a fresh `filament_id` appears immediately; the colliding one never does. Fix: generated presets now get a fresh unique `filament_id`, and the `.info` `base_id` chains to the stock/system ancestor instead of a parent user preset's cloud id.
- **Baseline suggestions are now stock profiles compatible with the selected printer.** In 1.1.0 the "select a base profile" step suggested the user's own custom presets (some flagged as incompatible with the printer). It now recommends only stock (system) profiles — brand-name or generic — for the calibrated material that are compatible with the selected printer. User and incompatible-printer presets remain available under Advanced selection.

### Notes for existing users

- Reinstall this build for the fixes to take effect (the fix applies to newly generated profiles).
- A profile installed by 1.1.0 into a signed-in Bambu account is stuck in Bambu's cloud with the colliding id; editing local files won't unhide it. Remove it in Bambu Studio: select the preset, open it for editing (the edit/pencil icon opens the Filament settings dialog), and click the small **'X' (delete) icon in the upper-right of that edit dialog** — this removes it from your cloud sync. Then re-run "Create Slicer Profile" — your calibration data is preserved in PerfectFit.

## 1.1.0 - 2026-07-19

See [docs/RELEASE_NOTES_1.1.0.md](docs/RELEASE_NOTES_1.1.0.md) for the full release notes.

### Added

- Linux desktop release packaging via `.deb` and AppImage artifacts.
- Experimental slicer profile generation and direct install workflows for supported Orca-family slicers.
- Bambu Studio Developer mode guidance for manual calibration tests with Bambu printers selected.
- Regression tests covering Bambu Developer mode instructions, coarse/fine Flow Rate wording, and VFA mention.

### Changed

- Release workflow now builds Windows, macOS, and Linux artifacts into draft GitHub releases.
- README and research notes now document Bambu Developer mode availability for Retraction, Max Flow Rate, and VFA.

### Known limitations

- Linux packages are generated, but Linux native slicer detection/install behavior is not yet verified.
- macOS native slicer detection/install behavior remains export-oriented pending real-machine verification.
