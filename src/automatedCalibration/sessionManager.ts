// ---------------------------------------------------------------------------
// Automated Calibration Pipeline — session lifecycle (Stage 2).
//
// A calibration session is just a `CalibrationProject` carrying the optional
// automated fields (see AutomatedSessionExtension). This module creates, moves,
// validates, and safely recovers those fields. It never modifies a project's
// calibration RESULTS (steps/finals/history) — the working profile is derived,
// reconstructable scaffolding, so if it is ever corrupt we set it aside and keep
// the user's real calibration data intact.
//
// Persistence itself is unchanged: because the session fields are optional
// additions to CalibrationProject, IndexedDB already stores and restores them
// via `saveProject`/`getProject`. Nothing here writes to the filesystem.
//
// The whole flow stays behind the disabled `automatedCalibration` flag.
// ---------------------------------------------------------------------------

import type { CalibrationId, CalibrationProject } from '../types';
import type {
  CalibrationSessionStatus,
  EngineId,
  ProvenanceSource,
  SlicerMode,
  TemporaryCalibrationProfile
} from './types';
import {
  applyValue,
  createTemporaryProfile,
  getWorkingProfile,
  isSessionResumable,
  normalizeNozzleIndex,
  primaryNozzleIndex,
  profileNozzleIndex
} from './session';
import { addTimeline, uid } from '../storage/store';

/** Sub-schema version stamped on a session's automated fields, independent of
 *  the app-wide storage SCHEMA_VERSION so the session shape can evolve on its
 *  own migration track later.
 *
 *  Deliberately NOT bumped when `inputFingerprintForStep` started folding the
 *  nozzle into its hash: this number describes the SHAPE of the persisted
 *  session fields, and that shape is unchanged — a fingerprint is still an
 *  opaque string on the same field. Bumping it would imply a migration that
 *  does not exist (nothing reads this value to transform anything), while the
 *  actual effect — pre-existing prepared jobs reading as `stale` once, meaning
 *  "prepare me again" — needs no data rewrite. See the note at
 *  `inputFingerprintForStep`. */
export const AUTOMATED_SESSION_SCHEMA = 1;

/**
 * True when a project carries ANY automated-session scaffolding — a status, a
 * primary working profile, or per-nozzle profiles.
 *
 * Deliberately broader than `hasAutomatedSession`, which asks whether a session
 * is USABLE. This asks whether there is anything session-shaped to inspect at
 * all, which is the question both the safe loader and the backup importer have
 * to answer before they touch the session fields. It lives here so the two can
 * never drift apart: a project that carries only `workingProfiles` (an extra
 * nozzle's profile, no primary) counted as a session in one place and as a
 * plain manual project in the other.
 */
export function carriesSessionData(
  project: Pick<CalibrationProject, 'sessionStatus' | 'workingProfile' | 'workingProfiles'>
): boolean {
  return (
    project.sessionStatus !== undefined ||
    project.workingProfile !== undefined ||
    project.workingProfiles !== undefined
  );
}

// --- working profile construction ------------------------------------------

export interface WorkingProfileSeed {
  key: string;
  value: number | string | boolean;
  source: ProvenanceSource;
  stepId?: CalibrationId;
}

/** Build a temporary working profile for ONE nozzle from optional seed values
 *  (base-profile values or safe material/printer defaults). Pure. Omit
 *  `nozzleIndex` for a single-nozzle machine's only nozzle. */
export function buildWorkingProfile(input: {
  projectId: string;
  displayName: string;
  sourceProfileName?: string;
  nozzleIndex?: number;
  seeds?: WorkingProfileSeed[];
  now?: string;
}): TemporaryCalibrationProfile {
  let wp = createTemporaryProfile({
    id: uid(),
    displayName: input.displayName,
    projectId: input.projectId,
    sourceProfileName: input.sourceProfileName,
    nozzleIndex: input.nozzleIndex,
    now: input.now
  });
  for (const s of input.seeds ?? []) {
    wp = applyValue(wp, s.key, s.value, s.source, { stepId: s.stepId, now: input.now });
  }
  return wp;
}

// --- per-nozzle working profiles -------------------------------------------

/**
 * Store a nozzle's working profile on the session. The first profile stored
 * becomes the session's primary (kept in `workingProfile`, where every existing
 * single-nozzle consumer already looks); further nozzles are held alongside it.
 * Replacing a nozzle's profile never disturbs another nozzle's values.
 *
 * Mutates and returns the project, matching the store's in-place convention.
 * Does NOT persist — the caller saves via `saveProject`.
 */
export function setWorkingProfile(
  project: CalibrationProject,
  profile: TemporaryCalibrationProfile
): CalibrationProject {
  const index = profileNozzleIndex(profile, project.nozzleIndex ?? 0);
  const stamped: TemporaryCalibrationProfile = { ...profile, nozzleIndex: index };

  if (!project.workingProfile || primaryNozzleIndex(project) === index) {
    project.workingProfile = stamped;
  } else {
    const rest = (project.workingProfiles ?? []).filter((p) => profileNozzleIndex(p) !== index);
    rest.push(stamped);
    rest.sort((a, b) => profileNozzleIndex(a) - profileNozzleIndex(b));
    project.workingProfiles = rest;
  }
  return project;
}

/**
 * The working profile for a nozzle, creating an empty one when that nozzle has
 * none yet. Use this when a step is about to record a result for a nozzle the
 * session has not touched before (the auxiliary nozzle on a dual-nozzle
 * machine). Mutates the project only when a profile has to be created.
 */
export function ensureWorkingProfile(
  project: CalibrationProject,
  nozzleIndex?: number,
  opts?: { displayName?: string; sourceProfileName?: string; seeds?: WorkingProfileSeed[]; now?: string }
): TemporaryCalibrationProfile {
  const index = normalizeNozzleIndex(nozzleIndex ?? project.nozzleIndex);
  const existing = getWorkingProfile(project, index);
  if (existing) return existing;
  const created = buildWorkingProfile({
    projectId: project.id,
    displayName: opts?.displayName ?? project.workingProfile?.displayName ?? 'Working profile',
    sourceProfileName: opts?.sourceProfileName ?? project.workingProfile?.sourceProfileName,
    nozzleIndex: index,
    seeds: opts?.seeds,
    now: opts?.now
  });
  setWorkingProfile(project, created);
  return getWorkingProfile(project, index) as TemporaryCalibrationProfile;
}

// --- session creation ------------------------------------------------------

/** Attach a fresh automated session to a project (status `created`). Mutates and
 *  returns the project, matching the store's in-place convention. Does NOT
 *  persist — the caller saves via `saveProject`. */
export function beginSession(
  project: CalibrationProject,
  opts: {
    slicerMode: SlicerMode;
    engineId?: EngineId;
    /** The session's primary nozzle profile. */
    workingProfile: TemporaryCalibrationProfile;
    /** Further nozzles' profiles, for a session spanning a dual-nozzle machine. */
    additionalProfiles?: TemporaryCalibrationProfile[];
  }
): CalibrationProject {
  project.automatedSchemaVersion = AUTOMATED_SESSION_SCHEMA;
  project.slicerMode = opts.slicerMode;
  project.selectedEngineId = opts.engineId;
  project.sessionStatus = 'created';
  project.workingProfile = opts.workingProfile;
  project.workingProfiles = [];
  for (const extra of opts.additionalProfiles ?? []) setWorkingProfile(project, extra);
  project.generatedJobs = project.generatedJobs ?? [];
  project.sessionWarnings = project.sessionWarnings ?? [];
  addTimeline(project, {
    stepId: 'project',
    kind: 'started',
    summary: `Automated calibration session started (${opts.slicerMode})`
  });
  return project;
}

// --- status transitions ----------------------------------------------------

const ALLOWED_TRANSITIONS: Record<CalibrationSessionStatus, CalibrationSessionStatus[]> = {
  created: ['in_progress', 'cancelled'],
  in_progress: ['waiting_for_print', 'waiting_for_result', 'completed', 'cancelled', 'failed'],
  waiting_for_print: ['waiting_for_result', 'in_progress', 'cancelled', 'failed'],
  waiting_for_result: ['in_progress', 'completed', 'cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: ['in_progress', 'cancelled']
};

/** Whether a session may move between two statuses. Same-status is a no-op and
 *  always allowed; terminal statuses (completed/cancelled) allow nothing else. */
export function canTransition(from: CalibrationSessionStatus, to: CalibrationSessionStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface TransitionResult {
  ok: boolean;
  reason?: string;
}

/** Move a session to a new status if the transition is legal. Mutates the
 *  project and records a timeline entry. Never throws. */
export function setSessionStatus(
  project: CalibrationProject,
  to: CalibrationSessionStatus,
  opts?: { note?: string }
): TransitionResult {
  const from = project.sessionStatus;
  if (from === undefined) return { ok: false, reason: 'This project has no automated session.' };
  if (!canTransition(from, to)) {
    return { ok: false, reason: `A session cannot move from "${from}" to "${to}".` };
  }
  project.sessionStatus = to;
  addTimeline(project, {
    stepId: 'project',
    kind: to === 'completed' ? 'completed' : 'note',
    summary: opts?.note ?? `Session ${to.replace(/_/g, ' ')}`
  });
  return { ok: true };
}

export const cancelSession = (p: CalibrationProject, note?: string): TransitionResult =>
  setSessionStatus(p, 'cancelled', { note: note ?? 'Session cancelled' });
export const completeSession = (p: CalibrationProject, note?: string): TransitionResult =>
  setSessionStatus(p, 'completed', { note: note ?? 'Session completed' });
export const failSession = (p: CalibrationProject, note?: string): TransitionResult =>
  setSessionStatus(p, 'failed', { note: note ?? 'Session failed' });

// --- validation ------------------------------------------------------------

/** Structural checks on a working profile. Returns human-readable problems
 *  (empty array = valid). Accepts `unknown` so it can vet data read back from
 *  storage that may have been tampered with or truncated. */
export function validateWorkingProfile(wp: unknown): string[] {
  if (!wp || typeof wp !== 'object') return ['working profile is missing or not an object'];
  const w = wp as Partial<TemporaryCalibrationProfile>;
  const errors: string[] = [];
  if (typeof w.id !== 'string' || !w.id) errors.push('working profile id is missing');
  if (typeof w.createdForProjectId !== 'string' || !w.createdForProjectId) {
    errors.push('working profile is not linked to a project');
  }
  if (
    w.nozzleIndex !== undefined &&
    (typeof w.nozzleIndex !== 'number' || !Number.isInteger(w.nozzleIndex) || w.nozzleIndex < 0)
  ) {
    errors.push('working profile nozzle index is not a whole number');
  }
  const valuesOk = !!w.values && typeof w.values === 'object';
  const provOk = !!w.provenance && typeof w.provenance === 'object';
  if (!valuesOk) errors.push('working profile values are missing');
  if (!provOk) errors.push('working profile provenance is missing');
  if (valuesOk && provOk) {
    for (const key of Object.keys(w.provenance as object)) {
      if (!(key in (w.values as object))) {
        errors.push(`provenance references "${key}" with no matching value`);
      }
    }
  }
  return errors;
}

/** Structural checks on a project's automated session. Empty array = valid. */
export function validateSession(project: CalibrationProject): string[] {
  const errors: string[] = [];
  const status = project.sessionStatus;
  const validStatuses: CalibrationSessionStatus[] = [
    'created', 'in_progress', 'waiting_for_print', 'waiting_for_result',
    'completed', 'cancelled', 'failed'
  ];
  if (status === undefined || !validStatuses.includes(status)) {
    errors.push('session status is missing or invalid');
  }
  if (project.slicerMode === undefined) errors.push('session slicer mode is missing');
  errors.push(...validateWorkingProfile(project.workingProfile));

  // Extra nozzles: each must be well-formed, and no two profiles may claim the
  // same nozzle (two profiles for one nozzle means one silently wins).
  const extras = project.workingProfiles;
  if (extras !== undefined) {
    if (!Array.isArray(extras)) {
      errors.push('session working profiles are not a list');
    } else {
      const seen = new Set<number>([primaryNozzleIndex(project)]);
      extras.forEach((p, i) => {
        for (const e of validateWorkingProfile(p)) errors.push(`nozzle profile ${i + 1}: ${e}`);
        const idx = profileNozzleIndex(p);
        if (seen.has(idx)) errors.push(`two working profiles claim nozzle ${idx + 1}`);
        seen.add(idx);
      });
    }
  }
  return errors;
}

// --- safe loading / recovery -----------------------------------------------

export interface SafeSessionLoad {
  project: CalibrationProject;
  /** True when a usable automated session is present. */
  automated: boolean;
  /** True when a session was present but corrupt and had to be set aside. */
  degraded: boolean;
  warnings: string[];
}

/** Inspect a loaded project and return a usable view of its session. If the
 *  session data is corrupt, the automated fields are stripped so the project
 *  stays fully usable in the manual workflow — the user's calibration results
 *  (steps/finals/history) are never touched. Never throws. */
export function loadSessionSafe(project: CalibrationProject): SafeSessionLoad {
  if (!carriesSessionData(project)) {
    return { project, automated: false, degraded: false, warnings: [] };
  }
  const errors = validateSession(project);
  if (errors.length === 0) {
    return { project, automated: true, degraded: false, warnings: [] };
  }
  // Corrupt session: set the scaffolding aside, keep the real data.
  delete project.automatedSchemaVersion;
  delete project.slicerMode;
  delete project.sessionStatus;
  delete project.workingProfile;
  delete project.workingProfiles;
  delete project.generatedJobs;
  delete project.sessionWarnings;
  delete project.selectedEngineId;
  return {
    project,
    automated: false,
    degraded: true,
    warnings: [
      'The automated session data for this project could not be read and was set aside; ' +
        'your recorded calibration results are unaffected. ' +
        `(${errors.join('; ')})`
    ]
  };
}

// --- queries ---------------------------------------------------------------

/** True when a project carries a usable automated session. */
export function hasAutomatedSession(project: CalibrationProject): boolean {
  return project.sessionStatus !== undefined && !!project.workingProfile;
}

/** True when a project's session can be reopened and continued. */
export function isResumable(project: CalibrationProject): boolean {
  return (
    hasAutomatedSession(project) &&
    project.sessionStatus !== undefined &&
    isSessionResumable(project.sessionStatus)
  );
}

/** Filter a list of projects to the resumable automated sessions (for a resume
 *  prompt / session browser). */
export function resumableSessions(projects: CalibrationProject[]): CalibrationProject[] {
  return projects.filter(isResumable);
}
