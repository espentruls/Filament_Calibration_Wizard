// ---------------------------------------------------------------------------
// Guided session — public surface.
//
// The guided mode is a session-based experience layered ALONGSIDE the classic
// step-by-step wizard, which keeps working exactly as it does today. A session
// is a view over an existing `CalibrationProject`: it knows which nozzle it
// calibrates, carries results forward between steps with visible provenance,
// says precisely what to change in the slicer for that nozzle, and tracks what
// is ready / blocked / stale.
//
// Everything here is pure logic: no DOM, no storage calls, no slicing. The user
// prints the slicer's own built-in test and enters what they see — that manual
// path is the whole of the guided session, on desktop and in the browser alike.
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

export { partialProfile } from './partialProfile';

export {
  clearSessionOverride,
  recordSessionResult,
  resolveGuidedSession,
  resolveSessionNozzle,
  sessionActionsFor,
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
