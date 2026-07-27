// ---------------------------------------------------------------------------
// Guided session — session lifecycle.
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
 * Store a nozzle's working profile on the session. The profile for the session's
 * PRIMARY nozzle is kept in `workingProfile`, where every existing single-nozzle
 * consumer already looks; further nozzles are held alongside it. Replacing a
 * nozzle's profile never disturbs another nozzle's values.
 *
 * The primary slot only ever holds the primary NOZZLE's profile — an empty slot
 * is not a free space another nozzle may occupy. It can legitimately be empty
 * (`loadSessionSafe` empties it when that one profile was corrupt, keeping the
 * others), and letting an auxiliary profile move in would leave its own entry
 * behind: two records claiming one nozzle, one of them stale and invisible, with
 * the next load forced to choose between them.
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

  if (primaryNozzleIndex(project) === index) {
    project.workingProfile = stamped;
    // An older entry for this nozzle would now be a duplicate claim.
    const others = (project.workingProfiles ?? []).filter((p) => profileNozzleIndex(p) !== index);
    if (project.workingProfiles && others.length !== project.workingProfiles.length) {
      project.workingProfiles = others;
    }
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

const VALID_SESSION_STATUSES: readonly CalibrationSessionStatus[] = [
  'created', 'in_progress', 'waiting_for_print', 'waiting_for_result',
  'completed', 'cancelled', 'failed'
];

/** Structural checks on a project's automated session. Empty array = valid.
 *
 *  Reports EVERY problem it finds rather than stopping at the first, because
 *  `loadSessionSafe` has to tell a corrupt profile apart from a valid one that
 *  merely sits next to it. */
export function validateSession(project: CalibrationProject): string[] {
  const errors: string[] = [];
  const status = project.sessionStatus;
  if (status === undefined || !VALID_SESSION_STATUSES.includes(status)) {
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

/** How many recorded values a (possibly corrupt) profile holds; -1 = unreadable. */
function recordedValueCount(profile: unknown): number {
  const values = (profile as Partial<TemporaryCalibrationProfile> | null | undefined)?.values;
  return values && typeof values === 'object' ? Object.keys(values).length : -1;
}

/**
 * Name a (possibly corrupt) working profile precisely enough that the user can
 * tell WHICH nozzle's data is being talked about. A warning that says only
 * "the session data" cannot be acted on — and on a dual-nozzle machine it is
 * the difference between "the nozzle I already re-measured" and "the bowden
 * auxiliary I spent an evening on".
 */
function describeProfile(profile: unknown, fallbackNozzle: number): string {
  const p = (profile && typeof profile === 'object' ? profile : {}) as Partial<TemporaryCalibrationProfile>;
  const raw = p.nozzleIndex;
  const known = typeof raw === 'number' && Number.isInteger(raw) && raw >= 0;
  const index = known ? (raw as number) : fallbackNozzle;
  const detail: string[] = [];
  if (typeof p.displayName === 'string' && p.displayName.trim()) detail.push(`"${p.displayName.trim()}"`);
  const count = recordedValueCount(profile);
  if (count >= 0) detail.push(`${count} recorded value${count === 1 ? '' : 's'}`);
  if (!known) detail.push('no nozzle recorded');
  return `the working profile for nozzle ${index + 1}${detail.length ? ` (${detail.join(', ')})` : ''}`;
}

/** A profile that survived validation, with the nozzle it is read as. */
interface SurvivingProfile {
  profile: TemporaryCalibrationProfile;
  nozzle: number;
}

/**
 * Inspect a loaded project and return a usable view of its session.
 *
 * Corrupt session data is set aside so the project stays fully usable in the
 * manual workflow; the user's calibration results (steps/finals/history) are
 * never touched. Never throws.
 *
 * EVERY WORKING PROFILE IS JUDGED ON ITS OWN. A session on a dual-nozzle
 * machine keeps one profile per nozzle, and `workingProfiles` is the ONLY
 * record of the auxiliary nozzle's measurements — on the Bambu X2D that is the
 * bowden-fed nozzle this whole product exists for. Discarding it because a
 * DIFFERENT nozzle's profile is malformed would be silent, permanent data loss,
 * so a corrupt profile takes nothing with it but itself.
 *
 * What is genuinely reconstructable — the status, slicer mode, engine choice and
 * generated-job records — is reset when it no longer describes anything, which
 * leaves the project reading as "session not started". Starting the session
 * again reattaches every surviving profile (see `ensureSessionFields`), so the
 * measurements come back with it.
 */
export function loadSessionSafe(project: CalibrationProject): SafeSessionLoad {
  if (!carriesSessionData(project)) {
    return { project, automated: false, degraded: false, warnings: [] };
  }
  if (validateSession(project).length === 0) {
    return { project, automated: true, degraded: false, warnings: [] };
  }

  const warnings: string[] = [];
  let removedSomething = false;
  // The nozzle the primary slot speaks for, read BEFORE anything is removed so a
  // corrupt primary cannot move it (and so a surviving profile is never promoted
  // into the primary slot from a DIFFERENT nozzle).
  const primaryNozzle = primaryNozzleIndex(project);

  // --- 1. validate and salvage each profile independently --------------------
  const survivors: SurvivingProfile[] = [];
  const consider = (candidate: unknown, fallbackNozzle: number): void => {
    const errors = validateWorkingProfile(candidate);
    if (errors.length) {
      warnings.push(
        `Could not read ${describeProfile(candidate, fallbackNozzle)}; it was set aside ` +
          `(${errors.join('; ')}). No other nozzle's profile was affected.`
      );
      removedSomething = true;
      return;
    }
    const profile = candidate as TemporaryCalibrationProfile;
    survivors.push({ profile, nozzle: profileNozzleIndex(profile, fallbackNozzle) });
  };

  if (project.workingProfile !== undefined) consider(project.workingProfile, primaryNozzle);

  const extras = project.workingProfiles;
  if (extras !== undefined && !Array.isArray(extras)) {
    warnings.push(
      'The list of extra nozzle working profiles was not a list and was set aside; ' +
        'no individual profile could be recovered from it.'
    );
    removedSomething = true;
  } else {
    // `getWorkingProfile` reads an extra with no stamped nozzle as nozzle 0, so
    // recovery reads it the same way — recovery must never disagree with reads.
    for (const extra of extras ?? []) consider(extra, 0);
  }

  // --- 2. one profile per nozzle, keeping the richer of any duplicate --------
  const byNozzle = new Map<number, TemporaryCalibrationProfile>();
  for (const { profile, nozzle } of survivors) {
    const existing = byNozzle.get(nozzle);
    if (!existing) {
      byNozzle.set(nozzle, profile);
      continue;
    }
    // Two records claim one nozzle: one of them was already invisible to every
    // reader. Keep whichever holds more measurements (ties keep the one a reader
    // would already have seen) and say exactly which one went.
    const keep = Object.keys(profile.values).length > Object.keys(existing.values).length
      ? profile
      : existing;
    const dropped = keep === profile ? existing : profile;
    byNozzle.set(nozzle, keep);
    warnings.push(
      `Two working profiles claimed nozzle ${nozzle + 1}. ` +
        `${describeProfile(dropped, nozzle).replace(/^the/, 'The')} was set aside; ` +
        `${describeProfile(keep, nozzle)} was kept.`
    );
    removedSomething = true;
  }

  // --- 3. rebuild the two storage slots, touching nothing that did not change -
  const primaryProfile = byNozzle.get(primaryNozzle);
  const rest = [...byNozzle.entries()]
    .filter(([nozzle]) => nozzle !== primaryNozzle)
    .sort((a, b) => a[0] - b[0])
    .map(([, profile]) => profile);

  if (primaryProfile !== project.workingProfile) {
    if (primaryProfile) project.workingProfile = primaryProfile;
    else delete project.workingProfile;
  }
  const extrasUnchanged =
    Array.isArray(extras) && rest.length === extras.length && rest.every((p, i) => p === extras[i]);
  if (!extrasUnchanged) {
    if (rest.length) project.workingProfiles = rest;
    else if (extras !== undefined) delete project.workingProfiles;
  }
  // Nothing survived at all: drop even an empty leftover list, so the project
  // reads as a plain manual one rather than as a session with no profiles
  // (`carriesSessionData` would otherwise stay true forever).
  if (!project.workingProfile && project.workingProfiles && !project.workingProfiles.length) {
    delete project.workingProfiles;
  }

  // --- 4. reset the reconstructable scaffolding only if it describes nothing --
  const status = project.sessionStatus;
  const usable =
    !!project.workingProfile &&
    status !== undefined &&
    VALID_SESSION_STATUSES.includes(status) &&
    project.slicerMode !== undefined;

  const hasScaffolding =
    project.automatedSchemaVersion !== undefined ||
    project.slicerMode !== undefined ||
    project.sessionStatus !== undefined ||
    project.generatedJobs !== undefined ||
    project.sessionWarnings !== undefined ||
    project.selectedEngineId !== undefined;

  if (!usable && hasScaffolding) {
    delete project.automatedSchemaVersion;
    delete project.slicerMode;
    delete project.sessionStatus;
    delete project.generatedJobs;
    delete project.sessionWarnings;
    delete project.selectedEngineId;
    removedSomething = true;
    const kept = [...byNozzle.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([nozzle, profile]) => describeProfile(profile, nozzle));
    warnings.push(
      'The session’s own record (status, slicer mode and prepared jobs) no longer ' +
        'described a usable session and was reset to "not started". ' +
        (kept.length
          ? `Your measured values were kept — ${kept.join('; ')} — and are reattached ` +
            'the next time you start the session.'
          : 'No working profile could be recovered.')
    );
  }

  if (!removedSomething) {
    return { project, automated: usable, degraded: false, warnings: [] };
  }
  warnings.push(
    'Your recorded calibration results (steps, history and finals) are unaffected.'
  );
  return { project, automated: usable, degraded: true, warnings };
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
