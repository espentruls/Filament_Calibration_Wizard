import type { ChamberAdvice, CalibrationId, CalibrationProject, ExtruderType, MaterialPreset, NozzleProfile, PrinterProfile } from '../types';
import { getMaterial } from '../data/materials';

/**
 * Suggested default test ranges, derived from material preset + printer
 * profile + extruder type. Always editable; validated against printer limits.
 */

export interface RangeSuggestion {
  start: number;
  end: number;
  step: number;
  warnings: string[];
}

/**
 * The longest retraction PerfectFit will suggest, compute, display or install
 * for a flexible filament. Long retractions drag soft filament into the cold
 * zone: grinding, a plugged heatbreak, and on many extruders a jam that needs
 * the hotend taken apart.
 *
 * One constant, imported everywhere the number is enforced (the suggestion
 * layer here, the retraction test form, and the profile write path in
 * src/slicerIntegration/validation.ts) so the layers cannot drift apart and
 * tell the user two different stories.
 */
export const FLEXIBLE_RETRACTION_MAX_MM = 1.5;

/**
 * Resolve which physical nozzle a project calibrates. On legacy single-nozzle
 * profiles (no `nozzles` array) the effective feed falls back to the printer's
 * extruder type; without a printer it defaults to direct drive.
 */
export function resolveNozzle(
  project: Pick<CalibrationProject, 'nozzleIndex'>,
  printer?: PrinterProfile
): { nozzle?: NozzleProfile; index: number; feed: ExtruderType } {
  const index = project.nozzleIndex ?? 0;
  const nozzle = printer?.nozzles?.[index];
  return { nozzle, index, feed: nozzle?.feed ?? printer?.extruderType ?? 'direct' };
}

/**
 * How many PHYSICAL nozzles a printer profile declares, and whether the app is
 * entitled to show per-nozzle machinery for it.
 *
 * This exists because "how many nozzles?" has three answers, not two, and
 * because the tempting fourth source of the number is wrong. A filament
 * preset's value-slot count is NOT a nozzle count: a single-nozzle Bambu P2S
 * presents three value slots, which are the Standard / High Flow / E3D High
 * Flow hotend variants of one physical nozzle, while a two-nozzle X2D presents
 * four or six depending on the bundle version. Slot count carries no nozzle
 * information in either direction, so nothing here may be derived from it — the
 * only sound source is the printer profile's own `nozzles` list.
 */
export type NozzleTopologyKind = 'single' | 'multi' | 'unknown';

export interface NozzleTopology {
  kind: NozzleTopologyKind;
  /** Physical nozzles. 0 when there is no printer profile to ask. */
  count: number;
  /** The declared nozzles, empty when the profile lists none. */
  nozzles: NozzleProfile[];
  /**
   * True only when the profile declares two or more physical nozzles WITH their
   * feed paths — i.e. when a per-nozzle choice is a real, answerable question.
   * A single-nozzle machine must never be shown dual-nozzle machinery, and
   * neither must a machine we merely suspect has two.
   */
  perNozzle: boolean;
  /** One sentence when the profile is ambiguous or self-contradictory. */
  note: string | null;
}

export function nozzleTopology(printer?: PrinterProfile): NozzleTopology {
  if (!printer) {
    return {
      kind: 'unknown', count: 0, nozzles: [], perNozzle: false,
      note: 'No printer profile is selected, so PerfectFit cannot say how many nozzles this machine has.'
    };
  }
  const nozzles = printer.nozzles ?? [];
  const declared = printer.extruderCount;
  if (nozzles.length >= 2) {
    const disagrees = typeof declared === 'number' && declared !== nozzles.length;
    return {
      kind: 'multi', count: nozzles.length, nozzles, perNozzle: true,
      note: disagrees
        ? `This profile lists ${nozzles.length} nozzles but records ${declared} extruder(s). The nozzle list is what PerfectFit calibrates against — correct whichever is wrong in the printer profile.`
        : null
    };
  }
  if (nozzles.length === 1) {
    return { kind: 'single', count: 1, nozzles, perNozzle: false, note: null };
  }
  // No nozzle list. An extruder count above one says there is more hardware
  // here than the profile describes, but not which physical nozzle is which or
  // how each is fed — and without the feed path there is nothing honest to
  // suggest per nozzle. So this reads as unknown, not as a second nozzle.
  if (typeof declared === 'number' && declared > 1) {
    return {
      kind: 'unknown', count: declared, nozzles: [], perNozzle: false,
      note: `This profile records ${declared} extruders but lists no nozzles, so PerfectFit cannot tell them apart or say how each one is fed. Add them under Nozzles in the printer profile to calibrate one nozzle at a time.`
    };
  }
  return { kind: 'single', count: 1, nozzles: [], perNozzle: false, note: null };
}

/**
 * Small badge text identifying the project's nozzle, shown next to the project
 * name. Null when the project has no nozzle choice worth showing.
 */
export function nozzleBadgeLabel(
  project: Pick<CalibrationProject, 'nozzleIndex'>,
  printer?: PrinterProfile
): string | null {
  if (project.nozzleIndex === undefined) return null;
  const nozzle = printer?.nozzles?.[project.nozzleIndex];
  if (nozzle) return nozzle.label;
  return project.nozzleIndex > 0 ? `Nozzle ${project.nozzleIndex + 1}` : null;
}

/**
 * One-line caution for a final retraction distance that a flexible filament
 * should never be printed with, or null when there is nothing to say.
 *
 * The browser build has no install path, so the report, the printable card and
 * the clipboard copy ARE the deliverable there: the cap has to be visible on
 * them, not only on the desktop write path.
 */
export function flexibleRetractionCaution(
  materialId: string,
  retractionMm: number | undefined
): string | null {
  if (retractionMm === undefined || !Number.isFinite(retractionMm)) return null;
  if (!getMaterial(materialId).flexible) return null;
  if (retractionMm <= FLEXIBLE_RETRACTION_MAX_MM) return null;
  return `Above the ${FLEXIBLE_RETRACTION_MAX_MM} mm limit PerfectFit applies to flexible filament — long retractions pull soft filament into the cold zone and jam the extruder. Use the lowest acceptable distance at or under ${FLEXIBLE_RETRACTION_MAX_MM} mm.`;
}

/**
 * A machine limit worth clamping against: present, finite, and above zero.
 *
 * A saved profile can carry 0 or a non-number for a limit it never learned —
 * `undefined` from a database record with no value, or a corrupted import.
 * Clamping to those produces suggestions no printer can execute (a temperature
 * tower running from 0 °C down to -20 °C), so a limit like that is treated as
 * "not stated" and simply not applied. The value is still checked at entry by
 * `validateAgainstPrinter`, which is where a genuinely impossible machine has to
 * surface — a suggestion layer must not invent negative temperatures.
 */
function statedLimit(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function suggestTempRange(materialId: string, printer?: PrinterProfile): RangeSuggestion {
  const m = getMaterial(materialId);
  let { start, end, step } = m.towerRange;
  const warnings: string[] = [];
  const limit = statedLimit(printer?.maxNozzleTemp);
  if (limit !== undefined && start > limit) {
    warnings.push(`The suggested start (${start} °C) exceeds this printer's max nozzle temperature (${limit} °C). Clamped — but verify this material is printable on this machine at all.`);
    start = limit;
    // Keep a usable descending span (≥20 °C) after clamping, without ever
    // descending below a temperature a hotend could actually hold.
    if (end > start - 15) end = Math.max(Math.round(start / 2), start - 20);
  }
  return { start, end, step, warnings };
}

/**
 * What to do with the build chamber for this material on this machine.
 *
 * Chamber temperature is GUIDANCE, not a calibration: there is no measurable
 * optimum to search for, so PerfectFit never adds a step for it and never writes
 * it into a preset. What it does do is refuse to let one instruction ("run the
 * chamber hot") be applied to a material it damages.
 *
 * The number, when there is one, is the hottest the MACHINE allows, capped by
 * the material's own ceiling — never a vendor setpoint copied blind, and never
 * a number at all when either side is unknown.
 */
export interface ChamberSuggestion {
  advice: ChamberAdvice;
  /**
   * The chamber temperature to set (°C), or undefined when nothing can be
   * sourced and clamped. 0 means "heater off", which is a real instruction.
   */
  suggestedC?: number;
  /** One sentence, sentence case: the instruction itself. */
  headline: string;
  /** Reasons and caveats. Amber material — cautions, not decoration. */
  warnings: string[];
  /**
   * True when the MATERIAL's own ceiling held the number below what the machine
   * could have done — i.e. PerfectFit is deliberately not using the whole range.
   */
  clamped: boolean;
}

/**
 * True when this printer profile is known to be able to heat its chamber.
 *
 * Deliberately three-state-ish: an absent `heatedChamber` with an absent
 * `maxChamberTemp` means "not specified", which reads as false here — the app
 * says nothing about a chamber it has no evidence exists. The one definition,
 * shared by the suggestion layer, the session advisory and the New Project
 * screen, so those three cannot disagree about whether there is a heater to talk
 * about at all.
 */
export function printerCanHeatChamber(printer?: PrinterProfile): boolean {
  if (!printer || printer.heatedChamber === false) return false;
  if (printer.maxChamberTemp === 0) return false;
  return printer.heatedChamber === true || statedLimit(printer.maxChamberTemp) !== undefined;
}

export function suggestChamberTemp(materialId: string, printer?: PrinterProfile): ChamberSuggestion {
  const m = getMaterial(materialId);
  const g = m.chamber;
  const warnings: string[] = [];
  const rawMax = typeof printer?.maxChamberTemp === 'number' && Number.isFinite(printer.maxChamberTemp)
    ? printer.maxChamberTemp
    : undefined;
  const machineMax = statedLimit(rawMax);
  /** The profile positively says there is no chamber heating to use. */
  const noChamber = printer !== undefined && (printer.heatedChamber === false || rawMax === 0);
  const canHeat = printerCanHeatChamber(printer);

  if (g.advice === 'unknown') {
    return {
      advice: 'unknown', clamped: false, warnings: [g.why],
      headline: `No chamber guidance exists for ${m.label} — take the number from the spool label or datasheet.`
    };
  }

  if (g.advice === 'ambient') {
    // The correctness trap. "As hot as it goes" is right for ABS and wrong here,
    // so this branch always answers with a number: zero.
    warnings.push(g.why);
    if (canHeat) {
      const named = printer?.name ? `"${printer.name}"` : 'This printer';
      const upto = machineMax !== undefined ? ` to ${machineMax} °C` : '';
      const ceiling = g.maxC !== undefined
        ? ` If your machine heats the chamber whether you ask it to or not, keep it at or below ${g.maxC} °C.`
        : '';
      warnings.push(`${named} can heat its chamber${upto}. Leave that off for ${m.label}.${ceiling}`);
    }
    return {
      advice: 'ambient', suggestedC: 0, clamped: false, warnings,
      headline: `Leave chamber heating off for ${m.label} — set the chamber target to 0 °C.`
    };
  }

  // advice === 'hot'
  if (noChamber) {
    const named = printer?.name ? `"${printer.name}"` : 'this printer profile';
    return {
      advice: 'hot', clamped: false,
      headline: `${m.label} wants a warm chamber, but ${named} states no heated chamber. A passive enclosure still helps — expect more warping without one.`,
      warnings: [g.why]
    };
  }

  // A number needs BOTH ends: a machine ceiling to stay under and a material
  // ceiling to stay under. Missing either, the advice is given in words. An
  // unstated machine limit is not permission to name a temperature — nothing
  // here knows what that chamber can hold.
  if (machineMax === undefined || g.maxC === undefined) {
    const vendor = g.vendorC !== undefined
      ? ` The slicer vendor ships ${g.vendorC} °C for it.`
      : '';
    const ceiling = g.maxC !== undefined
      ? ` Never above ${g.maxC} °C for this material.`
      : '';
    const reason = machineMax === undefined
      ? 'this printer profile does not state a chamber limit'
      : 'PerfectFit has no sourced ceiling for this material';
    return {
      advice: 'hot', clamped: false,
      headline: `${m.label} wants the chamber as warm as the machine allows, but ${reason} — so PerfectFit names no number here.${ceiling}${vendor}`,
      warnings: [g.why]
    };
  }

  const suggestedC = Math.floor(Math.min(machineMax, g.maxC));
  const clamped = g.maxC < machineMax;
  warnings.push(g.why);
  if (g.vendorC !== undefined) {
    if (suggestedC > g.vendorC) {
      warnings.push(`The slicer vendor ships ${g.vendorC} °C for ${m.label}; anything from there up to this machine's ${suggestedC} °C is normal. Higher is not automatically better — it is the warping that decides.`);
    } else if (suggestedC < g.vendorC) {
      warnings.push(`The slicer vendor ships ${g.vendorC} °C for ${m.label}, which this machine cannot reach — ${suggestedC} °C is its ceiling. Expect a little more warping.`);
    } else {
      warnings.push(`This matches the ${g.vendorC} °C the slicer vendor ships for ${m.label}.`);
    }
  }
  return {
    advice: 'hot', suggestedC, clamped, warnings,
    // Which of the two ceilings actually decided the number is the whole point
    // of `clamped`, and saying "as warm as this machine allows" when the
    // MATERIAL held it back misreports the machine's capability.
    headline: clamped
      ? `Run the chamber at ${suggestedC} °C for ${m.label} — the ceiling for this material, below the ${machineMax} °C this machine could reach.`
      : `Run the chamber at ${suggestedC} °C for ${m.label} — as warm as this machine allows.`
  };
}

export function suggestPaRange(extruder: ExtruderType, material: MaterialPreset, highFlow = false, nozzle?: NozzleProfile): RangeSuggestion {
  // Klipper-style ballparks; all editable. Flexible filaments need much more PA.
  const flexibleWarning = 'Flexible filaments (TPU) often need noticeably higher PA than rigid ones and respond less predictably — expect a wider usable band.';
  const auxBowden = nozzle?.feed === 'bowden';
  if (extruder === 'bowden') {
    // Bowden wins the range: even flexibles need the wide Bowden band.
    // The 0–1 / 0.02 band matches Bambu's remote-extruder (aux nozzle) guidance.
    const warnings = ['Bowden systems need much larger PA values; the transition is also less sharp.'];
    if (auxBowden) {
      warnings.push('This project calibrates a bowden-fed auxiliary nozzle: expect K far above direct-drive values — typical results land between 0.5 and 1.0 (a PETG example is ~0.72), versus 0–0.1 on the direct-drive side.');
      warnings.push('On Bambu dual-nozzle machines, automatic Flow Dynamics covers the MAIN hotend only — the auxiliary nozzle must be calibrated with the manual test (see the slicer steps).');
      if (material.flexible) warnings.push('The auxiliary nozzle is not rated for flexible filaments — calibrate TPU on the main (direct drive) nozzle instead.');
    }
    if (material.flexible) warnings.push(flexibleWarning);
    return { start: 0, end: 1.0, step: 0.02, warnings };
  }
  if (material.flexible) {
    return { start: 0, end: 0.2, step: 0.005, warnings: [flexibleWarning] };
  }
  if (highFlow) {
    return { start: 0, end: 0.08, step: 0.002, warnings: ['High-flow hotends usually land at lower PA than standard hotends of the same type.'] };
  }
  return { start: 0, end: 0.1, step: 0.002, warnings: [] };
}

export function suggestRetractionRange(extruder: ExtruderType, material: MaterialPreset, printer?: PrinterProfile, nozzle?: NozzleProfile): RangeSuggestion {
  const warnings: string[] = [];
  const auxBowden = nozzle?.feed === 'bowden';
  let s: RangeSuggestion;
  if (material.flexible) {
    s = { start: 0, end: FLEXIBLE_RETRACTION_MAX_MM, step: 0.1, warnings: [`Keep retraction minimal for flexible filament — long retractions jam extruders. PerfectFit will not install a flexible retraction above ${FLEXIBLE_RETRACTION_MAX_MM} mm.`] };
    if (auxBowden) s.warnings.push('The auxiliary nozzle is not rated for flexible filaments — calibrate TPU on the main (direct drive) nozzle instead.');
  } else if (auxBowden) {
    // Bowden-fed auxiliary nozzle (X2D-style remote extruder). The printer
    // profile's saved retraction range describes the MAIN feed path, so it is
    // deliberately not applied here.
    return {
      start: 2, end: 6, step: 0.5,
      warnings: [
        // Speeds are per feed path, and quoting the main nozzle's figure here
        // was wrong: the X2D machine preset declares retraction_speed and
        // deretraction_speed as ["30","30","20","20"], indexed by extruder
        // variant — slots 0/1 are the direct-drive variants, 2/3 the bowden
        // ones. 30 mm/s is the direct-drive value; the auxiliary ships 20.
        'Bowden-fed auxiliary nozzle: start at the 2 mm machine default and raise in ~0.5 mm steps — most filaments land between 2 and 4 mm (up to 6 for stubborn ones). The X2D ships 20 mm/s retract and 20 mm/s deretract on its bowden slots; the 30 mm/s figure is the direct-drive main-nozzle value. Change length before speed.',
        'Bambu Studio bug #10404: leaving the "Bowden Extruder" retraction override unset ("nil") silently falls back to the 0.8 mm MAIN default on the auxiliary nozzle — always tick Length and set it explicitly.'
      ]
    };
  } else if (extruder === 'bowden') {
    s = { start: 1, end: 6, step: 0.2, warnings: [] };
  } else {
    s = { start: 0, end: 2, step: 0.1, warnings: [] };
  }
  if (printer && printer.retractionRange && printer.retractionRange.end > 0) {
    const materialStart = s.start;
    s.start = printer.retractionRange.start;
    // Flexibles keep the flexible-safe cap — a saved profile range must not push TPU into jam territory.
    s.end = material.flexible ? Math.min(printer.retractionRange.end, s.end) : printer.retractionRange.end;
    // The flexible cap can pull the end below a profile start meant for rigid
    // filament — clamp the start too so the suggestion stays ascending.
    if (s.start >= s.end) s.start = Math.min(materialStart, s.end);
    warnings.push('Using the starting range saved in the printer profile.');
  }
  s.warnings.push(...warnings);
  return s;
}

export function suggestMvsRange(materialId: string, printer?: PrinterProfile): RangeSuggestion {
  const m = getMaterial(materialId);
  let { start, end, step } = m.mvsRange;
  const warnings: string[] = [];
  if (printer?.maxVolumetricFlow && printer.maxVolumetricFlow > 0 && end > printer.maxVolumetricFlow * 1.25) {
    warnings.push(`Test end reduced toward the printer's rated max flow (${printer.maxVolumetricFlow} mm³/s) — testing far beyond the machine's rating mostly measures the machine, not the filament.`);
    end = Math.max(start + 2, Math.round(printer.maxVolumetricFlow * 1.25));
  }
  return { start, end, step, warnings };
}

export function suggestFlowMethodDefaults(method: string): { modifiers: number[] } {
  switch (method) {
    case 'yolo': return { modifiers: [-0.05, -0.04, -0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03, 0.04, 0.05] };
    case 'yolo-perfectionist': return { modifiers: [-0.04, -0.035, -0.03, -0.025, -0.02, -0.015, -0.01, -0.005, 0, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.035] };
    case 'pass1': return { modifiers: [-20, -15, -10, -5, 0, 5, 10, 15, 20] };
    case 'pass2': return { modifiers: [-9, -8, -7, -6, -5, -4, -3, -2, -1, 0] };
    default: return { modifiers: [] };
  }
}

export const STEP_DEPENDENCY_WARNINGS: Partial<Record<CalibrationId, string>> = {
  'flow-pass1': 'Flow results are only trustworthy after temperature is calibrated.',
  'flow-pass2': 'Pass 2 requires the Pass 1 (or YOLO) result saved in the profile.',
  'pressure-advance': 'Pressure Advance is judged by line width — calibrate flow first.',
  'flow-verify': 'The re-check only makes sense AFTER Pressure Advance is calibrated and saved — that\'s what it verifies against.',
  retraction: 'Stringing depends on temperature and pressure — calibrate those first.',
  'max-volumetric-speed': 'Max flow depends strongly on temperature — calibrate it first.',
  shrinkage: 'Dimensions are only meaningful after temperature and flow are locked in — over-extrusion fakes low shrinkage.',
  'ooze-control': 'Ooze behavior depends on retraction and pressure advance — calibrate those first.',
  'final-verification': 'Verification is only meaningful after the other calibrations.'
};
