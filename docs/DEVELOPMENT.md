# Development

Build, test, architecture, printer-database, hosting, desktop-packaging and model-licensing notes
for Trim. The user-facing documentation is in [README.md](../README.md).

## Requirements

- Node.js — CI builds releases on **22** and the Docker image builds on **24**. There is no
  `engines` field in `package.json`, so older versions may work; they are not tested.
- Rust (stable, ≥ 1.77.2), only if you build the desktop app — see
  [Packaging as a desktop app](#packaging-as-a-desktop-app-tauri).

## Run

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

Both suites gate the release: they run in CI on **every** platform that produces a binary, and they
run **before** anything is packaged, so a change that breaks either one cannot be built into an
installer — see [`.github/workflows/release.yml`](../.github/workflows/release.yml). The same
workflow asserts that the version agrees across `package.json`, `Cargo.toml` and `tauri.conf.json`,
and that the committed printer database is up to date.

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

CI proves the logic; a human proves the install. A human-workflow checklist lives in
[MANUAL_TEST_CHECKLIST.md](MANUAL_TEST_CHECKLIST.md).

## Production build

```bash
npm run build        # typechecks, then bundles to dist/
npm run preview      # serve the production bundle locally
```

`dist/` is fully static and uses relative paths — it works from any folder or subpath.

## Architecture

```
src/
  types.ts               # all domain types
  app.ts / main.ts       # shell, hash router, theme, leave-guard
  styles.css             # design system (light/dark, large text, print)
  data/
    calibrations.ts      # the 10 test definitions + verification categories
    slicers.ts           # version-aware slicer instructions (Orca 2.4.x, Bambu 1.7+)
    materials.ts         # 14 material presets (suggestions only, always editable)
    printerDatabase.ts   # lookup and refresh over printers.json
    printers.json        # generated printer specs (379 machines) — never hand-edited
    glossary.ts          # searchable help content
    models.ts            # external model manifest (5 entries; public/models/manifest.json
                         #   carries 3 — see Model licensing)
  logic/
    formulas.ts          # formula engine — every calc returns inputs/formula/result/warnings
    ranges.ts            # suggested ranges from material + printer + the NOZZLE's feed path
    validation.ts        # numeric/range/printer-limit checks, per-nozzle compatibility verdicts
    stepPlan.ts          # the project's own step order, incl. splicing the optional step
    confidence.ts        # confidence score
    recommendations.ts   # smart retest recommendations
  session/               # guided-session reasoning (pure, DOM-free): plan, per-nozzle
                         #   working profile, value provenance, staleness
  automatedCalibration/  # step workflow registry, dependency graph, per-nozzle working
                         #   profiles — the session depends on this (see "What was removed")
  slicerIntegration/     # detection registry, preset generation, slot resolution, diffing,
                         #   validation, and the desktop install bridge
  storage/               # IndexedDB wrapper + repository, drafts, settings
  export/backup.ts       # JSON export/import with schema versioning & migration
  ui/                    # dashboard, printers, project views, wizard, guided session,
                         #   forms, profile wizard, report, card…
src-tauri/               # Rust desktop shell: slicer detection, backup, atomic install
tests/                   # vitest suites
docs/                    # research notes, manual test checklist, screenshots
```

Adding a calibration test = new entry in `data/calibrations.ts` + a form controller in
`ui/testForms.ts` + slicer steps in `data/slicers.ts`. No page redesign needed.

## Updating the printer database

The Add Printer screen lets users pick from a database of known printers, which
auto-fills the machine specs (temperature limits, extruder type, build volume,
supported nozzle sizes, chamber, firmware…). That database is generated from a
human-editable spreadsheet and committed as JSON, so no build tooling or Excel
is needed at runtime.

**Source of truth:** [`Printer_Database/Printer_Database.xlsx`](../Printer_Database/Printer_Database.xlsx)
→ worksheet **`Printer Specifications`**.
**Runtime data:** [`src/data/printers.json`](../src/data/printers.json) (committed;
bundled into the app).
**Generator:** [`scripts/generate-printer-database.mjs`](../scripts/generate-printer-database.mjs)
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
  is preserved. The app never renders an unknown value as `0` — spec readouts show
  an em-dash and text surfaces say "not specified".
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

The database carries no per-nozzle field — an extruder count, not a nozzle list. Dual-nozzle
layouts are entered on the printer profile itself, or filled by the X2D quick-fill, and a profile
records for every spec whether it came from the database or was entered by hand.

## Hosting on Nginx

```nginx
server {
    listen 80;
    server_name calibration.example.lan;
    root /var/www/trim/dist;
    index index.html;
}
```

No SPA fallback is configured because none is needed: routing is hash-based and every asset path is
relative. Copy the contents of `dist/` to the `root` directory — nothing else is needed (no PHP, no
database). Apache works identically (`DocumentRoot` at `dist/`). Served over HTTP(S), the app also
installs as a PWA and works offline after first load.

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
The desktop shell **ships in this repository** — [`src-tauri/`](../src-tauri/) holds the Rust side,
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
across, and none needed to be: 2.0.0 was tagged but no release was ever published from it, so there
is nothing installed anywhere to migrate. A 2.0.0 build's data is not deleted either — the two
identities coexist, so 3.0.0 installs alongside rather than over it.

**Before changing the identifier again, read `APP_IDENTIFIER` in
[`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs).** On Windows and Linux that string decides where
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

## Model licensing

Orca Slicer generates most calibration tests in-slicer, so most steps need no model download. Two
do. **Shrinkage**: neither Orca nor Bambu Studio generates a shrinkage test, so all three of that
step's methods are external — a free calibration plate, a paid CaliFlower MK2, or a large object of
your own you can measure accurately. **Final verification**: a downloaded model or a part of your
own.

External models are **linked, not bundled**, because their licenses (e.g. CC BY-ND for 3DBenchy) do
not clearly permit redistribution inside an app. See
[public/models/manifest.json](../public/models/manifest.json) for the source, license and attribution
of each entry it carries. Note that the manifest lists three models and does not include the two
external shrinkage tools the shrinkage step links to, so it is not a complete inventory of every
third-party link the app can open.
