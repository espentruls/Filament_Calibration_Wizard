# Slicer Profile Research

Verified findings for the Trim profile generator/installer. Every claim below is
either **verified** (inspected on a real installation or in official sources, date noted)
or explicitly marked **unverified**. Do not promote unverified behavior into code
defaults.

Research method: direct read-only inspection of real installations on the development
machine (Windows 11 Pro, x64), including real user presets, system preset libraries,
`.conf` files, and `.info` sidecars. No slicer data was modified during research.

---

## Family overview

All five supported slicers are PrusaSlicer → BambuStudio → OrcaSlicer lineage forks and
share one user-data layout (verified 2026-07-19 on all five):

```
%APPDATA%\{SlicerFolder}\
  {SlicerFolder}.conf          JSON + trailing "# MD5 checksum <hex>" line
  system\                      vendor preset libraries (read-only to us)
    {Vendor}.json              vendor index: machine_model_list / process_list /
                               filament_list / machine_list (name + sub_path entries)
    {Vendor}\filament\*.json   full system presets
  user\
    {accountId}\               cloud-account-bound presets (numeric for Bambu,
                               UUID for Orca/Orca-Flashforge)
    default\                   local presets (no account)
      filament\*.json          user filament presets
      filament\*.info          sidecar metadata (see below)
      filament\base\           cached/derived vendor-library presets (treat as
                               read-only; classify separately from user presets)
      machine\  process\       other preset classes (out of scope)
```

### Active account directory (important)

`app.preset_folder` inside the `.conf` JSON names the **currently active** user
subdirectory. Empty string means `default`. Verified 2026-07-19:

| Slicer | `app.preset_folder` observed | Active dir |
|---|---|---|
| OrcaSlicer | `1f187aab-0335-47bc-9634-e0946f9f1726` | UUID dir |
| Bambu Studio | `3964423668` | numeric account dir |
| Snapmaker Orca | `""` | `default` |
| ElegooSlicer | `""` | `default` |
| Orca-Flashforge | `""` | `default` |

The `.conf` ends with a `# MD5 checksum` line. **We never write the `.conf`.** Reading:
strip everything from `# MD5 checksum` onward, parse the rest as JSON.

### User filament preset format (verified on all five, 2026-07-19)

JSON object. Two shapes observed:

1. **Delta preset** (Orca, Snapmaker, Elegoo, Flashforge — 12–19 keys): stores only
   overridden keys plus identity fields, and resolves the rest through `inherits`.
2. **Full snapshot** (Bambu Studio preset observed with 139 keys, `inherits: ""`):
   stores every filament key.

Common identity fields:

| Field | Meaning | Notes |
|---|---|---|
| `name` | preset display name | must match file stem |
| `from` | `"User"` for user presets, `"system"` for system presets | generated presets must use `"User"` |
| `inherits` | parent system preset name, or `""` | resolves against system vendor libraries |
| `version` | preset schema version, e.g. `2.3.1.20` | **copy from base profile**, do not invent |
| `filament_settings_id` | `[name]` (string array) | keep in sync with `name` |
| `compatible_printers` | array of printer preset names | optional in delta presets |
| `filament_type`, `filament_vendor` | material / vendor arrays | optional in delta presets |
| `filament_id` | short id (e.g. `P9e57294`) | seen on Bambu custom filament; clone from base when present |

All setting values are **arrays of strings**, one element per extruder:
`"nozzle_temperature": ["260", "260"]` on a dual-nozzle Bambu H2S preset,
`["220"]` on single-extruder machines. `"nil"` is a sentinel meaning "no
filament-level override" (e.g. `"filament_retraction_speed": ["nil", "nil"]`).
Percentages are strings like `"25%"`. **Array length must be preserved.**

### `.info` sidecar (verified on all five, 2026-07-19)

Plain text `key = value` lines:

```
sync_info = create | update | (empty)
user_id = (empty for local presets; account id for cloud-synced)
setting_id = (empty locally; cloud id once synced, e.g. PFUS… / UUID)
base_id = setting_id of the base system preset (e.g. GFSL99, OGFSG96_00)
updated_time = unix seconds
```

Observed patterns:
- Local-only preset (`default` dir): `sync_info = create` (or `update`), empty
  `user_id`/`setting_id`, `base_id` from the system base, `updated_time` set.
- Cloud-synced preset (account dir): `sync_info` empty, `user_id` = account id,
  `setting_id` = server-assigned id.

For generated presets we write: `sync_info = create`, empty `user_id` and
`setting_id`, `base_id` = the base system preset's `setting_id` when known (else
empty), `updated_time` = now. The slicer/cloud takes ownership from there.

### System presets (verified, OrcaSlicer 2026-07-19)

`from: "system"`, `instantiation: "true" | "false"` (non-instantiated presets are
abstract intermediate nodes like `fdm_filament_pla`), `filament_id` + `setting_id`
short codes. Inheritance chains resolve inside the vendor library
(user preset → `inherits` → system preset → `inherits` → abstract fdm profiles).
**System presets are never modified and never written.**

### Preset visibility / restart behavior

PrusaSlicer-lineage slicers enumerate `user/{active}/filament/*.json` at startup.
Writing a well-formed `.json` (+ `.info`) pair into the active user filament directory
makes the preset appear after restart. Status per slicer is tracked in
`docs/SLICER_PROFILE_TEST_MATRIX.md`; treat as **unverified per slicer until the manual
import + restart test has been run there.** No separate index/manifest/db file was found
that needs updating for user presets (the `.conf` checksum file does not reference
individual presets; `hints.cereal` is unrelated UI hint state).

Cloud caveat (Bambu Studio, OrcaSlicer with a logged-in account): the slicer may
later sync, duplicate, re-id, or delete local files in account dirs. We warn the user
and never claim cloud-sync behavior.

### filament_id dedup (Bambu, verified 2026-07-19 in Bambu Studio 2.7.x)

**A cloned preset MUST get a fresh unique `filament_id`.** When signed in, Bambu
Studio keys the filament dropdown by `filament_id`: if a local preset shares its
`filament_id` with a cloud-synced preset (e.g. the parent it was cloned from),
Bambu shows the synced parent and **hides the local clone entirely** — it never
appears in the filament list even though the file is valid, compatible, and in the
right directory. Proven directly: a clone that kept the parent's `filament_id` was
invisible; an otherwise-identical copy with a fresh `filament_id` appeared
immediately. Fix (`orcaFamily.cloneAndPatch`): assign a fresh `P`+7-hex id to every
clone whose base has a `filament_id`. Also, `base_id` in the `.info` must chain to
the **system** ancestor's `setting_id`, not a parent *user* preset's cloud id
(`PFUS…`), which similarly ties the clone to the parent.

Corollary: this must happen at **generation** time (before first sync). Editing an
already-synced preset's local file does not help — Bambu shows the cloud copy, which
still carries the old id. A preset already broken this way must be deleted in the
slicer (removing the cloud copy) and reinstalled.

---

## Per-slicer findings (all verified 2026-07-19 on Windows 11 x64 unless noted)

### 1. Orca Slicer

- Version tested: **2.4.2** (`app.version` in conf); user presets carry preset
  version `2.3.1.20`.
- Executable: `C:\Program Files\OrcaSlicer\orca-slicer.exe`; process name `orca-slicer.exe`.
- User data: `%APPDATA%\OrcaSlicer\`; active user dir was the account UUID dir.
- User presets: delta format (19 keys observed), `inherits` set, single-element arrays
  on single-extruder targets.
- `user_backup-v*` folders exist at the data root — the slicer snapshots user data on
  version upgrades. Do not scan them as live presets.
- macOS (documented in official repo; **unverified locally — no macOS machine yet**):
  data at `~/Library/Application Support/OrcaSlicer`, app at `/Applications/OrcaSlicer.app`.

### 2. Bambu Studio

- Version tested: **02.07.01.62**.
- Executable: `C:\Program Files\Bambu Studio\bambu-studio.exe`; process `bambu-studio.exe`.
- User data: `%APPDATA%\BambuStudio\`; **two account dirs plus `default` observed**;
  active dir = `app.preset_folder` (`3964423668`).
- User presets observed as full snapshots (139 keys, `inherits: ""`), dual-element
  arrays for dual-nozzle H2S, `"nil"` sentinels, `filament_id` present.
  Note: Bambu Studio can also produce delta presets when the user saves a derived
  preset; both shapes must parse.
- `filament_inventory/`, `track/`, `cache/` are unrelated; do not touch.
- macOS (**unverified locally**): `~/Library/Application Support/BambuStudio`.

### 3. Snapmaker Orca

- Version tested: **01.10.01.50** (`app.version`); user presets carry `2.2.44.2`.
- Executable: `C:\Program Files\Snapmaker_Orca\snapmaker-orca.exe`; process
  `snapmaker-orca.exe`.
- User data: `%APPDATA%\Snapmaker_Orca\`; only `default` account dir observed;
  `preset_folder` empty.
- Delta presets (14 keys observed). System vendors: `Snapmaker`, `OrcaFilamentLibrary`.
- macOS (**unverified locally**): `~/Library/Application Support/Snapmaker_Orca` expected.

### 4. ElegooSlicer

- Version tested: **1.5.2.2**; user presets carry `1.3.2.9`+.
- Executable: `C:\Program Files\ElegooSlicer\elegoo-slicer.exe`; process
  `elegoo-slicer.exe`.
- User data: `%APPDATA%\ElegooSlicer\`; `default` active. Quirk: some machine preset
  JSONs sit directly in `user\` root (OrangeStorm Giga extruder variants) — filament
  scanning must only look inside `user/*/filament/`.
- Delta presets; `user/default/filament/base/` heavily used (vendor-library caches for
  Elegoo and even Bambu printers).
- macOS (**unverified locally**): `~/Library/Application Support/ElegooSlicer` expected.

### 5. Flash Studio Desktop (Orca-Flashforge)

- Version tested: **01.10.01.50** (`app.version`); user presets carry `2.3.0.3`.
- Executable: `C:\Program Files\Flashforge\Orca-Flashforge\flash studio.exe`
  (note the space and the rebrand; data folder still `Orca-Flashforge`). Process name
  `flash studio.exe`. Older installs may use an `Orca-Flashforge.exe` name
  (**unverified**).
- User data: `%APPDATA%\Orca-Flashforge\`; UUID account dir + `default`;
  `preset_folder` empty → `default` active.
- Delta presets (12 keys observed). Some presets exist without `.info` sidecars —
  sidecar must be treated as optional when scanning.
- System vendors: `Flashforge`, `Custom`, `OrcaFilamentLibrary`.
- macOS (**unverified locally**).

---

## Install flavours: one slicer, several data directories

A slicer *family* can be installed in more than one *flavour* — release, beta,
nightly — each with its own data directory. The registry therefore has one row
per flavour (`SLICER_VARIANTS` in `src/slicerIntegration/registry.ts` and
`src-tauri/src/slicer_integration/mod.rs`), while the family id (`slicer_id`,
e.g. `bambu`) stays the preset-format/adapter key shared by every flavour.

**A row may only be added after the data directory, the config file name, the
executable path and the process image name have been read off a real install,
with the date.** Guessed rows are indistinguishable from verified ones once they
are in the table.

### Bambu Studio Beta (verified 2026-08-01, Windows 11 x64)

| Item | Value |
|---|---|
| Data directory | `%APPDATA%\BambuStudioBeta\` |
| Config file | `BambuStudio.conf` — **not** `BambuStudioBeta.conf` |
| `app.version` | `02.08.01.55` |
| `app.preset_folder` | `2572316032` (signed in) |
| `app.sync_user_preset` | `True` |
| Vendor library | `system\BBL.json` version `02.08.00.04`; only the `BBL` vendor |
| Executable | `C:\Program Files\Bambu Studio\bambu-studio.exe`, FileVersion `02.08.01.55` |
| Process image name | `bambu-studio.exe` |
| macOS path | **UNVERIFIED** — no macOS machine available; deliberately absent |

The config file name is decoupled from the directory name. Deriving it (as
`{data_dir_name}.conf`) leaves the config unread, which makes the active preset
folder unknown; the previous code then fell back to `default` and would have
targeted the empty `user\default` instead of the account folder holding the
user's presets.

**The Beta replaced the release binary in the same folder.** On the inspected
machine there is exactly one Bambu executable, at the release path, reporting
the Beta's version, running under the release's process image name. Two
consequences, both encoded:

- The executable cannot tell the flavours apart, so a flavour is reported
  because its **data directory** exists. An executable-only entry is emitted at
  most once per family, for the default flavour, and only when no flavour of
  that family has a data directory — otherwise a release-only machine would show
  a phantom Beta.
- Running-detection is family-wide (`family_process_names`), so the
  refuse-while-open guard covers both flavours. That is also the conservative
  reading while one binary serves both.

### Stale data directories

Same machine, same date: the release directory `%APPDATA%\BambuStudio\` was last
written 2026-07-18 (config `02.07.01.62`, `preset_folder` empty,
`sync_user_preset` `False`, `user\default\filament` empty), while the Beta
directory's config was written 2026-08-01. Both are real; only one is in use.

Because `02.07.` matches a `directInstallVerified` entry, the stale directory
used to be reported as a fully verified install and would have accepted an
install, verified it, and reported success into a folder the running slicer has
not opened since July. Detection now sorts a family's installs by config write
time, names the newer sibling on the older rows (`superseded_by`), and never
hides either — a genuine side-by-side setup stays visible.

### Choosing the account folder

`app.preset_folder` names it. Empty string means `default` (verified on the
signed-out release install). When the config **cannot be read**, or names a
folder that is not there, **no location is marked active** and a note says so —
the previous silent fallback to `default` is what turns a config-read failure
into a write aimed at the wrong folder.

Two flavours of one family both have a `default` account folder, so an account
id alone does not identify a directory. Every scan/install/backup call carries
the flavour id. Without one the native side resolves the account folder across
the family and refuses (`AMBIGUOUS_INSTALL`) when more than one flavour has it,
naming both candidates, rather than guessing.

### Cloud sync observed

`sync_user_preset = True` and the account folder is bulk-rewritten. On
2026-08-01 all 501 preset `.json`/`.info` pairs in
`user\2572316032\filament` carried write times inside a three-second window
right after launch; a later read of the same folder found **one** preset left
(the user's own hand-saved one). A preset installed into an account folder is
live data the slicer owns. The mitigations are unchanged and correct: warn on a
cloud-linked location, take a verified backup before writing, and offer
re-verification afterwards. Nothing here claims a preset can survive a sync.

---

## Calibrated-field mapping (Orca family, all five slicers)

Field names verified against real presets from all five slicers:

| Trim result | Preset key | Unit/format |
|---|---|---|
| Nozzle temperature | `nozzle_temperature` | °C, string array per extruder |
| First-layer temp | `nozzle_temperature_initial_layer` | °C, string array |
| Flow ratio | `filament_flow_ratio` | ratio, string array |
| Pressure advance | `pressure_advance` (+ `enable_pressure_advance` = `["1"]`) | string array |
| Retraction length | `filament_retraction_length` | mm, string array, `nil` allowed |
| Retraction speed | `filament_retraction_speed` | mm/s, string array, `nil` allowed |
| Deretraction speed | `filament_deretraction_speed` | mm/s, string array, `nil` allowed |
| Max volumetric speed | `filament_max_volumetric_speed` | mm³/s, string array |

Notes:
- Retraction keys with the `filament_` prefix are *filament-level overrides* of
  printer-level values; `nil` means "use printer value". Patching them replaces `nil`
  with a concrete value only for the extruder(s) being calibrated.
- `enable_pressure_advance` must be set to `"1"` when patching `pressure_advance`
  if the base has it `"0"`/absent (verified semantics in OrcaSlicer UI and presets).
- Bed temperature keys are plate-specific in this family
  (`hot_plate_temp`, `textured_plate_temp`, `cool_plate_temp`, … + `_initial_layer`
  variants) — Trim does not calibrate bed temp per plate, so v1 does **not**
  patch bed temperature.

## Unverified items (kept out of default behavior)

- macOS paths for all five slicers (documented upstream, not yet inspected here).
- Linux paths and native slicer integration behavior (Linux desktop packages are built, but profile detection/install is not yet verified).
- Whether each slicer tolerates a missing `.info` for a new preset (observed existing
  presets without sidecars in Orca-Flashforge, so likely; we always write one anyway).
- Older/newer slicer versions than the ones listed above.
- **Bambu Studio Beta on macOS.** `~/Library/Application Support/BambuStudioBeta`
  is plausible but was not inspected, so the Beta row carries no macOS candidate.
- **Orca nightly builds and Orca forks.** No Orca install existed on the
  inspected machine, so no nightly/fork flavour rows were added. Whether they use
  a distinct data directory name or share `OrcaSlicer` is unknown.
- **A true side-by-side Bambu install** (release and Beta as two separate
  binaries). On the inspected machine the Beta replaced the release binary at the
  same path, so only the shared-executable case is verified. The second
  executable path and process name cannot be added until someone has seen them.
- **Direct install on Bambu Studio 02.08.** Layout, config schema, system library
  layout and preset/`.info` schema were verified read-only; no preset has been
  generated or installed against that version, so `directInstallVerified` stays
  false until `SLICER_PROFILE_TEST_MATRIX.md` records a pass.
- Whether Bambu Studio 2.8 still ignores a preset with no `filament_id` the way
  2.7.x did. The Beta's own Save-As wrote such a preset into the account folder,
  so the 2.7-era claim is not established for 2.8. Minting a fresh id is safe
  either way, so no behaviour changed on this.
- `flash studio.exe` vs legacy `Orca-Flashforge.exe` executable naming across
  Flashforge versions.

## Evidence

- Direct filesystem inspection, 2026-07-19, Windows 11 Pro x64, all five slicers
  installed with real user presets (sanitized copies in
  `tests/slicerIntegration/fixtures/`).
- Direct read-only inspection, 2026-08-01, Windows 11 x64: `%APPDATA%\BambuStudio`
  and `%APPDATA%\BambuStudioBeta` (directory listings, both `.conf` files,
  `user\` trees, `system\BBL.json`), `C:\Program Files\Bambu Studio\bambu-studio.exe`
  version resource, and `tasklist`. Nothing was written. The layouts are
  reproduced as synthetic trees in the `discovery.rs` tests and as fabricated
  detection payloads in `tests/slicerIntegration/discovery.test.ts`; no automated
  test reads a real slicer configuration.
- OrcaSlicer wiki (cloned `SoftFever/OrcaSlicer.wiki.git` during earlier Trim
  research) for calibration semantics.
