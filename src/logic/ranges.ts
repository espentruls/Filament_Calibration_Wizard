import type { CalibrationId, CalibrationProject, ExtruderType, MaterialPreset, NozzleProfile, PrinterProfile } from '../types';
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

export function suggestTempRange(materialId: string, printer?: PrinterProfile): RangeSuggestion {
  const m = getMaterial(materialId);
  let { start, end, step } = m.towerRange;
  const warnings: string[] = [];
  if (printer && start > printer.maxNozzleTemp) {
    warnings.push(`The suggested start (${start} °C) exceeds this printer's max nozzle temperature (${printer.maxNozzleTemp} °C). Clamped — but verify this material is printable on this machine at all.`);
    start = printer.maxNozzleTemp;
    if (end > start - 15) end = start - 20; // keep a usable descending span (≥20 °C) after clamping
  }
  return { start, end, step, warnings };
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
    s = { start: 0, end: 1.5, step: 0.1, warnings: ['Keep retraction minimal for flexible filament — long retractions jam extruders. If using Bowden with TPU, consider not calibrating past ~2 mm at all.'] };
    if (auxBowden) s.warnings.push('The auxiliary nozzle is not rated for flexible filaments — calibrate TPU on the main (direct drive) nozzle instead.');
  } else if (auxBowden) {
    // Bowden-fed auxiliary nozzle (X2D-style remote extruder). The printer
    // profile's saved retraction range describes the MAIN feed path, so it is
    // deliberately not applied here.
    return {
      start: 2, end: 6, step: 0.5,
      warnings: [
        'Bowden-fed auxiliary nozzle: start at the 2 mm machine default and raise in ~0.5 mm steps — most filaments land between 2 and 4 mm (up to 6 for stubborn ones). The 30 mm/s default retraction speed is fine.',
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
  retraction: 'Stringing depends on temperature and pressure — calibrate those first.',
  'max-volumetric-speed': 'Max flow depends strongly on temperature — calibrate it first.',
  'ooze-control': 'Ooze behavior depends on retraction and pressure advance — calibrate those first.',
  'final-verification': 'Verification is only meaningful after the other calibrations.'
};
