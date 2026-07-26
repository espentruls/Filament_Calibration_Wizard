// ---------------------------------------------------------------------------
// Automated Calibration Pipeline — engine registry + diagnostics (Stage 5).
//
// Enumerates the available slicing engines and produces the engine-status data
// the (Stage 7) UI renders: which engines are detected, which is valid, what it
// can do, and which one PerfectFit recommends. Pure orchestration over the
// engines — no UI here (a rendered panel would be dead code while the feature
// flag is off, so it lands with the Stage 7 UX, exactly as the Stage 2
// session-browser was deferred).
// ---------------------------------------------------------------------------

import type {
  CapabilityResult,
  EngineDetectionResult,
  EngineId,
  NozzleCountSource,
  SlicingEngineCapabilities
} from './types';
import { multiExtruderSupport, printerNozzleCount } from './capabilities';
import { type EngineNativeBridge, nativeEngineBridge } from './engineBridge';
import { InstalledOrcaEngine } from './engines/installedOrcaEngine';
import { ManualExportEngine } from './engines/manualExportEngine';

/** Flattened detection + validation + capability view of one engine. */
export interface EngineStatus {
  engineId: EngineId;
  displayName: string;
  detected: boolean;
  valid: boolean;
  version: string | null;
  source: EngineDetectionResult['source'];
  executablePath: string | null;
  capabilities: SlicingEngineCapabilities;
  errors: string[];
  warnings: string[];
  notes: string[];
  /**
   * Whether this engine can serve the nozzle the caller asked about (see
   * `EngineDiscoveryContext`). Present on every status; for a single-nozzle or
   * unknown printer at nozzle 0 it is simply supported.
   */
  nozzleSupport?: CapabilityResult;
}

/** What the caller is trying to do, so diagnostics can answer honestly rather
 *  than in the abstract. Omit it entirely for a plain "what have I got?" probe. */
export interface EngineDiscoveryContext {
  /** The printer profile being calibrated, for its nozzle count. */
  printer?: NozzleCountSource;
  /** Which physical nozzle the session targets. Defaults to 0 (main/only). */
  nozzleIndex?: number;
}

export interface EngineDiagnostics {
  /** Whether the desktop bridge is available at all. */
  desktop: boolean;
  engines: EngineStatus[];
  /** The engine PerfectFit would use by default, if any is usable. */
  recommendedEngineId: EngineId | null;
  warnings: string[];
}

/** An engine that can report a combined status for diagnostics. */
interface DiagnosableEngine {
  status(): Promise<EngineStatus>;
}

/** Build the engine list. Manual export is always present; the installed-Orca
 *  engine is present but reports "not detected" without a desktop bridge. */
export function createEngines(bridge: EngineNativeBridge = nativeEngineBridge): DiagnosableEngine[] {
  return [new InstalledOrcaEngine(bridge), new ManualExportEngine()];
}

/** True when an engine can actually turn a prepared project into g-code now,
 *  FOR THE NOZZLE the caller asked about. An engine that cannot serve the
 *  requested nozzle is not a candidate, however capable it is otherwise. */
function canSlice(s: EngineStatus): boolean {
  if (!(s.detected && s.valid && s.capabilities.slice)) return false;
  return s.nozzleSupport?.supported !== false;
}

/**
 * Probe every engine and summarize. Recommends the first slice-capable engine
 * (installed Orca, listed first) and otherwise falls back to manual export,
 * which is always available. Never throws — a probe failure is reported as an
 * engine error, so the diagnostics screen always renders.
 *
 * Pass a `context` to ask the question that matters to a session: "can anything
 * here slice for the auxiliary nozzle of THIS printer?" — the answer branches on
 * the engine's real multi-extruder capability, not on an assumption.
 */
export async function discoverEngines(
  bridge: EngineNativeBridge = nativeEngineBridge,
  context: EngineDiscoveryContext = {}
): Promise<EngineDiagnostics> {
  const engines = createEngines(bridge);
  const statuses = await Promise.all(
    engines.map(async (e): Promise<EngineStatus> => {
      try {
        return await e.status();
      } catch (err) {
        return {
          engineId: 'manual_export',
          displayName: 'Unknown engine',
          detected: false,
          valid: false,
          version: null,
          source: 'none',
          executablePath: null,
          capabilities: {
            slice: false,
            export3mf: false,
            exportGcode: false,
            multiPlate: false,
            multiExtruder: false
          },
          errors: [`Engine probe failed: ${err instanceof Error ? err.message : String(err)}`],
          warnings: [],
          notes: []
        };
      }
    })
  );

  const nozzleIndex = context.nozzleIndex ?? 0;
  for (const s of statuses) {
    s.nozzleSupport = multiExtruderSupport(
      s.valid ? s.capabilities : null,
      context.printer,
      nozzleIndex
    );
  }

  const slicer = statuses.find(canSlice);
  const manual = statuses.find((s) => s.engineId === 'manual_export' && s.valid);
  const recommendedEngineId = slicer?.engineId ?? manual?.engineId ?? null;

  const warnings: string[] = [];
  if (!bridge.isDesktop()) {
    warnings.push('Running in a browser build — automated slicing needs the desktop app; manual export only.');
  } else if (!slicer) {
    warnings.push('No slice-capable engine detected. Install OrcaSlicer or select its executable, or use manual export.');
  }
  // Say plainly when the blocker is the nozzle rather than the engine itself:
  // a second nozzle is exactly the case this product exists for.
  if (!slicer && printerNozzleCount(context.printer) > 1) {
    const blocked = statuses.find(
      (s) => s.detected && s.valid && s.capabilities.slice && s.nozzleSupport?.supported === false
    );
    if (blocked) {
      warnings.push(
        `${blocked.displayName} cannot slice for a chosen nozzle on this multi-nozzle printer, so this step stays on the manual path.`
      );
    }
  }

  return { desktop: bridge.isDesktop(), engines: statuses, recommendedEngineId, warnings };
}
