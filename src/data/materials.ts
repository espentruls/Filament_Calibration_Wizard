import type { MaterialPreset } from '../types';

/**
 * Material presets: SUGGESTED starting points only.
 * Every range stays editable in the UI, and the app cross-checks
 * against the selected printer profile's limits before recommending anything.
 *
 * Sources: general manufacturer datasheet ranges; deliberately conservative.
 *
 * --- chamber guidance -------------------------------------------------------
 * `chamber` is GUIDANCE, never a calibration step, and is never written into a
 * slicer preset. Two numbers per material, both sourced:
 *
 *   `vendorC` — the chamber setpoint Bambu Studio ships for that material. In
 *     the shipped X2D presets `chamber_temperatures` is declared ONLY for the
 *     high-Tg families — ABS/ASA 60 (65 on Bambu's own-brand spools), the PA
 *     family 60, PC 60, PPA 60, PET-CF 50 — and is absent (inheriting 0) for
 *     every PLA, PETG, PCTG, TPU, PVA and PP preset. It is shown as a reference
 *     point, never used as the suggestion.
 *
 *   `maxC` — the hottest chamber Trim will ever suggest. Where a glass
 *     transition is published it is Tg − 10 °C, which is the vendor's own
 *     heat-creep rule ("keep the enclosure at least 10 degrees below the glass
 *     transition temperature"): PLA Tg 45 → 35, TPU 30 → 20, PETG 60 → 50,
 *     PCTG 90 → 80, ABS/ASA 100 → 90. Where no Tg is published here, the
 *     vendor's own setpoint is the ceiling instead — Trim does not go
 *     above a shipped value without evidence.
 *
 * The classification is the load-bearing half, not the number. "Chamber as hot
 * as it goes" is right for ABS/ASA and actively damaging for PLA and PETG: a hot
 * chamber heat-soaks the filament path and softens filament ABOVE the melt zone,
 * which is heat creep — jams, ground filament, a hotend that comes apart.
 */
export const MATERIALS: MaterialPreset[] = [
  {
    id: 'PLA', label: 'PLA',
    description: 'The most common, easiest material. Low warp, prints cool.',
    nozzleTemp: { min: 190, max: 230 }, bedTemp: { min: 50, max: 65 },
    towerRange: { start: 230, end: 190, step: 5 },
    startingFlowRatio: 0.98,
    mvsRange: { start: 5, end: 20, step: 0.5 }, typicalMvs: 12,
    chamber: {
      advice: 'ambient', maxC: 35,
      why: 'PLA softens around 45 °C. A heated chamber warms the whole filament path, so the filament goes soft above the melt zone instead of in it — that is heat creep, and it ends in a jam and ground filament. Leave chamber heating off.'
    },
    warnings: []
  },
  {
    id: 'PLA+', label: 'PLA+ / Tough PLA',
    description: 'Modified PLA with better toughness; usually likes slightly higher temps than plain PLA.',
    nozzleTemp: { min: 200, max: 235 }, bedTemp: { min: 50, max: 70 },
    towerRange: { start: 235, end: 195, step: 5 },
    startingFlowRatio: 0.98,
    mvsRange: { start: 5, end: 20, step: 0.5 }, typicalMvs: 12,
    chamber: {
      advice: 'ambient', maxC: 35,
      why: 'PLA+ is still a PLA: it softens near 45 °C, and a warm chamber softens it in the feed path above the melt zone. That is heat creep — jams and ground filament. Leave chamber heating off.'
    },
    warnings: ['"PLA+" formulations vary a lot between brands — trust the spool label over this preset.']
  },
  {
    id: 'PETG', label: 'PETG',
    description: 'Tough, slightly flexible, good chemical resistance. Tends to string and stick hard to some plates.',
    nozzleTemp: { min: 220, max: 260 }, bedTemp: { min: 70, max: 85 },
    towerRange: { start: 260, end: 220, step: 5 },
    startingFlowRatio: 0.95,
    mvsRange: { start: 4, end: 15, step: 0.5 }, typicalMvs: 9,
    hygroscopic: true,
    chamber: {
      advice: 'ambient', maxC: 50,
      why: 'PETG softens around 60 °C. A heated chamber warms the filament path above the melt zone and causes heat creep — jams and ground filament — so leave chamber heating off. PETG does not warp enough to need it.'
    },
    warnings: [
      'PETG often arrives WET from the factory — standard plastic bags with desiccant are not proof of dryness. Dry it before calibrating (typically 65 °C for 4–6 h), even brand-new spools.',
      'PETG can bond permanently to bare glass or PEI at high bed temps — use a release agent or textured plate if unsure.',
      'PETG strings more than PLA; expect to rely on the retraction test.'
    ]
  },
  {
    id: 'PCTG', label: 'PCTG',
    description: 'A tougher, less stringy relative of PETG.',
    nozzleTemp: { min: 240, max: 270 }, bedTemp: { min: 70, max: 90 },
    towerRange: { start: 270, end: 240, step: 5 },
    startingFlowRatio: 0.95,
    mvsRange: { start: 4, end: 15, step: 0.5 }, typicalMvs: 9,
    hygroscopic: true,
    chamber: {
      advice: 'ambient', maxC: 80,
      why: 'PCTG takes more heat than PETG (it softens near 90 °C), but it does not need a heated chamber and the slicer vendor ships none for it. Leave chamber heating off unless the datasheet asks for it.'
    },
    warnings: [
      'Like PETG, PCTG can arrive wet even in sealed packaging — dry new spools before calibrating.',
      'Check that your hotend is rated for sustained printing at 260 °C+.'
    ]
  },
  {
    // Temperature, bed and flow numbers here are FIELD-VALIDATED on a Bambu Lab
    // X2D (nozzle, bed and chamber all in range; no warping; first layer stuck
    // perfectly) and independently corroborated by the shipped Bambu presets:
    // `filament_flow_ratio` 0.95 matches exactly, and the documented ABS window
    // is 240–280 with a 270 default, which this tower brackets. They are not to
    // be churned without stronger evidence than either of those.
    //
    // `typicalMvs` deliberately stays at 10 even though Bambu's X2D ABS presets
    // clamp `filament_max_volumetric_speed` to 15–16: that ceiling is a property
    // of that machine's hotend (its rated flow is 22 mm³/s), while this field is
    // material-scoped and feeds exactly one thing — a hint when a measurement
    // lands below 0.6 × typical. Raising it to a machine-specific number would
    // fire that hint on every slower printer. The 4–18 test range already
    // brackets Bambu's 15–16, so the measurement can find it.
    id: 'ABS', label: 'ABS',
    description: 'Strong and heat-resistant, but warps: needs a hot bed and ideally an enclosure. Fumes — ventilate.',
    nozzleTemp: { min: 230, max: 270 }, bedTemp: { min: 90, max: 110 },
    towerRange: { start: 270, end: 230, step: 5 },
    startingFlowRatio: 0.95,
    mvsRange: { start: 4, end: 18, step: 0.5 }, typicalMvs: 10,
    hygroscopic: true, enclosureRecommended: true,
    chamber: {
      // 70 °C, not the 90 an inherited generic Tg would give.
      // `fdm_filament_abs.json` declares no `temperature_vitrification` of its
      // own — the 100 °C comes from `fdm_filament_common.json` and is a default,
      // not an ABS measurement. Bambu's ABS-SPECIFIC numbers in the same files
      // are `filament_dev_drying_softening_temperature` 80 and
      // `filament_dev_ams_drying_heat_distortion_temperature` 90, so a 90 °C
      // chamber would hold the spool and feed path at ABS's own heat-distortion
      // temperature — and this file's own drying warning forbids 80 °C. 10 °C
      // below the softening point is the ceiling that agrees with both.
      // (No effect on the X2D, whose 65 °C machine limit binds first.)
      advice: 'hot', vendorC: 60, maxC: 70,
      why: 'ABS warps as it cools unevenly, and a warm chamber is the fix — it flattens the thermal gradient and keeps layer bonds strong. It softens at about 80 °C, so the chamber stays below that: the feed path and the spool sit in the chamber too, and softening filament before it reaches the melt zone is heat creep.'
    },
    warnings: [
      'ABS produces fumes (styrene) — print in a ventilated space, ideally an enclosure with filtration.',
      'Check your printer\'s max bed temperature: many beds cannot reach 100 °C.',
      'ABS absorbs moisture — dry it before calibrating: 65 °C for 12 h, or 80 °C for 8 h. Do not go above 80 °C; that is ABS\'s own softening point and it distorts by 90 °C. An old open spool should be assumed wet however it looks.',
      'Wet ABS oozes in a way no retraction value can fix: the steam pressure is generated inside the melt, downstream of the extruder. Extrude 100 mm into open air first — popping, a bubbly or matte strand, or extrusion that keeps running after you stop it all mean "dry it and start over".'
    ]
  },
  {
    id: 'ASA', label: 'ASA',
    description: 'Like ABS but UV-stable for outdoor parts. Same enclosure and ventilation needs.',
    nozzleTemp: { min: 240, max: 270 }, bedTemp: { min: 90, max: 110 },
    towerRange: { start: 270, end: 240, step: 5 },
    startingFlowRatio: 0.95,
    mvsRange: { start: 4, end: 16, step: 0.5 }, typicalMvs: 10,
    hygroscopic: true, enclosureRecommended: true,
    chamber: {
      // 75 °C for the same reason ABS is 70: ASA's own softening temperature is
      // 85 °C (Bambu's `filament_dev_drying_softening_temperature`), not the
      // 100 °C generic vitrification default its preset inherits. 10 °C below
      // that is the ceiling. (No effect on the X2D — its 65 °C limit binds.)
      advice: 'hot', vendorC: 60, maxC: 75,
      why: 'ASA warps like ABS and wants the same warm chamber, for the same reason: a smaller thermal gradient means less internal stress and stronger layer bonds. It softens at about 85 °C, so the chamber stays below that — the spool and feed path sit in the chamber too, and filament that softens before the melt zone jams instead of extruding.'
    },
    warnings: [
      'ASA produces fumes — ventilate. Enclosure strongly recommended to prevent warping.',
      'ASA absorbs moisture — dry it before calibrating: 65 °C for 12 h, or 80 °C for 8 h, and never above 80 °C (its softening point). Wet ASA strings and oozes no matter how retraction is set.'
    ]
  },
  {
    id: 'TPU', label: 'TPU (flexible)',
    description: 'Flexible filament. Print slow, minimal retraction; hard for Bowden extruders.',
    nozzleTemp: { min: 210, max: 240 }, bedTemp: { min: 30, max: 60 },
    towerRange: { start: 240, end: 210, step: 5 },
    startingFlowRatio: 1.0,
    mvsRange: { start: 1, end: 8, step: 0.5 }, typicalMvs: 3.5,
    flexible: true, hygroscopic: true,
    chamber: {
      advice: 'ambient', maxC: 20,
      why: 'TPU softens around 30 °C — lower than any other common filament. A heated chamber makes soft filament softer exactly where it has to be pushed, so it buckles and jams. Leave chamber heating off.'
    },
    warnings: [
      'TPU frequently arrives WET even in sealed factory bags, and wet TPU strings and bubbles badly — dry it before calibrating (typically 50–60 °C for 6–12 h), even brand-new spools.',
      'Flexible filaments can bind or buckle in Bowden systems — reduce retraction drastically and print slowly.',
      'High retraction with TPU commonly jams extruders. Start near zero.'
    ]
  },
  {
    id: 'PA', label: 'PA / Nylon',
    description: 'Very tough and wear-resistant, but extremely moisture-sensitive: must be dried before calibrating.',
    nozzleTemp: { min: 250, max: 290 }, bedTemp: { min: 70, max: 100 },
    towerRange: { start: 290, end: 250, step: 5 },
    startingFlowRatio: 0.95,
    mvsRange: { start: 3, end: 14, step: 0.5 }, typicalMvs: 8,
    hygroscopic: true, enclosureRecommended: true,
    chamber: {
      advice: 'hot', vendorC: 60, maxC: 60,
      why: 'Nylon warps badly and a warm chamber holds it flat. The slicer vendor ships 60 °C for the whole PA family, and Trim does not suggest above a shipped setpoint without evidence.'
    },
    warnings: [
      'Wet nylon is uncalibratable — dry it (typically 70–80 °C for 8–12 h) before any test.',
      'Many stock hotends with PTFE liners are NOT safe above 250 °C — verify an all-metal hot path.'
    ]
  },
  {
    id: 'PA-CF', label: 'PA-CF (carbon-filled nylon)',
    description: 'Carbon-fiber-filled nylon: stiff, dimensionally stable, abrasive.',
    nozzleTemp: { min: 260, max: 300 }, bedTemp: { min: 70, max: 100 },
    towerRange: { start: 300, end: 260, step: 5 },
    startingFlowRatio: 0.95,
    mvsRange: { start: 2, end: 12, step: 0.5 }, typicalMvs: 7,
    hygroscopic: true, enclosureRecommended: true,
    chamber: {
      advice: 'hot', vendorC: 60, maxC: 60,
      why: 'Carbon-filled nylon still warps and still wants a warm chamber. The slicer vendor ships 60 °C for the whole PA family, and Trim does not suggest above a shipped setpoint without evidence.'
    },
    warnings: [
      'Abrasive: requires a hardened steel (or better) nozzle. Brass will wear out quickly.',
      'Dry before calibrating; verify your hotend is rated for 280 °C+.'
    ]
  },
  {
    id: 'PA-GF', label: 'PA-GF (glass-filled nylon)',
    description: 'Glass-fiber-filled nylon: strong and heat resistant, very abrasive.',
    nozzleTemp: { min: 260, max: 300 }, bedTemp: { min: 70, max: 100 },
    towerRange: { start: 300, end: 260, step: 5 },
    startingFlowRatio: 0.95,
    mvsRange: { start: 2, end: 12, step: 0.5 }, typicalMvs: 7,
    hygroscopic: true, enclosureRecommended: true,
    chamber: {
      advice: 'hot', vendorC: 60, maxC: 60,
      why: 'Glass-filled nylon warps like plain nylon and wants the same warm chamber. The slicer vendor ships 60 °C for the whole PA family, and Trim does not suggest above a shipped setpoint without evidence.'
    },
    warnings: [
      'Very abrasive: hardened nozzle required.',
      'Dry before calibrating; verify hotend temperature rating.'
    ]
  },
  {
    id: 'PC', label: 'PC (polycarbonate)',
    description: 'Very strong and heat resistant; demands high temps and an enclosure.',
    nozzleTemp: { min: 260, max: 310 }, bedTemp: { min: 90, max: 115 },
    towerRange: { start: 310, end: 260, step: 5 },
    startingFlowRatio: 0.95,
    mvsRange: { start: 2, end: 12, step: 0.5 }, typicalMvs: 8,
    hygroscopic: true, enclosureRecommended: true,
    chamber: {
      advice: 'hot', vendorC: 60, maxC: 60,
      why: 'Polycarbonate warps hard and a warm chamber is close to mandatory. Its glass transition is high (around 120 °C), but the slicer vendor ships 60 °C for it and Trim does not suggest above a shipped setpoint without evidence.'
    },
    warnings: [
      'Requires an all-metal hotend rated well above 280 °C and usually a 100 °C+ bed — check both limits.',
      'Most open-frame printers cannot print PC reliably.'
    ]
  },
  {
    id: 'PPA', label: 'PPA (high-temp nylon)',
    description: 'High-performance polyphthalamide; industrial material with demanding requirements.',
    nozzleTemp: { min: 280, max: 320 }, bedTemp: { min: 100, max: 120 },
    towerRange: { start: 320, end: 280, step: 5 },
    startingFlowRatio: 0.95,
    mvsRange: { start: 2, end: 10, step: 0.5 }, typicalMvs: 6,
    hygroscopic: true, enclosureRecommended: true,
    chamber: {
      advice: 'hot', vendorC: 60, maxC: 60,
      why: 'PPA is a high-temperature nylon and warps accordingly; a warm chamber is expected. The slicer vendor ships 60 °C for it, and Trim does not suggest above a shipped setpoint without evidence.'
    },
    warnings: [
      'Exceeds the temperature limits of most consumer printers — verify every limit before attempting.',
      'Usually fiber-filled: hardened nozzle required.'
    ]
  },
  {
    id: 'PPS', label: 'PPS',
    description: 'Extreme-performance polymer (chemical + heat resistance). Requires specialized hardware.',
    nozzleTemp: { min: 300, max: 340 }, bedTemp: { min: 100, max: 140 },
    towerRange: { start: 340, end: 300, step: 5 },
    startingFlowRatio: 0.95,
    mvsRange: { start: 2, end: 10, step: 0.5 }, typicalMvs: 5,
    hygroscopic: true, enclosureRecommended: true,
    chamber: {
      advice: 'hot',
      why: 'PPS needs an actively heated chamber, but no vendor setpoint is shipped for it and no glass transition is recorded here — so Trim offers no number. Take it from the manufacturer datasheet.'
    },
    warnings: [
      'Only for machines rated for 300 °C+ nozzle, heated chamber recommended. Most printers cannot print PPS.',
      'Consult the manufacturer datasheet — ranges vary widely.'
    ]
  },
  {
    id: 'OTHER', label: 'Other / specialty',
    description: 'Anything not listed. Enter ranges from the manufacturer\'s datasheet.',
    nozzleTemp: { min: 190, max: 260 }, bedTemp: { min: 40, max: 100 },
    towerRange: { start: 250, end: 200, step: 5 },
    startingFlowRatio: 1.0,
    mvsRange: { start: 3, end: 15, step: 0.5 }, typicalMvs: 8,
    chamber: {
      advice: 'unknown',
      why: 'No chamber guidance exists for an unlisted material. Use the datasheet: as a rule, keep the chamber at least 10 °C below the material\'s glass transition, and leave it off entirely for anything that softens below about 60 °C.'
    },
    warnings: ['No preset exists for this material — use the ranges printed on the spool or datasheet.']
  }
];

export function getMaterial(id: string): MaterialPreset {
  return MATERIALS.find(m => m.id === id) ?? MATERIALS[MATERIALS.length - 1];
}
