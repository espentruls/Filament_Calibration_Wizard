// ---------------------------------------------------------------------------
// Core domain types for Trim Filament Calibration Wizard
// ---------------------------------------------------------------------------

export type SlicerId = 'orca' | 'bambu';

export type ExperienceMode = 'coach' | 'expert';

export type ExtruderType = 'direct' | 'bowden';

export type MaterialId =
  | 'PLA' | 'PLA+' | 'PETG' | 'PCTG' | 'ABS' | 'ASA' | 'TPU'
  | 'PA' | 'PA-CF' | 'PA-GF' | 'PC' | 'PPA' | 'PPS' | 'OTHER';

export type CalibrationId =
  | 'temperature'
  | 'flow-pass1'
  | 'flow-pass2'
  | 'pressure-advance'
  | 'flow-verify'
  | 'retraction'
  | 'max-volumetric-speed'
  | 'shrinkage'
  | 'ooze-control'
  | 'final-verification';

export type StepStatus = 'not-started' | 'in-progress' | 'completed' | 'skipped';

export type ConfidenceLevel = 'low' | 'medium' | 'high';

// --- Printer profile -------------------------------------------------------

/** One physical nozzle/feed path on a multi-nozzle printer (e.g. Bambu Lab X2D). */
export interface NozzleProfile {
  /** Display label, e.g. "Main (direct drive)" / "Auxiliary (bowden)". */
  label: string;
  /** How filament reaches this nozzle — drives PA and retraction suggestions. */
  feed: ExtruderType;
  /** Speed cap for this path (mm/s), if the maker publishes one. */
  maxSpeed?: number;
  /** Acceleration cap for this path (mm/s²), if published. */
  maxAccel?: number;
  notes?: string;
}

export interface PrinterProfile {
  id: string;
  name: string;
  manufacturer: string;
  nozzleDiameter: number;        // mm
  maxNozzleTemp: number;         // °C
  maxBedTemp: number;            // °C
  maxVolumetricFlow?: number;    // mm³/s, if known
  extruderType: ExtruderType;
  retractionRange: { start: number; end: number }; // suggested mm
  /**
   * Physical nozzles on multi-nozzle machines (e.g. Bambu Lab X2D: direct-drive
   * main + bowden-fed auxiliary). Absent = legacy single-nozzle profile.
   */
  nozzles?: NozzleProfile[];
  notes: string;
  createdAt: string;
  updatedAt: string;

  // --- Extended machine specs (schema v4; all optional) --------------------
  // Populated from the printer database when a printer is selected, freely
  // editable afterwards. `undefined` means "not specified" — never rendered as
  // 0. Older saved printers simply lack these keys and keep working.
  model?: string;
  technology?: string;
  maxChamberTemp?: number;       // °C
  heatedChamber?: boolean;
  supportedNozzleDiameters?: number[]; // mm
  buildVolume?: { x?: number; y?: number; z?: number }; // mm
  maxPrintSpeed?: number;        // mm/s
  maxAcceleration?: number;      // mm/s²
  firmware?: string;
  extruderCount?: number;
  multiMaterialCompatibility?: string; // e.g. "AMS", "MMU"
  releaseYear?: number;

  // --- Database linkage (schema v4) ----------------------------------------
  /** Id of the source record in printers.json, or null/undefined if manual. */
  databasePrinterId?: string | null;
  /** printers.json schemaVersion this profile was populated from. */
  databaseSchemaVersion?: number;
  /**
   * printers.json dataRevision this profile was populated from. When the
   * shipped database is newer, the Printers page offers to refresh the specs.
   * Missing on profiles saved before 1.3.2 — treated as revision 1.
   */
  databaseDataRevision?: number;
  /** True when entered by hand (not matched to a database record). */
  isManual?: boolean;
}

// --- Printer specification database (generated from Printer_Database.xlsx) --

export type SpecExtruderType = 'direct-drive' | 'bowden' | 'mixed' | 'unknown';

/** One printer record as produced by scripts/generate-printer-database.mjs. */
export interface PrinterSpecification {
  id: string;
  manufacturer: string;
  model: string;
  technology?: string | null;
  extruderType?: SpecExtruderType | null;
  maxNozzleTempC?: number | null;
  maxBedTempC?: number | null;
  maxChamberTempC?: number | null;
  heatedChamber?: boolean | null;
  maxVolumetricFlowMm3s?: number | null;
  defaultNozzleDiameterMm?: number | null;
  supportedNozzleDiametersMm?: number[];
  buildVolumeMm?: { x?: number | null; y?: number | null; z?: number | null };
  maxPrintSpeedMmS?: number | null;
  maxAccelerationMmS2?: number | null;
  firmware?: string | null;
  extruderCount?: number | null;
  multiMaterialCompatibility?: string | null;
  releaseYear?: number | null;
  profileSource?: string | null;
  sourceFile?: string | null;
  notes?: string | null;
}

/** Shape of src/data/printers.json. */
export interface PrinterDatabase {
  schemaVersion: number;
  /**
   * Bumped when the DATA changes in a way saved profiles should pick up, even
   * though the shape (schemaVersion) is unchanged. Profiles record the revision
   * they were filled from, so the app can offer to refresh stale specs.
   * Absent in databases generated before 1.3.2 — treat as revision 1.
   */
  dataRevision?: number;
  source: string;
  sheet: string;
  printerCount: number;
  manufacturerCount: number;
  manufacturers: string[];
  printers: PrinterSpecification[];
}

// --- Material presets ------------------------------------------------------

/**
 * What a material wants from the build chamber.
 *
 *   'hot'     — run the chamber as warm as the machine allows. High-Tg materials
 *               (ABS, ASA, PA, PC) warp without it; a warm chamber lowers the
 *               thermal gradient and improves layer bonding.
 *   'ambient' — chamber heating stays OFF. Below roughly Tg − 10 °C is the whole
 *               rule: a hot chamber heat-soaks the filament path and softens the
 *               filament ABOVE the melt zone, which is heat creep — jams, ground
 *               filament, and a hotend that has to come apart. This is the case
 *               where "just set it to the max" does damage.
 *   'unknown' — nothing is sourced for this material. Say so; suggest nothing.
 */
export type ChamberAdvice = 'hot' | 'ambient' | 'unknown';

/**
 * Per-material chamber guidance. GUIDANCE, never a calibration step: a chamber
 * has no measurable optimum the way a temperature tower does, so Trim
 * neither tests it nor writes it into a slicer preset. It only ever says what to
 * set, and refuses to say anything it cannot source.
 */
export interface MaterialChamberGuidance {
  advice: ChamberAdvice;
  /**
   * The chamber setpoint the slicer vendor ships for this material (°C), where
   * one is known. Shown as a reference point — never used as the suggestion,
   * because a machine's own maximum decides that.
   */
  vendorC?: number;
  /**
   * The highest chamber temperature Trim will suggest for this material
   * (°C). Absent means "no sourced ceiling", and no number is offered at all.
   * Every value carries its source in `src/data/materials.ts`.
   */
  maxC?: number;
  /** One sentence, sentence case, giving the reason. Shown to the user. */
  why: string;
}

export interface MaterialPreset {
  id: MaterialId;
  label: string;
  description: string;
  /** Suggested nozzle temperature range (°C). Editable, never enforced. */
  nozzleTemp: { min: number; max: number };
  bedTemp: { min: number; max: number };
  /** Suggested temp tower range. */
  towerRange: { start: number; end: number; step: number };
  /** Typical starting flow ratio. */
  startingFlowRatio: number;
  /** Typical max volumetric speed test range (mm³/s). */
  mvsRange: { start: number; end: number; step: number };
  /** Typical safe MVS ballpark used only for sanity warnings. */
  typicalMvs: number;
  /** True for flexible materials (TPU): changes PA + retraction guidance. */
  flexible?: boolean;
  /** Requires drying before calibration is meaningful. */
  hygroscopic?: boolean;
  /** Needs enclosure / warns about warping. */
  enclosureRecommended?: boolean;
  /**
   * What to do with the build chamber. Required, not optional: a material that
   * says nothing about the chamber is exactly how "set it to the max" gets
   * applied to PLA. Materials where it does not matter say so.
   */
  chamber: MaterialChamberGuidance;
  warnings: string[];
}

// --- Project ---------------------------------------------------------------

export interface FilamentInfo {
  manufacturer: string;
  productLine: string;
  material: MaterialId;
  materialOther?: string;    // when material === 'OTHER'
  color: string;
  diameter: number;          // mm (1.75 / 2.85)
  startingProfile: string;   // e.g. "Generic PLA"
}

export interface ProjectSlicerInfo {
  slicer: SlicerId;
  version: string;           // e.g. "2.4.x"
}

export interface CalibrationProject {
  id: string;
  createdAt: string;
  updatedAt: string;
  calibrationDate: string;
  filament: FilamentInfo;
  printerProfileId: string;
  nozzleType: string;        // brass / hardened steel / etc.
  /**
   * Which physical nozzle this project calibrates — an index into the printer
   * profile's `nozzles` array. Absent means 0 (the main/only nozzle).
   */
  nozzleIndex?: number;
  slicer: ProjectSlicerInfo;
  notes: string;
  mode: ExperienceMode;
  /** Order of calibration steps for this project (user may reorder). */
  stepOrder: CalibrationId[];
  steps: Record<CalibrationId, CalibrationStepState>;
  timeline: TimelineEntry[];
  archived: boolean;
  /** Final chosen values, denormalized for dashboard display. */
  finals: FinalValues;
  /**
   * Slicer profiles generated from this calibration (schema v2+).
   * Absent on v1 projects; normalized to [] on load/import.
   */
  generatedProfiles?: import('./slicerIntegration/types').GeneratedProfileRecord[];
  /**
   * Outcome of the pre-calibration slicer preset backup prompt (optional;
   * absent on older projects). Present once the user backed up or dismissed.
   */
  presetBackup?: PresetBackupRecord;
  /**
   * Present only when the user was warned that this filament and this nozzle
   * are a poor pair and chose to calibrate anyway. Absent means either "no
   * warning was raised" or "no warning needed acknowledging" — never "the app
   * approved it".
   */
  compatibilityOverride?: CompatibilityOverrideRecord;

  // --- Automated calibration session (schema v5; all optional) -------------
  // Present only once an automated session is started (behind the disabled
  // `automatedCalibration` flag). Absent on every existing project, which keeps
  // the current manual workflow completely unaffected. Types live in
  // src/automatedCalibration/types.ts; referenced inline (like generatedProfiles
  // above) to avoid a circular top-level import.
  /** Sub-schema version for the automated session fields (independent of the
   *  app-wide storage SCHEMA_VERSION). */
  automatedSchemaVersion?: number;
  slicerMode?: import('./automatedCalibration/types').SlicerMode;
  sessionStatus?: import('./automatedCalibration/types').CalibrationSessionStatus;
  workingProfile?: import('./automatedCalibration/types').TemporaryCalibrationProfile;
  /** Working profiles for the session's other nozzles (one per nozzle) — a
   *  dual-nozzle machine needs independent values per feed path. Accessed
   *  through getWorkingProfile/setWorkingProfile, never directly. */
  workingProfiles?: import('./automatedCalibration/types').TemporaryCalibrationProfile[];
  generatedJobs?: import('./automatedCalibration/types').GeneratedJobRecord[];
  sessionWarnings?: import('./automatedCalibration/types').SessionWarning[];
  selectedEngineId?: import('./automatedCalibration/types').EngineId;
}

/** Result of the "back up your slicer presets before calibrating" prompt. */
export interface PresetBackupRecord {
  status: 'done' | 'skipped';
  at: string;
  /** Ids in the desktop backup store (Settings → Slicer profile backups). */
  backupIds: string[];
  fileCount: number;
}

export interface FinalValues {
  nozzleTemp?: number;
  firstLayerTemp?: number;
  highFlowTemp?: number;
  bedTemp?: number;
  flowRatio?: number;
  pressureAdvance?: number;
  retractionDistance?: number;
  retractionSpeed?: number;
  maxVolumetricSpeed?: number;
  /** Measured XY shrinkage as a percentage of nominal size (e.g. 99.4). */
  shrinkagePercent?: number;
}

export interface CalibrationStepState {
  status: StepStatus;
  /** Latest attempt (working data). */
  current: CalibrationAttempt | null;
  /** Historical attempts, newest first. Never overwritten. */
  history: CalibrationAttempt[];
  confidence?: ConfidenceLevel;
  retestRecommended?: boolean;
  completedAt?: string;
}

/** One run of a calibration test — inputs, observations, and results. */
export interface CalibrationAttempt {
  id: string;
  startedAt: string;
  completedAt?: string;
  method?: string;                       // e.g. 'yolo' | 'pass1' | 'tower' | 'pattern' | 'line'
  /** Test range/settings the user configured. */
  settings: Record<string, number | string | boolean>;
  /** Raw result entry (selected sample, measured value, etc). */
  result: Record<string, number | string | boolean | number[] | string[]>;
  /** Computed outputs (the values to enter in the slicer). */
  computed: Record<string, number | string>;
  prerequisitesConfirmed: string[];
  notes: string;
  photoIds: string[];
  confidence?: ConfidenceLevel;
}

export interface TimelineEntry {
  id: string;
  at: string;
  stepId: CalibrationId | 'project';
  kind: 'started' | 'value-set' | 'completed' | 'retest' | 'note' | 'created' | 'skipped' | 'reset';
  summary: string;
  detail?: string;
}

// --- Calibration definitions (data-driven) --------------------------------

export interface NumericInputDef {
  key: string;
  label: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Explains the input in Coach mode. */
  help?: string;
}

export interface MethodDef {
  id: string;
  label: string;
  description: string;
  /** Which slicers support this method natively. */
  slicers: SlicerId[];
  recommended?: boolean;
}

export interface CalibrationDef {
  id: CalibrationId;
  name: string;
  shortName: string;
  icon: string;
  /** Beginner-friendly purpose text. */
  purpose: string;
  /** Why this step sits where it does in the order. */
  whyThisOrder: string;
  /** "Why am I doing this?" expanded explanation. */
  whyExpanded: string;
  dependencies: CalibrationId[];
  prerequisites: { id: string; label: string; coachNote?: string }[];
  methods: MethodDef[];
  /** What the user inspects on the print. */
  evaluationGuide: EvaluationItem[];
  resultPrecision: number; // decimal places for the final value
  slicerDestination: SlicerDestination;
  versionNotes: string[];
}

export interface EvaluationItem {
  title: string;
  look: string;             // what to look for
  meaning: string;          // what it indicates
  severity: 'good' | 'adjust' | 'bad';
}

// --- nozzle / filament compatibility ---------------------------------------

/**
 * How a (physical nozzle, filament) pair reads.
 *
 * Severity ONLY. None of these levels is permission to act and none of them
 * stops anything: the user owns the hardware and is the authority on it, so
 * every level short of `clear` is a warning with an override. The tiers mirror
 * the slicer's own vocabulary so the wording in Trim and the wording in
 * the slicer cannot drift apart:
 *
 *   'blocked'  — the preset data says the combination is unusable on this nozzle.
 *   'critical' — marked highly not recommended.
 *   'caution'  — marked not recommended: usable, with a higher failure rate.
 *   'clear'    — the data was read AND it carries a compatibility record saying
 *                this pair is available. Never inferred from silence.
 *   'unknown'  — nothing could be read. This is the honest default, and it is
 *                NOT an all-clear: a preset that carries no compatibility record
 *                is silent, not approving.
 */
export type CompatibilityLevel = 'blocked' | 'critical' | 'caution' | 'clear' | 'unknown';

/** One traceable statement behind a verdict. Never a bare assertion. */
export interface CompatibilityEvidence {
  /** Where it came from: a preset key and its value, a preset name, or a rule. */
  source: string;
  /** The statement itself, sentence case. */
  detail: string;
  /** False when read from data; true when Trim deduced it. */
  inferred: boolean;
}

export interface CompatibilityVerdict {
  level: CompatibilityLevel;
  /** One sentence, sentence case. */
  headline: string;
  evidence: CompatibilityEvidence[];
  /** True when the level rests on deduction rather than on data we read. */
  inferred: boolean;
  /**
   * Always false, and typed as the literal so no caller can flip it. A
   * compatibility verdict warns; it never refuses to run a calibration.
   */
  blocksCalibration: false;
  /** True when the user should have to acknowledge before proceeding. */
  needsAcknowledgement: boolean;
}

/**
 * The user's decision to calibrate a pair Trim warned about.
 *
 * Stored on the project so later guidance stays honest: a value calibrated past
 * a compatibility warning is still the user's value, but a report that never
 * mentions the warning would read as if the app had approved the combination.
 */
export interface CompatibilityOverrideRecord {
  at: string;
  /** The level that was overridden — the state of the world at that moment. */
  level: CompatibilityLevel;
  /** The headline shown at the time, verbatim. */
  headline: string;
  /** The evidence lines shown at the time, verbatim. */
  evidence: string[];
  /** Which physical nozzle, and what it was called. */
  nozzleIndex: number;
  nozzleLabel?: string;
  material: MaterialId;
  /** The preset the verdict was read from, when there was one. */
  presetName?: string;
  /** True when the overridden verdict was inferred rather than read. */
  inferred: boolean;
}

export interface SlicerDestination {
  scope: 'filament' | 'printer' | 'process' | 'per-object' | 'calibration-only';
  /** Human path per slicer, filled from slicer content files. */
  note: string;
}

// --- Slicer instruction content (version-aware) ----------------------------

export interface SlicerVersionContent {
  slicer: SlicerId;
  slicerLabel: string;
  version: string;             // version family this content was verified against
  verifiedOn: string;          // ISO date the docs were checked
  docsUrl: string;
  calibrationMenuPath: string; // e.g. "Menu bar → Calibration"
  perTest: Partial<Record<CalibrationId, SlicerTestInstructions>>;
}

export interface SlicerTestInstructions {
  available: boolean;
  builtIn: boolean;            // generated in-slicer (no model download needed)
  menuPath: string;
  steps: string[];             // numbered instructions, original wording
  saveTo: { path: string; field: string; scope: SlicerDestination['scope']; note: string };
  disableFirst?: string[];     // things to temporarily disable
  gotchas?: string[];
}

// --- Models manifest -------------------------------------------------------

export interface ModelManifestEntry {
  test: string;
  localFile: string | null;    // filename under /models or null when download-only
  bundled: boolean;
  sourceUrl: string;
  license: string;
  attribution: string;
  recommendedUse: string;
  slicerCompatibility: string;
  fileType: string;
}

// --- Settings & misc -------------------------------------------------------

export interface AppSettings {
  theme: 'light' | 'dark' | 'auto';
  largeText: boolean;
  defaultMode: ExperienceMode;
  /** Safety margin applied to measured MVS, e.g. 0.85 = keep 15% headroom. */
  mvsSafetyMargin: number;
}

export interface GlossaryEntry {
  term: string;
  definition: string;
  related?: string[];
}

export interface StoredPhoto {
  id: string;
  projectId: string;
  stepId: CalibrationId;
  attemptId: string;
  createdAt: string;
  name: string;
  type: string;
  blob: Blob;
  /** Reserved for future AI analysis results; unused in v1. */
  analysis?: null;
}

// --- Backup format ---------------------------------------------------------

export interface BackupFile {
  /**
   * Format marker, not a product name. Frozen at the pre-3.0 value so files
   * exported by 1.x and 2.x still import after the rename to Trim — see
   * `APP_MARKER` in src/export/backup.ts.
   */
  app: 'perfectfit-filament-calibration-wizard';
  schemaVersion: number;
  exportedAt: string;
  projects: CalibrationProject[];
  printers: PrinterProfile[];
  settings?: AppSettings;
  /** Photos are exported as base64 only in full backups. */
  photos?: { meta: Omit<StoredPhoto, 'blob'>; dataUrl: string }[];
}

export interface VerificationCategory {
  id: string;
  label: string;
  coachHint: string;
  /** Calibration steps most likely responsible when this category fails, in priority order. */
  likelyCauses: { step: CalibrationId; why: string }[];
}

export type VerificationMark = 'pass' | 'acceptable' | 'needs-adjustment' | 'not-tested';
