// ---------------------------------------------------------------------------
// Guided session — public types.
//
// A guided session is a VIEW over an existing `CalibrationProject`, not a second
// entity competing with it. The project already records the plan (`stepOrder`),
// the results (`steps`, `finals`), the nozzle (`nozzleIndex`) and the timeline;
// the session adds only what a project cannot express on its own — where the
// user is, what each value's PROVENANCE is, and what to change in the slicer
// right now.
//
// The persisted half of that (session status, per-nozzle working profiles,
// generated jobs) reuses the optional session fields upstream already added to
// `CalibrationProject`; nothing new is stored. Everything else in this file is
// derived on read, so an existing project opened in guided mode needs no
// migration and the classic step-by-step wizard keeps working untouched.
// ---------------------------------------------------------------------------

import type {
  CalibrationId,
  CalibrationProject,
  ConfidenceLevel,
  ExtruderType,
  NozzleProfile,
  PrinterProfile,
  SlicerId,
  StepStatus
} from '../types';
import type { CalibrationSessionStatus, ProvenanceSource } from '../automatedCalibration';
import type { NormalizedProfileKey } from '../automatedCalibration';

// --- values & provenance ----------------------------------------------------

/**
 * Where a resolved value came from. This is not decoration: the product promise
 * is "no black boxes", so every number the guided flow pre-fills has to say why
 * it is that number.
 *
 * Maps one-to-one onto upstream's `ProvenanceSource`, with one addition —
 * `unset`, which the working-profile shape cannot express because a profile only
 * stores values it HAS. An unset value is what makes the UI's unlit dial
 * possible: never a fabricated zero.
 */
export type ValueProvenance =
  | 'calibrated'
  | 'user-override'
  | 'carried'
  | 'printer-default'
  | 'material-default'
  | 'unset';

/** One source that offered a value for a key, with the reason it did. */
export interface ValueCandidate {
  provenance: Exclude<ValueProvenance, 'unset'>;
  value: number;
  /** ISO timestamp the value was recorded/measured, when known. */
  at?: string;
  /** The calibration that measured it (provenance `calibrated`). */
  stepId?: CalibrationId;
  /** Sentence-case explanation shown next to the number. */
  detail: string;
}

/** A single setting resolved for one step on one nozzle, with its provenance. */
export interface ResolvedValue {
  key: NormalizedProfileKey;
  label: string;
  unit: string;
  /** Decimal places for display — formatting only, never applied to math. */
  precision: number;
  /** Absent means "not known". The UI must render an unlit dial, not a zero. */
  value?: number;
  provenance: ValueProvenance;
  stepId?: CalibrationId;
  at?: string;
  /** One sentence explaining why the value is what it is. */
  explanation: string;
  /** Suggested band from the material preset, where one exists. */
  suggestedRange?: { min: number; max: number };
  /** Every source considered, winner first — the "why" the UI can expand. */
  candidates: ValueCandidate[];
  /** True when the step cannot be trusted without this value. */
  required: boolean;
  /**
   * True when the value is real information — measured, overridden on purpose,
   * or carried from the base profile. A material default does NOT satisfy a
   * requirement: running pressure advance at a material's generic flow ratio is
   * precisely the mistake the guided flow exists to prevent, so it is shown as a
   * placeholder and still counts as missing.
   */
  satisfied: boolean;
  /** Pre-formatted `value + unit`, or undefined when unset. */
  display?: string;
}

/** The inputs a step should run with, resolved from everything already known. */
export interface StepWorkingValues {
  stepId: CalibrationId;
  nozzleIndex: number;
  /** Required first, then optional; canonical key order within each group. */
  inherited: ResolvedValue[];
  /** Required keys still unknown — the reason a step is not ready. */
  missing: NormalizedProfileKey[];
  /** Keys this step will produce when it completes. */
  produces: NormalizedProfileKey[];
  /** True when every required input is known. */
  ready: boolean;
}

// --- progression ------------------------------------------------------------

export type StepPhase =
  | 'complete'
  | 'stale'
  | 'in-progress'
  | 'ready'
  | 'blocked'
  | 'skipped';

/** Why a step cannot start yet. */
export interface StepBlocker {
  kind: 'step' | 'value';
  /** The dependency step that has not run (kind `step`). */
  stepId?: CalibrationId;
  /** The unknown input (kind `value`). */
  key?: NormalizedProfileKey;
  reason: string;
}

export type StaleReasonKind =
  | 'dependency-recalibrated'
  | 'inputs-changed'
  | 'retest-flagged';

export interface StaleReason {
  kind: StaleReasonKind;
  /** The dependency whose result moved (kind `dependency-recalibrated`). */
  stepId?: CalibrationId;
  detail: string;
}

export interface StepStaleness {
  stale: boolean;
  reasons: StaleReason[];
}

/** One entry of the session's ordered plan. */
export interface SessionStep {
  id: CalibrationId;
  name: string;
  shortName: string;
  icon: string;
  /** 1-based position in this project's plan. */
  position: number;
  /** The project's own recorded status. */
  status: StepStatus;
  phase: StepPhase;
  blockedBy: StepBlocker[];
  missingInputs: NormalizedProfileKey[];
  produces: NormalizedProfileKey[];
  staleness: StepStaleness;
  retestRecommended: boolean;
  confidence?: ConfidenceLevel;
  completedAt?: string;
  /** True for steps outside DEFAULT_ORDER (currently only ooze-control). */
  optional: boolean;
  /** True when this step is a checklist rather than a sliced test print. */
  needsSlicing: boolean;
}

// --- what to change right now -----------------------------------------------

export type SessionActionKind =
  | 'carry-forward'
  /**
   * Something to set on the MACHINE rather than in a preset — currently only the
   * build chamber. Its wording comes from `src/data/materials.ts`, not from the
   * slicer content, and its `source` says so; it carries a menu path only if the
   * shipped slicer data names a chamber field, and otherwise the plan records a
   * gap rather than inventing one.
   */
  | 'environment'
  | 'disable'
  | 'perform'
  | 'record'
  | 'trap';

export type ActionSeverity = 'info' | 'caution' | 'alert';

/**
 * One precise instruction. Every `path`, `field`, `detail` and `nozzleColumn`
 * string is taken verbatim from `src/data/slicers.ts` — this module routes
 * shipped, version-aware, wiki-verified content and never writes slicer facts of
 * its own. `title` is app copy (sentence case).
 *
 * The single exception is the `environment` kind, whose `detail` comes verbatim
 * from the material preset in `src/data/materials.ts`; it is still routed, never
 * written here, and `source` names the file it came from either way.
 */
export interface SessionAction {
  id: string;
  order: number;
  kind: SessionActionKind;
  title: string;
  slicer: SlicerId;
  slicerLabel: string;
  slicerVersion: string;
  /** Menu/settings path, verbatim from the slicer content. */
  path?: string;
  /** Exact field name, verbatim from the slicer content. */
  field?: string;
  /** The value to type, formatted. Absent when the test has yet to measure it. */
  value?: string;
  /**
   * Which per-extruder column the value belongs in, e.g. "Bowden Extruder".
   * Only ever populated when the shipped slicer content names that column.
   */
  nozzleColumn?: string;
  detail: string;
  severity: ActionSeverity;
  /** Where the wording came from, for auditing: file · slicer · step · field. */
  source: string;
  /** The calibration whose instructions supplied this action. */
  fromStepId: CalibrationId;
}

export interface SessionActionPlan {
  stepId: CalibrationId;
  nozzleIndex: number;
  nozzleLabel: string;
  feed: ExtruderType;
  slicer: SlicerId;
  slicerLabel: string;
  slicerVersion: string;
  verifiedOn: string;
  docsUrl: string;
  calibrationMenuPath: string;
  /** The step's own menu path, when the shipped content has one. */
  menuPath?: string;
  /** False when the slicer has no entry for this test. */
  available: boolean;
  actions: SessionAction[];
  /**
   * Things the shipped data does not cover, stated plainly. The alternative —
   * inventing a menu path — is forbidden.
   */
  gaps: string[];
}

// --- partial profile --------------------------------------------------------

export interface PartialProfileReport {
  nozzleIndex: number;
  /** Every value measured so far, in canonical order. */
  values: ResolvedValue[];
  calibratedKeys: NormalizedProfileKey[];
  /** Keys the remaining plan steps would still produce. */
  missingKeys: NormalizedProfileKey[];
  completedSteps: CalibrationId[];
  remainingSteps: CalibrationId[];
  /** True when at least one value is measured — enough to install something. */
  installable: boolean;
  /** True when every value the plan can produce has been measured. */
  complete: boolean;
  /**
   * The app's existing calibration confidence score (0–100). Present only for
   * the project's own nozzle, which is what that score describes.
   */
  confidence?: number;
  /** Sentence-case summary, e.g. "Temperature and flow ratio are measured…". */
  summary: string;
}

// --- the session ------------------------------------------------------------

/** Which physical nozzle a session calibrates, resolved against the printer. */
export interface SessionNozzle {
  index: number;
  label: string;
  feed: ExtruderType;
  /** The printer profile's nozzle entry, when the profile has one. */
  profile?: NozzleProfile;
  /** True when the printer is known to have more than one nozzle. */
  multiNozzle: boolean;
  /** True for a non-primary nozzle on a multi-nozzle machine. */
  auxiliary: boolean;
}

export interface GuidedSession {
  projectId: string;
  project: CalibrationProject;
  printer?: PrinterProfile;
  nozzle: SessionNozzle;
  slicer: SlicerId;
  slicerLabel: string;
  slicerVersion: string;
  /**
   * Upstream's session status when the project carries one, else `created` for
   * a project that has only ever been driven by the classic wizard.
   */
  status: CalibrationSessionStatus;
  /** True when the project carries persisted session fields. */
  started: boolean;
  /** The ordered plan, exactly the project's own `stepOrder`. */
  plan: SessionStep[];
  /** First step that can be started now. */
  nextActionableStepId: CalibrationId | null;
  /** The step the UI should open: in-progress, else ready, else stale, else blocked. */
  focusStepId: CalibrationId | null;
  completedStepIds: CalibrationId[];
  blockedStepIds: CalibrationId[];
  staleStepIds: CalibrationId[];
  /** Completed / total, 0–100, over this project's own plan. */
  progressPercent: number;
  /** Non-fatal notes about the session itself (never slicer facts). */
  warnings: string[];
}

// --- write results ----------------------------------------------------------

export interface SessionSyncResult {
  project: CalibrationProject;
  /** Keys whose value or provenance changed in the working profile. */
  changedKeys: NormalizedProfileKey[];
  /** Generated jobs newly marked stale by upstream's fingerprint rule. */
  staleJobIds: string[];
}

/** Bridge between this module's provenance and upstream's. Never yields
 *  `unset` — a working profile only ever stores values it actually has. */
export const PROVENANCE_FROM_UPSTREAM: Record<
  ProvenanceSource,
  Exclude<ValueProvenance, 'unset'>
> = {
  calibration_result: 'calibrated',
  user_input: 'user-override',
  base_profile: 'carried',
  printer_default: 'printer-default',
  material_default: 'material-default'
};

/** Bridge back to upstream's provenance vocabulary. `unset` has no upstream
 *  equivalent — a working profile only stores values it has. */
export const PROVENANCE_TO_UPSTREAM: Record<
  Exclude<ValueProvenance, 'unset'>,
  ProvenanceSource
> = {
  calibrated: 'calibration_result',
  'user-override': 'user_input',
  carried: 'base_profile',
  'printer-default': 'printer_default',
  'material-default': 'material_default'
};
