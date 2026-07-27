# Automated Calibration Pipeline — Architecture

> **Status: REMOVED before 2.0.0. This document is upstream history, kept for
> reference — it does not describe anything this fork ships.**
>
> Everything below was inherited from the upstream project and deleted from this
> fork before its first release. The UI path never shipped; the backing Rust
> modules (`engine.rs`, `preset_resolver.rs`, `project_assembly.rs`), their eight
> IPC commands, and the TypeScript engine layer (`engineBridge.ts`,
> `engineRegistry.ts`, `capabilities.ts`, `printerMapping.ts`,
> `projectPreparation.ts`, `orcaProjectConfig.ts`, `assets.ts`, `engines/`) were
> removed too. Any file path or command named below no longer exists here.
>
> **Why it went, and the hazard to meet before reviving it**, are recorded in
> [X2D_ENHANCEMENT_PLAN.md](X2D_ENHANCEMENT_PLAN.md) under "Known hazard if
> slicing is ever wired up" — read that first. In short: the pipeline assembled
> its project from the slicer's own calibration template, so the g-code it
> produced described the template's machine and not the user's, and the config
> merge feeding it applied no value limits at all.
>
> It could also never have run on the printers this fork exists for: the
> capability check refused every nozzle on a multi-nozzle machine, and it drove
> OrcaSlicer only, while Bambu Studio is a hand-off destination by upstream's
> own design.

## Goal

Let PerfectFit manage a whole calibration session: the user picks a printer,
nozzle, slicer workflow, and base filament profile, and PerfectFit prepares and
slices each calibration test itself — so the user no longer hand-drives the
slicer for every test. The user still prints, measures, and enters results, and
PerfectFit **never** starts a print on its own.

This does not replace the manual workflow; it adds an automated path alongside
it. Users without a compatible slicing engine keep the manual experience.

## Non-goals / boundaries

- Do **not** embed OrcaSlicer's UI or copy its source. Orca is driven only as an
  external executable over CLI arguments and files.
- Do **not** reverse-engineer Bambu Cloud or Bambu network protocols. Bambu
  Studio is a manual handoff destination only.
- Do **not** start a physical printer, or label an unsliced 3MF "printer-ready".
- Do **not** silently overwrite user slicer profiles or edit vendor/system
  presets.

## Core strategy: assemble a complete Orca project 3MF

A complete OrcaSlicer **project 3MF** embeds everything needed to slice with no
external preset files:

- `Metadata/project_settings.config` — a **flat, fully-resolved** settings object
  (no `inherits`).
- `Metadata/custom_gcode_per_layer.xml` — optional per-layer injected G-code used
  by parameterized tests (e.g. the pressure-advance pattern).
- `3D/3dmodel.model` — the calibration model geometry.

PerfectFit assembles such a project (calibration model + a `project_settings.config`
that merges the resolved printer/process settings with the session's calibrated
filament values + any test-specific custom G-code) and slices it via the CLI:

```
orca-slicer.exe --datadir <isolated> --outputdir <out> --slice 0 <project.3mf>
```

This mirrors what Orca's own Calibration menu produces internally, so we reuse
Orca's model instead of reverse-engineering an opaque CLI. Preset marshalling
via `--load-settings`/`--load-filaments` is **not** the primary path.

### Verified engine constraints (OrcaSlicer 2.4.2, Windows)

- **Slicing works headless.** A self-contained project 3MF slices to
  `<outputdir>/plate_1.gcode`, exit code 0, with no console.
- **CLI stdout/stderr is uncapturable.** Orca reroutes CLI output to an attached
  console (`CONOUT$`), bypassing inherited pipes — capture via pipe, file
  redirect, and PowerShell all yield nothing. **Success is judged from the
  output artifact and Orca's log at `<datadir>/log/`, never from stdout.**
- **Always use an isolated `--datadir`.** This gives readable logs and, critically,
  never touches the user's real Orca configuration (`%APPDATA%/OrcaSlicer/`).

## Key architectural interfaces

Defined in [`src/automatedCalibration/types.ts`](../src/automatedCalibration/types.ts):

- **`SlicingEngine`** — pluggable slicing backend. Planned implementations:
  `ManagedOrcaEngine`, `InstalledOrcaEngine`, `ManualExportEngine`,
  `BambuStudioHandoff`. Engines are **not** responsible for printer
  communication.
- **`PrintDestination`** — where a prepared/sliced job goes, kept separate from
  slicing. Initial: `SaveToFileDestination`, `OpenInInstalledSlicerDestination`.
  Future extension points: Moonraker, OctoPrint, PrusaLink.
- **`TemporaryCalibrationProfile`** — a working filament profile a session
  mutates as results arrive, tracking value provenance (base profile vs.
  material default vs. user input vs. calibration result). Normalized PerfectFit
  keys; slicer-specific mapping stays in `src/slicerIntegration/adapters`.
- **`CalibrationStepDefinition`** — the dependency-aware step model the workflow
  engine builds on top of the instructional content in
  `src/data/calibrations.ts`.
- **`CalibrationAssetDefinition`** — licensed, versioned, checksummed calibration
  model/registry entry (bundled, downloaded, or user-provided).

### Engine layer (Stage 5)

Two engines implement `SlicingEngine` so far:

- **`ManualExportEngine`** — always available, needs no external slicer. It
  reports export capability but **not** slice capability; `slice()` returns a
  deliberately not-sliced job (never a fake "printer-ready" one). This is the
  guaranteed fallback for browser builds and users without Orca.
- **`InstalledOrcaEngine`** — drives an OrcaSlicer install the user already has
  (auto-detected, or an executable they select manually) as an external process.

Discovery, validation, and slicing are delegated to native Tauri commands in
[`src-tauri/src/slicer_integration/engine.rs`](../src-tauri/src/slicer_integration/engine.rs):

- **Capability validation is by structure, not name.** An executable is trusted
  as a slicing engine only when it ships `resources/calib` and `resources/profiles`
  beside it — the assets the pipeline depends on — so a mis-named or unrelated
  binary is rejected rather than name-trusted.
- **A tamper-evident engine manifest** (id, executable path, version, sha256
  checksum, capabilities) is written under a PerfectFit-managed root. The slice
  runner launches only the manifest-vetted binary; the frontend never passes a
  raw executable path.
- **The process runner** captures exit code and duration, enforces a timeout,
  honors a cancellation token, and always reaps the child — but **never captures
  stdout**. Success is judged from the output artifact (present, non-empty) and
  the engine's `<datadir>/log/`.
- **Isolated per-job paths.** The frontend passes validated session/job ids, and
  the runner resolves them to `sessions/<id>/jobs/<id>/{workspace,datadir,out}`
  under the managed root — never touching the user's real Orca configuration.

`discoverEngines()` summarizes engine status (detected / valid / capabilities /
recommended engine) for the diagnostics screen; the rendered panel lands with
the Stage 7 UX (a visible screen now would be dead code while the flag is off).

### Project generation (Stage 6)

PerfectFit turns a shipped calibration project into one carrying the session's
calibrated values by assembling a complete project 3mf:

- **Config merge (pure TS,
  [`orcaProjectConfig.ts`](../src/automatedCalibration/orcaProjectConfig.ts)).**
  Parses the template's flat `project_settings.config`, overwrites only the
  calibrated filament keys (reusing the profile installer's verified
  calibration→Orca-key mapping and array-of-strings semantics), and serializes
  it back with the template's key order preserved. Every other setting stays
  byte-for-byte.
- **Assembly (native,
  [`project_assembly.rs`](../src-tauri/src/slicer_integration/project_assembly.rs)).**
  `read_project_config` extracts the template's config for the merge;
  `assemble_calibration_project` copies the template 3mf and swaps in the merged
  config, writing `project.3mf` into the job workspace. Only the one config
  entry changes; the model, per-layer custom g-code, and relationships are
  preserved. The source template is confined to the vetted engine's own
  `resources/` (a calibration model always comes from the user's install).
- **Verified end-to-end on real Orca (2.4.2, Windows).** An assembled, modified
  `pa_pattern` project slices headless to a 94 KB `plate_1.gcode`, exit 0.

Support is narrow in this increment: steps whose asset is already a complete
project (`project-template`, e.g. the pressure-advance pattern). Bare-model
steps (temperature/flow towers) need parameterized project generation.

**Printer preset resolution
([`preset_resolver.rs`](../src-tauri/src/slicer_integration/preset_resolver.rs)).**
An arbitrary printer's settings are resolved from Orca's own vendor profiles by
walking the `inherits` chains under `resources/profiles/<Vendor>/{machine,
process,filament}/`. Parents are vendor-local (every vendor ships its own base
presets), so resolution is a bounded single-vendor index-and-walk; each chain is
merged child-overrides-parent, and the three resolved objects combine into one
flat `project_settings.config`. Verified on the live install: resolving a Bambu
X1 Carbon selection yields that printer's config (364 keys, correct
`printer_model`/`nozzle_diameter`), and Orca slices a project built from it
(117 KB `plate_1.gcode`, exit 0 — distinct from the N1 template's output).

A PerfectFit printer selection is mapped to those exact preset names by
[`printerMapping.ts`](../src/automatedCalibration/printerMapping.ts): a
PerfectFit printer's `model` equals Orca's machine `printer_model`, so the
native `list_installed_machines` index is matched on model + nozzle to the
machine leaf, whose `default_print_profile` gives the process
(`InstalledOrcaEngine.resolveForPrinter(selection, filamentName)`). Filament is
a **separate selection**: Orca machine leaves carry no default filament, and in
a calibration the material is the thing being tuned, so the caller supplies the
filament preset. What remains for a full guided session is the material →
filament-preset choice and the Stage 7 UX around it.

### Relationship to existing code

The automated session **extends the existing `CalibrationProject`** — it is not a
parallel entity. `AutomatedSessionExtension` documents the (all-optional) fields
that will fold into `CalibrationProject` when the storage schema is migrated.
Session state lives in IndexedDB like the rest of the app; only slicer working
directories and sliced artifacts live on the filesystem.

## Expected filesystem layout (engine + jobs)

Documented here; the engine manager that creates it is implemented in a later
stage. Everything lives under an application-managed root, isolated per session
and per job:

```
<app-data>/perfectfit/
  engines/
    managed-orca/
      manifest.json            # engine id, upstream version, checksum, capabilities
      bin/…                    # the managed Orca executable (optional feature)
  sessions/
    <sessionId>/
      jobs/
        <jobId>/
          workspace/           # staged model + assembled project.3mf + manifest
          datadir/             # isolated Orca --datadir (config + log/)
          out/                 # sliced artifacts (plate_1.gcode, …)
```

No Orca executable is bundled in the repository. The managed engine is an
optional, separately-packaged component added in a later stage.

## Staged delivery

Built on a long-running `feature/automated-calibration` branch (never on `main`
until complete). Each stage keeps the app buildable, keeps existing tests green,
and leaves the automated behavior disabled until it is ready.

| Stage | Focus |
|-------|-------|
| 0 | Orca CLI spike (throwaway) — proved headless slicing viability |
| 1 | Repository audit + architectural contracts + disabled flag (this document) |
| 2 | Durable sessions + temporary profiles (extend `CalibrationProject`) |
| 3 | Workflow registry + result inheritance / stale-job invalidation |
| 4 | Calibration asset registry + project preparation (unsliced workspace) |
| 5 | Engine discovery/validation + safe process runner |
| 6 | Orca project generation + automated slicing MVP (narrow support matrix) |
| 7 | End-to-end guided automated session UX |
| 8 | Finish Calibration — profile export/install (wraps the verified installer) |
| 9 | Optional managed Orca engine + packaging + third-party notices |
| 10 | Hardening, compatibility matrix, docs, beta prep |

## Licensing note

OrcaSlicer is AGPL-3.0; PerfectFit is AGPL-3.0-only. Driving Orca as a separate
executable keeps a bundled engine "mere aggregation" rather than a derivative
work. Distributing or downloading the Orca binary still obliges PerfectFit to
provide the pinned version's corresponding source and AGPL notices. Third-party
licensing/attribution artifacts are added in Stage 9 and **must be reviewed by
the project owner before any public distribution** — nothing here constitutes
verified legal advice.
