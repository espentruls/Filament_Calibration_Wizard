// ---------------------------------------------------------------------------
// Automated Calibration Pipeline — capability-result constructors.
//
// Tiny pure helpers so engines/destinations report capabilities consistently
// rather than hand-building result objects at every call site.
//
// `multiExtruder` is deliberately split in two halves that are only combined
// here: what the ENGINE can do (its own flag, reported from detection — never
// assumed) and how many nozzles the PRINTER actually has (from the printer
// profile). Claiming multi-extruder slicing an engine cannot do would send a
// user's auxiliary-nozzle calibration through a path that silently produces
// main-nozzle g-code, so an unknown answer is reported as unsupported with a
// reason rather than guessed.
// ---------------------------------------------------------------------------

import type { CapabilityResult, NozzleCountSource, SlicingEngineCapabilities } from './types';

/** A conservative "nothing supported yet" capability set — the safe default
 *  before an engine has been detected and validated. */
export function emptyEngineCapabilities(): SlicingEngineCapabilities {
  return {
    slice: false,
    export3mf: false,
    exportGcode: false,
    multiPlate: false,
    multiExtruder: false
  };
}

export function supported(): CapabilityResult {
  return { supported: true, reasons: [] };
}

export function unsupported(...reasons: string[]): CapabilityResult {
  return { supported: false, reasons };
}

// --- printer shape ----------------------------------------------------------

/**
 * How many physical nozzles a printer has, or 0 when that is not known. The
 * `nozzles` array (which carries each feed path) wins over the database's
 * `extruderCount`, because it is the profile the user actually edited. An
 * unknown count is never rounded up to 1 — callers must distinguish "one
 * nozzle" from "we don't know".
 */
export function printerNozzleCount(printer: NozzleCountSource | undefined | null): number {
  if (!printer) return 0;
  if (Array.isArray(printer.nozzles) && printer.nozzles.length > 0) return printer.nozzles.length;
  const count = printer.extruderCount;
  if (typeof count === 'number' && Number.isFinite(count) && count >= 1) return Math.floor(count);
  return 0;
}

/** True only when the printer is KNOWN to have more than one nozzle. */
export function isMultiNozzlePrinter(printer: NozzleCountSource | undefined | null): boolean {
  return printerNozzleCount(printer) > 1;
}

/**
 * Whether a given engine can prepare and slice for a specific nozzle of a given
 * printer, right now.
 *
 * Rules, in order:
 *   * a nozzle index the printer does not have is never supported;
 *   * a single-nozzle (or unknown) printer at nozzle 0 needs nothing special;
 *   * anything on a machine with two or more nozzles — INCLUDING its main
 *     nozzle — needs real multi-extruder handling, because the machine preset
 *     itself carries per-extruder values;
 *   * without validated engine capabilities the answer is "unknown", reported
 *     as unsupported with a reason.
 */
export function multiExtruderSupport(
  capabilities: SlicingEngineCapabilities | null | undefined,
  printer: NozzleCountSource | undefined | null,
  nozzleIndex = 0
): CapabilityResult {
  if (!Number.isInteger(nozzleIndex) || nozzleIndex < 0) {
    return unsupported('A nozzle must be identified by a whole number, counting from 0.');
  }
  const count = printerNozzleCount(printer);
  if (count > 0 && nozzleIndex >= count) {
    return unsupported(
      `This printer profile describes ${count} nozzle${count === 1 ? '' : 's'}, so nozzle ${nozzleIndex + 1} is not one of them.`
    );
  }
  if (nozzleIndex === 0 && count <= 1) return supported();
  if (!capabilities) {
    return unsupported('This engine has not been detected and validated yet, so its multi-nozzle support is unknown.');
  }
  if (!capabilities.multiExtruder) {
    return unsupported(
      'This engine has not been confirmed to slice for a chosen nozzle on a multi-nozzle printer, so it is not used for one.'
    );
  }
  return supported();
}
