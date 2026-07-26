// ---------------------------------------------------------------------------
// The auto-preparation gate — progressive enhancement, honestly reported.
//
// One module answers "could this step be prepared automatically?", so one test
// file pins it: the machine-level probe, the per-step derivation, the caching
// that keeps a render off the filesystem, and the session-shaped answer the
// guided screen actually consumes.
//
// The default state of the app is "no": most projects are Bambu Studio ones,
// the automatedCalibration flag is off, most users are in the browser, and most
// machines have no OrcaSlicer install. These tests pin that every one of those
// noes is REPORTED rather than silently hidden, that a PERMANENT no never reads
// like a fixable setup problem, that the probe never throws, that it costs one
// filesystem scan per session instead of one per render, and — the case this
// product exists for — that a second nozzle is never promised automation an
// engine cannot deliver.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';

import {
  AUTOMATABLE_SLICERS,
  ENGINE_PROBE_TTL_MS,
  PREPARABLE_ASSET_TYPES,
  buildValueContext,
  canAutoPrepareStep,
  canAutoPrepareSteps,
  invalidateEngineAvailability,
  peekEngineAvailability,
  peekSessionCapability,
  probeEngineAvailability,
  resolveGuidedSession,
  resolveSessionCapability,
  resolveSessionNozzle,
  sessionCapabilityFor,
  slicerIsAutomatable,
  stepAutoPrepareFrom,
  type CapabilityCode,
  type EngineAvailabilityInput
} from '../../src/session';
import { CALIBRATION_ASSETS } from '../../src/automatedCalibration';
import type { CalibrationId, CalibrationProject, PrinterProfile } from '../../src/types';
import type {
  EngineNativeBridge,
  RawEngineCapabilities,
  RawEngineDetection
} from '../../src/automatedCalibration';
import { DEFAULT_EXPERIMENTAL_FEATURES } from '../../src/slicerIntegration/types';
import type { ExperimentalFeatures } from '../../src/slicerIntegration/types';
import { auxProject, dualNozzlePrinter, makeProject, singleNozzlePrinter } from './fixtures';

const FLAG_OFF: ExperimentalFeatures = { ...DEFAULT_EXPERIMENTAL_FEATURES, automatedCalibration: false };
const FLAG_ON: ExperimentalFeatures = { ...DEFAULT_EXPERIMENTAL_FEATURES, automatedCalibration: true };

const CAPS = (over: Partial<RawEngineCapabilities> = {}): RawEngineCapabilities => ({
  slice: true,
  export_3mf: true,
  export_gcode: true,
  multi_plate: true,
  multi_extruder: false,
  ...over
});

interface FakeBridgeOptions {
  desktop?: boolean;
  detected?: boolean;
  valid?: boolean;
  capabilities?: RawEngineCapabilities;
  executablePath?: string | null;
  errors?: string[];
  /** Any use of the bridge throws — proves a path never touches it. */
  throwOnUse?: boolean;
  /** Records every native call, so caching can be asserted by call count. */
  calls?: string[];
}

function fakeBridge(opts: FakeBridgeOptions = {}): EngineNativeBridge {
  const note = (name: string): void => {
    opts.calls?.push(name);
    if (opts.throwOnUse) throw new Error(`bridge.${name} must not be called`);
  };
  const detection = (): RawEngineDetection => ({
    engine_id: 'installed_orca',
    detected: opts.detected ?? false,
    display_name: 'Installed OrcaSlicer',
    version: '2.4.1',
    executable_path: opts.executablePath === undefined ? '/opt/OrcaSlicer/orca-slicer' : opts.executablePath,
    source: 'installed',
    checksum_sha256: null,
    capabilities: opts.capabilities ?? CAPS(),
    valid: opts.valid ?? false,
    errors: opts.errors ?? [],
    warnings: [],
    notes: []
  });
  const reject = <T>(name: string): Promise<T> => {
    note(name);
    return Promise.reject(new Error(`${name} not used in these tests`));
  };
  return {
    isDesktop: () => {
      note('isDesktop');
      return opts.desktop ?? false;
    },
    detectSlicingEngine: async () => {
      note('detectSlicingEngine');
      return detection();
    },
    validateSlicingEngine: async () => {
      note('validateSlicingEngine');
      return detection();
    },
    runCalibrationSlice: () => reject('runCalibrationSlice'),
    cancelCalibrationSlice: () => reject('cancelCalibrationSlice'),
    readProjectConfig: () => reject('readProjectConfig'),
    assembleCalibrationProject: () => reject('assembleCalibrationProject'),
    resolvePresetByNames: () => reject('resolvePresetByNames'),
    listInstalledMachines: () => reject('listInstalledMachines')
  };
}

/** A fully working engine: detected, validated, slice-capable. */
const workingEngine = (over: FakeBridgeOptions = {}): FakeBridgeOptions => ({
  desktop: true,
  detected: true,
  valid: true,
  ...over
});

const codes = (r: { code: CapabilityCode }[]): CapabilityCode[] => r.map((x) => x.code);
const text = (r: { message: string }[]): string => r.map((x) => x.message).join(' ');

/** The session-shaped call, the way the guided screen makes it. */
const ask = (
  project: CalibrationProject = makeProject(),
  printer: PrinterProfile | undefined = singleNozzlePrinter(),
  nozzleIndex = 0,
  stepId: CalibrationId = 'pressure-advance',
  opts: Parameters<typeof resolveSessionCapability>[3] = {}
) =>
  resolveSessionCapability(
    buildValueContext({ project, printer, nozzleIndex }),
    resolveSessionNozzle(project, printer, nozzleIndex),
    stepId,
    opts
  );

beforeEach(() => {
  invalidateEngineAvailability();
});

// ---------------------------------------------------------------------------
// Bambu Studio: a permanent no, stated once
// ---------------------------------------------------------------------------

describe('a slicer PerfectFit does not drive (Bambu Studio)', () => {
  const bambu = (over: Partial<EngineAvailabilityInput> = {}): EngineAvailabilityInput => ({
    slicer: 'bambu',
    slicerVersion: '1.7+',
    features: FLAG_ON,
    printer: dualNozzlePrinter(),
    nozzleIndex: 1,
    bridge: fakeBridge(workingEngine()),
    ...over
  });

  it('is data, not a guess: only Orca is driven today', () => {
    expect(AUTOMATABLE_SLICERS).toEqual(['orca']);
    expect(slicerIsAutomatable('bambu')).toBe(false);
    expect(slicerIsAutomatable('orca')).toBe(true);
    // Not naming a slicer is not the same as naming one we cannot drive.
    expect(slicerIsAutomatable(undefined)).toBe(true);
  });

  it('says so with its own code, and never as a missing installation', async () => {
    const availability = await probeEngineAvailability(bambu());
    expect(availability.available).toBe(false);
    expect(availability.automatable).toBe(false);
    expect(codes(availability.reasons)).toEqual(['slicer-not-driven']);
    expect(text(availability.reasons)).toContain('Bambu Studio');
    expect(text(availability.reasons)).toMatch(/by design/);
    // The wrong thing to tell a Bambu user, in all its forms:
    expect(text(availability.reasons)).not.toMatch(/No Orca ?Slicer installation was found/);
    expect(text(availability.reasons)).not.toMatch(/switched off/);
    expect(text(availability.reasons)).not.toMatch(/desktop app/);
  });

  it('is an expected state, not a fault: info severity, permanently true', async () => {
    const availability = await probeEngineAvailability(bambu());
    expect(availability.reasons[0].severity).toBe('info');
    expect(availability.reasons[0].permanent).toBe(true);
  });

  it('points at what PerfectFit does automate instead — the preset', async () => {
    const availability = await probeEngineAvailability(bambu());
    expect(availability.alternative?.kind).toBe('install-preset');
    expect(availability.alternative?.title).toContain('Bambu Studio');
    expect(availability.alternative?.detail).toMatch(/preset/);
  });

  it('never touches the native bridge, however good the engine on this machine is', async () => {
    const calls: string[] = [];
    const availability = await probeEngineAvailability(
      bambu({ bridge: fakeBridge({ ...workingEngine(), throwOnUse: true, calls }) })
    );
    expect(availability.available).toBe(false);
    expect(availability.probed).toBe(false);
    expect(calls).toEqual([]);
  });

  it('outranks the flag, so turning automation on is never dangled as the fix', async () => {
    const off = await probeEngineAvailability(bambu({ features: FLAG_OFF }));
    const on = await probeEngineAvailability(bambu({ features: FLAG_ON }));
    expect(codes(off.reasons)).toEqual(['slicer-not-driven']);
    expect(codes(on.reasons)).toEqual(['slicer-not-driven']);
    expect(off.reasons[0].message).toBe(on.reasons[0].message);
  });

  it('answers synchronously, so the screen states it without waiting', () => {
    const peeked = peekEngineAvailability(bambu({ bridge: fakeBridge({ throwOnUse: true }) }));
    expect(peeked?.automatable).toBe(false);
    expect(codes(peeked?.reasons ?? [])).toEqual(['slicer-not-driven']);
  });

  it('gives every step of a plan the same one sentence, not a per-step drumbeat', async () => {
    const project = auxProject('bambu');
    const answers = await canAutoPrepareSteps(project.stepOrder, bambu());
    expect(answers).toHaveLength(project.stepOrder.length);
    const lines = new Set(answers.map((a) => a.headline));
    expect(lines.size).toBe(1);
    for (const a of answers) {
      expect(a.canAutoPrepare, a.stepId).toBe(false);
      expect(codes(a.reasons), a.stepId).toEqual(['slicer-not-driven']);
      expect(a.alternative?.kind, a.stepId).toBe('install-preset');
    }
  });

  it('reaches the guided screen through the session gate, in session shape', async () => {
    const project = auxProject('bambu');
    const capability = await ask(project, dualNozzlePrinter(), 1, 'pressure-advance', {
      features: FLAG_ON,
      bridge: fakeBridge({ ...workingEngine(), throwOnUse: true })
    });
    expect(capability.mode).toBe('manual');
    expect(capability.manualPathAvailable).toBe(true);
    expect(capability.canAutoPrepare).toBe(false);
    expect(capability.automatable).toBe(false);
    expect(capability.handoff).toBeNull();
    expect(capability.reasonDetails[0].code).toBe('slicer-not-driven');
    expect(capability.reasonDetails[0].permanent).toBe(true);
    expect(capability.headline).toBe(capability.reasons[0]);
    expect(capability.alternative?.kind).toBe('install-preset');
    // No engine was asked, so no nozzle verdict is invented for one.
    expect(capability.nozzleSupport).toBeUndefined();
  });

  it('leaves an Orca session alone', async () => {
    const availability = await probeEngineAvailability(
      bambu({ slicer: 'orca', slicerVersion: '2.4.x', printer: singleNozzlePrinter(), nozzleIndex: 0 })
    );
    expect(availability.automatable).toBe(true);
    expect(availability.available).toBe(true);
    expect(codes(availability.reasons)).toEqual(['available']);
  });
});

// ---------------------------------------------------------------------------

describe('the default path: automatedCalibration off', () => {
  it('says no without ever touching the native bridge', async () => {
    const calls: string[] = [];
    const availability = await probeEngineAvailability({
      slicer: 'orca',
      features: FLAG_OFF,
      bridge: fakeBridge({ throwOnUse: true, calls }),
      printer: singleNozzlePrinter()
    });
    expect(availability.available).toBe(false);
    expect(availability.flagEnabled).toBe(false);
    expect(availability.desktop).toBe(false);
    expect(availability.engineId).toBeNull();
    expect(codes(availability.reasons)).toEqual(['flag-off']);
    expect(calls).toEqual([]);
  });

  it('is what an app with no persisted flags answers', async () => {
    // No `features`: the flag is read from storage, which does not exist in a
    // node process — an unreadable flag is an off flag, never an assumed yes.
    const availability = await probeEngineAvailability();
    expect(availability.available).toBe(false);
    expect(codes(availability.reasons)).toEqual(['flag-off']);
  });

  it('explains itself in sentence case, mentioning the manual path', async () => {
    const availability = await probeEngineAvailability({ features: FLAG_OFF });
    expect(availability.reasons[0].message).toMatch(/manual path/);
    expect(availability.reasons[0].severity).toBe('info');
    expect(availability.reasons[0].permanent).toBe(false);
    expect(availability.reasons[0].message).not.toMatch(/[A-Z]{4,}/);
  });

  it('answers synchronously, so a render never waits on it', () => {
    const peeked = peekEngineAvailability({ features: FLAG_OFF, bridge: fakeBridge({ throwOnUse: true }) });
    expect(peeked?.available).toBe(false);
    expect(codes(peeked?.reasons ?? [])).toEqual(['flag-off']);
  });

  it('says no for every step of an auxiliary-nozzle plan', async () => {
    const project = auxProject('orca');
    const answers = await canAutoPrepareSteps(project.stepOrder, {
      slicer: 'orca',
      features: FLAG_OFF,
      bridge: fakeBridge({ throwOnUse: true }),
      printer: dualNozzlePrinter(),
      nozzleIndex: 1
    });
    expect(answers).toHaveLength(project.stepOrder.length);
    for (const a of answers) {
      expect(a.canAutoPrepare, a.stepId).toBe(false);
      expect(a.engineId, a.stepId).toBeNull();
      expect(a.headline.length, a.stepId).toBeGreaterThan(0);
      expect(codes(a.reasons), a.stepId).toEqual(['flag-off']);
    }
  });

  it('answers manual through the session gate without touching the bridge', async () => {
    const calls: string[] = [];
    const capability = await ask(undefined, undefined, 0, 'pressure-advance', {
      features: FLAG_OFF,
      bridge: fakeBridge({ throwOnUse: true, calls })
    });
    expect(capability.mode).toBe('manual');
    expect(capability.canAutoPrepare).toBe(false);
    expect(capability.manualPathAvailable).toBe(true);
    expect(capability.engineId).toBeNull();
    expect(capability.handoff).toBeNull();
    expect(capability.flagEnabled).toBe(false);
    expect(capability.automatable).toBe(true);
    expect(capability.reasons.join(' ')).toContain('manual path');
    expect(calls).toEqual([]);
  });

  it('answers manual for every step of an auxiliary-nozzle plan', async () => {
    const project = auxProject('bambu');
    const printer = dualNozzlePrinter();
    for (const stepId of project.stepOrder) {
      const capability = await ask(project, printer, 1, stepId, {
        features: FLAG_OFF,
        bridge: fakeBridge({ throwOnUse: true })
      });
      expect(capability.mode, stepId).toBe('manual');
      expect(capability.manualPathAvailable, stepId).toBe(true);
    }
  });

  it('is what the session helper returns by default', async () => {
    const project = makeProject();
    const session = resolveGuidedSession({ project, printer: singleNozzlePrinter() });
    const capability = await sessionCapabilityFor(session, 'temperature', {
      features: FLAG_OFF,
      bridge: fakeBridge({ throwOnUse: true })
    });
    expect(capability.canAutoPrepare).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('in a browser build', () => {
  const browser = (over: Partial<EngineAvailabilityInput> = {}): EngineAvailabilityInput => ({
    slicer: 'orca',
    features: FLAG_ON,
    bridge: fakeBridge({ desktop: false }),
    ...over
  });

  it('says no because there is no desktop shell, and says so', async () => {
    const availability = await probeEngineAvailability(browser());
    expect(availability.available).toBe(false);
    expect(availability.desktop).toBe(false);
    expect(codes(availability.reasons)).toEqual(['not-desktop']);
    expect(text(availability.reasons)).toMatch(/desktop app/);
    expect(availability.reasons[0].severity).toBe('info');
    // Fixable: running the desktop build changes this answer.
    expect(availability.reasons[0].permanent).toBe(false);
  });

  it('does not go looking for engines it cannot reach', async () => {
    const calls: string[] = [];
    await probeEngineAvailability(browser({ bridge: fakeBridge({ desktop: false, calls }) }));
    expect(calls).not.toContain('detectSlicingEngine');
  });

  it('is the answer with no bridge injected at all, since node is not Tauri', async () => {
    const availability = await probeEngineAvailability({ features: FLAG_ON });
    expect(availability.desktop).toBe(false);
    expect(codes(availability.reasons)).toEqual(['not-desktop']);
  });

  it('still lets every step fall back to the manual path', async () => {
    const answer = await canAutoPrepareStep('pressure-advance', browser());
    expect(answer.canAutoPrepare).toBe(false);
    expect(answer.headline).toMatch(/manual path/);
  });

  it('stays manual through the session gate', async () => {
    const capability = await ask(undefined, undefined, 0, 'pressure-advance', {
      features: FLAG_ON,
      bridge: fakeBridge({ desktop: false })
    });
    expect(capability.mode).toBe('manual');
    expect(capability.desktop).toBe(false);
    expect(capability.reasons.join(' ')).toContain('desktop app');
  });
});

// ---------------------------------------------------------------------------

describe('on the desktop with no usable engine', () => {
  it('names Orca Slicer when nothing is installed', async () => {
    const availability = await probeEngineAvailability({
      slicer: 'orca',
      features: FLAG_ON,
      bridge: fakeBridge({ desktop: true, detected: false })
    });
    expect(availability.available).toBe(false);
    expect(availability.desktop).toBe(true);
    expect(codes(availability.reasons)).toEqual(['no-engine']);
    expect(text(availability.reasons)).toMatch(/Orca ?Slicer/);
  });

  it('never counts manual export as automation', async () => {
    const availability = await probeEngineAvailability({
      features: FLAG_ON,
      bridge: fakeBridge({ desktop: true, detected: false })
    });
    expect(availability.engineId).toBeNull();
    expect(availability.available).toBe(false);
  });

  it('stays manual with no hand-off through the session gate', async () => {
    const capability = await ask(undefined, undefined, 0, 'pressure-advance', {
      features: FLAG_ON,
      bridge: fakeBridge({ desktop: true, detected: false, valid: false })
    });
    expect(capability.mode).toBe('manual');
    expect(capability.canAutoPrepare).toBe(false);
    expect(capability.handoff).toBeNull();
  });

  it('reports an installation that failed validation as caution, in its own words', async () => {
    const availability = await probeEngineAvailability({
      features: FLAG_ON,
      bridge: fakeBridge({
        desktop: true,
        detected: true,
        valid: false,
        errors: ['resources/calib is missing from this installation.']
      })
    });
    expect(codes(availability.reasons)).toEqual(['engine-unusable']);
    expect(availability.reasons[0].severity).toBe('caution');
    expect(text(availability.reasons)).toMatch(/could not be validated/);
    expect(text(availability.reasons)).toContain('resources/calib is missing');
  });

  it('says no when the engine cannot slice, however well it validates', async () => {
    const availability = await probeEngineAvailability({
      features: FLAG_ON,
      bridge: fakeBridge(workingEngine({ capabilities: CAPS({ slice: false }) }))
    });
    expect(availability.available).toBe(false);
    expect(availability.engineId).toBeNull();
    expect(codes(availability.reasons)).toEqual(['engine-unusable']);
    expect(text(availability.reasons)).toMatch(/can slice a project/);
  });
});

// ---------------------------------------------------------------------------

describe('nozzle honesty on a dual-nozzle machine', () => {
  const x2d = (nozzleIndex: number, caps: Partial<RawEngineCapabilities> = {}): EngineAvailabilityInput => ({
    slicer: 'orca',
    features: FLAG_ON,
    printer: dualNozzlePrinter(),
    nozzleIndex,
    bridge: fakeBridge(workingEngine({ capabilities: CAPS(caps) }))
  });

  it('refuses the auxiliary nozzle when the engine cannot target an extruder', async () => {
    const availability = await probeEngineAvailability(x2d(1));
    expect(availability.available).toBe(false);
    expect(codes(availability.reasons)).toEqual(['nozzle-unsupported']);
    expect(availability.nozzleSupport.supported).toBe(false);
    expect(availability.nozzleCount).toBe(2);
    expect(text(availability.reasons)).toMatch(/2 nozzles/);
    expect(text(availability.reasons)).toMatch(/nozzle 2/);
  });

  it('refuses the MAIN nozzle too, because the machine preset is per-extruder', async () => {
    const availability = await probeEngineAvailability(x2d(0));
    expect(availability.available).toBe(false);
    expect(codes(availability.reasons)).toEqual(['nozzle-unsupported']);
  });

  it('allows it only once the engine reports proven multi-extruder support', async () => {
    const availability = await probeEngineAvailability(x2d(1, { multi_extruder: true }));
    expect(availability.available).toBe(true);
    expect(availability.engineId).toBe('installed_orca');
    expect(availability.nozzleSupport.supported).toBe(true);
    expect(codes(availability.reasons)).toEqual(['available']);
  });

  it('refuses a nozzle the printer does not have, in the printer own words', async () => {
    const availability = await probeEngineAvailability(x2d(5, { multi_extruder: true }));
    expect(availability.available).toBe(false);
    expect(codes(availability.reasons)).toEqual(['nozzle-unsupported']);
    expect(text(availability.reasons)).toMatch(/2 nozzle/);
    expect(text(availability.reasons)).toMatch(/nozzle 6 is not one of them/);
  });

  it('keeps the two nozzles answers apart rather than reusing one probe', async () => {
    const bridge = fakeBridge(workingEngine({ capabilities: CAPS({ multi_extruder: true }) }));
    const printer = dualNozzlePrinter();
    const main = await probeEngineAvailability({ features: FLAG_ON, printer, nozzleIndex: 0, bridge });
    const aux = await probeEngineAvailability({ features: FLAG_ON, printer, nozzleIndex: 1, bridge });
    expect(main.nozzleIndex).toBe(0);
    expect(aux.nozzleIndex).toBe(1);
    expect(aux.reasons[0].message).toMatch(/nozzle 2/);
    expect(main.reasons[0].message).toMatch(/nozzle 1/);
  });

  it('is not confused by a single-nozzle printer, which needs no extruder targeting', async () => {
    const availability = await probeEngineAvailability({
      features: FLAG_ON,
      printer: singleNozzlePrinter(),
      bridge: fakeBridge(workingEngine())
    });
    expect(availability.available).toBe(true);
    expect(availability.nozzleCount).toBe(1);
  });

  it('refuses to promise a session automation for a nozzle the engine cannot serve', async () => {
    const project = auxProject('orca');
    const capability = await ask(project, dualNozzlePrinter(), 1, 'pressure-advance', {
      features: FLAG_ON,
      bridge: fakeBridge(workingEngine({ capabilities: CAPS({ multi_extruder: false }) }))
    });
    expect(capability.mode).toBe('manual');
    expect(capability.canAutoPrepare).toBe(false);
    expect(capability.nozzleSupport?.supported).toBe(false);
    expect(capability.reasons.join(' ')).toMatch(/nozzle/i);
  });

  it('allows the session once the engine reports proven multi-extruder support', async () => {
    const project = auxProject('orca');
    const capability = await ask(project, dualNozzlePrinter(), 1, 'pressure-advance', {
      features: FLAG_ON,
      bridge: fakeBridge(workingEngine({ capabilities: CAPS({ multi_extruder: true }) }))
    });
    expect(capability.mode).toBe('assisted');
    expect(capability.handoff?.nozzleIndex).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('per-step answers', () => {
  const desktopOrca = (over: FakeBridgeOptions = {}): EngineAvailabilityInput => ({
    slicer: 'orca',
    features: FLAG_ON,
    printer: singleNozzlePrinter(),
    bridge: fakeBridge(workingEngine(over))
  });

  it('offers auto-preparation for a step whose test is a complete project', async () => {
    const answer = await canAutoPrepareStep('pressure-advance', desktopOrca());
    expect(answer.canAutoPrepare).toBe(true);
    expect(answer.engineId).toBe('installed_orca');
    expect(codes(answer.reasons)).toEqual(['available']);
    expect(answer.headline).toMatch(/Installed OrcaSlicer/);
  });

  it('never claims to prepare a checklist step, even with a perfect engine', async () => {
    const answer = await canAutoPrepareStep('ooze-control', desktopOrca());
    expect(answer.canAutoPrepare).toBe(false);
    expect(codes(answer.reasons)).toEqual(['step-not-sliced']);
    expect(answer.headline).toMatch(/checklist/);
    // Nothing the user installs turns a checklist into a sliced test.
    expect(answer.reasons[0].permanent).toBe(true);
  });

  it('says no for a test whose model still needs its parameters generated', async () => {
    const answer = await canAutoPrepareStep('temperature', desktopOrca());
    expect(answer.canAutoPrepare).toBe(false);
    expect(codes(answer.reasons)).toEqual(['step-unsupported']);
    expect(answer.headline).toMatch(/manual path/);
  });

  it('says no when the engine cannot export g-code', async () => {
    const answer = await canAutoPrepareStep(
      'pressure-advance',
      desktopOrca({ capabilities: CAPS({ export_gcode: false }) })
    );
    expect(answer.canAutoPrepare).toBe(false);
    expect(codes(answer.reasons)).toEqual(['step-unsupported']);
    expect(answer.headline).toMatch(/g-code/);
  });

  it('says no when the test model cannot be located in an allowed place', async () => {
    // Validated engine, but no executable path — so no resources root, and the
    // model is one PerfectFit is not allowed to redistribute.
    const answer = await canAutoPrepareStep('pressure-advance', desktopOrca({ executablePath: null }));
    expect(answer.canAutoPrepare).toBe(false);
    expect(codes(answer.reasons)).toEqual(['asset-unavailable']);
    expect(answer.headline).toMatch(/Orca ?Slicer installation/);
  });

  it('carries the machine-level no through to every step, unchanged', async () => {
    const answers = await canAutoPrepareSteps(['temperature', 'pressure-advance', 'retraction'], {
      features: FLAG_ON,
      bridge: fakeBridge({ desktop: true, detected: false })
    });
    for (const a of answers) {
      expect(a.canAutoPrepare, a.stepId).toBe(false);
      expect(codes(a.reasons), a.stepId).toEqual(['no-engine']);
    }
  });

  it('only ever promises what the engine layer can actually assemble today', async () => {
    // The engine accepts a complete project template and rejects everything
    // else. If that widens, this list widens with it — deliberately, not by
    // accident.
    expect(PREPARABLE_ASSET_TYPES).toEqual(['project-template']);
    const availability = await probeEngineAvailability(desktopOrca());
    const preparable = (Object.keys(CALIBRATION_ASSETS) as CalibrationId[])
      .filter((id) => stepAutoPrepareFrom(availability, id).canAutoPrepare);
    expect(preparable).toEqual(['pressure-advance']);
  });

  it('derives step answers purely, with no further probing', async () => {
    const calls: string[] = [];
    const bridge = fakeBridge(workingEngine({ calls }));
    const availability = await probeEngineAvailability({ features: FLAG_ON, bridge, printer: singleNozzlePrinter() });
    const before = calls.length;
    for (const id of ['temperature', 'pressure-advance', 'ooze-control'] as const) {
      stepAutoPrepareFrom(availability, id);
    }
    expect(calls.length).toBe(before);
  });

  it('never claims to prepare a checklist step through the session gate', async () => {
    const project = auxProject('orca');
    const capability = await ask(project, dualNozzlePrinter(), 1, 'ooze-control', {
      features: FLAG_ON,
      bridge: fakeBridge(workingEngine({ capabilities: CAPS({ multi_extruder: true }) }))
    });
    expect(capability.mode).toBe('manual');
    expect(capability.reasons.join(' ')).toContain('checklist');
  });
});

// ---------------------------------------------------------------------------

describe('the session-shaped answer the guided screen consumes', () => {
  it('offers auto-preparation with a typed hand-off when an engine is real', async () => {
    const capability = await ask(undefined, undefined, 0, 'pressure-advance', {
      features: FLAG_ON,
      bridge: fakeBridge(workingEngine())
    });
    expect(capability.mode).toBe('assisted');
    expect(capability.canAutoPrepare).toBe(true);
    expect(capability.engineId).toBe('installed_orca');
    expect(capability.manualPathAvailable).toBe(true);
    expect(capability.automatable).toBe(true);
    expect(capability.handoff).toEqual({
      engineId: 'installed_orca',
      projectId: expect.any(String),
      stepId: 'pressure-advance',
      nozzleIndex: 0,
      inputFingerprint: expect.any(String)
    });
  });

  it('keeps the plain sentences and their codes in step with each other', async () => {
    const capability = await ask(undefined, undefined, 0, 'temperature', {
      features: FLAG_ON,
      bridge: fakeBridge(workingEngine())
    });
    expect(capability.reasons).toEqual(capability.reasonDetails.map((r) => r.message));
    expect(capability.headline).toBe(capability.reasons[0]);
    expect(capability.reasonDetails[0].code).toBe('step-unsupported');
  });

  it('answers from the cache synchronously once the probe has run', async () => {
    const project = makeProject();
    const printer = singleNozzlePrinter();
    const ctx = buildValueContext({ project, printer, nozzleIndex: 0 });
    const nozzle = resolveSessionNozzle(project, printer, 0);
    const opts = { features: FLAG_ON, bridge: fakeBridge(workingEngine()) };

    expect(peekSessionCapability(ctx, nozzle, 'pressure-advance', opts)).toBeNull();
    await resolveSessionCapability(ctx, nozzle, 'pressure-advance', opts);
    const peeked = peekSessionCapability(ctx, nozzle, 'pressure-advance', opts);
    expect(peeked?.canAutoPrepare).toBe(true);
    expect(peeked?.handoff?.engineId).toBe('installed_orca');
  });

  it('falls back to manual when engine detection blows up', async () => {
    const broken = fakeBridge({ desktop: true });
    broken.isDesktop = () => {
      throw new Error('bridge exploded');
    };
    const capability = await ask(undefined, undefined, 0, 'pressure-advance', {
      features: FLAG_ON,
      bridge: broken
    });
    expect(capability.mode).toBe('manual');
    expect(capability.canAutoPrepare).toBe(false);
    expect(capability.reasons.join(' ')).toContain('bridge exploded');
  });
});

// ---------------------------------------------------------------------------

describe('caching, so a render never hits the filesystem', () => {
  const detects = (calls: string[]): number => calls.filter((c) => c === 'detectSlicingEngine').length;

  it('probes once and serves the rest of the session from memory', async () => {
    const calls: string[] = [];
    const input: EngineAvailabilityInput = {
      features: FLAG_ON,
      printer: singleNozzlePrinter(),
      bridge: fakeBridge(workingEngine({ calls }))
    };
    const first = await probeEngineAvailability(input);
    const second = await probeEngineAvailability(input);
    expect(detects(calls)).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.available).toBe(first.available);
  });

  it('shares one probe between callers that ask at the same moment', async () => {
    const calls: string[] = [];
    const input: EngineAvailabilityInput = {
      features: FLAG_ON,
      printer: singleNozzlePrinter(),
      bridge: fakeBridge(workingEngine({ calls }))
    };
    const answers = await Promise.all([
      probeEngineAvailability(input),
      probeEngineAvailability(input),
      probeEngineAvailability(input)
    ]);
    expect(detects(calls)).toBe(1);
    expect(answers.every((a) => a.available)).toBe(true);
  });

  it('answers a whole plan from a single probe', async () => {
    const calls: string[] = [];
    const project = auxProject('orca');
    await canAutoPrepareSteps(project.stepOrder, {
      features: FLAG_ON,
      printer: dualNozzlePrinter(),
      nozzleIndex: 1,
      bridge: fakeBridge(workingEngine({ calls, capabilities: CAPS({ multi_extruder: true }) }))
    });
    expect(detects(calls)).toBe(1);
  });

  it('costs one probe however many times the step screen redraws', async () => {
    // The bug this consolidation fixes: the guided step screen asks once per
    // draw, and the wired gate used to rediscover engines on every call.
    const calls: string[] = [];
    const project = makeProject();
    const printer = singleNozzlePrinter();
    const ctx = buildValueContext({ project, printer, nozzleIndex: 0 });
    const nozzle = resolveSessionNozzle(project, printer, 0);
    const opts = { features: FLAG_ON, bridge: fakeBridge(workingEngine({ calls })) };

    for (let draw = 0; draw < 12; draw += 1) {
      await resolveSessionCapability(ctx, nozzle, 'pressure-advance', opts);
    }
    expect(detects(calls)).toBe(1);
  });

  it('can be read synchronously once probed, and is null before that', async () => {
    const bridge = fakeBridge(workingEngine());
    const input: EngineAvailabilityInput = { features: FLAG_ON, printer: singleNozzlePrinter(), bridge };
    expect(peekEngineAvailability(input)).toBeNull();
    await probeEngineAvailability(input);
    const peeked = peekEngineAvailability(input);
    expect(peeked?.available).toBe(true);
    expect(peeked?.cached).toBe(true);
  });

  it('re-probes on demand, for "I just installed it"', async () => {
    const calls: string[] = [];
    const input: EngineAvailabilityInput = {
      features: FLAG_ON,
      printer: singleNozzlePrinter(),
      bridge: fakeBridge(workingEngine({ calls }))
    };
    await probeEngineAvailability(input);
    await probeEngineAvailability({ ...input, refresh: true });
    expect(detects(calls)).toBe(2);
  });

  it('re-probes after the cache is invalidated', async () => {
    const calls: string[] = [];
    const input: EngineAvailabilityInput = {
      features: FLAG_ON,
      printer: singleNozzlePrinter(),
      bridge: fakeBridge(workingEngine({ calls }))
    };
    await probeEngineAvailability(input);
    invalidateEngineAvailability(input.bridge);
    await probeEngineAvailability(input);
    expect(detects(calls)).toBe(2);
  });

  it('lets a cached answer go stale rather than pretending forever', async () => {
    const calls: string[] = [];
    const input: EngineAvailabilityInput = {
      features: FLAG_ON,
      printer: singleNozzlePrinter(),
      bridge: fakeBridge(workingEngine({ calls })),
      now: 1_000_000
    };
    await probeEngineAvailability(input);
    await probeEngineAvailability({ ...input, now: 1_000_000 + ENGINE_PROBE_TTL_MS + 1 });
    expect(detects(calls)).toBe(2);
  });

  it('never lets one nozzle answer stand in for another', async () => {
    const calls: string[] = [];
    const printer = dualNozzlePrinter();
    const bridge = fakeBridge(workingEngine({ calls, capabilities: CAPS({ multi_extruder: true }) }));
    await probeEngineAvailability({ features: FLAG_ON, printer, nozzleIndex: 0, bridge });
    await probeEngineAvailability({ features: FLAG_ON, printer, nozzleIndex: 1, bridge });
    expect(detects(calls)).toBe(2);
  });

  it('never lets one machine answer leak into a different bridge', async () => {
    const first: string[] = [];
    const second: string[] = [];
    await probeEngineAvailability({ features: FLAG_ON, bridge: fakeBridge(workingEngine({ calls: first })) });
    await probeEngineAvailability({ features: FLAG_ON, bridge: fakeBridge(workingEngine({ calls: second })) });
    expect(detects(first)).toBe(1);
    expect(detects(second)).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('a probe failure is a no with a reason, never a throw', () => {
  it('survives a desktop check that explodes', async () => {
    const bridge = fakeBridge({ desktop: true });
    bridge.isDesktop = () => {
      throw new Error('bridge exploded');
    };
    const availability = await probeEngineAvailability({ features: FLAG_ON, bridge });
    expect(availability.available).toBe(false);
    expect(codes(availability.reasons)).toEqual(['probe-failed']);
    expect(availability.reasons[0].severity).toBe('caution');
    expect(text(availability.reasons)).toContain('bridge exploded');
  });

  it('survives engine discovery that explodes half way through', async () => {
    const bridge = fakeBridge(workingEngine());
    let calls = 0;
    bridge.isDesktop = () => {
      calls += 1;
      if (calls > 1) throw new Error('registry exploded');
      return true;
    };
    const availability = await probeEngineAvailability({ features: FLAG_ON, bridge });
    expect(availability.available).toBe(false);
    expect(codes(availability.reasons)).toEqual(['probe-failed']);
    expect(text(availability.reasons)).toContain('registry exploded');
  });

  it('does not cache a failure — the next probe tries again', async () => {
    let broken = true;
    const calls: string[] = [];
    const bridge = fakeBridge(workingEngine({ calls }));
    const realIsDesktop = bridge.isDesktop;
    bridge.isDesktop = () => {
      if (broken) throw new Error('transient');
      return realIsDesktop();
    };
    const input: EngineAvailabilityInput = { features: FLAG_ON, printer: singleNozzlePrinter(), bridge };
    expect((await probeEngineAvailability(input)).available).toBe(false);
    broken = false;
    expect((await probeEngineAvailability(input)).available).toBe(true);
    expect(calls.filter((c) => c === 'detectSlicingEngine').length).toBe(1);
  });

  it('still answers every step, on the manual path', async () => {
    const bridge = fakeBridge({ desktop: true });
    bridge.isDesktop = () => {
      throw new Error('bridge exploded');
    };
    const answer = await canAutoPrepareStep('pressure-advance', { features: FLAG_ON, bridge });
    expect(answer.canAutoPrepare).toBe(false);
    expect(answer.reasons.length).toBeGreaterThan(0);
    expect(answer.headline).toContain('bridge exploded');
  });
});
