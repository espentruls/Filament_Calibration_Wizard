// ---------------------------------------------------------------------------
// Automated Calibration Pipeline — public surface (Stage 1).
//
// Contracts + pure helpers only. No engine, session persistence, slicing, or UI
// is exported yet; those arrive in later stages behind the disabled flag.
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
  getWorkingProfile,
  listWorkingProfiles
} from './session';
// `workingProfileNozzles` stays module-local: nothing outside `./session` calls
// it, and the guided UI deliberately draws one panel per PHYSICAL nozzle from
// the printer profile rather than one per stored working profile. Import it from
// './session' directly if a caller ever genuinely needs it.
export type { WorkingProfileHolder } from './session';

export {
  emptyEngineCapabilities,
  supported,
  unsupported,
  printerNozzleCount,
  isMultiNozzlePrinter,
  multiExtruderSupport
} from './capabilities';

export { isAutomatedCalibrationEnabled } from './featureFlag';

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

export {
  CALIBRATION_ASSETS,
  getAsset,
  resolveAsset,
  joinResourcePath
} from './assets';
export type { AssetSourceKind, AssetResolutionContext, AssetResolution } from './assets';

export {
  JOB_MANIFEST_SCHEMA,
  WORKSPACE_PREFIX,
  workspaceDirName,
  isPerfectFitWorkspaceName,
  prepareJob
} from './projectPreparation';
// `resolveJobNozzleIndex` stays module-local: it is `prepareJob`'s own input
// precedence rule, and every caller reads the nozzle back off the returned plan.
export type {
  StagedFileDescriptor,
  JobManifest,
  PreparedJobPlan,
  PrepareJobInput
} from './projectPreparation';

// --- engine layer (Stage 5) ------------------------------------------------

export { nativeEngineBridge, fromRawCapabilities } from './engineBridge';
export type {
  EngineNativeBridge,
  RawEngineDetection,
  RawEngineCapabilities,
  RawSliceRun,
  RunSliceArgs,
  RawAssembledProject,
  AssembleProjectArgs,
  RawResolvedPreset,
  ResolvePresetArgs,
  RawMachinePreset
} from './engineBridge';

export {
  mapPrinterToOrca,
  formatNozzle,
  presetExtruderCount,
  projectPresetForNozzle,
  PER_EXTRUDER_MACHINE_KEYS
} from './printerMapping';
export type { OrcaMachineMapping, PerExtruderProjection } from './printerMapping';

export { InstalledOrcaEngine } from './engines/installedOrcaEngine';
export { ManualExportEngine } from './engines/manualExportEngine';
export {
  baseName,
  dirName,
  resourcesRootFromExe,
  inspectSlicedJob,
  notSlicedJob,
  splitRawDetection,
  applyNozzleToPreset
} from './engines/engineSupport';

export {
  parseProjectConfig,
  applyPatchesToConfig,
  serializeProjectConfig,
  mergeCalibrationIntoProjectConfig
} from './orcaProjectConfig';
export type { ConfigMergeResult } from './orcaProjectConfig';

export { createEngines, discoverEngines } from './engineRegistry';
export type { EngineStatus, EngineDiagnostics, EngineDiscoveryContext } from './engineRegistry';
