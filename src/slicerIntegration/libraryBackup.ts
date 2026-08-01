// ---------------------------------------------------------------------------
// Whole-library preset backups: snapshot the user preset folders (filament,
// machine, process) of detected slicers into the regular backup store BEFORE
// the wizard directs anyone to edit profiles. Desktop-only (goes through the
// bridge); callers must check bridge.isDesktop() and degrade to manual
// guidance in the browser build.
// ---------------------------------------------------------------------------

import * as bridge from './bridge';
import type { IntegrationSlicerId } from './types';

export interface LibraryBackupOutcome {
  backups: bridge.RawBackupSummary[];
  /** Human-readable notes for locations that could not be backed up. */
  notes: string[];
}

export function totalFileCount(o: LibraryBackupOutcome): number {
  return o.backups.reduce((n, b) => n + b.file_count, 0);
}

/**
 * Back up every user preset location of the detected slicers (optionally only
 * one slicer). Each location becomes one restorable backup in
 * Settings → Slicer profile backups. Failures on individual locations do not
 * abort the rest — they are reported as notes.
 */
export async function backupDetectedPresetLibraries(
  projectId: string,
  onlySlicer?: IntegrationSlicerId
): Promise<LibraryBackupOutcome> {
  const detected = await bridge.detectSupportedSlicers();
  const backups: bridge.RawBackupSummary[] = [];
  const notes: string[] = [];
  for (const s of detected) {
    if (onlySlicer && s.slicer_id !== onlySlicer) continue;
    const label = s.variant_label || s.slicer_id;
    if (!s.user_locations.length) {
      notes.push(`${label}: no user preset folders found (has the slicer been started once?).`);
      continue;
    }
    for (const loc of s.user_locations) {
      try {
        // Named per install flavour: a family can have several installs (Bambu
        // Studio and its Beta both have a `default` folder), and each is
        // snapshotted separately rather than one standing in for the other.
        backups.push(await bridge.backupSlicerUserPresets(
          s.slicer_id as IntegrationSlicerId, loc.account_id, projectId, s.variant_id));
      } catch (e) {
        notes.push(`${label} (${loc.account_id}): ${String(e)}`);
      }
    }
  }
  return { backups, notes };
}
