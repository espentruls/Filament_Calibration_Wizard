// ---------------------------------------------------------------------------
// Session / working-profile helpers — public surface.
//
// This directory once also held the assisted auto-prepare path: a slicing-engine
// abstraction, an Orca preset resolver, a 3mf project assembler and an unbounded
// project-config merge. That path was deleted before release, together with the
// native commands behind it (see CHANGELOG.md and docs/X2D_ENHANCEMENT_PLAN.md).
// What remains is what the guided session in `src/session` actually uses: pure,
// storage-only helpers for per-nozzle working profiles and the step workflow.
// Nothing here slices, writes a project file, or edits a slicer preset.
// ---------------------------------------------------------------------------

export type * from './types';

export {
  createTemporaryProfile,
  applyValue,
  valuesFromSource,
  fingerprintValues,
  jobIsStale,
  isSessionResumable,
  normalizeNozzleIndex,
  profileNozzleIndex,
  primaryNozzleIndex,
  printerNozzleCount,
  getWorkingProfile,
  listWorkingProfiles
} from './session';
// `workingProfileNozzles` stays module-local: nothing outside `./session` calls
// it, and the guided UI deliberately draws one panel per PHYSICAL nozzle from
// the printer profile rather than one per stored working profile. Import it from
// './session' directly if a caller ever genuinely needs it.
export type { WorkingProfileHolder } from './session';

export {
  AUTOMATED_SESSION_SCHEMA,
  buildWorkingProfile,
  setWorkingProfile,
  ensureWorkingProfile,
  beginSession,
  canTransition,
  setSessionStatus,
  cancelSession,
  completeSession,
  failSession,
  validateWorkingProfile,
  validateSession,
  loadSessionSafe,
  hasAutomatedSession,
  isResumable,
  resumableSessions
} from './sessionManager';
export type { WorkingProfileSeed, TransitionResult, SafeSessionLoad } from './sessionManager';

export {
  WORKFLOW_STEPS,
  getStepDefinition,
  orderWorkflow,
  missingDependencies,
  stepReadiness,
  validateStepResult,
  applyStepResult,
  inputFingerprintForStep,
  markStaleJobs
} from './workflow';
export type { NormalizedProfileKey, StepResultValues, StepReadiness } from './workflow';
