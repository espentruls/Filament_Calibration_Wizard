# Automated Calibration Pipeline — Architecture

> **Status: in development, disabled by default.** This document describes the
> architecture of PerfectFit's automated calibration pipeline as it is built out
> across multiple stages. The feature is gated behind the
> `automatedCalibration` experimental flag, which is **off** until the pipeline
> is complete. The existing manual calibration workflow and the slicer-profile
> installer are unaffected.

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
