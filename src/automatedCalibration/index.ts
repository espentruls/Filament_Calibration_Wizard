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
  isSessionResumable
} from './session';

export {
  emptyEngineCapabilities,
  supported,
  unsupported
} from './capabilities';

export { isAutomatedCalibrationEnabled } from './featureFlag';
