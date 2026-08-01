// ---------------------------------------------------------------------------
// Slicer profile integration — shared types.
//
// Everything here is deliberately independent from the calibration domain types
// except where a calibration project feeds profile generation. The browser/PWA
// build uses the web-safe subset (parse/generate/diff/validate/export); native
// detection and installation only run in the Tauri desktop build.
// ---------------------------------------------------------------------------

import type { CalibrationProject, ExtruderType, MaterialId } from '../types';

/**
 * Hotend flow class on one physical nozzle. Bambu's slot legends name both
 * ("Bowden Standard" vs "Bowden High Flow") and ship different values for them,
 * so it selects WHICH slot a nozzle's calibration belongs in.
 */
export type HotendFlowClass = 'standard' | 'high';

/** Slicers supported by the integration subsystem (superset of the wizard's SlicerId). */
export type IntegrationSlicerId =
  | 'orca'
  | 'bambu'
  | 'snapmaker-orca'
  | 'elegoo'
  | 'flash-studio';

export type SlicerFamily = 'orca' | 'bambu' | 'other';

export type Platform = 'windows' | 'macos' | 'linux';

// --- capabilities ----------------------------------------------------------

export interface SlicerCapabilities {
  canScanProfiles: boolean;
  canParseProfiles: boolean;
  canGenerateProfiles: boolean;
  canExportProfiles: boolean;
  canInstallDirectly: boolean;
  canVerifyInstallation: boolean;
  requiresRestart: boolean;
  requiresClosedProcess: boolean;
}

// --- detection -------------------------------------------------------------

export interface UserDataLocation {
  /** Stable id used to address this location in scan/install commands. */
  id: string;
  /** Absolute directory, e.g. …\OrcaSlicer\user\default */
  path: string;
  /** Account id ("default" for the local, non-cloud directory). */
  accountId: string;
  /** True when the slicer's .conf names this as the active preset folder. */
  active: boolean;
  /** Number of user filament presets found here (quick count, not a full scan). */
  filamentProfileCount: number;
  /** Likely cloud-synchronized (bound to a logged-in slicer account). */
  cloudLinked: boolean;
}

export interface SlicerInstallation {
  id: string;
  slicerId: IntegrationSlicerId;
  displayName: string;
  version: string | null;
  executablePath: string | null;
  dataDirectory: string | null;
  userDataLocations: UserDataLocation[];
  source: 'automatic' | 'manual';
  confidence: 'verified' | 'likely' | 'unknown';
  capabilities: SlicerCapabilities;
  /** Non-fatal detection notes shown in diagnostics. */
  notes: string[];
}

// --- profiles --------------------------------------------------------------

export type ProfileSourceType = 'system' | 'user' | 'cloud' | 'project' | 'manual' | 'unknown';

export interface DetectedFilamentProfile {
  id: string;
  slicerId: IntegrationSlicerId;
  name: string;
  vendor: string | null;
  materialType: string | null;
  colorName: string | null;
  sourceType: ProfileSourceType;
  filePath: string | null;
  parentProfileName: string | null;
  compatiblePrinterNames: string[];
  compatiblePrinterModels: string[];
  compatibleNozzleDiameters: number[];
  profileVersion: string | null;
  /** Full parsed JSON, unknown fields preserved. */
  rawProfile: unknown;
  /** Raw .info sidecar text, when present. */
  infoSidecar: string | null;
  writable: boolean;
  warnings: string[];
}

/** A parsed profile plus what we could learn about it. */
export interface ParsedFilamentProfile {
  profile: DetectedFilamentProfile;
  /** Number of extruder positions in the widest per-extruder array. */
  extruderCount: number;
  /** True when the profile is a delta preset relying on `inherits`. */
  isDelta: boolean;
  /** Whether the format was recognized as Orca-family filament JSON. */
  schemaRecognized: boolean;
  /**
   * The `filament_extruder_variant` legend after inheritance/include resolution,
   * when the scanner was able to resolve it. Optional: `resolveSlotLegend()`
   * falls back to the preset's own key and then to the known `include`
   * templates. Never write it into `rawProfile` — round-trip validation depends
   * on rawProfile being the file's own keys.
   */
  resolvedExtruderVariants?: string[] | null;
}

export interface ProfileSource {
  kind: 'detected' | 'manual-file';
  fileName: string;
  json: string;
  infoText?: string | null;
  filePath?: string | null;
}

// --- compatibility & recommendation ---------------------------------------

export interface ProfileCompatibilityResult {
  compatible: boolean;
  /** Human explanations of any concerns; empty when fully compatible. */
  warnings: string[];
  /** Hard blockers (e.g. different material family without override). */
  errors: string[];
}

export interface RecommendationReason {
  label: string;
  /** true = matched (✓), false = informational miss shown in expanded view. */
  matched: boolean;
  points: number;
}

export interface ScoredProfile {
  profile: DetectedFilamentProfile;
  score: number;
  reasons: RecommendationReason[];
  compatibility: ProfileCompatibilityResult;
}

// --- generation ------------------------------------------------------------

/** One calibrated value to patch into the clone. */
export interface CalibratedFieldPatch {
  /** PerfectFit-side identifier, e.g. 'nozzleTemp'. */
  sourceKey: string;
  /** Target preset key, e.g. 'nozzle_temperature'. */
  presetKey: string;
  label: string;
  value: number;
  unit: string;
  /** Literal suffix appended to the serialized value (e.g. '%' for filament_shrink). */
  valueSuffix?: string;
  /** Extra keys that must be set alongside (e.g. enable_pressure_advance). */
  companions?: { presetKey: string; value: string }[];
}

export interface ProfileGenerationRequest {
  slicerId: IntegrationSlicerId;
  baseProfile: DetectedFilamentProfile;
  newName: string;
  patches: CalibratedFieldPatch[];
  /**
   * 0-based VALUE SLOT index the calibration is written to. On Bambu presets
   * this indexes the extruder-variant legend, which is NOT the nozzle number —
   * resolve it with `resolveTargetSlot()`, never from `project.nozzleIndex`.
   */
  targetExtruderIndex: number;
  /** Apply to every extruder position instead of only targetExtruderIndex. */
  applyToAllExtruders: boolean;
  /**
   * How filament reaches the calibrated nozzle (from the printer profile's
   * `nozzles[project.nozzleIndex].feed`). Proves the chosen slot belongs to the
   * calibrated nozzle on presets whose slots are per feed path. Absent = not
   * known, which makes such a preset refuse the write instead of guessing.
   */
  calibratedNozzleFeed?: ExtruderType | null;
  /** Hotend flow class on the calibrated nozzle. Defaults to standard. */
  calibratedHotendFlow?: HotendFlowClass;
  /** Printer-profile label for the calibrated nozzle, used in messages. */
  calibratedNozzleLabel?: string | null;
  /**
   * How many PHYSICAL nozzles the printer profile declares
   * (`printer.nozzles.length`). A preset legend that names only hotend variants
   * of one feed path cannot address one nozzle of two — both read whichever
   * slot matches their fitted hotend — so a per-nozzle write on such a machine
   * is refused. Absent = the printer profile does not say.
   */
  physicalNozzleCount?: number;
  /**
   * Bambu Studio only: bake the calibrated pressure advance into the filament
   * start g-code as `M900 K<v> L1000 M10`. Bambu Studio ignores the native
   * pressure_advance field for Bambu machines (they use on-machine Flow
   * Dynamics), so this is the only way the value reaches the printer. Requires
   * the user to set Flow Dynamics Calibration = Off in the Send-print-job
   * dialog. No effect for Orca-family targets (which honor the native field).
   */
  bakePressureAdvanceGcode?: boolean;
  project: CalibrationProject;
}

export interface ProfileFieldChange {
  presetKey: string;
  label: string;
  before: string | null;
  after: string;
  unit?: string;
  /** Index within per-extruder arrays, when relevant. */
  extruderIndex?: number;
}

/**
 * A calibrated value that was deliberately NOT written, with the reason.
 * Generated when writing the key would require inventing a value for a nozzle
 * the project did not calibrate (see cloneAndPatch).
 */
export interface SkippedFieldNote {
  presetKey: string;
  label: string;
  reason: string;
}

export interface GeneratedFilamentProfile {
  slicerId: IntegrationSlicerId;
  name: string;
  fileStem: string;
  /** Final preset object (unknown fields preserved from base). */
  data: Record<string, unknown>;
  /** Serialized JSON exactly as it will be written. */
  serialized: string;
  /** .info sidecar content to write next to the preset. */
  infoText: string;
  baseProfileName: string;
  baseProfileFingerprint: string;
  changedFields: ProfileFieldChange[];
  /**
   * Calibrated values left out of the preset because writing them would have
   * required guessing a value for an untargeted nozzle. Surfaced as warnings
   * that must be acknowledged before install.
   */
  skippedFields?: SkippedFieldNote[];
  preservedFieldCount: number;
  generatedAt: string;
}

// --- validation ------------------------------------------------------------

export interface ValidationMessage {
  code: string;
  message: string;
  /** Materials warnings must be acknowledged before install. */
  requiresAcknowledgement?: boolean;
}

export interface ProfileValidationResult {
  valid: boolean;
  errors: ValidationMessage[];
  warnings: ValidationMessage[];
  preservedFieldCount: number;
  changedFields: ProfileFieldChange[];
  unresolvedFields: string[];
}

// --- installation ----------------------------------------------------------

export type ProfileInstallErrorCode =
  | 'SLICER_NOT_FOUND'
  | 'SLICER_VERSION_UNKNOWN'
  | 'USER_DATA_NOT_FOUND'
  | 'MULTIPLE_USER_DATA_LOCATIONS'
  | 'PROFILE_PARSE_FAILED'
  | 'PROFILE_SCHEMA_UNSUPPORTED'
  | 'INHERITANCE_UNRESOLVED'
  | 'PROFILE_INCOMPATIBLE'
  | 'DUPLICATE_PROFILE'
  | 'SLICER_RUNNING'
  | 'BACKUP_FAILED'
  | 'WRITE_PERMISSION_DENIED'
  | 'ATOMIC_WRITE_FAILED'
  | 'INSTALL_VERIFICATION_FAILED'
  | 'ROLLBACK_FAILED'
  | 'UNSUPPORTED_MULTI_TOOL_PROFILE'
  | 'NOT_DESKTOP'
  | 'UNKNOWN';

export interface ProfileInstallError {
  code: ProfileInstallErrorCode;
  message: string;
  /** Raw technical detail for the expandable diagnostics section. */
  detail?: string;
}

export interface ProfileInstallRequest {
  slicerId: IntegrationSlicerId;
  installationId: string;
  userDataLocationId: string;
  profile: GeneratedFilamentProfile;
  projectId: string;
  /** Overwrite an existing preset with the same name (backup still made). */
  allowReplace: boolean;
}

export interface ProfileInstallResult {
  success: boolean;
  installedFiles: string[];
  changedFiles: string[];
  backupId: string | null;
  verificationPassed: boolean;
  restartRequired: boolean;
  warnings: string[];
  error: ProfileInstallError | null;
}

export interface ProfileVerificationRequest {
  slicerId: IntegrationSlicerId;
  filePath: string;
  expectedSerialized: string;
}

export interface ProfileVerificationResult {
  verified: boolean;
  detail: string;
}

// --- backups ---------------------------------------------------------------

export interface BackupFileEntry {
  originalPath: string;
  /** null when the file did not exist before install (restore = delete). */
  backupPath: string | null;
  checksumSha256: string | null;
  existedBefore: boolean;
}

export interface ProfileBackupManifest {
  backupId: string;
  slicerId: IntegrationSlicerId;
  slicerVersion: string | null;
  createdAt: string;
  installedProfileName: string;
  perfectFitProjectId: string;
  files: BackupFileEntry[];
  backupRoot: string;
}

// --- project linkage -------------------------------------------------------

export interface ProfileInstallHistoryEntry {
  at: string;
  mode: 'export' | 'install' | 'saved';
  slicerId: IntegrationSlicerId;
  slicerVersion: string | null;
  destination: string | null;
  backupId: string | null;
  verificationPassed: boolean | null;
  success: boolean;
  note?: string;
}

export interface GeneratedProfileRecord {
  id: string;
  projectId: string;
  slicerId: IntegrationSlicerId;
  slicerVersion: string | null;
  installationId: string | null;
  baseProfileName: string;
  baseProfileFingerprint: string;
  generatedProfileName: string;
  generatedAt: string;
  generatedProfileData: unknown;
  generatedInfoText: string;
  changedFields: ProfileFieldChange[];
  validation: ProfileValidationResult | null;
  installHistory: ProfileInstallHistoryEntry[];
}

// --- feature flags ---------------------------------------------------------

export interface ExperimentalFeatures {
  slicerProfileGeneration: boolean;
  automaticProfileInstallation: boolean;
  unsupportedVersionOverride: boolean;
  advancedProfileSelection: boolean;
  /**
   * TOMBSTONE — reads as false and gates nothing. This flag guarded the assisted
   * auto-prepare path (a slicing engine that configured and sliced each test);
   * that path was deleted before release, so there is no longer any code to
   * enable. The key is kept because `ExperimentalFeatures` is a persisted
   * localStorage shape and because comments elsewhere still name it; it was
   * never exposed in Settings, so no user can have turned it on.
   */
  automatedCalibration: boolean;
}

export const DEFAULT_EXPERIMENTAL_FEATURES: ExperimentalFeatures = {
  slicerProfileGeneration: true,
  automaticProfileInstallation: true, // still gated per-version by the registry
  unsupportedVersionOverride: false,
  advancedProfileSelection: true,
  automatedCalibration: false // tombstone: nothing reads this (see the interface)
};

// --- compatibility registry ------------------------------------------------

export interface VerifiedSlicerVersion {
  slicerId: IntegrationSlicerId;
  /** Prefix match against the detected version, e.g. "2.4." matches 2.4.2. */
  versionRange: string;
  platforms: Platform[];
  profileScanVerified: boolean;
  profileGenerationVerified: boolean;
  directInstallVerified: boolean;
  verificationDate: string;
  notes: string[];
}

// --- material normalization -------------------------------------------------

/** Canonical material family used for compatibility scoring. */
export interface NormalizedMaterial {
  /** Canonical token, e.g. 'PLA', 'PLA+', 'PETG', 'PETG-HF', 'PA-CF'. */
  canonical: string;
  /** Broad family, e.g. 'PLA' for PLA+ / PLA Silk; 'PETG' for PETG-HF. */
  family: string;
}

export type WizardMaterial = MaterialId;
