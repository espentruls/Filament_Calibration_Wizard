// ---------------------------------------------------------------------------
// Guided session — public surface.
//
// The guided mode is a session-based experience layered ALONGSIDE the classic
// step-by-step wizard, which keeps working exactly as it does today. A session
// is a view over an existing `CalibrationProject`: it knows which nozzle it
// calibrates, carries results forward between steps with visible provenance,
// says precisely what to change in the slicer for that nozzle, tracks what is
// ready / blocked / stale, and — only when an engine is genuinely available —
// offers to prepare the next test automatically.
//
// Everything here is pure logic: no DOM, no storage calls, no slicing. It runs
// with the experimental `automatedCalibration` flag OFF, which is its default.
// ---------------------------------------------------------------------------

export type * from './types';
// The two provenance bridges are runtime maps, so they need a value export of
// their own — `export type *` above carries the interfaces only.
export { PROVENANCE_FROM_UPSTREAM, PROVENANCE_TO_UPSTREAM } from './types';

export {
  VALUE_META,
  CANONICAL_KEYS,
  buildValueContext,
  formatValue,
  inheritedInputsFor,
  isSatisfying,
  keysProducedBy,
  resolveAllValues,
  resolveStepValues,
  resolveValue,
  stepsProducing
} from './values';
export type { ValueContext, ValueMeta } from './values';

export {
  buildPlan,
  firstWithPhase,
  focusStep,
  nextActionable,
  progressPercent,
  stepBlockers,
  stepRecord,
  stepStaleness
} from './progression';
export type { StepRecord } from './progression';

export { alerts, buildActionPlan, valueActions } from './actions';

// The single auto-preparation gate. `resolveSessionCapability` /
// `peekSessionCapability` are what a screen calls; the probe below them is
// cached per session, so asking once per render costs one filesystem scan
// rather than one per draw. The machine-level calls are exported for callers
// that have no session in hand (a plan overview, a diagnostics screen).
export {
  AUTOMATABLE_SLICERS,
  ENGINE_PROBE_TTL_MS,
  PREPARABLE_ASSET_TYPES,
  canAutoPrepareStep,
  canAutoPrepareSteps,
  invalidateEngineAvailability,
  peekEngineAvailability,
  peekSessionCapability,
  probeEngineAvailability,
  resolveSessionCapability,
  slicerIsAutomatable,
  stepAutoPrepareFrom
} from './capability';
export type {
  CapabilityOptions,
  EngineAvailability,
  EngineAvailabilityInput,
  StepAutoPrepareAnswer
} from './capability';

export { partialProfile } from './partialProfile';

export {
  clearSessionOverride,
  recordSessionResult,
  resolveGuidedSession,
  resolveSessionNozzle,
  sessionActionsFor,
  sessionCapabilityFor,
  sessionContext,
  sessionMaterial,
  sessionPartialProfile,
  sessionStepView,
  sessionValues,
  sessionValuesFor,
  setSessionOverride,
  startGuidedSession,
  syncSessionValues
} from './session';
export type {
  OverrideInput,
  RecordResultInput,
  RecordResultOutcome,
  ResolveSessionInput,
  SessionStepView,
  StartSessionOptions,
  SyncOptions
} from './session';
