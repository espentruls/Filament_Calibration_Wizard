// ---------------------------------------------------------------------------
// Guided session — stored shapes.
//
// The types the guided session in `src/session` persists on a
// `CalibrationProject`: per-nozzle working profiles, their value provenance, and
// the step workflow's records.
//
// This file used to also carry the contracts for the assisted auto-prepare path
// (SlicingEngine, PrinterSelection, ResolvedPrinterPreset,
// PreparedCalibrationProject, SlicedCalibrationJob, PrintDestination, the asset
// registry). That path and its native commands were deleted before release, so
// those contracts went with them rather than staying as a description of
// something the app does not do.
//
// Design decisions this file still encodes:
//   * The session EXTENDS the existing `CalibrationProject` — it is NOT a
//     parallel entity. `AutomatedSessionExtension` describes the fields folded
//     into `CalibrationProject`; every one is optional, so existing projects and
//     the manual wizard are unaffected.
//   * Session/profile state lives in IndexedDB, like the rest of the app.
// ---------------------------------------------------------------------------

import type { CalibrationId, CalibrationProject } from '../types';
import type { IntegrationSlicerId } from '../slicerIntegration/types';

// --- engine / session identity ---------------------------------------------

/**
 * How a session expects its calibration tests to reach a printer. Only
 * `manual_export` is reachable today — the user slices in their own slicer —
 * but stored sessions may still name one of the others, so the union stays
 * readable rather than silently failing validation on load.
 */
export type EngineId =
  | 'managed_orca'
  | 'installed_orca'
  | 'manual_export'
  | 'bambu_handoff';

/** A session's chosen path is exactly its engine id. */
export type SlicerMode = EngineId;

export type CalibrationSessionStatus =
  | 'created'
  | 'in_progress'
  | 'waiting_for_print'
  | 'waiting_for_result'
  | 'completed'
  | 'cancelled'
  | 'failed';

// --- temporary working profile ---------------------------------------------

/** Where a working-profile value came from — user input vs inherited vs measured. */
export type ProvenanceSource =
  | 'base_profile'
  | 'printer_default'
  | 'material_default'
  | 'user_input'
  | 'calibration_result';

export interface ProvenanceRecord {
  source: ProvenanceSource;
  /** The calibration step that produced the value, when applicable. */
  stepId?: CalibrationId;
  updatedAt: string;
}

/** A working filament profile a session mutates as results come in. Normalized
 *  PerfectFit keys — slicer-specific key mapping happens through the existing
 *  `src/slicerIntegration/adapters`, never here.
 *
 *  `values` is deliberately FLAT (one slot per setting), so a single profile can
 *  only ever describe ONE physical nozzle: a bowden auxiliary nozzle needs its
 *  own retraction distance and pressure advance, which cannot share a slot with
 *  the direct-drive main nozzle's. A profile therefore names the nozzle it
 *  belongs to, and a session holds ONE PROFILE PER NOZZLE (see
 *  `AutomatedSessionExtension.workingProfiles`). Composite `key@index` value keys
 *  are explicitly NOT used — they would break `applyValue`, `fingerprintValues`
 *  and every consumer that reads a normalized key. */
export interface TemporaryCalibrationProfile {
  id: string;
  displayName: string;
  createdForProjectId: string;
  sourceProfileName?: string;
  /**
   * Which physical nozzle this profile describes — an index into the printer
   * profile's `nozzles` array. Absent means 0 (the main/only nozzle), matching
   * `CalibrationProject.nozzleIndex`.
   */
  nozzleIndex?: number;
  values: Record<string, number | string | boolean>;
  provenance: Record<string, ProvenanceRecord>;
  createdAt: string;
  updatedAt: string;
}

// --- generated jobs & warnings ---------------------------------------------

export type GeneratedJobStatus = 'prepared' | 'sliced' | 'failed' | 'stale';

export interface GeneratedJobRecord {
  id: string;
  stepId: CalibrationId;
  /**
   * Which physical nozzle this job was generated for. Absent means 0 (the
   * main/only nozzle). A job is identified by step AND nozzle: the same step run
   * on two nozzles is two different jobs with two different workspaces.
   */
  nozzleIndex?: number;
  createdAt: string;
  engineId: EngineId;
  engineVersion: string | null;
  slicerMode: SlicerMode;
  status: GeneratedJobStatus;
  /** Fingerprint of the working-profile values used, to detect staleness when
   *  an upstream result later changes. */
  inputFingerprint: string;
  /** Path to the sliced artifact, when one was produced. */
  outputPath: string | null;
  sliced: boolean;
  warnings: string[];
}

export interface SessionWarning {
  code: string;
  message: string;
  at: string;
  stepId?: CalibrationId;
}

/**
 * The fields Stage 2 will add to `CalibrationProject` to make it an automated
 * session. Kept as a standalone interface in Stage 1 so the contract is
 * reviewable before the schema migration lands. Every field is optional, so
 * existing projects and the current manual workflow are completely unaffected.
 */
export interface AutomatedSessionExtension {
  /** Per-session schema version, folded into the storage migration in Stage 2. */
  automatedSchemaVersion?: number;
  slicerMode?: SlicerMode;
  sessionStatus?: CalibrationSessionStatus;
  /**
   * The session's PRIMARY working profile — the one for the nozzle the session
   * started on (`workingProfile.nozzleIndex`, falling back to the project's
   * `nozzleIndex`). Kept as its own field so every existing single-nozzle
   * consumer keeps working unchanged.
   */
  workingProfile?: TemporaryCalibrationProfile;
  /**
   * Working profiles for the session's OTHER nozzles, one per nozzle. A dual
   * nozzle machine (e.g. the Bambu X2D's direct-drive main + bowden auxiliary)
   * needs two independent sets of values; a flat profile cannot hold both.
   *
   * Read and write these through `getWorkingProfile` / `setWorkingProfile`
   * rather than touching either field directly — the split between the primary
   * field and this list is an implementation detail of the storage shape.
   */
  workingProfiles?: TemporaryCalibrationProfile[];
  generatedJobs?: GeneratedJobRecord[];
  sessionWarnings?: SessionWarning[];
  selectedEngineId?: EngineId;
}

/** A `CalibrationProject` once the session fields are present. */
export type AutomatedCalibrationSession = CalibrationProject & AutomatedSessionExtension;

// --- printer shape ---------------------------------------------------------

/**
 * The minimum shape needed to count a printer's physical nozzles. Satisfied by
 * both `PrinterProfile` (our saved profile, with the `nozzles` array we added
 * for dual-nozzle machines) and `PrinterSpecification` (the shipped printer
 * database, which only carries `extruderCount`). Neither field is guaranteed —
 * an unknown count is reported as unknown, never assumed to be 1.
 */
export interface NozzleCountSource {
  nozzles?: unknown[];
  extruderCount?: number | null;
}

// --- workflow step definition ------------------------------------------------

/**
 * The dependency-aware step model the guided session's workflow builds on top of
 * the instructional content in `src/data/calibrations.ts`. The registry itself is
 * `WORKFLOW_STEPS` in `./workflow`.
 */
export interface CalibrationStepDefinition {
  id: CalibrationId;
  /** Normalized value keys this step needs from earlier steps to prepare. */
  requiredInputs: string[];
  optionalInputs: string[];
  /** Normalized value keys this step's result produces. */
  produces: string[];
  needsSlicing: boolean;
  supportsManualFiles: boolean;
  compatibleSlicers: IntegrationSlicerId[];
  /** Validation ranges for produced values (normalized key → inclusive range). */
  valueRanges: Record<string, { min: number; max: number }>;
  /** Steps whose result change invalidates this step's generated jobs. */
  recalibrationDependsOn: CalibrationId[];
}
