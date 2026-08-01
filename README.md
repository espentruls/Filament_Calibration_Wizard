# Trim: Filament Calibration

Create a calibrated filament profile for Orca Slicer or Bambu Studio in one guided workflow, on
single-nozzle, dual-nozzle and multi-nozzle printers. No tutorials, no guesswork, no spreadsheets.

> **The name.** In aviation, trimming is adjusting the controls so the aircraft holds steady
> without constant correction — which is exactly what calibrating a filament profile does. The app
> was called *PerfectFit X2D* up to version 2.0.0; the X2D suggested one printer, and it works with
> any of them. See [CHANGELOG.md](CHANGELOG.md) for what the 3.0.0 rename means for existing data.

> **This is a fork.** Trim builds on
> [PerfectFit](https://github.com/tayloraaron078-tech/Filament_Calibration_Wizard) by Aaron Taylor
> and adds per-nozzle calibration. It ships under its own product name and bundle
> identifier, so it installs **alongside** upstream rather than over it and keeps a separate data
> store. Every download link, issue link, and install guide in this repository refers to this fork;
> upstream is credited, not linked as a download.

<img width="1148" height="1007" alt="Hero" src="https://github.com/user-attachments/assets/f56b6877-6558-460a-9df0-097523c63046" />

A local-first web app that walks you step by step through calibrating a filament profile
for **Orca Slicer** (default) or **Bambu Studio** — temperature, flow ratio (two passes),
pressure advance, retraction, max volumetric speed, and a final verification print —
without tutorials, wikis, or guesswork.

- **Coach Mode**: plain-language guidance, good/bad examples, "I'm not sure" decision helpers,
  confidence checks, adaptive troubleshooting.
- **Expert Mode**: condensed flow — ranges, formulas, destinations.
- **No black boxes**: every calculation shows inputs, formula, substitution, and rounding.
- **Signature features**: calibration timeline, confidence score, smart retest recommendations,
  printable one-page calibration card with QR, printable full report, JSON backup/restore.
- **Per-nozzle calibration** — the thing that distinguishes Trim. Printer profiles describe as many
  nozzles as the machine has: one on a single-nozzle printer, two on a Bambu Lab X2D, more on an
  H2D or H2C. Each project calibrates one specific nozzle, and its ranges follow that nozzle's feed
  path, so a bowden-fed auxiliary gets its own PA/retraction ranges instead of direct-drive numbers,
  and aux projects get a dedicated ooze-control step. The X2D layout is the one this has been used
  on; H2D and H2C are modelled from published specifications and untested on the actual machines.
- **Guided session**: one screen per test — the exact settings to change in your slicer, then print
  and measure. Results carry forward (pressure advance runs at the temperature and flow you already
  measured), and every pre-filled number shows where it came from. The classic step-by-step wizard
  is untouched and reachable from every step.
- **Slicer preset generation & installation**: builds an Orca/Bambu filament preset from your
  measured values. The browser build downloads a `.json` for manual import; the desktop build can
  write it directly into your slicer's user preset directory. This edits your real preset library —
  see [Known limitations](#known-limitations) for exactly what it touches and how to switch it off.
- **Privacy**: no account, no backend, no analytics/telemetry. Your calibration data (photos
  included) stays in browser storage on this device. The desktop build additionally writes — only
  when you ask it to — a filament preset into your slicer's user preset directory, plus the backup
  it takes of the affected files first, under the app's own data folder. External model links open
  third-party sites.

<img width="1102" height="831" alt="Create Project" src="https://github.com/user-attachments/assets/36fc37fd-c053-4746-814b-48919f965853" />

## Requirements

- Node.js 18+ (for development/build only — the built web app is static files)
- Rust (stable, ≥ 1.77.2) only if you build the desktop app — see
  [Packaging as a desktop app](#packaging-as-a-desktop-app-tauri)

## Install & run (development)

```bash
npm install
npm run dev          # http://localhost:5173
```

## Tests

```bash
npm test                                          # vitest — formulas, ranges, validation,
                                                  #   import/export, migration, slicer integration
cargo test --manifest-path src-tauri/Cargo.toml   # Rust — preset installer, backups, path safety
```

Both suites gate the release: they run in CI on **every** platform that produces a binary, and
they run **before** anything is packaged, so a change that breaks either one cannot be built into
an installer — see [`.github/workflows/release.yml`](.github/workflows/release.yml).

**What that gate does not cover.** Several Rust tests are marked `#[ignore]` and therefore never
run in CI — and they are precisely the ones that exercise the real filesystem against a genuine
slicer installation:

- the supervised install/restore harness (`manual_install_from_env`, `manual_restore_from_env`),
  which drives the production install and restore code against a real preset directory supplied
  through environment variables;
- the `probe_real_*` probes, which read an installed slicer's own configuration rather than a
  temporary directory built by the test.

So the paths that write into your slicer are covered in CI by unit tests over temporary
directories, and against a real install only by tests a human has to run deliberately:

```bash
# needs a real slicer installed; the manual_* tests also need the env vars
# documented in the comment above them in src-tauri/src/slicer_integration/install.rs
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored
```

Treat that as the honest boundary: CI proves the logic, a human proves the install. A
human-workflow checklist lives in [docs/MANUAL_TEST_CHECKLIST.md](docs/MANUAL_TEST_CHECKLIST.md).

<img width="1103" height="835" alt="Wizard Page" src="https://github.com/user-attachments/assets/6ed5ee39-3db5-4761-bfb9-c39a10259c3d" />

## Production build

```bash
npm run build        # typechecks, then bundles to dist/
npm run preview      # serve the production bundle locally
```

`dist/` is fully static and uses relative paths — it works from any folder or subpath.

## Updating the Printer Database

The Add Printer screen lets users pick from a database of known printers, which
auto-fills the machine specs (temperature limits, extruder type, build volume,
supported nozzle sizes, chamber, firmware…). That database is generated from a
human-editable spreadsheet and committed as JSON, so no build tooling or Excel
is needed at runtime.

**Source of truth:** [`Printer_Database/Printer_Database.xlsx`](Printer_Database/Printer_Database.xlsx)
→ worksheet **`Printer Specifications`**.
**Runtime data:** [`src/data/printers.json`](src/data/printers.json) (committed;
bundled into the app).
**Generator:** [`scripts/generate-printer-database.mjs`](scripts/generate-printer-database.mjs)
(plain Node, no dependencies — works on Windows, macOS, Linux, and CI).

To add or change a printer:

1. Open `Printer_Database/Printer_Database.xlsx`.
2. Add or edit a row on the **Printer Specifications** sheet. Keep the existing
   column order (see below). The `Data Sources` sheet is provenance only and is
   ignored by the generator.
3. Save the workbook.
4. Regenerate the runtime data and review the printed warnings:
   ```bash
   npm run generate:printers
   ```
5. Run the tests:
   ```bash
   npm test
   ```
6. Commit **both** the workbook and `src/data/printers.json`. The next release
   build picks them up automatically — CI does not regenerate the JSON, so the
   committed file is what ships.

Validate without changing the committed file (used in CI / pre-release):

```bash
npm run validate:printers   # exits non-zero if printers.json is stale
```

### Column reference

| Column | Field | Notes |
| --- | --- | --- |
| Manufacturer | required | brand |
| Printer Model | required | may include the brand prefix; the id de-duplicates it |
| Technology | optional | e.g. FFF |
| Extruder Type | optional | `Direct Drive` → `direct-drive`, `Bowden` → `bowden`, mixed → `mixed` |
| Max Nozzle/Bed/Chamber Temp (C) | optional | numbers |
| Heated Chamber | optional | `Yes`/`No` → boolean; blank → unknown |
| Max Volumetric Flow (mm3/s) | optional | number |
| Default Nozzle Diameter (mm) | optional | number |
| Supported Nozzle Sizes (mm) | optional | comma list, e.g. `0.2, 0.4, 0.6`; suffixes like `0.4HS` and `0.4+0.6` are read as their diameters |
| Build Volume X/Y/Z (mm) | optional | numbers |
| Max Print Speed / Acceleration | optional | numbers |
| Firmware, Number of Extruders, AMS/MMU Compatibility, Release Year, Profile Source, Source File, Notes | optional | passed through |

**Rules the generator enforces:**

- **Blank vs. unknown:** empty cells become `null` (or are omitted). A real `0`
  is preserved. The app renders unknown values as “Not specified”, never `0`.
- **Duplicates:** rows with the same manufacturer + model are flagged as
  warnings and each is kept with a distinct id (`…-2`, `…-3`).
- **Empty rows** are skipped; **rows with data but no manufacturer/model** are
  reported as warnings, never silently dropped.
- **IDs** are stable, readable slugs derived from manufacturer + model
  (`bambu-lab-x1-carbon`, `creality-ender-3-v3-ke`), with collision suffixing.
  Never rename an id when you edit a row’s other fields — saved user printers
  reference it. For a **renamed or discontinued** model, keep the row (and its
  id) and note the change in the Notes column rather than deleting it, so
  existing profiles keep their database link.
- Output is **deterministic** (sorted, no timestamp) so regeneration produces a
  clean diff.

## Hosting on Nginx

```nginx
server {
    listen 80;
    server_name calibration.example.lan;
    root /var/www/trim/dist;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Copy the contents of `dist/` to the `root` directory — nothing else is needed
(no PHP, no database). Apache works identically (`DocumentRoot` at `dist/`).
Served over HTTP(S), the app also installs as a PWA and works offline after first load.

> Data is stored per-browser (IndexedDB + localStorage) under the origin you serve from.
> Moving the app to a different domain/port means starting fresh — export a backup first
> and restore it from Settings.

## Docker

The repository ships a `Dockerfile` and an `example-docker-compose.yaml` for
running the app as a container. The image is a multi-stage build: Node builds
the static bundle, which is then served by a tiny BusyBox `httpd` — no Node,
backend, or database in the runtime layer.

```bash
docker build -t trim:latest .
docker run -d -p 8080:80 --name trim trim:latest   # http://localhost:8080
```

`example-docker-compose.yaml` is a sample stack for reverse-proxying the
container behind [Traefik](https://traefik.io/) with automatic Let's Encrypt
TLS. Adjust the `Host(...)` rule, network, and image name to match your setup.
Because the app uses hash-based routing and relative paths, the static server
needs no SPA-fallback configuration.

> The same per-origin storage note from the Nginx section applies: data lives
> in the browser under the origin you serve from.

## Packaging as a desktop app (Tauri)

Tauri v2 wraps the static build in a small native shell (preferred over Electron: ~10 MB vs ~150 MB).
The desktop shell **ships in this repository** — [`src-tauri/`](src-tauri/) holds the Rust side,
including the slicer preset installer — so there is nothing to initialise. Do **not** run
`tauri init`: it would overwrite the shipped configuration.

```bash
# prerequisites: Rust toolchain (rustup) plus the OS-specific Tauri prerequisites
# for Windows, macOS, or Linux
npm install
npm run tauri dev      # develop inside the native window
npm run tauri build    # native app plus the bundles configured for the current OS
```

`src-tauri/tauri.conf.json` carries this fork's identity — product name **Trim**, bundle identifier
`io.github.espentruls.trim` — which is why it installs alongside upstream PerfectFit instead of on
top of it, and why the two do not share a data store.

The identifier changed in 3.0.0 (it was `io.github.espentruls.perfectfit-x2d`). No data is carried
across, and none needed to be: 2.0.0 was published but never installed by anyone. A 2.0.0 build's
data is not deleted either — the two identities coexist, so 3.0.0 installs alongside rather than
over it.

**Before changing the identifier again, read `APP_IDENTIFIER` in
[`src-tauri/src/lib.rs`](src-tauri/src/lib.rs).** On Windows and Linux that string decides where
*all* of the app's data lives, not just its caches: Tauri forces the webview's data directory to
`LocalData/<identifier>`, so `%LOCALAPPDATA%\<identifier>\EBWebView\Default` holds the IndexedDB
and localStorage behind every project, printer, photo and setting, while `{app data}/<identifier>`
holds the slicer preset backups. The IndexedDB origin (`http://tauri.localhost`) does not depend on
the identifier, so the stores are portable — but nothing moves them. The next identifier change
needs a data migration shipped with it.

The frontend itself needs no changes for the desktop build: it avoids absolute URLs and needs no
server. Inside Tauri, calibration data persists in the WebView's storage; the JSON backup/restore in
Settings is the supported migration path between browser and desktop builds, and between upstream
PerfectFit and this fork.

## Data storage & backups

| What | Where |
|---|---|
| Projects, printer profiles, photos | IndexedDB (`perfectfit-db`) |
| Settings, in-progress form drafts | localStorage |
| Backups | JSON files you export (Settings → Backup) |
| Slicer preset backups (desktop build only) | `{app data}/slicer-backups/{slicer}/{backup id}/` — e.g. `%APPDATA%\io.github.espentruls.trim\slicer-backups\` on Windows. Written automatically before any preset install, restorable from Settings → *Slicer profile backups*. |

- **Backup**: Settings → *Export all data* (optionally with photos, base64-embedded).
- **Restore**: Settings → *Restore from backup*. Imports never overwrite: colliding ids
  are imported as copies.
- Single projects can be exported/imported from the dashboard (printer profile embedded).
- Clearing browser site data deletes everything — back up first.

## Model licensing

Orca Slicer generates **all six core calibration tests in-slicer** — no model downloads are
required. Optional external models (3DBenchy for verification; stringing/extrusion tests for
fallback-model gaps) are **linked, not bundled**, because their licenses (e.g. CC BY-ND for
3DBenchy) don't clearly permit redistribution inside an app. See
[public/models/manifest.json](public/models/manifest.json) for source, license, and attribution
of each entry.

## Slicer version compatibility

Instructions are **version-aware data**, not code: `src/data/slicers.ts` holds per-slicer,
per-version content with a `verifiedOn` date (currently: Orca Slicer **2.4.x** and Bambu Studio
**1.7+**, both verified 2026-07-23 against the official wikis). Updating for a new release
means editing/adding one data entry. Research notes with sources and verified formulas:
[docs/RESEARCH.md](docs/RESEARCH.md).

**Assumptions worth re-verifying when a new slicer version ships:**
- Calibration menu still at top bar → `Calibration` (Orca) / `Calibration` tab plus the Develop Mode title-bar menu (Bambu Studio)
- Menu entry labels still differ per slicer: Orca `Flow ratio` / `Retraction` / top-level `Max flowrate` vs Bambu `Flow rate` ▸ Coarse-Fine / `Retraction test` / `More...` ▸ `Max flowrate`
- Temp tower still steps 5 °C per block; retraction/PA towers still step once per mm of height
- Flow YOLO modifiers still ±0.05 @ 0.01; Pass 2 still −9…0%
- Bambu Studio Developer mode exposes retraction, Max flowrate, and VFA calibration while a Bambu printer is selected

## Architecture

```
src/
  types.ts               # all domain types
  app.ts / main.ts       # shell, hash router, theme, leave-guard
  styles.css             # design system (light/dark, large text, print)
  data/
    calibrations.ts      # test definitions (core tests + optional dual-nozzle ooze control)
    slicers.ts           # version-aware slicer instructions (Orca 2.4.x, Bambu 1.7+)
    materials.ts         # 14 material presets (suggestions only, always editable)
    glossary.ts          # searchable help content
    models.ts            # external model manifest (mirrored in public/models/)
  logic/
    formulas.ts          # formula engine — every calc returns inputs/formula/result/warnings
    ranges.ts            # suggested test ranges from material+printer+extruder
    validation.ts        # numeric/range/printer-limit validation
    confidence.ts        # confidence score
    recommendations.ts   # smart retest recommendations
  session/               # guided-session reasoning (pure, DOM-free): plan, per-nozzle
                         #   working profile, value provenance, staleness
  slicerIntegration/     # preset generation, diffing, and the desktop install bridge
  storage/               # IndexedDB wrapper + repository, drafts, settings
  export/backup.ts       # JSON export/import with schema versioning & migration
  ui/                    # dashboard, printers, project views, wizard, guided session,
                         #   forms, profile wizard, report, card…
src-tauri/               # Rust desktop shell: slicer detection, backup, atomic install
tests/                   # vitest suites
docs/                    # research notes + manual test checklist
```

Adding a calibration test = new entry in `data/calibrations.ts` + a form controller in
`ui/testForms.ts` + slicer steps in `data/slicers.ts`. No page redesign needed.

## Known limitations

What the app does *not* do, and the caveats on what it does. The preset entry is here because it is
the one feature that writes outside the app's own storage — read it before you let it run.

- The QR code on the calibration card links to the app URL + project id — it opens the saved
  calibration on any device pointed at the **same hosted instance & browser profile**; it does
  not embed the data itself (the printed card carries the values in plain text).
- **Slicer profile generation and installation (experimental, on by default) edits your real
  preset library.** From a project with calibrated values, Trim builds an Orca/Bambu
  filament preset from your results.
  In the browser build it downloads a `.json` preset for manual import. In the desktop (Tauri)
  build it can install directly into your slicer's user preset directory (e.g.
  `%APPDATA%\OrcaSlicer\user\<account>\filament\`) on slicer versions verified for direct
  install: it backs up the affected files first, writes to a temp file, verifies, atomically
  moves it into place, re-verifies, refuses to run while the slicer is open, and will not
  replace an existing preset unless you explicitly confirm replacement (backups are restorable
  from the app). Preset formats are version-volatile, so support is verified per slicer
  version — and, today, on **Windows only**: every entry in the verified-version registry is
  Windows-verified, so on macOS and Linux the wizard reports direct install as unverified and
  points you at the export-and-import path instead. Both behaviours can be turned off in
  **Settings → Experimental features**
  (`Slicer profile generation`, `Automatic profile installation`).
- Photos are stored and exported but not analyzed (AI photo evaluation is a designed-for,
  not-built v1 exclusion, like accounts, cloud sync, and printer control).
- Bambu Studio Developer mode exposes retraction, Max flowrate, and VFA calibration while a Bambu printer is selected; external models remain fallback options
  rather than pretending.
- Orca's built-in calibration tests always target filament slot 1 and expose no extruder picker,
  so multi-tool printers need a manual filament reassignment — the wizard says so rather than
  pretending the limitation isn't there.
- Suggested ranges are conservative starting points, not guarantees — spool labels and
  datasheets always win.

### Troubleshooting

- **Linux: blank window on launch (Wayland).** If the app opens to an empty window and, when
  launched from a terminal, prints `Could not create default EGL display: EGL_BAD_PARAMETER`,
  start it with `WEBKIT_DISABLE_DMABUF_RENDERER=1` set — for example
  `WEBKIT_DISABLE_DMABUF_RENDERER=1 './Trim_<version>_amd64.AppImage'`, substituting the
  filename you actually downloaded (tab-completion will fill it in). WebKitGTK's DMABUF
  renderer fails to initialise EGL on some Wayland setups; this makes it fall back to a working
  path. The app sets the variable itself (unless you set it yourself), so this workaround should
  not be needed on this build — it is kept here for anyone running an older one.
- **Windows SmartScreen warns on the installer, and macOS may call the `.dmg` damaged.** The
  release binaries are **not code-signed** and the `.dmg` is **not notarized** — this project has no
  paid signing certificate. That is a missing signature, not a detection of anything. On Windows
  choose *More info → Run anyway*; on macOS see
  [Install on Mac.md](Install%20on%20Mac.md), or build from source with `npm run tauri build` if you
  would rather not rely on either.

<img width="1103" height="833" alt="Auto Results" src="https://github.com/user-attachments/assets/fa9ebd12-6d73-42b2-8d50-2e8a2825b278" />

## What the guided session does and does not do

The session-based experience shipped in **2.0.0**: it carries results forward between steps, shows
where every pre-filled number came from, and can install what has been measured so far as a filament
preset — see **Guided session** and **Slicer preset generation & installation** above.

It does **not** prepare the test prints for you. An earlier plan to have the app configure and slice
each calibration test automatically was **removed before release**: it could only ever have driven
OrcaSlicer, and a half-working path that silently produces the wrong test plate is worse than no path
at all. The removal went all the way down — the desktop commands it called are no longer registered
and the modules behind them are deleted, not merely left unreachable, so the unguarded project
assembly and config merge are not present in the installed app at all. The reasoning is preserved in
[docs/X2D_ENHANCEMENT_PLAN.md](docs/X2D_ENHANCEMENT_PLAN.md) as the condition on ever reviving it.
The session tells you exactly what to change and where, and you make the change. The app never talks
to your printer and never starts a print.

## Future ideas

AI-assisted photo evaluation (storage schema already reserves an `analysis` field), photo
comparison, multiple printers per filament (multiple nozzles per printer already ships — see
**Per-nozzle calibration** above), printer API integration,
community preset sharing, filament inventory with drying/spool tracking.

## License

Copyright (C) 2026 Aaron Taylor — original PerfectFit
Copyright (C) 2026 espentruls — Trim (fork of PerfectFit)

PerfectFit is free software: you can redistribute it and/or modify it under the terms of the
**GNU Affero General Public License, version 3** as published by the Free Software Foundation.
The full text is in [License](License).

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY —
without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
See the GNU Affero General Public License for more details.

**Why AGPL-3.0:** PerfectFit is built around the Orca-family slicers, and OrcaSlicer, PrusaSlicer,
and Slic3r are all AGPL-3.0. Matching that license keeps the project compatible with the ecosystem
it depends on — particularly as future releases integrate more deeply with the slicers themselves —
and guarantees the work stays open: anyone may use, modify, sell, or host PerfectFit, but
derivative works must remain open source under the same terms, including when offered over a
network.

Prior to version 1.3.1 the project used a custom non-commercial license (R3D-NC v1.0). That license
was incompatible with AGPL-3.0 code and has been retired. Releases up to and including 1.3.0 remain
available under their original terms.
