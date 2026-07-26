// ---------------------------------------------------------------------------
// Automated Calibration Pipeline — printer-DB → Orca preset mapping (Stage 6).
//
// Maps a PerfectFit printer selection to the exact Orca preset names the
// `inherits` resolver needs. A PerfectFit printer's `model` equals Orca's
// machine `printer_model`, and the sliceable machine leaf is that model at a
// specific nozzle (e.g. "Bambu Lab X1 Carbon" + 0.4 → the leaf whose
// printer_model + nozzle_diameter match). The leaf's `default_print_profile`
// gives the process.
//
// Filament is deliberately NOT derived here: Orca machine leaves carry no
// default filament (verified — `default_filament_profile` is empty on the
// nozzle leaves), and in a calibration the filament IS the thing being tuned, so
// the material/filament preset is a separate selection the caller supplies.
//
// Pure module (no fs, no native): callers pass the machine list obtained from
// the native `listInstalledMachines`.
// ---------------------------------------------------------------------------

import type { RawMachinePreset } from './engineBridge';

export interface OrcaMachineMapping {
  vendor: string;
  /** Exact machine leaf name, e.g. "Bambu Lab X1 Carbon 0.4 nozzle". */
  machineName: string;
  /** Default process preset name from the machine leaf. */
  process: string;
}

/** Format a nozzle diameter the way Orca stores it ("0.4", "0.6", "0.8"). */
export function formatNozzle(nozzleMm: number): string {
  // Orca uses a plain decimal with no trailing zeros (0.4, not 0.40).
  return String(nozzleMm);
}

/**
 * Find the installed Orca machine leaf for a PerfectFit printer model + nozzle.
 * Matches on exact `printer_model` and nozzle diameter, and requires the leaf to
 * declare a default process (so the result is directly sliceable). Returns null
 * when the printer/nozzle isn't present in the install.
 */
export function mapPrinterToOrca(
  printerModel: string,
  nozzleMm: number,
  machines: RawMachinePreset[]
): OrcaMachineMapping | null {
  const nozzle = formatNozzle(nozzleMm);
  const match = machines.find(
    (m) =>
      m.printer_model === printerModel &&
      m.nozzle_diameter === nozzle &&
      !!m.default_print_profile
  );
  if (!match) return null;
  return {
    vendor: match.vendor,
    machineName: match.name,
    process: match.default_print_profile as string
  };
}

// --- per-extruder settings --------------------------------------------------

/**
 * Machine settings an Orca-family preset stores as ONE ENTRY PER EXTRUDER.
 *
 * This is an allow-list on purpose. A resolved `project_settings.config` is full
 * of arrays that are NOT per-extruder — `machine_max_acceleration_x` holds
 * [normal, stealth], filament keys hold one entry per filament slot — so
 * indexing every array by nozzle would quietly corrupt a machine profile. Only
 * keys named here are ever reduced to a single extruder; everything else is
 * passed through untouched.
 *
 * These are the retraction/geometry settings a dual-nozzle calibration actually
 * needs to carry per feed path. Extending the list is safe; guessing is not.
 */
export const PER_EXTRUDER_MACHINE_KEYS: readonly string[] = [
  'nozzle_diameter',
  'nozzle_type',
  'nozzle_volume',
  'extruder_type',
  'extruder_offset',
  'min_layer_height',
  'max_layer_height',
  'retraction_length',
  'retract_length_toolchange',
  'retraction_speed',
  'deretraction_speed',
  'retraction_minimum_travel',
  'retract_before_wipe',
  'retract_restart_extra',
  'retract_restart_extra_toolchange',
  'retract_when_changing_layer',
  'retract_lift_above',
  'retract_lift_below',
  'retract_lift_enforce',
  'z_hop',
  'z_hop_types',
  'wipe',
  'wipe_distance',
  'long_retractions_when_cut',
  'retraction_distances_when_cut'
];

export interface PerExtruderProjection {
  /** The projected settings — a new object; the input is not mutated. */
  settings: Record<string, unknown>;
  /** Keys whose per-extruder array was narrowed to the selected extruder. */
  indexedKeys: string[];
  /** Extruder count read from the preset (`nozzle_diameter` length), or null. */
  extruderCount: number | null;
  warnings: string[];
}

/** Extruder count a resolved preset declares — the length of its
 *  `nozzle_diameter` array, which Orca keeps one entry per extruder. Null when
 *  the key is missing or not an array (nothing is assumed from its absence). */
export function presetExtruderCount(settings: Record<string, unknown>): number | null {
  const nd = settings.nozzle_diameter;
  return Array.isArray(nd) && nd.length > 0 ? nd.length : null;
}

/**
 * Narrow a resolved preset's per-extruder settings to ONE extruder.
 *
 * Bambu dual-nozzle presets store these values as per-extruder arrays, so a
 * consumer that reads element 0 always gets the main nozzle's value — the wrong
 * answer for an auxiliary-nozzle calibration. This picks element `nozzleIndex`
 * instead, keeping the array shape (`[value]`) that Orca's config format
 * expects.
 *
 * Deliberately conservative: nozzle 0 is returned untouched (identical to the
 * previous behaviour), and any unexpected shape — a non-array value, an array
 * that is too short, or an array whose length disagrees with the preset's
 * extruder count — is left exactly as it was with a warning explaining why,
 * rather than guessed at.
 */
export function projectPresetForNozzle(
  settings: Record<string, unknown>,
  nozzleIndex: number
): PerExtruderProjection {
  const extruderCount = presetExtruderCount(settings);
  const out: Record<string, unknown> = { ...settings };
  const indexedKeys: string[] = [];
  const warnings: string[] = [];

  if (!Number.isInteger(nozzleIndex) || nozzleIndex <= 0) {
    // Nozzle 0 (or an unusable index) → unchanged: element 0 is already correct.
    if (Number.isInteger(nozzleIndex) && nozzleIndex < 0) {
      warnings.push('Nozzle index must be a whole number counting from 0; the preset was left unchanged.');
    }
    return { settings: out, indexedKeys, extruderCount, warnings };
  }

  if (extruderCount === null) {
    warnings.push(
      'This preset does not list a nozzle diameter per extruder, so PerfectFit could not tell which values belong to the second nozzle; the preset was left unchanged.'
    );
    return { settings: out, indexedKeys, extruderCount, warnings };
  }
  if (nozzleIndex >= extruderCount) {
    warnings.push(
      `This preset describes ${extruderCount} extruder${extruderCount === 1 ? '' : 's'}, so it has nothing for nozzle ${nozzleIndex + 1}; the preset was left unchanged.`
    );
    return { settings: out, indexedKeys, extruderCount, warnings };
  }

  for (const key of PER_EXTRUDER_MACHINE_KEYS) {
    if (!(key in out)) continue;
    const value = out[key];
    if (!Array.isArray(value)) {
      warnings.push(`'${key}' is not stored per extruder in this preset; it was left unchanged.`);
      continue;
    }
    if (value.length !== extruderCount) {
      warnings.push(
        `'${key}' has ${value.length} entries but the preset declares ${extruderCount} extruders; it was left unchanged.`
      );
      continue;
    }
    out[key] = [value[nozzleIndex]];
    indexedKeys.push(key);
  }

  return { settings: out, indexedKeys, extruderCount, warnings };
}
