import { describe, it, expect } from 'vitest';
import {
  InstalledOrcaEngine,
  ManualExportEngine,
  discoverEngines,
  splitRawDetection,
  fromRawCapabilities
} from '../../src/automatedCalibration';
import type {
  EngineNativeBridge,
  RawEngineDetection,
  RawSliceRun,
  RunSliceArgs
} from '../../src/automatedCalibration';
import type { PreparedCalibrationProject } from '../../src/automatedCalibration';

// --- fixtures ---------------------------------------------------------------

const VALID_ORCA: RawEngineDetection = {
  engine_id: 'installed_orca',
  detected: true,
  display_name: 'Installed OrcaSlicer',
  version: '2.4.2',
  executable_path: 'C:\\Program Files\\OrcaSlicer\\orca-slicer.exe',
  source: 'installed',
  checksum_sha256: 'abc123',
  capabilities: { slice: true, export_3mf: true, export_gcode: true, multi_plate: false, multi_extruder: false },
  valid: true,
  errors: [],
  warnings: ['Multi-plate and multi-extruder support not verified without a trial slice'],
  notes: []
};

const INVALID_ORCA: RawEngineDetection = {
  ...VALID_ORCA,
  checksum_sha256: null,
  capabilities: { slice: false, export_3mf: false, export_gcode: false, multi_plate: false, multi_extruder: false },
  valid: false,
  errors: ['resources/calib not found — calibration models are missing'],
  warnings: []
};

const SLICE_OK: RawSliceRun = {
  engine_id: 'installed_orca',
  exit_code: 0,
  duration_ms: 4200,
  timed_out: false,
  cancelled: false,
  output_dir: 'C:\\PerfectFit\\sessions\\sess-1\\jobs\\job-1\\out',
  gcode_path: 'C:\\PerfectFit\\sessions\\sess-1\\jobs\\job-1\\out\\plate_1.gcode',
  artifact_paths: ['C:\\PerfectFit\\sessions\\sess-1\\jobs\\job-1\\out\\plate_1.gcode'],
  log_dir: 'C:\\PerfectFit\\sessions\\sess-1\\jobs\\job-1\\datadir\\log',
  succeeded: true
};

const PREPARED: PreparedCalibrationProject = {
  id: 'job-1',
  projectId: 'sess-1',
  stepId: 'pressure-advance',
  workspaceDir: 'C:\\PerfectFit\\sessions\\sess-1\\jobs\\job-1\\workspace',
  projectFilePath: 'C:\\PerfectFit\\sessions\\sess-1\\jobs\\job-1\\workspace\\project.3mf',
  manifestPath: 'C:\\PerfectFit\\sessions\\sess-1\\jobs\\job-1\\workspace\\job-manifest.json',
  sliced: false,
  createdAt: '2026-07-26T00:00:00Z'
};

function fakeBridge(overrides: Partial<EngineNativeBridge> = {}): EngineNativeBridge {
  return {
    isDesktop: () => true,
    detectSlicingEngine: async () => VALID_ORCA,
    validateSlicingEngine: async () => VALID_ORCA,
    runCalibrationSlice: async () => SLICE_OK,
    cancelCalibrationSlice: async () => true,
    ...overrides
  };
}

// --- capability mapping -----------------------------------------------------

describe('capability mapping', () => {
  it('maps snake_case native capabilities to camelCase', () => {
    const caps = fromRawCapabilities(VALID_ORCA.capabilities);
    expect(caps).toEqual({ slice: true, export3mf: true, exportGcode: true, multiPlate: false, multiExtruder: false });
  });

  it('splits a raw detection into detection + validation, nulling caps when invalid', () => {
    expect(splitRawDetection(VALID_ORCA).validation.capabilities).not.toBeNull();
    expect(splitRawDetection(INVALID_ORCA).validation.capabilities).toBeNull();
    expect(splitRawDetection(VALID_ORCA).detection.source).toBe('installed');
  });
});

// --- ManualExportEngine -----------------------------------------------------

describe('ManualExportEngine', () => {
  const engine = new ManualExportEngine();

  it('is always detected and valid, export-only (never slices)', async () => {
    expect((await engine.detect()).detected).toBe(true);
    const v = await engine.validate();
    expect(v.valid).toBe(true);
    const caps = await engine.getCapabilities();
    expect(caps.export3mf).toBe(true);
    expect(caps.slice).toBe(false);
  });

  it('slice() returns a deliberately not-sliced job, never printer-ready', async () => {
    const job = await engine.slice(PREPARED, { outputDir: 'x', timeoutMs: 1000 });
    expect(job.sliced).toBe(false);
    expect(job.succeeded).toBe(false);
    expect(job.outputGcodePath).toBeNull();
    expect(job.engineId).toBe('manual_export');
    const inspection = await engine.inspectOutput(job);
    expect(inspection.ok).toBe(false);
    expect(inspection.findings.join(' ')).toMatch(/open the prepared project/i);
  });
});

// --- InstalledOrcaEngine (desktop) ------------------------------------------

describe('InstalledOrcaEngine (desktop)', () => {
  it('detects and validates from the native payload', async () => {
    const engine = new InstalledOrcaEngine(fakeBridge());
    const d = await engine.detect();
    expect(d.detected).toBe(true);
    expect(d.version).toBe('2.4.2');
    expect(d.executablePath).toContain('orca-slicer.exe');
    expect(d.source).toBe('installed');
    const caps = await engine.getCapabilities();
    expect(caps.slice).toBe(true);
    expect(engine.version).toBe('2.4.2');
  });

  it('slice() maps prepared-project ids onto the managed job layout', async () => {
    let captured: RunSliceArgs | null = null;
    const engine = new InstalledOrcaEngine(
      fakeBridge({
        runCalibrationSlice: async (args) => {
          captured = args;
          return SLICE_OK;
        }
      })
    );
    await engine.detect(); // populate version
    const job = await engine.slice(PREPARED, { outputDir: 'out', timeoutMs: 60_000, cancellationToken: 'tok-1' });

    expect(captured).not.toBeNull();
    expect(captured!.sessionId).toBe('sess-1'); // projectId → session
    expect(captured!.jobId).toBe('job-1'); // prepared id → job
    expect(captured!.projectFileName).toBe('project.3mf'); // basename of the 3mf
    expect(captured!.cancellationToken).toBe('tok-1');

    expect(job.succeeded).toBe(true);
    expect(job.sliced).toBe(true);
    expect(job.outputGcodePath).toContain('plate_1.gcode');
    expect(job.durationMs).toBe(4200);
    expect(job.exitCode).toBe(0);
    expect(job.engineVersion).toBe('2.4.2');
    expect(job.logPath).toContain('log');

    const inspection = await engine.inspectOutput(job);
    expect(inspection.ok).toBe(true);
    expect(inspection.artifactExists).toBe(true);
    // Deep g-code provenance is Stage 6 — reported as "not performed", not guessed.
    expect(inspection.expectedPrinterApplied).toBeNull();
  });

  it('does not slice when no project 3mf is assembled', async () => {
    const engine = new InstalledOrcaEngine(fakeBridge());
    const job = await engine.slice({ ...PREPARED, projectFilePath: null }, { outputDir: 'o', timeoutMs: 1000 });
    expect(job.succeeded).toBe(false);
    expect(job.sliced).toBe(false);
  });

  it('project assembly rejects clearly until Stage 6', async () => {
    const engine = new InstalledOrcaEngine(fakeBridge());
    await expect(engine.resolvePrinterPreset({ printerProfileId: 'p', nozzleDiameterMm: 0.4, slicer: 'orca' })).rejects.toThrow(
      /STAGE6_NOT_IMPLEMENTED/
    );
  });
});

// --- InstalledOrcaEngine (web build, no bridge) -----------------------------

describe('InstalledOrcaEngine (web build)', () => {
  const webBridge = fakeBridge({ isDesktop: () => false });

  it('reports not-detected and refuses to slice off the desktop', async () => {
    const engine = new InstalledOrcaEngine(webBridge);
    const d = await engine.detect();
    expect(d.detected).toBe(false);
    expect(d.notes.join(' ') + (await engine.validate()).errors.join(' ')).toMatch(/desktop app/i);
    const caps = await engine.getCapabilities();
    expect(caps.slice).toBe(false);
    const job = await engine.slice(PREPARED, { outputDir: 'o', timeoutMs: 1000 });
    expect(job.succeeded).toBe(false);
  });
});

// --- engine diagnostics -----------------------------------------------------

describe('engine diagnostics', () => {
  it('recommends installed Orca when it is slice-capable', async () => {
    const diag = await discoverEngines(fakeBridge());
    expect(diag.desktop).toBe(true);
    expect(diag.recommendedEngineId).toBe('installed_orca');
    expect(diag.engines.map((e) => e.engineId)).toEqual(expect.arrayContaining(['installed_orca', 'manual_export']));
    expect(diag.warnings).toHaveLength(0);
  });

  it('falls back to manual export when no slice-capable engine exists', async () => {
    const diag = await discoverEngines(fakeBridge({ detectSlicingEngine: async () => INVALID_ORCA }));
    expect(diag.recommendedEngineId).toBe('manual_export');
    expect(diag.warnings.join(' ')).toMatch(/no slice-capable engine/i);
  });

  it('recommends manual export and warns in a browser build', async () => {
    const diag = await discoverEngines(fakeBridge({ isDesktop: () => false }));
    expect(diag.desktop).toBe(false);
    expect(diag.recommendedEngineId).toBe('manual_export');
    expect(diag.warnings.join(' ')).toMatch(/browser build/i);
  });

  it('never throws — a probe failure surfaces as an engine error', async () => {
    const diag = await discoverEngines(
      fakeBridge({
        detectSlicingEngine: async () => {
          throw new Error('boom');
        }
      })
    );
    // manual export is still valid and recommended
    expect(diag.recommendedEngineId).toBe('manual_export');
    expect(diag.engines.some((e) => e.errors.some((m) => /probe failed/i.test(m)))).toBe(true);
  });
});
