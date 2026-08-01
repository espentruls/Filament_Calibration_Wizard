// ---------------------------------------------------------------------------
// Profile validation — runs before export and again before installation.
// Errors block installation; material warnings require acknowledgement.
// Values are never silently clamped: conflicts are reported with both values.
// ---------------------------------------------------------------------------

import type { CalibrationProject, PrinterProfile } from '../types';
import type {
  DetectedFilamentProfile, GeneratedFilamentProfile, ProfileValidationResult, ValidationMessage
} from './types';
import { extruderCountOf, normalizeMaterial, sameMaterialFamily } from './orcaFamily';
import { summarizeDiff } from './diff';
import { projectMaterialLabel } from './recommendations';
import { getMaterial } from '../data/materials';
import { FLEXIBLE_RETRACTION_MAX_MM } from '../logic/ranges';

export interface ValidationContext {
  project: CalibrationProject;
  printer?: PrinterProfile;
  baseProfile: DetectedFilamentProfile;
  /** Names of presets already present at the destination (duplicate check). */
  existingProfileNames?: string[];
  /** Values the user explicitly acknowledged despite warnings. */
  acknowledgedWarningCodes?: string[];
}

const err = (code: string, message: string): ValidationMessage => ({ code, message });
const warn = (code: string, message: string, ack = false): ValidationMessage =>
  ({ code, message, requiresAcknowledgement: ack });

// --- what the preset will actually make the printer do ----------------------
// Limits are read from the generated preset, NOT from the changed-field list:
// the printer executes the file. A calibrated value that happens to equal the
// value already in the base produces no change entry, and a base value we are
// re-writing unchanged is still a value this app puts in front of a heater.

/** One value found in a preset key, with a slot suffix for multi-nozzle presets. */
interface WrittenValue {
  n: number;
  /** " (slot 2)" on per-extruder arrays, "" on single-slot keys. */
  where: string;
}

/**
 * Numeric values a preset key will carry on disk. Skips "nil" and empty slots
 * (the no-filament-override sentinel — those impose nothing on the printer) and
 * anything that is not a number, which the NON_FINITE check already covers.
 */
function writtenValues(data: Record<string, unknown>, key: string): WrittenValue[] {
  const v = data[key];
  const slots: unknown[] = Array.isArray(v) ? v : (v === undefined || v === null ? [] : [v]);
  const out: WrittenValue[] = [];
  slots.forEach((slot, i) => {
    if (typeof slot !== 'string' && typeof slot !== 'number') return;
    const s = String(slot).trim();
    if (s === '' || s.toLowerCase() === 'nil') return;
    const n = Number(s.replace(/%$/, ''));
    if (!Number.isFinite(n)) return;
    out.push({ n, where: slots.length > 1 ? ` (slot ${i + 1})` : '' });
  });
  return out;
}

/** Nozzle-commanding temperature keys (NOT the *_range_* advisory fields). */
const NOZZLE_TEMP_KEYS: { key: string; label: string }[] = [
  { key: 'nozzle_temperature', label: 'Nozzle temperature' },
  { key: 'nozzle_temperature_initial_layer', label: 'First layer nozzle temperature' }
];

/**
 * Bed-commanding keys. Orca-family presets carry one pair per build plate type
 * plus the PrusaSlicer-style generic pair; any of them can drive the bed.
 */
const BED_TEMP_KEYS: { key: string; label: string }[] = [
  { key: 'hot_plate_temp', label: 'Hot plate temperature' },
  { key: 'hot_plate_temp_initial_layer', label: 'Hot plate temperature (first layer)' },
  { key: 'cool_plate_temp', label: 'Cool plate temperature' },
  { key: 'cool_plate_temp_initial_layer', label: 'Cool plate temperature (first layer)' },
  { key: 'eng_plate_temp', label: 'Engineering plate temperature' },
  { key: 'eng_plate_temp_initial_layer', label: 'Engineering plate temperature (first layer)' },
  { key: 'textured_plate_temp', label: 'Textured plate temperature' },
  { key: 'textured_plate_temp_initial_layer', label: 'Textured plate temperature (first layer)' },
  { key: 'supertack_plate_temp', label: 'Supertack plate temperature' },
  { key: 'supertack_plate_temp_initial_layer', label: 'Supertack plate temperature (first layer)' },
  { key: 'bed_temperature', label: 'Bed temperature' },
  { key: 'bed_temperature_initial_layer', label: 'Bed temperature (first layer)' }
];

const CHAMBER_TEMP_KEYS: { key: string; label: string }[] = [
  { key: 'chamber_temperature', label: 'Chamber temperature' },
  { key: 'chamber_temperatures', label: 'Chamber temperature' }
];

/**
 * Re-exported so importers of the write path see the same identity the
 * suggestion layer and the retraction test form use. One number, one owner.
 */
export { FLEXIBLE_RETRACTION_MAX_MM };
/** Same window the retraction test form accepts at entry time (src/ui/testForms.ts). */
const RETRACTION_SPEED_MIN_MMS = 5;
const RETRACTION_SPEED_MAX_MMS = 120;

/**
 * Whether the calibrated filament is a flexible. Uses the wizard's own material
 * preset first, then the free-text label for "Other / specialty" projects.
 */
function isFlexibleProject(project: CalibrationProject): boolean {
  if (getMaterial(project.filament.material).flexible) return true;
  const label = projectMaterialLabel(project);
  if (normalizeMaterial(label)?.family === 'TPU') return true;
  return /\bTP[UEC]\b/i.test(label);
}

export function validateGeneratedProfile(
  generated: GeneratedFilamentProfile,
  ctx: ValidationContext
): ProfileValidationResult {
  const errors: ValidationMessage[] = [];
  const warnings: ValidationMessage[] = [];
  const unresolved: string[] = [];

  // --- parseable output & round trip ---------------------------------------
  let reparsed: Record<string, unknown> | null = null;
  try {
    reparsed = JSON.parse(generated.serialized) as Record<string, unknown>;
  } catch (e) {
    errors.push(err('SERIALIZE_INVALID', `Generated profile does not re-parse: ${String(e)}`));
  }

  const baseRaw = ctx.baseProfile.rawProfile as Record<string, unknown>;

  if (reparsed) {
    // Round-trip: every base key must exist in the output (unknown fields
    // survive), except identity keys we intentionally remove. For Bambu,
    // system-preset plumbing is stripped too (no preset Bambu itself writes
    // into a user folder carries these, and `include` breaks user-dir loads).
    const removedOk = new Set(['setting_id', 'user_id']);
    if (generated.slicerId === 'bambu') {
      for (const k of ['type', 'instantiation', 'include']) removedOk.add(k);
    }
    for (const key of Object.keys(baseRaw)) {
      if (!(key in reparsed) && !removedOk.has(key)) {
        errors.push(err('FIELD_LOST', `Field lost in generation: ${key}`));
      }
    }

    // Required identity fields.
    if (typeof reparsed.name !== 'string' || !reparsed.name) {
      errors.push(err('NAME_MISSING', 'Generated profile has no name.'));
    } else if (reparsed.name !== generated.name) {
      errors.push(err('NAME_MISMATCH', 'Preset name does not match the requested profile name.'));
    }
    if (reparsed.from !== 'User') {
      errors.push(err('FROM_INVALID', 'Generated profile must be a user preset (from = "User").'));
    }
    const fsid = reparsed.filament_settings_id;
    if (!Array.isArray(fsid) || fsid[0] !== generated.name) {
      errors.push(err('SETTINGS_ID_MISMATCH', 'filament_settings_id must equal the preset name.'));
    }
    if ('version' in baseRaw && reparsed.version !== baseRaw.version) {
      errors.push(err('VERSION_DRIFT', 'Preset schema version must be copied from the base profile.'));
    }
    // Cloning a system preset must inherit that preset by name (how the
    // slicer saves user presets); cloning a user preset preserves its
    // inherits (already a concrete system name).
    const expectedInherits = ctx.baseProfile.sourceType === 'system' && ctx.baseProfile.name
      ? ctx.baseProfile.name
      : ('inherits' in baseRaw ? baseRaw.inherits : undefined);
    if (expectedInherits !== undefined && reparsed.inherits !== expectedInherits) {
      errors.push(err('INHERITS_DRIFT', `Generated profile must inherit "${String(expectedInherits)}".`));
    }
    // Bambu-lineage slicers key filaments by filament_id; a clone without its
    // own fresh id is ignored or hidden behind the preset it was cloned from.
    if (typeof reparsed.filament_id !== 'string' || !reparsed.filament_id) {
      errors.push(err('FILAMENT_ID_MISSING', 'Generated profile must carry its own filament_id.'));
    } else if (typeof baseRaw.filament_id === 'string' && baseRaw.filament_id === reparsed.filament_id) {
      errors.push(err('FILAMENT_ID_COLLISION', 'filament_id must differ from the base profile (the slicer hides id collisions).'));
    }
    if (generated.slicerId === 'bambu' && !Array.isArray(reparsed.filament_extruder_variant)) {
      errors.push(err('EXTRUDER_VARIANT_MISSING', 'Bambu presets must declare filament_extruder_variant (the slicer does not show presets without it). Trim could not establish what this preset\'s value slots mean, and will not invent a legend that could mislabel one nozzle\'s slot as another\'s — pick a base preset that declares its slot legend.'));
    }

    // Array shape: no per-extruder array may change length vs the base.
    const baseCount = extruderCountOf(baseRaw);
    const genCount = extruderCountOf(reparsed);
    // The legend names the slots, so it must be exactly as wide as they are.
    // A legend one entry short (the old three-entry direct-drive list stretched
    // over a four-slot X2D preset) mislabels every slot after the gap.
    const legend = reparsed.filament_extruder_variant;
    if (generated.slicerId === 'bambu' && Array.isArray(legend) && legend.length !== genCount) {
      errors.push(err('EXTRUDER_VARIANT_SHAPE',
        `filament_extruder_variant names ${legend.length} slot(s) but this preset carries ${genCount} value slot(s). The legend is what says which nozzle each slot belongs to, so a mismatch means slots are mislabelled.`));
    }
    if (genCount !== baseCount) {
      errors.push(err('EXTRUDER_SHAPE', `Extruder array shape changed (${baseCount} → ${genCount}).`));
    }

    // No unexpected drift beyond calibrated + identity fields.
    const diff = summarizeDiff(baseRaw, generated);
    for (const u of diff.unexpected) {
      errors.push(err('UNEXPECTED_CHANGE', `Unexpected change to field "${u.key}" — clone-and-patch must not alter it.`));
    }
  }

  // --- changed-field sanity --------------------------------------------------
  if (generated.changedFields.length === 0) {
    warnings.push(warn('NO_CHANGES', 'No calibrated values were applied — the new profile is an identical copy of the base.', true));
  }
  // Text-valued preset fields (g-code blocks) are exempt from numeric sanity.
  const NON_NUMERIC_KEYS = new Set(['filament_start_gcode', 'filament_end_gcode']);
  for (const c of generated.changedFields) {
    if (NON_NUMERIC_KEYS.has(c.presetKey)) continue;
    // "nil" is the no-filament-override sentinel, not a number. It is what an
    // untargeted slot receives when a key is added from scratch (the base
    // preset never set it), so it appears in the change list for every slot the
    // calibration did NOT target. It imposes nothing on the printer — the same
    // reason writtenValues() skips it in the limit checks below.
    if (String(c.after).trim().toLowerCase() === 'nil') continue;
    // Percent-typed fields (e.g. filament_shrink "99.4%") carry a % suffix.
    const n = Number(String(c.after).replace(/%$/, ''));
    if (!Number.isFinite(n)) {
      errors.push(err('NON_FINITE', `${c.label}: value "${c.after}" is not a finite number.`));
    }
  }

  // --- numeric limits (never clamped — reported with both values) -----------
  // Read from the preset that will be written, so a calibrated value equal to
  // the base value is checked exactly like a changed one.
  const printer = ctx.printer;
  // Every limit below is guarded by `printer &&`. With no printer profile they
  // all evaluate to nothing, and an empty result reads as "all checks passed"
  // in the wizard. Say plainly that nothing was checked instead, and make it an
  // acknowledged warning so installing becomes a conscious decision.
  if (!printer) {
    warnings.push(warn('PRINTER_UNRESOLVED',
      'No printer profile could be loaded for this project (the profile it referenced was deleted, or was not included in the backup that was restored), so NONE of the machine limits were checked: maximum nozzle temperature, maximum bed temperature, chamber temperature and maximum flow were all skipped. Only absolute plausibility bands were applied. Re-link this project to a printer profile before installing, or confirm by hand that every value below is inside your machine’s ratings.', true));
  }
  const written = reparsed ?? (generated.data as Record<string, unknown>);
  const each = (key: string, fn: (v: number, where: string) => void): void => {
    for (const { n, where } of writtenValues(written, key)) fn(n, where);
  };

  for (const { key, label } of NOZZLE_TEMP_KEYS) {
    each(key, (t, where) => {
      if (printer && t > printer.maxNozzleTemp) {
        errors.push(err('TEMP_OVER_PRINTER_MAX',
          `${label}${where} ${t} °C exceeds this printer's maximum of ${printer.maxNozzleTemp} °C. Correct the value or the printer limit before installing.`));
      }
      if (t < 140 || t > 450) {
        errors.push(err('TEMP_IMPLAUSIBLE', `${label}${where} ${t} °C is outside the plausible printing range (140–450 °C).`));
      }
    });
  }

  for (const { key, label } of BED_TEMP_KEYS) {
    each(key, (t, where) => {
      if (printer && t > printer.maxBedTemp) {
        errors.push(err('BED_TEMP_OVER_PRINTER_MAX',
          `${label}${where} ${t} °C exceeds this printer's maximum bed temperature of ${printer.maxBedTemp} °C. Correct the value or the printer limit before installing.`));
      }
      if (t < 0 || t > 200) {
        errors.push(err('BED_TEMP_IMPLAUSIBLE', `${label}${where} ${t} °C is outside the plausible bed range (0–200 °C).`));
      }
    });
  }

  for (const { key, label } of CHAMBER_TEMP_KEYS) {
    each(key, (t, where) => {
      if (t <= 0) return; // 0 = no chamber temperature requested
      if (printer?.maxChamberTemp !== undefined && t > printer.maxChamberTemp) {
        errors.push(err('CHAMBER_TEMP_OVER_PRINTER_MAX',
          `${label}${where} ${t} °C exceeds this printer's maximum chamber temperature of ${printer.maxChamberTemp} °C.`));
      }
      if (t > 120) {
        errors.push(err('CHAMBER_TEMP_IMPLAUSIBLE', `${label}${where} ${t} °C is outside the plausible chamber range (0–120 °C).`));
      }
      if (printer?.heatedChamber === false) {
        warnings.push(warn('CHAMBER_NOT_HEATED',
          `${label}${where} asks for ${t} °C, but this printer profile says it has no heated chamber. The slicer may wait for a temperature the machine can never reach.`));
      }
    });
  }

  each('filament_flow_ratio', (flow, where) => {
    if (flow < 0.5 || flow > 1.5) {
      errors.push(err('FLOW_IMPLAUSIBLE', `Flow ratio${where} ${flow} is outside the plausible range (0.5–1.5).`));
    }
  });

  each('pressure_advance', (pa, where) => {
    if (pa < 0 || pa > 2) {
      errors.push(err('PA_IMPLAUSIBLE', `Pressure advance${where} ${pa} is outside the plausible range (0–2).`));
    }
  });

  // Retraction: the suggestion layer caps flexibles at 1.5 mm because long
  // retractions drag soft filament into the cold zone and jam the extruder.
  // The write path has to enforce the same cap, or a value typed in by hand
  // (or carried over from a rigid-filament base) reaches the printer anyway.
  const flexible = isFlexibleProject(ctx.project);
  const materialLabel = projectMaterialLabel(ctx.project);
  each('filament_retraction_length', (retract, where) => {
    if (retract < 0 || retract > 15) {
      errors.push(err('RETRACT_IMPLAUSIBLE', `Retraction length${where} ${retract} mm is outside the plausible range (0–15 mm).`));
    } else if (flexible && retract > FLEXIBLE_RETRACTION_MAX_MM) {
      errors.push(err('RETRACT_OVER_FLEXIBLE_CAP',
        `Retraction length${where} ${retract} mm exceeds the ${FLEXIBLE_RETRACTION_MAX_MM} mm limit Trim applies to flexible filament (${materialLabel}). Long retractions pull soft filament into the cold zone and jam the extruder — lower it, or calibrate this filament as a rigid material only if you know the extruder tolerates it.`));
    }
  });
  each('filament_retraction_speed', (speed, where) => {
    if (speed < RETRACTION_SPEED_MIN_MMS || speed > RETRACTION_SPEED_MAX_MMS) {
      errors.push(err('RETRACT_SPEED_IMPLAUSIBLE',
        `Retraction speed${where} ${speed} mm/s is outside the range Trim calibrates (${RETRACTION_SPEED_MIN_MMS}–${RETRACTION_SPEED_MAX_MMS} mm/s).`));
    }
  });

  each('filament_max_volumetric_speed', (mvs, where) => {
    if (mvs <= 0 || mvs > 100) {
      errors.push(err('MVS_IMPLAUSIBLE', `Maximum volumetric speed${where} ${mvs} mm³/s is outside the plausible range (0–100).`));
    }
    if (printer?.maxVolumetricFlow && mvs > printer.maxVolumetricFlow) {
      warnings.push(warn('MVS_OVER_PRINTER',
        `Calibrated max volumetric speed${where} (${mvs} mm³/s) exceeds the printer profile's stated capability (${printer.maxVolumetricFlow} mm³/s). Install only if you trust the calibration result.`, true));
    }
  });

  each('filament_shrink', (shrink, where) => {
    if (shrink < 90 || shrink > 102) {
      errors.push(err('SHRINK_IMPLAUSIBLE', `Shrinkage${where} ${shrink}% is outside the plausible range (90–102%).`));
    }
  });

  // --- can this base preset even address the calibrated nozzle? -------------
  // Orca-family `get_at(i)` falls back to element 0 when a per-extruder array
  // is shorter than the extruder index, so a preset with fewer value slots than
  // the machine has nozzles applies its single value to EVERY nozzle — the same
  // premise the padding rule in cloneAndPatch() rests on. Generating against
  // such a base silently clamps the target slot to 0 (defaultTargetExtruder),
  // so an auxiliary bowden nozzle's calibration lands on the main direct-drive
  // hotend with nothing withheld and nothing reported.
  {
    const baseSlots = extruderCountOf(baseRaw);
    const calibratedNozzle = ctx.project.nozzleIndex ?? 0;
    const physicalNozzles = ctx.printer?.nozzles?.length ?? 0;
    if (baseSlots <= calibratedNozzle) {
      errors.push(err('BASE_CANNOT_ADDRESS_NOZZLE',
        `This base preset carries only ${baseSlots} value slot(s), so it cannot hold a value for nozzle ${calibratedNozzle + 1} — the nozzle this project calibrated. Orca-family slicers apply a single-slot value to EVERY nozzle, so installing this would give every nozzle (including the main one) nozzle ${calibratedNozzle + 1}'s calibration. Pick a base preset made for this machine — one whose value slots include the one that nozzle reads. (Slot count is not nozzle count: on a Bambu Lab X2D the auxiliary is nozzle 2 but its values live in slot 3 of 4.)`));
    } else if (physicalNozzles > baseSlots) {
      warnings.push(warn('BASE_NARROWER_THAN_PRINTER',
        `This base preset carries ${baseSlots} value slot(s) but the printer profile declares ${physicalNozzles} physical nozzles. The slicer will apply slot 1's values to every nozzle, including ones this project did not calibrate.`, true));
    }
  }

  // --- calibrated values that were deliberately not written -----------------
  for (const s of generated.skippedFields ?? []) {
    warnings.push(warn(`FIELD_NOT_WRITTEN:${s.presetKey}`, s.reason, true));
  }

  // --- material match ---------------------------------------------------------
  const projMat = projectMaterialLabel(ctx.project);
  if (ctx.baseProfile.materialType && !sameMaterialFamily(ctx.baseProfile.materialType, projMat)) {
    warnings.push(warn('MATERIAL_FAMILY_MISMATCH',
      `Base profile material (${ctx.baseProfile.materialType}) is a different family than the calibrated filament (${projMat}).`, true));
  }

  // --- duplicate name ---------------------------------------------------------
  const existing = ctx.existingProfileNames ?? [];
  if (existing.some(n => n.trim().toLowerCase() === generated.name.trim().toLowerCase())) {
    warnings.push(warn('DUPLICATE_NAME',
      `A preset named “${generated.name}” already exists at the destination. Installing will require choosing replace, rename, or numbered copy.`));
  }

  // --- inheritance -------------------------------------------------------------
  if (ctx.baseProfile.parentProfileName) {
    // Full resolution happens in the slicer; we record it as informational.
    unresolved.push(ctx.baseProfile.parentProfileName);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    preservedFieldCount: generated.preservedFieldCount,
    changedFields: generated.changedFields,
    unresolvedFields: unresolved
  };
}

/** Warnings that still need explicit acknowledgement before install. */
export function unacknowledgedWarnings(
  result: ProfileValidationResult,
  acknowledged: string[]
): ValidationMessage[] {
  return result.warnings.filter(w => w.requiresAcknowledgement && !acknowledged.includes(w.code));
}
