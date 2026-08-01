import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RawProfileFile } from '../../src/slicerIntegration/bridge';

const FIXTURE_DIR = join(__dirname, 'fixtures');

export function fixtureJson(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

export function fixtureRaw(
  name: string,
  overrides: Partial<RawProfileFile> = {}
): RawProfileFile {
  return {
    file_name: name,
    path: `C:\\fake\\${name}`,
    dir_kind: 'user',
    account_id: 'default',
    vendor: null,
    json: fixtureJson(name),
    info: null,
    writable: true,
    ...overrides
  };
}

/**
 * Vendor system presets copied byte-for-byte from a real Bambu Studio install
 * (system/BBL/filament) and kept read-only, purely to test against the real
 * shape rather than an invented one. They are Bambu Lab's files, not ours.
 *
 * - bambu-system-abs-x2d-4slot.json      "Generic ABS @BBL X2D 0.4 nozzle"
 *   FOUR value slots, declares NO legend of its own, and pulls one in via
 *   `include: ["fdm_filament_template_direct_bowden"]`. This is the shape that
 *   breaks index-based slot mapping: slots 0/1 are the MAIN direct-drive
 *   nozzle, slots 2/3 the AUXILIARY bowden nozzle.
 * - bambu-system-support-abs-x2d-4slot.json  same shape, uniform slots except
 *   retraction_distances_when_ec [3,3,4,4] — the bowden path's +1 mm.
 * - bambu-template-direct-bowden.json / bambu-template-direct-dual.json
 *   the only two `include` templates that exist in a full filament library;
 *   they are what BAMBU_INCLUDE_TEMPLATE_VARIANTS is asserted against.
 * - bambu-system-pla-hs-x2d-2slot-nolegend.json  "Generic PLA High Speed @BBL
 *   X2D 0.2 nozzle". TWO value slots, NO legend and NO `include` — so nothing
 *   in the file says what its slots mean. It is compatible with the X2D, whose
 *   machine preset declares extruder_type ["Direct Drive","Bowden"], which is
 *   exactly why a fabricated all-direct-drive legend here is unsafe. A survey
 *   of a full 1734-preset Bambu library found 24 presets of this shape.
 * - bambu-system-tpu-h2d-3slot-nolegend.json  "Bambu TPU 95A HF @BBL H2D 0.4
 *   nozzle". THREE value slots, likewise no legend and no `include`, on a
 *   two-nozzle machine. The three-slot case, so a fabricated three-entry legend
 *   would have fitted it exactly and still said nothing true.
 *
 * NOTE on bambu-user-full-pctg-dualnozzle.json: the name is misleading. It is a
 * 2-slot preset whose legend is ["Direct Drive Standard","Direct Drive High
 * Flow"] and whose compatible printer is the Bambu Lab H2S — a SINGLE-nozzle
 * machine with interchangeable hotends. Both of its slots are the same physical
 * nozzle, so it exercises slot isolation, never NOZZLE isolation. Use the X2D
 * fixture above for anything about two nozzles.
 */

/** All sanitized real user-preset fixtures, one per slicer. */
export const USER_FIXTURES: { file: string; slicer: 'orca' | 'bambu' | 'snapmaker-orca' | 'elegoo' | 'flash-studio' }[] = [
  { file: 'orca-user-delta-pla.json', slicer: 'orca' },
  { file: 'bambu-user-full-pctg-dualnozzle.json', slicer: 'bambu' },
  { file: 'snapmaker-user-delta-pla.json', slicer: 'snapmaker-orca' },
  { file: 'elegoo-user-delta-petg.json', slicer: 'elegoo' },
  { file: 'flashforge-user-delta-pctg.json', slicer: 'flash-studio' },
  { file: 'flashforge-user-delta-tpu.json', slicer: 'flash-studio' }
];
