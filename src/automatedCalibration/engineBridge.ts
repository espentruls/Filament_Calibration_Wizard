// ---------------------------------------------------------------------------
// Automated Calibration Pipeline — native engine bridge (Stage 5).
//
// The single boundary between the web-safe engine layer and the native Tauri
// commands in src-tauri/src/slicer_integration/engine.rs. Everything the
// engines do on the desktop goes through here, so a browser/PWA build (no
// __TAURI__) degrades cleanly to the manual-export path instead of throwing.
//
// The bridge is an injectable interface: production uses `nativeEngineBridge`
// (which reaches Tauri lazily through window.__TAURI__), and tests pass a fake
// so they never touch `window` or a real Orca install. Raw payload shapes use
// serde snake_case and mirror the Rust structs exactly.
// ---------------------------------------------------------------------------

import type { EngineId } from './types';

// --- raw payloads (snake_case, mirror engine.rs) ----------------------------

export interface RawEngineCapabilities {
  slice: boolean;
  export_3mf: boolean;
  export_gcode: boolean;
  multi_plate: boolean;
  multi_extruder: boolean;
}

export interface RawEngineDetection {
  engine_id: string;
  detected: boolean;
  display_name: string;
  version: string | null;
  executable_path: string | null;
  source: string;
  checksum_sha256: string | null;
  capabilities: RawEngineCapabilities;
  valid: boolean;
  errors: string[];
  warnings: string[];
  notes: string[];
}

export interface RawSliceRun {
  engine_id: string;
  exit_code: number | null;
  duration_ms: number;
  timed_out: boolean;
  cancelled: boolean;
  output_dir: string;
  gcode_path: string | null;
  artifact_paths: string[];
  log_dir: string | null;
  succeeded: boolean;
}

export interface RunSliceArgs {
  engineId: EngineId;
  sessionId: string;
  jobId: string;
  projectFileName: string;
  timeoutMs: number;
  cancellationToken?: string;
}

/** The native surface the engines depend on. Injectable for tests. */
export interface EngineNativeBridge {
  isDesktop(): boolean;
  detectSlicingEngine(engineId: EngineId, manualExePath?: string): Promise<RawEngineDetection>;
  validateSlicingEngine(engineId: EngineId): Promise<RawEngineDetection>;
  runCalibrationSlice(args: RunSliceArgs): Promise<RawSliceRun>;
  cancelCalibrationSlice(cancellationToken: string): Promise<boolean>;
}

// --- production implementation (Tauri via window.__TAURI__) ------------------

interface TauriGlobal {
  core: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
}

function tauri(): TauriGlobal | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { __TAURI__?: TauriGlobal };
  return w.__TAURI__ ?? null;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t = tauri();
  if (!t) throw new Error('NOT_DESKTOP: native engine commands are only available in the desktop app');
  return t.core.invoke<T>(cmd, args);
}

export const nativeEngineBridge: EngineNativeBridge = {
  isDesktop(): boolean {
    return tauri() !== null;
  },
  detectSlicingEngine(engineId, manualExePath) {
    return invoke<RawEngineDetection>('detect_slicing_engine', {
      engineId,
      manualExePath: manualExePath ?? null
    });
  },
  validateSlicingEngine(engineId) {
    return invoke<RawEngineDetection>('validate_slicing_engine', { engineId });
  },
  runCalibrationSlice(args) {
    return invoke<RawSliceRun>('run_calibration_slice', {
      engineId: args.engineId,
      sessionId: args.sessionId,
      jobId: args.jobId,
      projectFileName: args.projectFileName,
      timeoutMs: args.timeoutMs,
      cancellationToken: args.cancellationToken ?? null
    });
  },
  cancelCalibrationSlice(cancellationToken) {
    return invoke<boolean>('cancel_calibration_slice', { cancellationToken });
  }
};

/** Normalize native snake_case capabilities into the app's camelCase shape. */
export function fromRawCapabilities(c: RawEngineCapabilities) {
  return {
    slice: c.slice,
    export3mf: c.export_3mf,
    exportGcode: c.export_gcode,
    multiPlate: c.multi_plate,
    multiExtruder: c.multi_extruder
  };
}
