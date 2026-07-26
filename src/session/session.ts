// ---------------------------------------------------------------------------
// Guided session — the engine itself.
//
// `resolveGuidedSession` composes a read-only VIEW over an existing project:
// its nozzle, its plan, where the user is, what each step inherits, what to
// change in the slicer, and whether an engine could help. Nothing is persisted
// by resolving; a project that has only ever been driven by the classic
// step-by-step wizard opens in guided mode with no migration at all.
//
// The write half is deliberately small. A project already stores results
// (`steps`, `finals`, `timeline`) and the classic wizard already writes them —
// that path is untouched. What a project CANNOT express is per-nozzle working
// values with provenance, which is exactly what upstream's optional session
// fields hold. So the writers here do one thing: keep that working profile in
// step with the project's own record, and let the user override a value on
// purpose.
//
// Everything in this module runs with the experimental `automatedCalibration`
// flag off. The flag gates engines and slicing, not data shapes.
// ---------------------------------------------------------------------------

import type {
  CalibrationId,
  CalibrationProject,
  MaterialPreset,
  PrinterProfile
} from '../types';
import { getMaterial } from '../data/materials';
import { getSlicerContent } from '../data/slicers';
import { resolveNozzle } from '../logic/ranges';
import { carriesSessionData } from '../automatedCalibration/sessionManager';
import {
  beginSession,
  buildWorkingProfile,
  ensureWorkingProfile,
  getWorkingProfile,
  hasAutomatedSession,
  loadSessionSafe,
  markStaleJobs,
  normalizeNozzleIndex,
  printerNozzleCount,
  setWorkingProfile,
  validateStepResult,
  applyStepResult,
  applyValue,
  type EngineId,
  type NormalizedProfileKey,
  type SlicerMode,
  type StepResultValues,
  type TemporaryCalibrationProfile
} from '../automatedCalibration';
import {
  CANONICAL_KEYS,
  buildValueContext,
  resolveAllValues,
  resolveStepValues,
  resolveValue,
  type ValueContext
} from './values';
import { buildPlan, focusStep, nextActionable, progressPercent } from './progression';
import { buildActionPlan } from './actions';
import { partialProfile } from './partialProfile';
import { resolveSessionCapability, type CapabilityOptions } from './capability';
import {
  PROVENANCE_TO_UPSTREAM,
  type GuidedSession,
  type PartialProfileReport,
  type ResolvedValue,
  type SessionActionPlan,
  type SessionCapability,
  type SessionNozzle,
  type SessionStep,
  type SessionSyncResult,
  type StepWorkingValues
} from './types';

// --- nozzle -----------------------------------------------------------------

/**
 * Which physical nozzle a session calibrates, resolved against the printer
 * profile. Reuses `resolveNozzle` from the ranges logic, so the guided flow and
 * the classic wizard can never disagree about a nozzle's feed path.
 */
export function resolveSessionNozzle(
  project: Pick<CalibrationProject, 'nozzleIndex'>,
  printer?: PrinterProfile,
  nozzleIndex?: number
): SessionNozzle {
  const index = normalizeNozzleIndex(nozzleIndex ?? project.nozzleIndex);
  const { nozzle, feed } = resolveNozzle({ nozzleIndex: index }, printer);
  const count = printerNozzleCount(printer);
  return {
    index,
    label: nozzle?.label ?? (count > 1 ? `Nozzle ${index + 1}` : 'this nozzle'),
    feed,
    profile: nozzle,
    multiNozzle: count > 1,
    auxiliary: count > 1 && index > 0
  };
}

// --- resolve ----------------------------------------------------------------

export interface ResolveSessionInput {
  project: CalibrationProject;
  printer?: PrinterProfile;
  /**
   * Which nozzle to view. Defaults to the project's own nozzle, which is the
   * normal case — a project calibrates one nozzle. Naming a DIFFERENT nozzle
   * gives a view backed solely by that nozzle's working profile, so two nozzles
   * can never read each other's results.
   */
  nozzleIndex?: number;
}

/** Build the guided session view. Pure: resolving never persists anything. */
export function resolveGuidedSession(input: ResolveSessionInput): GuidedSession {
  const warnings: string[] = [];

  // Corrupt session scaffolding is set aside (upstream's recovery), never
  // rendered — the user's calibration results are untouched either way.
  const project = input.project;
  // Shares one predicate with the importer and the session loader, so the three
  // can never disagree about whether a project carries session scaffolding.
  if (carriesSessionData(project)) {
    warnings.push(...loadSessionSafe(project).warnings);
  }

  const nozzle = resolveSessionNozzle(project, input.printer, input.nozzleIndex);
  const ctx = buildValueContext({
    project,
    printer: input.printer,
    nozzleIndex: nozzle.index
  });
  const plan = buildPlan(ctx);
  const content = getSlicerContent(project.slicer.slicer, project.slicer.version);

  if (!input.printer) {
    warnings.push(
      'No printer profile is attached to this project, so nozzle feed path and machine limits are unknown.'
    );
  }
  const count = printerNozzleCount(input.printer);
  if (count > 0 && nozzle.index >= count) {
    warnings.push(
      `This project targets nozzle ${nozzle.index + 1}, but the printer profile describes ${count} nozzle${count === 1 ? '' : 's'}.`
    );
  }
  if (!ctx.ownsProjectResults) {
    warnings.push(
      `This view shows ${nozzle.label} only. The project records its own results for nozzle ${normalizeNozzleIndex(project.nozzleIndex) + 1}, so nothing measured there appears here.`
    );
  }

  return {
    projectId: project.id,
    project,
    printer: input.printer,
    nozzle,
    slicer: content.slicer,
    slicerLabel: content.slicerLabel,
    slicerVersion: content.version,
    status: project.sessionStatus ?? 'created',
    started: hasAutomatedSession(project),
    plan,
    nextActionableStepId: nextActionable(plan),
    focusStepId: focusStep(plan),
    completedStepIds: plan.filter((s) => s.status === 'completed').map((s) => s.id),
    blockedStepIds: plan.filter((s) => s.phase === 'blocked').map((s) => s.id),
    staleStepIds: plan.filter((s) => s.staleness.stale).map((s) => s.id),
    progressPercent: progressPercent(plan),
    warnings
  };
}

/** Rebuild the resolution context for a session. Cheap and deterministic. */
export function sessionContext(session: GuidedSession): ValueContext {
  return buildValueContext({
    project: session.project,
    printer: session.printer,
    nozzleIndex: session.nozzle.index
  });
}

// --- per-step views ---------------------------------------------------------

/** The values a step should run with, resolved with provenance. */
export function sessionValuesFor(
  session: GuidedSession,
  stepId: CalibrationId
): StepWorkingValues {
  return resolveStepValues(sessionContext(session), stepId);
}

/** The ordered "change this now" list for a step, routed from slicers.ts. */
export function sessionActionsFor(
  session: GuidedSession,
  stepId: CalibrationId
): SessionActionPlan {
  return buildActionPlan(sessionContext(session), session.nozzle, stepId);
}

/** Whether this step could be auto-prepared right now (progressive enhancement). */
export function sessionCapabilityFor(
  session: GuidedSession,
  stepId: CalibrationId,
  opts?: CapabilityOptions
): Promise<SessionCapability> {
  return resolveSessionCapability(sessionContext(session), session.nozzle, stepId, opts);
}

/** Which calibrated values exist so far, for a partial profile install. */
export function sessionPartialProfile(session: GuidedSession): PartialProfileReport {
  return partialProfile(sessionContext(session), session.nozzle);
}

/** Every value known for this nozzle, canonical order, with provenance. */
export function sessionValues(session: GuidedSession): ResolvedValue[] {
  return resolveAllValues(sessionContext(session));
}

export interface SessionStepView {
  step: SessionStep;
  values: StepWorkingValues;
  actions: SessionActionPlan;
}

/** Everything the UI needs to render one step of the guided flow, in one call. */
export function sessionStepView(
  session: GuidedSession,
  stepId: CalibrationId
): SessionStepView | null {
  const step = session.plan.find((s) => s.id === stepId);
  if (!step) return null;
  const ctx = sessionContext(session);
  return {
    step,
    values: resolveStepValues(ctx, stepId),
    actions: buildActionPlan(ctx, session.nozzle, stepId)
  };
}

// --- writes -----------------------------------------------------------------

export interface StartSessionOptions {
  printer?: PrinterProfile;
  nozzleIndex?: number;
  /** Defaults to `manual_export` — the always-available path. */
  slicerMode?: SlicerMode;
  engineId?: EngineId;
  displayName?: string;
  now?: string;
}

/**
 * Attach the persisted half of a guided session to a project and bring its
 * working profile up to date with whatever the project has already measured.
 *
 * Idempotent: starting a session on a project that already has one only syncs.
 * The default slicer mode is `manual_export`, which is honest — the manual path
 * is what runs until an engine is both present and proven for this nozzle.
 */
export function startGuidedSession(
  project: CalibrationProject,
  opts: StartSessionOptions = {}
): SessionSyncResult {
  const index = normalizeNozzleIndex(opts.nozzleIndex ?? project.nozzleIndex);
  const displayName =
    opts.displayName ??
    project.filament.startingProfile ??
    `${project.filament.manufacturer} ${project.filament.material}`.trim();

  ensureSessionFields(project, index, {
    displayName,
    slicerMode: opts.slicerMode,
    engineId: opts.engineId,
    now: opts.now
  });
  return syncSessionValues(project, { printer: opts.printer, nozzleIndex: index, now: opts.now });
}

/**
 * Make sure the project carries a complete, valid set of session fields plus a
 * working profile for this nozzle.
 *
 * Completeness matters: upstream's `loadSessionSafe` sets aside session data
 * that fails validation, so a working profile written without a session status
 * would be silently discarded on the next read — taking the user's overrides
 * with it. Every writer here goes through this function.
 */
function ensureSessionFields(
  project: CalibrationProject,
  nozzleIndex: number,
  opts: { displayName?: string; slicerMode?: SlicerMode; engineId?: EngineId; now?: string } = {}
): TemporaryCalibrationProfile {
  const displayName =
    opts.displayName ??
    project.workingProfile?.displayName ??
    project.filament.startingProfile ??
    `${project.filament.manufacturer} ${project.filament.material}`.trim();

  if (!hasAutomatedSession(project)) {
    const primary =
      project.workingProfile ??
      buildWorkingProfile({
        projectId: project.id,
        displayName,
        sourceProfileName: project.filament.startingProfile,
        nozzleIndex,
        now: opts.now
      });
    beginSession(project, {
      slicerMode: opts.slicerMode ?? 'manual_export',
      engineId: opts.engineId,
      workingProfile: primary,
      additionalProfiles: project.workingProfiles ?? []
    });
  }
  return ensureWorkingProfile(project, nozzleIndex, {
    displayName,
    sourceProfileName: project.filament.startingProfile,
    now: opts.now
  });
}

export interface SyncOptions {
  printer?: PrinterProfile;
  nozzleIndex?: number;
  now?: string;
}

/**
 * Push the project's recorded results into the nozzle's working profile, so the
 * profile is a faithful snapshot of what the session currently knows — values
 * plus provenance. Call it after the classic wizard completes a step; it is
 * idempotent, so calling it more often than necessary costs nothing.
 *
 * Only values that carry real information are written (measurements, deliberate
 * overrides, values carried from the base profile). Material defaults are
 * resolved on read and never materialize, so the profile never claims to know
 * something it does not.
 */
export function syncSessionValues(
  project: CalibrationProject,
  opts: SyncOptions = {}
): SessionSyncResult {
  const index = normalizeNozzleIndex(opts.nozzleIndex ?? project.nozzleIndex);
  const ctx = buildValueContext({ project, printer: opts.printer, nozzleIndex: index });
  const changedKeys: NormalizedProfileKey[] = [];

  let profile = getWorkingProfile(project, index);
  if (profile) {
    for (const key of CANONICAL_KEYS) {
      const resolved = resolveValue(ctx, key, false);
      if (resolved.value === undefined || !resolved.satisfied) continue;
      const currentValue = profile.values[key];
      const currentSource = profile.provenance[key]?.source;
      const nextSource = PROVENANCE_TO_UPSTREAM[
        resolved.provenance as Exclude<typeof resolved.provenance, 'unset'>
      ];
      if (currentValue === resolved.value && currentSource === nextSource) continue;
      profile = applyValue(profile, key, resolved.value, nextSource, {
        stepId: resolved.stepId,
        now: resolved.at ?? opts.now
      });
      changedKeys.push(key);
    }
    if (changedKeys.length) setWorkingProfile(project, profile);
  }

  return { project, changedKeys, staleJobIds: markStaleJobs(project) };
}

export interface OverrideInput {
  key: NormalizedProfileKey;
  value: number;
  nozzleIndex?: number;
  now?: string;
}

/**
 * Record a value the user set on purpose. An override placed AFTER a
 * measurement supersedes it (see `resolveValue`); an older one does not, so a
 * fresh calibration result always wins over a stale override.
 */
export function setSessionOverride(
  project: CalibrationProject,
  input: OverrideInput
): SessionSyncResult {
  const index = normalizeNozzleIndex(input.nozzleIndex ?? project.nozzleIndex);
  const existing = ensureSessionFields(project, index, { now: input.now });
  const next = applyValue(existing, input.key, input.value, 'user_input', { now: input.now });
  setWorkingProfile(project, next);
  return { project, changedKeys: [input.key], staleJobIds: markStaleJobs(project) };
}

/** Drop a user override so the value falls back to what was measured. */
export function clearSessionOverride(
  project: CalibrationProject,
  input: { key: NormalizedProfileKey; nozzleIndex?: number }
): SessionSyncResult {
  const index = normalizeNozzleIndex(input.nozzleIndex ?? project.nozzleIndex);
  const profile = getWorkingProfile(project, index);
  if (!profile || profile.provenance[input.key]?.source !== 'user_input') {
    return { project, changedKeys: [], staleJobIds: markStaleJobs(project) };
  }
  const values = { ...profile.values };
  const provenance = { ...profile.provenance };
  delete values[input.key];
  delete provenance[input.key];
  setWorkingProfile(project, { ...profile, values, provenance });
  return { project, changedKeys: [input.key], staleJobIds: markStaleJobs(project) };
}

export interface RecordResultInput {
  stepId: CalibrationId;
  values: StepResultValues;
  nozzleIndex?: number;
  now?: string;
}

export interface RecordResultOutcome extends SessionSyncResult {
  /** Validation problems from upstream. Non-empty means nothing was written. */
  errors: string[];
  profile?: TemporaryCalibrationProfile;
}

/**
 * Record a measurement straight into a nozzle's working profile.
 *
 * This exists for a nozzle the project does not itself record — the second feed
 * path on a dual-nozzle machine. For the project's own nozzle the classic
 * wizard remains the way results are saved (it writes the attempt, history,
 * photos, timeline and finals); call `syncSessionValues` afterwards.
 *
 * Validation and application are upstream's (`validateStepResult`,
 * `applyStepResult`). No calibration math happens here.
 */
export function recordSessionResult(
  project: CalibrationProject,
  input: RecordResultInput
): RecordResultOutcome {
  const errors = validateStepResult(input.stepId, input.values);
  if (errors.length) {
    return { project, changedKeys: [], staleJobIds: [], errors };
  }
  const index = normalizeNozzleIndex(input.nozzleIndex ?? project.nozzleIndex);
  const existing = ensureSessionFields(project, index, { now: input.now });
  const next = applyStepResult(existing, input.stepId, input.values, { now: input.now });
  setWorkingProfile(project, next);
  return {
    project,
    changedKeys: Object.keys(input.values) as NormalizedProfileKey[],
    staleJobIds: markStaleJobs(project),
    errors: [],
    profile: getWorkingProfile(project, index)
  };
}

/** Convenience: the material preset a project calibrates. */
export function sessionMaterial(project: CalibrationProject): MaterialPreset {
  return getMaterial(project.filament.material);
}
