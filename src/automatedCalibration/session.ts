// ---------------------------------------------------------------------------
// Automated Calibration Pipeline — pure session/working-profile helpers.
//
// Small, dependency-free, deterministic functions used across the later stages.
// They do NOT touch storage, the DOM, or the filesystem, so they are safe to
// unit test in the node test environment and safe to run in the browser build.
// ---------------------------------------------------------------------------

import type { CalibrationId } from '../types';
import type {
  AutomatedSessionExtension,
  CalibrationSessionStatus,
  GeneratedJobRecord,
  NozzleCountSource,
  ProvenanceSource,
  TemporaryCalibrationProfile
} from './types';

type ProfileValue = number | string | boolean;

/** Create an empty working profile for one nozzle of a project. Immutable
 *  inputs; the caller owns the returned object. */
export function createTemporaryProfile(input: {
  id: string;
  displayName: string;
  projectId: string;
  sourceProfileName?: string;
  /** Which physical nozzle the profile describes; defaults to 0 (main). */
  nozzleIndex?: number;
  now?: string;
}): TemporaryCalibrationProfile {
  const now = input.now ?? new Date().toISOString();
  return {
    id: input.id,
    displayName: input.displayName,
    createdForProjectId: input.projectId,
    sourceProfileName: input.sourceProfileName,
    nozzleIndex: normalizeNozzleIndex(input.nozzleIndex),
    values: {},
    provenance: {},
    createdAt: now,
    updatedAt: now
  };
}

// --- per-nozzle profile selection (pure) ------------------------------------

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

/** Coerce any nozzle index to a usable whole number ≥ 0. Absent/invalid = 0. */
export function normalizeNozzleIndex(index?: number | null): number {
  if (typeof index !== 'number' || !Number.isFinite(index) || index < 0) return 0;
  return Math.floor(index);
}

/** The nozzle a profile describes. Absent = `fallback` (default 0), which keeps
 *  profiles saved before dual-nozzle support readable. */
export function profileNozzleIndex(
  profile: Pick<TemporaryCalibrationProfile, 'nozzleIndex'> | undefined,
  fallback = 0
): number {
  if (profile?.nozzleIndex === undefined) return normalizeNozzleIndex(fallback);
  return normalizeNozzleIndex(profile.nozzleIndex);
}

/** Anything that can carry a session's working profiles — a `CalibrationProject`
 *  or a bare session extension. `nozzleIndex` is the project's own nozzle. */
export type WorkingProfileHolder = AutomatedSessionExtension & { nozzleIndex?: number };

/**
 * The nozzle a session's PRIMARY working profile belongs to: the profile's own
 * index when it has one, else the project's nozzle, else 0.
 */
export function primaryNozzleIndex(session: WorkingProfileHolder): number {
  if (session.workingProfile) {
    return profileNozzleIndex(session.workingProfile, session.nozzleIndex ?? 0);
  }
  return normalizeNozzleIndex(session.nozzleIndex);
}

/**
 * The working profile for one nozzle. Omit `nozzleIndex` to get the session's
 * primary profile (the pre-dual-nozzle behaviour of reading `workingProfile`).
 * Returns undefined when that nozzle has no profile yet — never a fabricated
 * empty one, so a caller can tell "not measured" from "measured as zero".
 */
export function getWorkingProfile(
  session: WorkingProfileHolder,
  nozzleIndex?: number
): TemporaryCalibrationProfile | undefined {
  if (nozzleIndex === undefined) return session.workingProfile;
  const want = normalizeNozzleIndex(nozzleIndex);
  const primary = session.workingProfile;
  if (primary && profileNozzleIndex(primary, session.nozzleIndex ?? 0) === want) return primary;
  return (session.workingProfiles ?? []).find((p) => profileNozzleIndex(p) === want);
}

/** Every working profile the session holds, primary first, in nozzle order after
 *  that. Read-only view — the array is freshly built. */
export function listWorkingProfiles(session: WorkingProfileHolder): TemporaryCalibrationProfile[] {
  const out: TemporaryCalibrationProfile[] = [];
  if (session.workingProfile) out.push(session.workingProfile);
  const primary = session.workingProfile ? primaryNozzleIndex(session) : -1;
  for (const p of session.workingProfiles ?? []) {
    if (profileNozzleIndex(p) === primary) continue; // never list the primary twice
    out.push(p);
  }
  return out;
}

/** Nozzle indices the session currently holds a working profile for, ascending. */
export function workingProfileNozzles(session: WorkingProfileHolder): number[] {
  const seen = new Set<number>();
  for (const p of listWorkingProfiles(session)) {
    seen.add(profileNozzleIndex(p, session.nozzleIndex ?? 0));
  }
  return [...seen].sort((a, b) => a - b);
}

/** Return a NEW profile with one value set and its provenance recorded. The
 *  input profile is never mutated. */
export function applyValue(
  profile: TemporaryCalibrationProfile,
  key: string,
  value: ProfileValue,
  source: ProvenanceSource,
  opts?: { stepId?: CalibrationId; now?: string }
): TemporaryCalibrationProfile {
  const now = opts?.now ?? new Date().toISOString();
  return {
    ...profile,
    values: { ...profile.values, [key]: value },
    provenance: {
      ...profile.provenance,
      [key]: { source, stepId: opts?.stepId, updatedAt: now }
    },
    updatedAt: now
  };
}

/** Keys whose current value came from a given provenance source. */
export function valuesFromSource(
  profile: TemporaryCalibrationProfile,
  source: ProvenanceSource
): string[] {
  return Object.keys(profile.provenance)
    .filter((k) => profile.provenance[k].source === source)
    .sort();
}

/** Deterministic fingerprint of a value set — order-independent, so it detects
 *  real value changes rather than key-insertion order. */
export function fingerprintValues(values: Record<string, ProfileValue>): string {
  const keys = Object.keys(values).sort();
  return JSON.stringify(keys.map((k) => [k, values[k]]));
}

/** A generated job is stale when its inputs no longer match the current working
 *  profile (unless it already failed — a failed job is re-run, not "stale"). */
export function jobIsStale(job: GeneratedJobRecord, currentFingerprint: string): boolean {
  if (job.status === 'failed') return false;
  return job.inputFingerprint !== currentFingerprint;
}

const RESUMABLE_STATUSES: ReadonlySet<CalibrationSessionStatus> = new Set([
  'created',
  'in_progress',
  'waiting_for_print',
  'waiting_for_result'
]);

/** Whether a session in this status can be safely reopened and continued. */
export function isSessionResumable(status: CalibrationSessionStatus): boolean {
  return RESUMABLE_STATUSES.has(status);
}
