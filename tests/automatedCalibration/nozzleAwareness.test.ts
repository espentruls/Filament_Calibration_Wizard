// ---------------------------------------------------------------------------
// Nozzle awareness across the automated-calibration contracts.
//
// The pipeline was designed nozzle-blind: one flat working profile per session,
// jobs keyed by step alone, and a workspace name built from project+step+inputs.
// On a dual-nozzle machine (the Bambu X2D's direct-drive main + bowden-fed
// auxiliary — the reason this product exists) that is not merely incomplete, it
// collides: the same step on two nozzles produced one identical directory.
//
// These tests pin the nozzle down at every point it has to travel through.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';

import {
  buildWorkingProfile,
  beginSession,
  setWorkingProfile,
  ensureWorkingProfile,
  getWorkingProfile,
  listWorkingProfiles,
  primaryNozzleIndex,
  profileNozzleIndex,
  createTemporaryProfile,
  validateSession,
  loadSessionSafe,
  applyStepResult,
  applyValue,
  inputFingerprintForStep,
  markStaleJobs,
  workspaceDirName,
  isPerfectFitWorkspaceName,
  prepareJob,
  printerNozzleCount,
  isMultiNozzlePrinter,
  multiExtruderSupport,
  emptyEngineCapabilities,
  projectPresetForNozzle,
  presetExtruderCount,
  applyNozzleToPreset,
  PER_EXTRUDER_MACHINE_KEYS,
  InstalledOrcaEngine,
  ManualExportEngine,
  discoverEngines
} from '../../src/automatedCalibration';
// Module-local helpers: exercised here, but deliberately not part of the
// automatedCalibration barrel's public surface.
import { workingProfileNozzles } from '../../src/automatedCalibration/session';
import { resolveJobNozzleIndex } from '../../src/automatedCalibration/projectPreparation';
import type {
  EngineNativeBridge,
  GeneratedJobRecord,
  PrinterSelection,
  RawEngineDetection,
  ResolvedPrinterPreset,
  SlicingEngineCapabilities
} from '../../src/automatedCalibration';
import { createProject } from '../../src/storage/store';
import type { CalibrationProject, PrinterProfile } from '../../src/types';

const AT = '2026-07-26T00:00:00.000Z';
const ORCA_ROOT = '/opt/OrcaSlicer/resources';
const SELECTION: PrinterSelection = { printerProfileId: 'p1', nozzleDiameterMm: 0.4, slicer: 'orca' };

// --- fixtures ---------------------------------------------------------------

function makeProject(over: Partial<CalibrationProject> = {}): CalibrationProject {
  const p = createProject({
    filament: {
      manufacturer: 'Acme', productLine: 'Basic', material: 'PLA',
      color: 'Black', diameter: 1.75, startingProfile: 'Generic PLA'
    },
    printerProfileId: 'printer-1',
    nozzleType: 'brass',
    slicer: { slicer: 'orca', version: '2.4.x' },
    notes: '',
    mode: 'coach'
  });
  return Object.assign(p, over);
}

/** A session spanning both nozzles of a dual-nozzle machine. */
function dualNozzleSession(): CalibrationProject {
  const project = makeProject();
  const main = buildWorkingProfile({
    projectId: project.id, displayName: 'PLA — main', nozzleIndex: 0, now: AT
  });
  const aux = buildWorkingProfile({
    projectId: project.id, displayName: 'PLA — auxiliary', nozzleIndex: 1, now: AT
  });
  beginSession(project, {
    slicerMode: 'installed_orca',
    engineId: 'installed_orca',
    workingProfile: main,
    additionalProfiles: [aux]
  });
  return project;
}

const X2D: Pick<PrinterProfile, 'nozzles' | 'extruderCount'> = {
  nozzles: [
    { label: 'Main (direct drive)', feed: 'direct' },
    { label: 'Auxiliary (bowden)', feed: 'bowden' }
  ]
};

// --- 1. PrinterSelection carries the nozzle ---------------------------------

describe('PrinterSelection identifies WHICH nozzle', () => {
  it('defaults to the main nozzle when no index is given', () => {
    expect(resolveJobNozzleIndex({ printerSelection: SELECTION })).toBe(0);
  });

  it('carries an explicit auxiliary-nozzle selection', () => {
    const aux: PrinterSelection = { ...SELECTION, nozzleIndex: 1 };
    expect(resolveJobNozzleIndex({ printerSelection: aux })).toBe(1);
  });

  it('falls back to the project nozzle, and an explicit request wins over both', () => {
    const project = { nozzleIndex: 1 };
    // A selection that says nothing about the nozzle defers to the project's.
    expect(resolveJobNozzleIndex({ printerSelection: SELECTION, project })).toBe(1);
    expect(resolveJobNozzleIndex({ project })).toBe(1);
    // An explicit selection wins over the project…
    expect(resolveJobNozzleIndex({ printerSelection: { nozzleIndex: 0 }, project })).toBe(0);
    // …and an explicit request wins over both.
    expect(resolveJobNozzleIndex({ nozzleIndex: 0, printerSelection: { nozzleIndex: 1 }, project })).toBe(0);
  });

  it('flows into the job manifest', () => {
    const project = dualNozzleSession();
    const plan = prepareJob({
      project, stepId: 'retraction', slicerMode: 'installed_orca',
      printerSelection: { ...SELECTION, nozzleIndex: 1 }, nozzleDiameterMm: 0.4,
      assetContext: { slicerResourceRoot: ORCA_ROOT }, jobId: 'j1'
    });
    expect(plan.manifest.nozzleIndex).toBe(1);
    expect(plan.manifest.printerSelection.nozzleIndex).toBe(1);
  });
});

// --- 2. one working profile per nozzle --------------------------------------

describe('a session holds one working profile per nozzle', () => {
  it('keeps two nozzles\u2019 retraction distances side by side', () => {
    const project = dualNozzleSession();
    // Direct-drive main: short retraction. Bowden auxiliary: much longer.
    setWorkingProfile(
      project,
      applyStepResult(getWorkingProfile(project, 0)!, 'retraction', { retractionDistance: 0.8 })
    );
    setWorkingProfile(
      project,
      applyStepResult(getWorkingProfile(project, 1)!, 'retraction', { retractionDistance: 4.5 })
    );

    expect(getWorkingProfile(project, 0)!.values.retractionDistance).toBe(0.8);
    expect(getWorkingProfile(project, 1)!.values.retractionDistance).toBe(4.5);
    // …and neither profile invented a composite value key.
    expect(Object.keys(getWorkingProfile(project, 0)!.values)).toEqual(['retractionDistance']);
  });

  it('stamps a nozzle on every created profile (absent = main)', () => {
    const created = createTemporaryProfile({ id: 'wp', displayName: 'w', projectId: 'p' });
    expect(created.nozzleIndex).toBe(0);
    expect(buildWorkingProfile({ projectId: 'p', displayName: 'w', nozzleIndex: 1 }).nozzleIndex).toBe(1);
    // A legacy profile with no index reads as the main nozzle.
    expect(profileNozzleIndex({ nozzleIndex: undefined })).toBe(0);
  });

  it('applyValue preserves the profile\u2019s nozzle', () => {
    const aux = buildWorkingProfile({ projectId: 'p', displayName: 'w', nozzleIndex: 1 });
    const next = applyValue(aux, 'pressureAdvance', 0.32, 'calibration_result', { now: AT });
    expect(next.nozzleIndex).toBe(1);
  });

  it('replacing one nozzle\u2019s profile leaves the other untouched', () => {
    const project = dualNozzleSession();
    const mainBefore = getWorkingProfile(project, 0)!;
    setWorkingProfile(
      project,
      applyStepResult(getWorkingProfile(project, 1)!, 'pressure-advance', { pressureAdvance: 0.35 })
    );
    expect(getWorkingProfile(project, 0)).toBe(mainBefore);
    expect(getWorkingProfile(project, 0)!.values.pressureAdvance).toBeUndefined();
    expect(getWorkingProfile(project, 1)!.values.pressureAdvance).toBe(0.35);
  });

  it('lists the nozzles it holds, primary first, without duplicates', () => {
    const project = dualNozzleSession();
    expect(workingProfileNozzles(project)).toEqual([0, 1]);
    expect(listWorkingProfiles(project)).toHaveLength(2);
    expect(primaryNozzleIndex(project)).toBe(0);
  });

  it('getWorkingProfile with no index still returns the session\u2019s primary profile', () => {
    const project = dualNozzleSession();
    expect(getWorkingProfile(project)).toBe(project.workingProfile);
  });

  it('reports no profile (rather than an empty one) for an untouched nozzle', () => {
    const project = makeProject();
    beginSession(project, {
      slicerMode: 'manual_export',
      workingProfile: buildWorkingProfile({ projectId: project.id, displayName: 'w' })
    });
    expect(getWorkingProfile(project, 1)).toBeUndefined();
  });

  it('ensureWorkingProfile creates a nozzle\u2019s profile on first use only', () => {
    const project = makeProject();
    beginSession(project, {
      slicerMode: 'manual_export',
      workingProfile: buildWorkingProfile({ projectId: project.id, displayName: 'w' })
    });
    const aux = ensureWorkingProfile(project, 1, { displayName: 'PLA — auxiliary' });
    expect(aux.nozzleIndex).toBe(1);
    expect(ensureWorkingProfile(project, 1)).toBe(aux); // idempotent
    expect(workingProfileNozzles(project)).toEqual([0, 1]);
    expect(validateSession(project)).toEqual([]);
  });

  it('a session started on the auxiliary nozzle keeps it as its primary', () => {
    const project = makeProject({ nozzleIndex: 1 });
    beginSession(project, {
      slicerMode: 'manual_export',
      workingProfile: buildWorkingProfile({ projectId: project.id, displayName: 'aux', nozzleIndex: 1 })
    });
    expect(primaryNozzleIndex(project)).toBe(1);
    expect(getWorkingProfile(project, 1)).toBe(project.workingProfile);
    expect(getWorkingProfile(project, 0)).toBeUndefined();
  });

  it('rejects two profiles claiming the same nozzle, and sets a corrupt session aside', () => {
    const project = dualNozzleSession();
    project.workingProfiles = [
      buildWorkingProfile({ projectId: project.id, displayName: 'dup', nozzleIndex: 0 })
    ];
    const errors = validateSession(project);
    expect(errors.join(' ')).toMatch(/two working profiles claim nozzle 1/);

    const stepsBefore = JSON.stringify(project.steps);
    const res = loadSessionSafe(project);
    expect(res.degraded).toBe(true);
    expect(project.workingProfiles).toBeUndefined();
    expect(JSON.stringify(project.steps)).toBe(stepsBefore); // real data untouched
  });
});

// --- 3. jobs, fingerprints and workspaces are per nozzle --------------------

describe('generated jobs are keyed by step AND nozzle', () => {
  it('REGRESSION: two nozzles yield distinct workspace directories', () => {
    const main = workspaceDirName('proj1', 'retraction', 'fp', 0);
    const aux = workspaceDirName('proj1', 'retraction', 'fp', 1);
    expect(main).not.toBe(aux);
    // …and both are still recognizable as PerfectFit-owned workspaces.
    expect(isPerfectFitWorkspaceName(main)).toBe(true);
    expect(isPerfectFitWorkspaceName(aux)).toBe(true);
    // An omitted index is the main nozzle, not a third directory.
    expect(workspaceDirName('proj1', 'retraction', 'fp')).toBe(main);
  });

  it('REGRESSION: preparing the same step for both nozzles does not collide', () => {
    const project = dualNozzleSession();
    const dirFor = (nozzleIndex: number): string =>
      prepareJob({
        project, stepId: 'retraction', slicerMode: 'installed_orca',
        printerSelection: { ...SELECTION, nozzleIndex }, nozzleDiameterMm: 0.4,
        assetContext: { slicerResourceRoot: ORCA_ROOT }, jobId: `j${nozzleIndex}`
      }).workspaceDirName;

    expect(dirFor(0)).not.toBe(dirFor(1));
    expect(dirFor(1)).toBe(dirFor(1)); // still deterministic per nozzle
  });

  it('a job snapshots the values of ITS OWN nozzle', () => {
    const project = dualNozzleSession();
    setWorkingProfile(
      project,
      applyStepResult(getWorkingProfile(project, 0)!, 'temperature', { nozzleTemp: 210 })
    );
    setWorkingProfile(
      project,
      applyStepResult(getWorkingProfile(project, 1)!, 'temperature', { nozzleTemp: 225 })
    );
    const applied = (nozzleIndex: number): unknown =>
      prepareJob({
        project, stepId: 'flow-pass1', slicerMode: 'installed_orca',
        printerSelection: { ...SELECTION, nozzleIndex }, nozzleDiameterMm: 0.4,
        assetContext: { slicerResourceRoot: ORCA_ROOT }, jobId: 'j'
      }).manifest.appliedValues.nozzleTemp;

    expect(applied(0)).toBe(210);
    expect(applied(1)).toBe(225);
  });

  it('warns rather than silently applying nothing for a nozzle with no profile', () => {
    const project = makeProject();
    beginSession(project, {
      slicerMode: 'installed_orca',
      workingProfile: buildWorkingProfile({ projectId: project.id, displayName: 'w' })
    });
    const plan = prepareJob({
      project, stepId: 'retraction', slicerMode: 'installed_orca',
      printerSelection: { ...SELECTION, nozzleIndex: 1 }, nozzleDiameterMm: 0.4,
      assetContext: { slicerResourceRoot: ORCA_ROOT }, jobId: 'j'
    });
    expect(plan.warnings.join(' ')).toMatch(/no working profile for nozzle 2/i);
  });

  it('the same values on a different nozzle fingerprint differently', () => {
    const main = buildWorkingProfile({ projectId: 'p', displayName: 'w', nozzleIndex: 0 });
    const aux = buildWorkingProfile({ projectId: 'p', displayName: 'w', nozzleIndex: 1 });
    const a = applyStepResult(main, 'flow-pass1', { flowRatio: 0.98 });
    const b = applyStepResult(aux, 'flow-pass1', { flowRatio: 0.98 });
    expect(inputFingerprintForStep(a, 'pressure-advance')).not.toBe(
      inputFingerprintForStep(b, 'pressure-advance')
    );
    // An explicit index overrides the profile's own.
    expect(inputFingerprintForStep(a, 'pressure-advance', 1)).toBe(
      inputFingerprintForStep(b, 'pressure-advance')
    );
  });
});

describe('markStaleJobs isolates the nozzles', () => {
  function job(over: Partial<GeneratedJobRecord>): GeneratedJobRecord {
    return {
      id: 'j', stepId: 'pressure-advance', createdAt: AT, engineId: 'installed_orca',
      engineVersion: '2.4.2', slicerMode: 'installed_orca', status: 'sliced',
      inputFingerprint: 'x', outputPath: '/tmp/plate_1.gcode', sliced: true, warnings: [],
      ...over
    };
  }

  function sessionWithJobPerNozzle(): CalibrationProject {
    const project = dualNozzleSession();
    for (const n of [0, 1]) {
      setWorkingProfile(
        project,
        applyStepResult(getWorkingProfile(project, n)!, 'flow-pass1', { flowRatio: 0.98 })
      );
    }
    project.generatedJobs = [0, 1].map((n) =>
      job({
        id: `job-pa-n${n}`,
        nozzleIndex: n,
        inputFingerprint: inputFingerprintForStep(getWorkingProfile(project, n), 'pressure-advance', n)
      })
    );
    return project;
  }

  it('a new result on one nozzle does not stale the other nozzle\u2019s jobs', () => {
    const project = sessionWithJobPerNozzle();
    // Re-measure flow on the AUXILIARY nozzle only.
    setWorkingProfile(
      project,
      applyStepResult(getWorkingProfile(project, 1)!, 'flow-verify', { flowRatio: 0.94 })
    );
    const stale = markStaleJobs(project);
    expect(stale).toEqual(['job-pa-n1']);
    expect(project.generatedJobs!.find((j) => j.id === 'job-pa-n0')!.status).toBe('sliced');
    expect(project.generatedJobs!.find((j) => j.id === 'job-pa-n1')!.status).toBe('stale');
  });

  it('leaves both alone when nothing changed', () => {
    expect(markStaleJobs(sessionWithJobPerNozzle())).toEqual([]);
  });

  it('treats a job with no nozzle index as the session\u2019s primary nozzle', () => {
    const project = dualNozzleSession();
    setWorkingProfile(
      project,
      applyStepResult(getWorkingProfile(project, 0)!, 'flow-pass1', { flowRatio: 0.98 })
    );
    project.generatedJobs = [
      job({
        id: 'legacy',
        inputFingerprint: inputFingerprintForStep(getWorkingProfile(project, 0), 'pressure-advance')
      })
    ];
    expect(markStaleJobs(project)).toEqual([]);
  });
});

// --- 4. multi-extruder is derived, not asserted -----------------------------

describe('multiExtruder is derived from the printer, honestly', () => {
  it('counts nozzles from the profile, then from extruderCount', () => {
    expect(printerNozzleCount(X2D)).toBe(2);
    expect(printerNozzleCount({ extruderCount: 2 })).toBe(2);
    expect(printerNozzleCount({ extruderCount: 1 })).toBe(1);
    // The nozzles array wins — it is the profile the user edited.
    expect(printerNozzleCount({ nozzles: [{}], extruderCount: 4 })).toBe(1);
  });

  it('reports an unknown nozzle count as unknown, never as 1', () => {
    expect(printerNozzleCount(undefined)).toBe(0);
    expect(printerNozzleCount({})).toBe(0);
    expect(printerNozzleCount({ extruderCount: null })).toBe(0);
    expect(isMultiNozzlePrinter(undefined)).toBe(false);
    expect(isMultiNozzlePrinter(X2D)).toBe(true);
  });

  const capable: SlicingEngineCapabilities = { ...emptyEngineCapabilities(), slice: true, multiExtruder: true };
  const notCapable: SlicingEngineCapabilities = { ...emptyEngineCapabilities(), slice: true };

  it('needs nothing special for the only nozzle of a single-nozzle printer', () => {
    expect(multiExtruderSupport(notCapable, { extruderCount: 1 }, 0).supported).toBe(true);
    expect(multiExtruderSupport(null, undefined, 0).supported).toBe(true);
  });

  it('refuses a nozzle the printer does not have', () => {
    const r = multiExtruderSupport(capable, { extruderCount: 1 }, 1);
    expect(r.supported).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/1 nozzle/);
  });

  it('requires real multi-extruder support on a multi-nozzle printer — including its main nozzle', () => {
    expect(multiExtruderSupport(notCapable, X2D, 1).supported).toBe(false);
    expect(multiExtruderSupport(notCapable, X2D, 0).supported).toBe(false);
    expect(multiExtruderSupport(capable, X2D, 1).supported).toBe(true);
  });

  it('reports "unknown" as unsupported with a reason, never as a guess', () => {
    const r = multiExtruderSupport(null, X2D, 1);
    expect(r.supported).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/not been detected and validated/i);
  });

  it('rejects a nonsense nozzle index', () => {
    expect(multiExtruderSupport(capable, X2D, -1).supported).toBe(false);
    expect(multiExtruderSupport(capable, X2D, 1.5).supported).toBe(false);
  });
});

// --- engines report their nozzle support truthfully -------------------------

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
  warnings: [],
  notes: []
};

const X2D_MACHINES = [
  {
    vendor: 'BBL',
    name: 'Bambu Lab X2D 0.4 nozzle',
    printer_model: 'Bambu Lab X2D',
    nozzle_diameter: '0.4',
    default_print_profile: '0.20mm Standard @BBL X2D',
    default_filament_profile: null
  }
];

/** A resolved dual-nozzle machine preset: per-extruder values are ARRAYS. */
const DUAL_SETTINGS = {
  printer_settings_id: 'Bambu Lab X2D 0.4 nozzle',
  nozzle_diameter: ['0.4', '0.4'],
  extruder_type: ['DirectDrive', 'Bowden'],
  retraction_length: ['0.8', '4.5'],
  retraction_speed: ['30', '60'],
  // NOT per extruder: two entries, but they are [normal, stealth].
  machine_max_acceleration_x: ['10000', '5000'],
  filament_flow_ratio: ['1']
};

const DUAL_PRESET = {
  settings_json: JSON.stringify(DUAL_SETTINGS),
  printer_model: 'Bambu Lab X2D',
  printer_settings_id: 'Bambu Lab X2D 0.4 nozzle',
  print_settings_id: '0.20mm Standard @BBL X2D',
  filament_settings_id: 'Bambu PLA Basic @BBL X2D',
  machine_key_count: 200,
  process_key_count: 100,
  filament_key_count: 64,
  warnings: []
};

function fakeBridge(overrides: Partial<EngineNativeBridge> = {}): EngineNativeBridge {
  return {
    isDesktop: () => true,
    detectSlicingEngine: async () => VALID_ORCA,
    validateSlicingEngine: async () => VALID_ORCA,
    runCalibrationSlice: async () => {
      throw new Error('not used');
    },
    cancelCalibrationSlice: async () => true,
    readProjectConfig: async () => '{}',
    assembleCalibrationProject: async () => {
      throw new Error('not used');
    },
    resolvePresetByNames: async () => DUAL_PRESET,
    listInstalledMachines: async () => X2D_MACHINES,
    ...overrides
  };
}

function withMultiExtruder(value: boolean): RawEngineDetection {
  return { ...VALID_ORCA, capabilities: { ...VALID_ORCA.capabilities, multi_extruder: value } };
}

describe('engines report nozzle support truthfully', () => {
  it('installed Orca refuses a multi-nozzle printer while native reports multi_extruder false', async () => {
    const engine = new InstalledOrcaEngine(fakeBridge());
    const single = await engine.supportsNozzle({ extruderCount: 1 }, 0);
    expect(single.supported).toBe(true);
    const aux = await engine.supportsNozzle(X2D, 1);
    expect(aux.supported).toBe(false);
    expect(aux.reasons.join(' ')).toMatch(/not been confirmed/i);
  });

  it('installed Orca accepts the auxiliary nozzle once the engine really reports it', async () => {
    const engine = new InstalledOrcaEngine(
      fakeBridge({ detectSlicingEngine: async () => withMultiExtruder(true) })
    );
    expect((await engine.supportsNozzle(X2D, 1)).supported).toBe(true);
  });

  it('manual export never claims multi-extruder slicing (it slices nothing)', async () => {
    const engine = new ManualExportEngine();
    expect((await engine.getCapabilities()).multiExtruder).toBe(false);
    expect((await engine.supportsNozzle({ extruderCount: 1 }, 0)).supported).toBe(true);
    expect((await engine.supportsNozzle(X2D, 1)).supported).toBe(false);
  });

  it('diagnostics do not recommend an engine that cannot serve the requested nozzle', async () => {
    const blocked = await discoverEngines(fakeBridge(), { printer: X2D, nozzleIndex: 1 });
    expect(blocked.recommendedEngineId).toBe('manual_export');
    expect(blocked.warnings.join(' ')).toMatch(/multi-nozzle printer/i);
    const orca = blocked.engines.find((e) => e.engineId === 'installed_orca')!;
    expect(orca.capabilities.slice).toBe(true); // it CAN slice…
    expect(orca.nozzleSupport!.supported).toBe(false); // …but not for this nozzle

    const ok = await discoverEngines(
      fakeBridge({ detectSlicingEngine: async () => withMultiExtruder(true) }),
      { printer: X2D, nozzleIndex: 1 }
    );
    expect(ok.recommendedEngineId).toBe('installed_orca');
  });

  it('a probe with no printer context behaves exactly as before', async () => {
    const diag = await discoverEngines(fakeBridge());
    expect(diag.recommendedEngineId).toBe('installed_orca');
    expect(diag.warnings).toEqual([]);
  });
});

// --- 5. per-extruder preset arrays ------------------------------------------

describe('per-extruder preset resolution', () => {
  it('reads the extruder count from nozzle_diameter, or reports it as unknown', () => {
    expect(presetExtruderCount(DUAL_SETTINGS)).toBe(2);
    expect(presetExtruderCount({ nozzle_diameter: ['0.4'] })).toBe(1);
    expect(presetExtruderCount({})).toBeNull();
    expect(presetExtruderCount({ nozzle_diameter: '0.4' })).toBeNull();
  });

  it('indexes per-extruder arrays by nozzle instead of taking element 0', () => {
    const p = projectPresetForNozzle(DUAL_SETTINGS, 1);
    expect(p.settings.retraction_length).toEqual(['4.5']);
    expect(p.settings.retraction_speed).toEqual(['60']);
    expect(p.settings.extruder_type).toEqual(['Bowden']);
    expect(p.indexedKeys).toEqual(expect.arrayContaining(['retraction_length', 'extruder_type']));
    expect(p.warnings).toEqual([]);
  });

  it('leaves the main nozzle untouched (element 0 is already correct)', () => {
    const p = projectPresetForNozzle(DUAL_SETTINGS, 0);
    expect(p.settings).toEqual(DUAL_SETTINGS);
    expect(p.indexedKeys).toEqual([]);
  });

  it('never mutates the preset it was given', () => {
    const before = JSON.stringify(DUAL_SETTINGS);
    projectPresetForNozzle(DUAL_SETTINGS, 1);
    expect(JSON.stringify(DUAL_SETTINGS)).toBe(before);
  });

  it('does NOT touch arrays that merely happen to have one entry per extruder', () => {
    // [normal, stealth] — indexing this by nozzle would corrupt the machine.
    const p = projectPresetForNozzle(DUAL_SETTINGS, 1);
    expect(p.settings.machine_max_acceleration_x).toEqual(['10000', '5000']);
    expect(p.settings.filament_flow_ratio).toEqual(['1']);
    expect(PER_EXTRUDER_MACHINE_KEYS).not.toContain('machine_max_acceleration_x');
  });

  it('keeps current behaviour and warns when the shape is unexpected', () => {
    // No nozzle_diameter → extruder count unknown.
    const unknown = projectPresetForNozzle({ retraction_length: ['0.8', '4.5'] }, 1);
    expect(unknown.settings.retraction_length).toEqual(['0.8', '4.5']);
    expect(unknown.indexedKeys).toEqual([]);
    expect(unknown.warnings.join(' ')).toMatch(/could not tell/i);

    // Asking for an extruder the preset does not describe.
    const tooFar = projectPresetForNozzle(DUAL_SETTINGS, 5);
    expect(tooFar.settings).toEqual(DUAL_SETTINGS);
    expect(tooFar.warnings.join(' ')).toMatch(/2 extruders/);

    // A per-extruder key that is not an array, and one of the wrong length.
    const odd = projectPresetForNozzle(
      { nozzle_diameter: ['0.4', '0.4'], retraction_length: '0.8', retraction_speed: ['30'] },
      1
    );
    expect(odd.settings.retraction_length).toBe('0.8');
    expect(odd.settings.retraction_speed).toEqual(['30']);
    expect(odd.warnings).toHaveLength(2);
    expect(odd.warnings.join(' ')).toMatch(/left unchanged/);
  });

  it('folds projection warnings into the resolved preset', () => {
    const preset: ResolvedPrinterPreset = {
      settings: { retraction_length: ['0.8', '4.5'] },
      printerModel: 'X', printerSettingsId: 'X', source: 'vendor_profile',
      warnings: ['pre-existing']
    };
    const out = applyNozzleToPreset(preset, 1);
    expect(out.warnings[0]).toBe('pre-existing');
    expect(out.warnings.length).toBeGreaterThan(1);
    expect(applyNozzleToPreset(preset, 0)).toBe(preset); // main nozzle: untouched
  });
});

describe('InstalledOrcaEngine per-nozzle preset resolution', () => {
  it('resolveForPrinter narrows per-extruder values to the selected nozzle', async () => {
    const engine = new InstalledOrcaEngine(fakeBridge());
    const preset = await engine.resolveForPrinter(
      { printerProfileId: 'bambu-lab-x2d', nozzleDiameterMm: 0.4, nozzleIndex: 1, slicer: 'orca' },
      'Bambu PLA Basic @BBL X2D'
    );
    expect(preset.settings.retraction_length).toEqual(['4.5']);
    expect(preset.settings.extruder_type).toEqual(['Bowden']);
  });

  it('resolveForPrinter leaves the main nozzle exactly as resolved', async () => {
    const engine = new InstalledOrcaEngine(fakeBridge());
    const preset = await engine.resolveForPrinter(
      { printerProfileId: 'bambu-lab-x2d', nozzleDiameterMm: 0.4, slicer: 'orca' },
      'Bambu PLA Basic @BBL X2D'
    );
    expect(preset.settings.retraction_length).toEqual(['0.8', '4.5']);
  });

  it('refuses a nozzle the printer database does not record', async () => {
    const engine = new InstalledOrcaEngine(fakeBridge());
    await expect(
      engine.mapSelection({
        printerProfileId: 'bambu-lab-x1-carbon', nozzleDiameterMm: 0.4, nozzleIndex: 1, slicer: 'orca'
      })
    ).rejects.toThrow(/NOZZLE_NOT_ON_PRINTER/);
  });
});
