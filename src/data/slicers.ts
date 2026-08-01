import type { SlicerId, SlicerVersionContent } from '../types';

const BAMBU_DEVELOPER_MODE_BEST_PATH =
  'Best path for Bambu printers: enable Developer mode first — Bambu Studio → Preferences → check the box labeled "Develop Mode" (yes, it really says "Develop Mode", not "Developer Mode" — a translation quirk). Once enabled, a Calibration button appears in the TITLE BAR next to the Redo (↷) arrow — the same Calibration menu all Orca-based slicers have, just with slightly different entries. The manual calibration tests all live in that title-bar menu, and your Bambu printer stays selected the whole time. The entries, in order, are: Temperature, Flow rate (Coarse / Fine — no YOLO), Pressure advance, Retraction test, More... (Max flowrate, VFA), and Tutorial.';

const BAMBU_NON_BAMBU_FALLBACK =
  'Fallback only: if you cannot or do not want to use Developer mode, temporarily select any non–Bambu-Lab printer profile to reveal the same Calibration tests, create/run the test, then switch back to your Bambu printer before saving values or doing normal prints.';

// --- Dual-nozzle (X2D) shared content ---------------------------------------

const BAMBU_GEAR_OFF_CAVEAT =
  'Manual K only applies when the pre-print calibration gear in the send-to-print dialog is set to "Off" — "Automatic"/"On" recalibrates or reuses the printer-side K instead.';

const BAMBU_K_SCALE_WARNING =
  'Never compare automatic and manual K numbers: automatic K on eddy-current machines (the X2D/H2D family) is intentionally HIGHER than manual pattern K — the two scales are not interchangeable.';

/**
 * The printer's own pre-print flow calibration has to be off while a MANUAL
 * flow test prints, or the two fight and the plate means nothing.
 *
 * Already stated in `CALIBRATIONS['flow-pass1'].versionNotes` and carried by
 * Orca's flow-pass1 entry; it applies just as much to the fine pass and the
 * re-check, which print the same kind of plate, and to Bambu Studio, where the
 * printer in question is always a Bambu one.
 */
const FLOW_CALIBRATION_OFF =
  'Set the printer\'s own "Flow Calibration" option in the send-to-print dialog to off before printing this plate. A machine that calibrates flow on top of a manual flow test fights the test, and the printed blocks stop meaning what their labels say.';

const ORCA_FLOW_CALIBRATION_OFF = 'Bambu printers only: ' + FLOW_CALIBRATION_OFF;

/**
 * The one feedback edge in the wizard's order, in Bambu's own words.
 *
 * Bambu list a changed maximum volumetric speed among the reasons to run a Flow
 * Dynamics Calibration — and the max-flow step comes three steps AFTER pressure
 * advance, so finishing it puts the calibrated K value up for re-confirmation.
 * The dependency graph only points backwards, so this has to be said in the
 * instructions the user actually reads at that moment.
 */
const MVS_INVALIDATES_K =
  'Before you move on: Bambu list "When the maximum volumetric speed or print temperature is changed in the filament settings" among their own reasons to run a Flow Dynamics Calibration — and changing the maximum volumetric speed is precisely what you just did. Re-confirm the pressure advance (K) value for this filament and nozzle before the verification print, so the profile you verify is the profile you will print with.';

const BAMBU_BUG_10404 =
  'KNOWN BUG (BambuStudio #10404): a filament preset whose "Bowden Extruder" retraction override is left unset ("nil") silently falls back to the MAIN 0.8 mm default on the auxiliary nozzle — under-retracting it. Always tick Length and set an explicit value for the bowden path.';

/**
 * Retraction speed for the X2D's bowden-fed auxiliary nozzle.
 *
 * Read from the owner's own install:
 *   …/BambuStudio/system/BBL/machine/Bambu Lab X2D 0.4 nozzle.json
 *     retraction_length   ["0.8","0.8","2","2"]
 *     retraction_speed    ["30","30","20","20"]
 *     deretraction_speed  ["30","30","20","20"]
 *
 * Those arrays are indexed by EXTRUDER VARIANT, not by physical nozzle: the
 * first two entries are the direct-drive variants (Direct Drive Standard /
 * High Flow) and the last two are the bowden variants (Bowden Standard /
 * High Flow). So 30 mm/s is the MAIN nozzle's figure and the auxiliary ships
 * 20 mm/s — the wizard previously told users the opposite.
 */
const BAMBU_X2D_BOWDEN_SPEED =
  'Speeds differ per feed path too: the bowden (auxiliary) variants ship 2 mm at 20 mm/s retract and 20 mm/s deretract, while 30 mm/s is the direct-drive main-nozzle figure. Change length before speed.';

/**
 * Neither slicer this wizard targets has a coasting setting. Verified for
 * Bambu Studio by searching its entire shipped configuration for any key
 * containing "coast" (zero hits across system/BBL); for Orca, coasting remains
 * an open feature request (OrcaSlicer #3325) rather than a shipped parameter.
 */
const NO_COASTING_NOTE =
  'Do not go looking for a "coasting" setting: neither Bambu Studio nor Orca ships one (Orca has an open feature request for it). The classic Cura anti-stringing advice to add coasting simply does not apply here — spend the effort on drying, temperature and retraction length instead.';

/**
 * The ordered lever list, kept identical in both slicers' retraction pages so
 * the instruction the user reads does not depend on which slicer they picked.
 */
const OOZE_LEVER_ORDER_NOTE =
  'If ooze is your actual complaint, work the levers in order of effect size, not convenience: (1) dry the filament, (2) nozzle temperature in 5 °C steps — the dominant lever, (3) retraction length then speed, (4) travel speed, (5) wipe at about one nozzle width, (6) z-hop last and usually counterproductive. Pressure advance is not on the list: it retimes pressure without changing the volume extruded.';

const BAMBU_X2D_AUX_CONSTRAINTS =
  'X2D auxiliary-nozzle limits: 200 mm/s and 1000 mm/s² caps, no flexible filaments (TPU), the aux nozzle size must match the main, and about 4 mm of Z height is lost while the auxiliary nozzle prints. It is intended mainly for support material — X2D "Quality mode" slicing automatically assigns the right (aux) nozzle only support material.';

/**
 * Which ooze belongs to which step. Repeated on both sides of the fork so a
 * user who lands on the wrong one is sent back rather than left tuning the
 * setting that cannot fix their symptom.
 */
const OOZE_FORK_NOTE =
  'This step is for TOOLCHANGE ooze — blobs, smears and colour bleed that appear where one nozzle hands over to the other. Drool during ordinary printing within a single filament is a different problem: it belongs to the temperature step (the dominant lever) and the retraction step (which carries the full ordered lever list), both of which every project has.';

/**
 * Bambu's own toolchange anti-ooze baseline on the X2D, so a user can tell
 * whether their profile is already at the vendor default or has drifted.
 *
 * Read from the owner's install, with inheritance resolved:
 *   filament/Generic ABS @BBL X2D 0.4 nozzle.json
 *     retraction_distances_when_ec   ["3","3","4","4"]   (3 mm direct-drive slots, 4 mm bowden slots)
 *     filament_cooling_before_tower  ["10","10","10","10"]
 *     filament_ramming_travel_time   ["0","0","0","0"]
 *     filament_tower_interface_print_temp ["270"]
 *   filament/fdm_filament_template_direct_bowden.json
 *     long_retractions_when_ec       ["1","1","1","1"]
 *     filament_cooling_before_tower  ["0","0","0","0"]   (X2D deliberately raises this to 10)
 *   machine/fdm_bbl_3dp_002_common.json
 *     wipe ["1"…], wipe_distance ["2"…], retract_before_wipe ["0%"…],
 *     z_hop ["0.4"…] z_hop_types ["Auto Lift"…], retract_length_toolchange ["2"…],
 *     machine_switch_extruder_time 5
 */
const BAMBU_X2D_TOOLCHANGE_DEFAULTS =
  'Bambu\'s own X2D baseline, for comparison against your profile: retraction on extruder change is 3 mm on the direct-drive slots and 4 mm on the bowden slots for every rigid material (0 for TPU and PVA), long retraction on extruder change is on, and cooling-before-tower is 10 — the shared template defaults that last one to 0, so Bambu deliberately pre-cools before the prime tower on this machine. Machine side: wipe on at 2 mm, retract-before-wipe 0%, z-hop 0.4 mm "Auto Lift", toolchange retract 2 mm, and about 5 s per extruder switch. Note 2 mm of wipe is already well beyond the 0.4–0.8 mm that stays artifact-free, so wipe is not where your remaining ooze is coming from.';

/**
 * Orca disables Resonance avoidance for EVERY calibration test — verified in
 * Plater.cpp, where each calib_* function sets `resonance_avoidance = false`
 * unconditionally. Of Orca's entire stock profile catalog, exactly one machine
 * preset ships it enabled (Snapmaker U1 0.4 nozzle), so only those users ever
 * see the resulting dialog. Reported by Guntram on the community Discord.
 */
const ORCA_RESONANCE_AVOIDANCE_NOTE =
  'If a "Creating a new project: unsaved changes" dialog appears listing "Resonance avoidance" (true → false), that is Orca\'s own doing, not a mistake on your part: every Orca calibration test deliberately turns Resonance avoidance off, because it slows outer walls and would distort the result. Transfer or Discard — it makes no difference here, since Orca creates the project first and forces the setting off immediately afterwards either way. Almost nobody sees this dialog: the Snapmaker U1 (0.4 nozzle) is the only stock Orca machine preset that ships with Resonance avoidance enabled.';

/**
 * Version-aware slicer instruction content.
 *
 * All wording is original. Facts (menu locations, defaults, formulas) verified
 * against the official OrcaSlicer wiki (github.com/SoftFever/OrcaSlicer wiki,
 * checked 2026-07-18 against the v2.4.x docs) and the Bambu Lab wiki.
 *
 * Menu labels re-verified 2026-07-23 against each slicer's menu-construction
 * source (MainFrame.cpp) and cross-checked against the installed binaries,
 * after a Discord report that several paths were wrong. The two slicers use
 * genuinely different labels for the same tests, so keep them straight:
 *
 *   Orca   Calibration: Temperature | Max flowrate | Pressure advance |
 *                       Flow ratio | Retraction | Cornering |
 *                       Input Shaping > | VFA | Calibration Guide
 *   Bambu  Calibration: Temperature | Flow rate > (Coarse, Fine) |
 *                       Pressure advance | Retraction test |
 *                       More... > (Max flowrate, VFA) | Tutorial
 *
 * Notably: Orca says "Flow ratio" where Bambu says "Flow rate"; Orca dropped
 * the "test" from "Retraction test"; and Max flowrate is top-level in Orca but
 * lives under "More..." in Bambu. Do not copy a path from one to the other.
 *
 * To support a new slicer version: copy an entry, adjust, and add it to
 * SLICER_CONTENT. Nothing else in the app needs to change.
 */

export const SLICER_CONTENT: SlicerVersionContent[] = [
  {
    slicer: 'orca',
    slicerLabel: 'Orca Slicer',
    version: '2.4.x',
    verifiedOn: '2026-07-23',
    docsUrl: 'https://github.com/SoftFever/OrcaSlicer/wiki/Calibration',
    calibrationMenuPath: 'Top menu bar → Calibration',
    perTest: {
      temperature: {
        available: true, builtIn: true,
        menuPath: 'Calibration → Temperature',
        steps: [
          'Open Orca Slicer and select the printer, the filament profile you are calibrating, and a standard process profile (0.2 mm quality is fine).',
          'In the top menu bar, open Calibration and choose Temperature.',
          'In the dialog, set the start (hotter) and end (cooler) temperatures from the range below. Orca steps the tower 5 °C per block.',
          'Click OK. Orca creates a new project containing the temp tower, scaled to your nozzle size.',
          'Slice the plate and check the Preview: each tower block should show its temperature.',
          'Print it (export G-code or send directly to the printer).',
          'When done: create a NEW project before doing normal prints — calibration mode changes settings you don\'t want to keep.'
        ],
        saveTo: {
          path: 'Filament settings (edit the filament profile) → Filament tab',
          field: 'Nozzle temperature — the fields appear in this order: "First layer" (optionally 5–10 °C hotter for adhesion), then "Other layers" (your chosen temp)',
          scope: 'filament',
          note: 'Save with the floppy-disk icon as a NEW user preset (e.g. "Brand PETG Blue - X1C - 0.4") — do not overwrite the stock generic preset.'
        },
        gotchas: [
          'The tower is generated in-slicer — you do not need to download a model.',
          'If every block looks bad, the problem is likely wet filament or a partial clog, not temperature.',
          ORCA_RESONANCE_AVOIDANCE_NOTE
        ]
      },
      'flow-pass1': {
        available: true, builtIn: true,
        menuPath: 'Calibration → Flow ratio',
        steps: [
          'Select the printer AND the filament profile you are calibrating — the test math builds on the profile\'s current flow ratio, so the right filament must be active.',
          'Note the profile\'s current Flow ratio (Filament settings → Filament tab) — the app asks for it below.',
          'Open Calibration → Flow ratio (Orca names the menu entry after the setting, not the test — Bambu Studio is the one that calls it "Flow rate"). Choose "YOLO (Recommended)" for the one-pass method, or "Pass 1 (Coarse)" for the legacy coarse pass.',
          'YOLO: a plate of eleven blocks appears, each labeled with an absolute modifier from −0.05 to +0.05 in 0.01 steps. Pass 1 (Coarse): nine blocks labeled −20 to +20 in 5% steps.',
          'Slice and print the plate.',
          'Pick the best block using the evaluation guide, then let this app compute the new flow ratio.',
          'Bambu printers only: in the print dialog, UNCHECK the machine\'s own "Flow Calibration" option — it would recalibrate on top of the test.',
          'Already calibrated this filament\'s flow ratio by hand? Enter that saved ratio as the current one above rather than resetting it — the test is computed from it, so an existing result becomes the starting point instead of being thrown away.'
        ],
        saveTo: {
          path: 'Filament settings → Filament tab',
          field: 'Flow ratio (a decimal near 1.0 — never a percentage)',
          scope: 'filament',
          note: 'Save the profile after entering the value; Pass 2 / YOLO verification builds on the SAVED value.'
        },
        disableFirst: [ORCA_FLOW_CALIBRATION_OFF],
        gotchas: [
          'YOLO modifiers are absolute (+0.01), legacy Pass 1/2 modifiers are percentages (+5). Don\'t mix the two formulas — this app applies the right one for the method you pick.',
          ORCA_RESONANCE_AVOIDANCE_NOTE
        ]
      },
      'flow-pass2': {
        available: true, builtIn: true,
        menuPath: 'Calibration → Flow ratio → Pass 2 (Fine)',
        steps: [
          'FIRST verify the Pass 1 result is entered AND saved in the filament profile — Pass 2 builds on it.',
          'Open Calibration → Flow ratio and choose "Pass 2 (Fine)".',
          'A plate of ten blocks appears with modifiers from −9 to 0 (percent, 1% steps).',
          'Slice and print, then pick the smoothest block.',
          'Enter the modifier below; the final ratio = saved ratio × (100 + modifier) / 100.'
        ],
        saveTo: {
          path: 'Filament settings → Filament tab',
          field: 'Flow ratio',
          scope: 'filament',
          note: 'Overwrite the Pass-1 value with this final one and save the user preset again.'
        },
        disableFirst: [ORCA_FLOW_CALIBRATION_OFF],
        gotchas: [ORCA_RESONANCE_AVOIDANCE_NOTE]
      },
      'pressure-advance': {
        available: true, builtIn: true,
        menuPath: 'Calibration → Pressure advance',
        steps: [
          'Select printer, filament, and process profile.',
          'Open Calibration → Pressure advance and pick a method: Tower, Pattern, or Line. Each method has direct-drive (DDE) and Bowden variants — pick the one matching your extruder.',
          'Enter start / end / step from the range below (the dialog pre-fills sensible defaults per extruder type).',
          'Slice and print the generated plate.',
          'Marlin firmware: Linear Advance must be compiled in (M900). If the print shows no change across samples, the firmware is ignoring PA.',
          'Klipper/Bambu: works out of the box.',
          'Bambu printers: uncheck the machine "Flow Dynamics Calibration" option in the print dialog so the printer doesn\'t overwrite the test.'
        ],
        saveTo: {
          path: 'Filament settings → Filament tab → Advanced',
          field: 'Enable pressure advance (check) + Pressure advance value',
          scope: 'filament',
          note: 'Per-filament value. Save the user preset. (Setting it in printer/process would apply to every filament — not what you want.)'
        },
        disableFirst: ['Bambu printers: "Flow Dynamics Calibration" checkbox in the print dialog'],
        gotchas: [
          'Tower: PA = start + step × best_height_mm (the tower steps PA once per mm of height).',
          'Line/Pattern: values are printed next to the lines — read them directly rather than counting samples when possible.',
          ORCA_RESONANCE_AVOIDANCE_NOTE
        ]
      },
      'flow-verify': {
        available: true, builtIn: true,
        menuPath: 'Calibration → Flow ratio → Pass 2 (Fine)',
        steps: [
          'Verify BOTH your calibrated flow ratio AND the new Pressure Advance value are saved in the filament profile — this re-check tests flow under the new PA.',
          'Open Calibration → Flow ratio and choose "Pass 2 (Fine)" (the same fine plate as before: −9 to 0, 1% steps).',
          'Slice and print.',
          'Pick the smoothest block. If the 0 block wins, your flow ratio is confirmed; a neighbor winning means PA was masking a small flow error.'
        ],
        saveTo: {
          path: 'Filament settings → Filament tab',
          field: 'Flow ratio',
          scope: 'filament',
          note: 'Only update the value if a block other than 0 won; then save the user preset again.'
        },
        disableFirst: [ORCA_FLOW_CALIBRATION_OFF],
        gotchas: [ORCA_RESONANCE_AVOIDANCE_NOTE]
      },
      retraction: {
        available: true, builtIn: true,
        menuPath: 'Calibration → Retraction',
        steps: [
          'Select printer, filament, and process profile.',
          'Open Calibration → Retraction (Orca 2.4 renamed this from "Retraction test"; "Retraction test" is Bambu Studio\'s wording).',
          'Set start / end / step. Defaults 0→2 mm step 0.1 suit direct drive; try 1→6 mm step 0.2 for Bowden.',
          'Slice and print the twin-tower test.',
          'Find the LOWEST height where the towers stay clean (strings stop).',
          'Measure that height with calipers, then read the true retraction length at that height from the sliced G-code preview: search the G-code for the "Calib_Retraction_tower" comments (don\'t trust raw retract commands — wipe settings distort them). This app also computes it from start + step × height.',
          OOZE_LEVER_ORDER_NOTE,
        ],
        saveTo: {
          path: 'Printer settings → Extruder → Retraction  (or per-filament: Filament settings → Setting overrides)',
          field: 'Length (mm) — and optionally Retraction speed',
          scope: 'printer',
          note: 'Retraction is PRINTER-scoped by default. If this filament needs a different value than your usual, use the filament profile\'s "Setting overrides" section instead of changing the printer profile.'
        },
        gotchas: [
          'If the tower is clean from the very bottom, set a small nonzero value (0.2–0.4 mm direct drive) rather than 0.',
          'If the top is STILL stringy, dry the filament and check the nozzle for leaks — more retraction won\'t fix moisture.',
          NO_COASTING_NOTE,
          'Travel speed, wipe and z-hop live in the process/printer profile, not here. They are settings to CHECK when ooze survives a good retraction value — PerfectFit does not compute them, because it has no measurement behind them.',
          ORCA_RESONANCE_AVOIDANCE_NOTE
        ]
      },
      'max-volumetric-speed': {
        available: true, builtIn: true,
        menuPath: 'Calibration → Max flowrate',
        steps: [
          'Select printer, filament (with calibrated temperature saved), and process profile.',
          'Open Calibration → Max flowrate — it sits at the TOP level of the Calibration menu, directly under Temperature. (Bambu Studio is the slicer that files it under "More...".)',
          'Set start / end / step (defaults 5→20 mm³/s, step 0.5 per mm of height are good unless you already know the ballpark).',
          'Slice and print the test tower.',
          'Watch and listen during the print — note the height where clicking or visible defects start.',
          'Measure with calipers the height just BELOW where defects begin.',
          'Alternative reading: in Preview, set the color scheme to "Flow" and find the flow value at your measured layer.'
        ],
        saveTo: {
          path: 'Filament settings → Filament tab',
          field: 'Max volumetric speed (mm³/s)',
          scope: 'filament',
          note: 'Enter the PRODUCTION value (with safety margin applied), not the raw measured maximum.'
        },
        gotchas: [
          'This test measures a best-case scenario. The official guidance is to reduce the measured value by 10–20% for real prints — this app applies your configured margin automatically.',
          MVS_INVALIDATES_K,
          ORCA_RESONANCE_AVOIDANCE_NOTE
        ]
      },
      shrinkage: {
        available: true, builtIn: false,
        menuPath: '(external test model — no calibration menu entry)',
        steps: [
          'Orca has no built-in shrinkage test — use one of the external tools from the models list (the free Printables shrinkage tool reads the percentage directly off a printed vernier scale).',
          'Before slicing the tool, open Filament settings → Filament and make sure Shrinkage is 100% (no compensation) — the test measures what the compensation SHOULD be.',
          'Print at 100% scale with your calibrated filament profile and normal process profile.',
          'Let the parts cool fully to room temperature before measuring/reading.',
          'Enter the reading(s) in the result step; the app combines X and Y into the value to save.'
        ],
        saveTo: {
          path: 'Filament settings → Filament tab',
          field: 'Shrinkage (labeled "Shrinkage (XY)" in newer Orca versions) — a percentage',
          scope: 'filament',
          note: 'Enter as a percentage (e.g. 99.4). Orca scales XY geometry up by 100/shrinkage% at slicing time. Save the user preset.'
        },
        gotchas: [
          'Re-slice existing plates after changing shrinkage — compensation is applied at slicing time.',
          'Newer Orca versions have a separate Z shrinkage field; the CaliLantern measures Z too if you want to fill it.'
        ]
      },
      'ooze-control': {
        available: true, builtIn: false,
        menuPath: 'Checklist — prime tower + per-filament retraction overrides',
        steps: [
          OOZE_FORK_NOTE,
          'Dry the filament(s) first — moisture is the top non-obvious ooze cause and defeats every setting below.',
          'Enable the prime tower for multi-filament/multi-tool prints, and give leaky filaments more prime volume.',
          'Set a per-filament retraction override for the ooze-prone extruder under the filament profile\'s setting overrides. Orca-family slicers expose the same prime-tower and per-extruder override concepts as Bambu Studio; exact menu wording varies by version.',
          'Print a small test with several toolchanges using your normal process profile, then judge the remaining ooze in the next step.'
        ],
        saveTo: {
          path: 'Process settings (prime tower) + Filament settings → Setting overrides (retraction)',
          field: 'Prime tower + retraction length override',
          scope: 'process',
          note: 'This step is mostly a checklist — there is no single calibration value. Record what you settled on in the result step so future spools start from it.'
        },
        gotchas: [
          'This checklist is written primarily for dual-nozzle Bambu machines (X2D); on other multi-tool printers the same order of defenses applies — dry filament and prime tower first, then per-extruder retraction.'
        ]
      },
      'final-verification': {
        available: true, builtIn: false,
        menuPath: '(normal printing — no calibration menu)',
        steps: [
          'Start a NEW project (File → New) to make sure no calibration mode is active.',
          'Select your printer, the newly saved filament user preset, and your normal process profile.',
          'Import a verification model (see the models list — e.g. 3DBenchy) or a real part of yours.',
          'Confirm the filament preset shows all your calibrated values (temperature, flow ratio, PA, max volumetric speed) and the printer/override retraction is set.',
          'Slice, check the Preview for anything odd, and print.',
          'Inspect using the checklist in the next step.'
        ],
        saveTo: {
          path: '—', field: '—', scope: 'calibration-only',
          note: 'Nothing to save; this validates the preset you already saved.'
        }
      }
    }
  },
  {
    slicer: 'bambu',
    slicerLabel: 'Bambu Studio',
    version: '1.7+',
    verifiedOn: '2026-07-23',
    docsUrl: 'https://wiki.bambulab.com/en/bambu-studio/Calibration',
    // NOTE: In current Bambu Studio (verified 2.7.x), enabling Preferences →
    // "Develop Mode" (their label) adds a Calibration button to the title bar
    // (next to the Redo arrow) exposing the manual tests while a Bambu Lab
    // printer stays selected. Temporarily selecting a non–Bambu-Lab printer
    // profile remains documented only as a fallback for users who cannot
    // enable Develop Mode (issue #1).
    calibrationMenuPath: 'Title bar → Calibration button (next to the Redo arrow; appears after enabling "Develop Mode" in Preferences)',
    perTest: {
      temperature: {
        available: true, builtIn: true,
        menuPath: 'Title bar → Calibration → Temperature (button appears after enabling Develop Mode)',
        steps: [
          'Select the Bambu printer and the filament preset you are calibrating.',
          BAMBU_DEVELOPER_MODE_BEST_PATH,
          'Open the title-bar Calibration menu and choose the Temperature test.',
          'Set the start and end temperatures from the range below (5 °C steps).',
          'Slice and print the tower.',
          'Pick the best block using the evaluation guide.'
        ],
        saveTo: {
          path: 'Filament settings → Filament tab',
          field: 'Nozzle temperature — the fields appear in this order: "First layer" (optional, 5–10 °C hotter for adhesion), then "Other layers" (your chosen temp)',
          scope: 'filament',
          note: 'Save as a NEW user preset — avoid overwriting Bambu system presets (they reset on updates anyway).'
        },
        gotchas: [
          'Bambu Studio Developer mode is the preferred fix when Temperature is hidden, because it exposes the calibration test without leaving the selected Bambu printer profile.',
          BAMBU_NON_BAMBU_FALLBACK,
          'Bambu machines also offer on-device/automatic calibration; this wizard uses the manual test so you make the judgment.'
        ]
      },
      'flow-pass1': {
        available: true, builtIn: true,
        menuPath: 'Title bar → Calibration → Flow rate → Coarse',
        steps: [
          'Select the Bambu printer and the filament preset to calibrate (its current flow ratio is the baseline).',
          BAMBU_DEVELOPER_MODE_BEST_PATH,
          'Open the title-bar Calibration menu → Flow rate → Coarse (Bambu Studio labels the submenu entries simply "Coarse" and "Fine"; Orca calls the whole thing "Flow ratio" instead). Manual mode prints blocks with modifiers around ±20% in 5% steps. Bambu Studio does not offer Orca\'s YOLO flow method.',
          'X1/P1 with lidar also offer automatic flow calibration — this wizard covers the MANUAL path so you stay in control of the judgment.',
          'Slice and print; pick the smoothest block.',
          'New ratio = old × (100 + modifier) / 100 — computed for you below.',
          'If you already ran this calibration by hand, your saved flow ratio is the baseline the coarse pass builds on — enter it as the current ratio rather than resetting it. Bambu\'s Coarse pass is this step and its Fine pass is the next one, so a hand-run pair covers both; if you would rather not reprint them, mark both steps skipped from the project screen and let the later flow re-check confirm the number.'
        ],
        saveTo: {
          path: 'Filament settings → Filament tab',
          field: 'Flow ratio (decimal)',
          scope: 'filament',
          note: 'Save the user preset before running the fine pass.'
        },
        disableFirst: [FLOW_CALIBRATION_OFF],
        gotchas: [
          'Bambu Studio Developer mode is the preferred fix when Flow Rate is hidden, because it exposes both coarse and fine Flow Rate tests with the Bambu printer still selected.',
          BAMBU_NON_BAMBU_FALLBACK
        ]
      },
      'flow-pass2': {
        available: true, builtIn: true,
        menuPath: 'Title bar → Calibration → Flow rate → Fine',
        steps: [
          'Verify the coarse result is saved in the filament preset.',
          BAMBU_DEVELOPER_MODE_BEST_PATH,
          'Open the title-bar Calibration menu → Flow rate → Fine: blocks from −9% to 0% in 1% steps. Bambu Studio does not offer Orca\'s YOLO flow method.',
          'Slice, print, pick the best block; final ratio = saved ratio × (100 + modifier) / 100.'
        ],
        saveTo: {
          path: 'Filament settings → Filament tab',
          field: 'Flow ratio',
          scope: 'filament',
          note: 'Overwrite the coarse value with the final one and save.'
        },
        disableFirst: [FLOW_CALIBRATION_OFF],
        gotchas: [
          'Same visibility caveat as the coarse pass: Developer mode is preferred because Pass 2 depends on the saved Bambu filament profile staying selected.',
          BAMBU_NON_BAMBU_FALLBACK
        ]
      },
      'pressure-advance': {
        available: true, builtIn: true,
        menuPath: 'Title bar → Calibration → Pressure advance  (the machine\'s automatic version lives on the separate Calibration TAB → Flow Dynamics)',
        steps: [
          'Bambu Studio calls Pressure Advance "Flow Dynamics Calibration"; the value is the K factor. Note that these are two different places in the UI: the manual test is "Pressure advance" in the Develop-mode title-bar Calibration MENU, while the machine\'s automatic Flow Dynamics wizard is on the "Calibration" TAB in the main tab bar. There is no "Flow Dynamics" entry in the title-bar menu.',
          BAMBU_DEVELOPER_MODE_BEST_PATH,
          'Open the title-bar Calibration menu → Pressure advance for the manual test (lidar-equipped X1/P1 can instead run Automatic Flow Dynamics from the Calibration tab, but manual keeps you in control and works for every material).',
          'Dual-nozzle machines (X2D): the calibration dialog shows a nozzle selector — pick the nozzle this project calibrates and run the test once per nozzle. Automatic Flow Dynamics covers the MAIN hotend only; the auxiliary (bowden-fed) nozzle must be calibrated manually here, using range 0–1 in 0.02 steps (typical aux results land between 0.5 and 1.0, e.g. ~0.72 for PETG, versus 0–0.1 on direct drive).',
          'Arriving with a K value already stored for this filament? Look at it before you replace it. Stored Flow Dynamics results are keyed to filament AND nozzle, so check which nozzle the existing result was measured on before assuming it covers the one this project targets, and check whether it came from the automatic calibration or from this manual test. ' + BAMBU_K_SCALE_WARNING,
          'The manual test prints a series of labeled lines at increasing K values.',
          'Pick the line with the most uniform width — no bulges at speed changes, no thin breaks.',
          'Enter the K value in the result step; it is usually labeled directly on the plate.'
        ],
        saveTo: {
          path: 'Flow Dynamics calibration dialog (the K value lives on the printer, not in the preset)',
          field: 'K factor',
          scope: 'filament',
          note: 'K values are stored ON THE PRINTER, keyed to filament + nozzle (assignable per AMS slot on the device screen); only the flow RATIO lives in the slicer filament preset. ' + BAMBU_GEAR_OFF_CAVEAT
        },
        gotchas: [
          'Bambu Studio Developer mode is the preferred fix when Flow Dynamics is hidden, because it exposes the manual K-factor test without leaving the selected Bambu printer profile.',
          BAMBU_NON_BAMBU_FALLBACK,
          'Lidar-equipped X1/P1 can also run automatic Flow Dynamics on the machine.',
          BAMBU_GEAR_OFF_CAVEAT,
          BAMBU_K_SCALE_WARNING,
          BAMBU_X2D_AUX_CONSTRAINTS
        ]
      },
      'flow-verify': {
        available: true, builtIn: true,
        menuPath: 'Title bar → Calibration → Flow rate → Fine',
        steps: [
          'Verify BOTH your calibrated flow ratio AND the new K factor (Flow Dynamics) are saved — this re-check tests flow under the new pressure timing.',
          BAMBU_DEVELOPER_MODE_BEST_PATH,
          'Open the title-bar Calibration menu → Flow rate → Fine (−9% to 0%, 1% steps) — the same plate as the earlier fine pass.',
          'Slice, print, pick the smoothest block. The 0% block winning means your flow ratio is confirmed.'
        ],
        saveTo: {
          path: 'Filament settings → Filament tab',
          field: 'Flow ratio',
          scope: 'filament',
          note: 'Only update if a non-zero block won; then save the user preset.'
        },
        disableFirst: [FLOW_CALIBRATION_OFF],
        gotchas: [BAMBU_NON_BAMBU_FALLBACK]
      },
      retraction: {
        available: true, builtIn: true,
        menuPath: 'Title bar → Calibration → Retraction test (Develop Mode)',
        steps: [
          'Select the Bambu printer, filament preset, and normal process profile.',
          BAMBU_DEVELOPER_MODE_BEST_PATH,
          'Open the title-bar Calibration menu and choose "Retraction test" (Bambu Studio kept this name; Orca 2.4 shortened its own entry to just "Retraction").',
          'Dual-nozzle machines (X2D): retraction is per-extruder — machine defaults are 0.8 mm for the main (direct drive) nozzle and 2 mm for the auxiliary (bowden) nozzle. Calibrate the nozzle this project targets; for the aux, start at 2 mm and raise in ~0.5 mm steps (most filaments land between 2 and 4 mm, up to 6). ' + BAMBU_X2D_BOWDEN_SPEED,
          'Run the generated stringing/retraction test, changing one variable at a time: distance first, then speed if needed.',
          OOZE_LEVER_ORDER_NOTE,
          'If Developer mode is not available, fall back to Orca Slicer or an external stringing test model and copy the resulting distance/speed into Bambu Studio.'
        ],
        saveTo: {
          path: 'Printer settings → Extruder → Retraction  (per-filament: Filament settings → Setting Overrides → "Direct Drive Extruder" / "Bowden Extruder")',
          field: 'Length (mm), Retraction speed',
          scope: 'printer',
          note: 'Printer-scoped by default. Dual-nozzle filament presets store values as per-extruder ARRAYS; to override per filament, open Filament settings → Setting Overrides, switch the selector to "Direct Drive Extruder" or "Bowden Extruder", then tick Length under Retraction and enter the value. ' + BAMBU_BUG_10404
        },
        gotchas: [
          BAMBU_NON_BAMBU_FALLBACK,
          BAMBU_BUG_10404,
          NO_COASTING_NOTE,
          'Travel speed and wipe live in the process profile and z-hop in the printer profile — settings to CHECK when ooze survives a good retraction value, not values PerfectFit computes. On the X2D there is little left to win there: the stock process profile already travels at 1000 mm/s and the machine already wipes 2 mm with a 0.4 mm "Auto Lift" z-hop.'
        ]
      },
      'max-volumetric-speed': {
        available: true, builtIn: true,
        menuPath: 'Title bar → Calibration → More... → Max flowrate (Develop Mode)',
        steps: [
          'Select the Bambu printer and the filament preset with calibrated temperature and flow saved.',
          BAMBU_DEVELOPER_MODE_BEST_PATH,
          'Open the title-bar Calibration menu, then the "More..." submenu, and choose Max flowrate. (This is where Bambu Studio and Orca genuinely differ: in Orca, Max flowrate is a top-level Calibration entry with no "More..." submenu at all.)',
          'Slice and print the generated max-flow test; note where surface quality, layer bonding, or extruder sounds first degrade.',
          'Use the last good flow as the raw result, then enter a conservative production value with safety margin in the filament preset.',
          'Developer mode also exposes VFA calibration in Bambu Studio, alongside Max flowrate in the same "More..." submenu. PerfectFit does not currently score VFA as a separate wizard step, but you can run it from there when diagnosing speed-related ringing or vertical fine artifacts.'
        ],
        saveTo: {
          path: 'Filament settings → Filament tab',
          field: 'Max volumetric speed (mm³/s)',
          scope: 'filament',
          note: 'Enter the production (margin-applied) value.'
        },
        gotchas: [
          BAMBU_NON_BAMBU_FALLBACK,
          MVS_INVALIDATES_K,
          'Bambu\'s own reason for keeping headroom: they warn that "An incorrect maximum volumetric speed can lead to nozzle clogging". The height where the tower failed is a measurement, not a speed to print at.'
        ]
      },
      shrinkage: {
        available: true, builtIn: false,
        menuPath: '(external test model — no calibration menu entry)',
        steps: [
          'Bambu Studio has no built-in shrinkage test — use one of the external tools from the models list (the free Printables shrinkage tool reads the percentage directly off a printed vernier scale).',
          'Before slicing, open Filament settings → Filament and set Shrinkage to 100% (no compensation) — the test measures what the compensation SHOULD be.',
          'Print at 100% scale with your calibrated filament preset and normal process profile.',
          'Let the parts cool fully before reading — enclosure materials (ABS/ASA) keep contracting for a while.',
          'Enter the reading(s) in the result step.'
        ],
        saveTo: {
          path: 'Filament settings → Filament tab',
          field: 'Shrinkage — a percentage',
          scope: 'filament',
          note: 'Enter as a percentage (e.g. 99.4); Bambu Studio scales XY geometry up by 100/shrinkage%. Save as your user preset.'
        },
        gotchas: ['Re-slice existing plates after changing shrinkage — compensation is applied at slicing time.']
      },
      'ooze-control': {
        available: true, builtIn: false,
        menuPath: 'Checklist — Process settings (prime tower) + Filament Setting Overrides + Developer Mode parameters',
        steps: [
          OOZE_FORK_NOTE,
          'Dry both filaments first — moisture flashing to steam in the hotend is the top non-obvious ooze cause, and no setting compensates for a wet spool.',
          'Enable the prime tower (the primary mitigation): every toolchange wipes and re-primes on the tower instead of on your part. Set per-filament prime volumes and give leaky pairings (PETG especially) more volume.',
          'Verify the bowden retraction override is SET: Filament settings → Setting Overrides → switch the selector to "Bowden Extruder" → Retraction → tick Length and enter your calibrated aux value. ' + BAMBU_BUG_10404,
          'Confirm manual K for the auxiliary nozzle: Preferences → Develop Mode, then the title-bar Calibration menu → Pressure advance — on dual-nozzle machines the dialog shows a nozzle selector; pick the auxiliary nozzle. Test range 0–1 in 0.02 steps; typical aux K lands between 0.5 and 1.0.',
          'Still oozing on stubborn pairings? Bambu Studio 2.5+ Developer Mode exposes ramming length, precooling temperature, and post-ramming travel time — raise them gradually for leaky combinations like PETG on the aux nozzle.',
          'Print a small two-filament model with several toolchanges using your normal process profile, then judge the remaining ooze in the next step.'
        ],
        saveTo: {
          path: 'Prime tower: Process settings. Aux retraction: Filament settings → Setting Overrides → "Bowden Extruder"',
          field: 'Prime tower (+ prime volumes) and the per-extruder retraction Length override; optionally the Developer Mode ramming/precooling parameters',
          scope: 'process',
          note: 'Dual-nozzle Bambu filament presets store values as per-extruder ARRAYS (X2D filament profiles carry four per-path variants: normal / HF / bowden normal / bowden HF); the Setting Overrides selector writes the right array slot for you.'
        },
        gotchas: [
          'Why the idle nozzle oozes: on toolchange Bambu Studio emits M104 S0 for the inactive nozzle (letting it cool toward ~60 °C) and reheats it when needed again — the reheat causes a melt-zone pressure spike that oozes on resume, PETG worst. There is no official standby-temperature field.',
          BAMBU_X2D_TOOLCHANGE_DEFAULTS,
          'Some of the X2D\'s anti-ooze defence is mechanical, not a setting: Bambu documents a flow blocker under the toolhead that blocks the nozzle while it is idle, plus a silicone wiping pad on the purge wiper. If the auxiliary nozzle is smearing ooze during its own wipe routine, that routine can be turned off — no calibration number fixes a mechanical path.',
          'Advanced users only: editing the change-filament G-code to hold the idle nozzle at ~160–180 °C avoids the full cool/reheat cycle — at the cost of some standing ooze. Only go there after the checklist above.',
          BAMBU_GEAR_OFF_CAVEAT,
          BAMBU_K_SCALE_WARNING,
          BAMBU_X2D_AUX_CONSTRAINTS
        ]
      },
      'final-verification': {
        available: true, builtIn: false,
        menuPath: '(normal printing)',
        steps: [
          'Start a fresh project; select printer, your saved filament user preset, and normal process profile.',
          'Import a verification model or a real part.',
          'Confirm the preset contains your calibrated values; slice, preview, print.',
          'Inspect with the checklist in the next step.'
        ],
        saveTo: { path: '—', field: '—', scope: 'calibration-only', note: 'Nothing to save.' }
      }
    }
  }
];

export function getSlicerContent(slicer: SlicerId, version?: string): SlicerVersionContent {
  const all = SLICER_CONTENT.filter(c => c.slicer === slicer);
  if (version) {
    const exact = all.find(c => c.version === version);
    if (exact) return exact;
  }
  return all[all.length - 1];
}

export function slicerVersionOptions(): { slicer: SlicerId; label: string; version: string }[] {
  return SLICER_CONTENT.map(c => ({ slicer: c.slicer, label: `${c.slicerLabel} ${c.version}`, version: c.version }));
}
