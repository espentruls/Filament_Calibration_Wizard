import { describe, it, expect } from 'vitest';
import { confidenceScore } from '../src/logic/confidence';
import { recommendationsForProject } from '../src/logic/recommendations';
import { suggestPaRange, suggestRetractionRange, suggestTempRange, suggestFlowMethodDefaults, resolveNozzle, nozzleBadgeLabel } from '../src/logic/ranges';
import { validateTestRange } from '../src/logic/validation';
import { getMaterial } from '../src/data/materials';
import { DEFAULT_ORDER, CALIBRATIONS } from '../src/data/calibrations';
import { getSlicerContent } from '../src/data/slicers';
import type { CalibrationProject, CalibrationId, CalibrationStepState, PrinterProfile } from '../src/types';

function baseProject(): CalibrationProject {
  const steps = {} as Record<CalibrationId, CalibrationStepState>;
  for (const id of DEFAULT_ORDER) steps[id] = { status: 'not-started', current: null, history: [] };
  return {
    id: 'p', createdAt: '', updatedAt: '', calibrationDate: '2026-07-18',
    filament: { manufacturer: 'M', productLine: '', material: 'PLA', color: '', diameter: 1.75, startingProfile: '' },
    printerProfileId: 'pr', nozzleType: 'brass',
    slicer: { slicer: 'orca', version: '2.4.x' },
    notes: '', mode: 'coach', stepOrder: [...DEFAULT_ORDER], steps,
    timeline: [], archived: false, finals: {}
  };
}

function complete(p: CalibrationProject, id: CalibrationId, conf: 'low' | 'medium' | 'high' = 'high',
  extras: Partial<NonNullable<CalibrationStepState['current']>> = {}): void {
  p.steps[id] = {
    status: 'completed',
    current: {
      id: 'a', startedAt: '2026-07-18T00:00:00Z', settings: {}, result: {}, computed: {},
      prerequisitesConfirmed: [], notes: '', photoIds: [], confidence: conf, ...extras
    },
    history: [], confidence: conf
  };
}

describe('confidence score', () => {
  it('is 0 for an empty project and 100 when everything is done at high confidence', () => {
    const p = baseProject();
    expect(confidenceScore(p).score).toBe(0);
    for (const id of DEFAULT_ORDER) complete(p, id, 'high');
    expect(confidenceScore(p).score).toBe(100);
  });

  it('low-confidence and retest-flagged results earn less', () => {
    const a = baseProject(); complete(a, 'temperature', 'high');
    const b = baseProject(); complete(b, 'temperature', 'low');
    expect(confidenceScore(b).score).toBeLessThan(confidenceScore(a).score);
    const c = baseProject(); complete(c, 'temperature', 'high');
    c.steps.temperature.retestRecommended = true;
    expect(confidenceScore(c).score).toBeLessThan(confidenceScore(a).score);
  });

  it('skipped steps contribute nothing', () => {
    const p = baseProject();
    p.steps.retraction.status = 'skipped';
    expect(confidenceScore(p).parts.find(x => x.step === 'retraction')!.earned).toBe(0);
  });

  it('scores against the project\'s own step plan — ooze-control counts only when carried', () => {
    const legacy = baseProject();
    for (const id of DEFAULT_ORDER) complete(legacy, id, 'high');
    expect(confidenceScore(legacy).score).toBe(100); // legacy projects unaffected by the optional step

    const aux = baseProject();
    aux.stepOrder = [...DEFAULT_ORDER.slice(0, -1), 'ooze-control', 'final-verification'];
    aux.steps['ooze-control'] = { status: 'not-started', current: null, history: [] };
    for (const id of DEFAULT_ORDER) complete(aux, id, 'high');
    expect(confidenceScore(aux).score).toBeLessThan(100);
    complete(aux, 'ooze-control', 'high');
    expect(confidenceScore(aux).score).toBe(100);
  });
});

describe('smart recommendations', () => {
  it('persistent stringing at max retraction → revisit temperature', () => {
    const p = baseProject();
    complete(p, 'retraction', 'medium', { result: { stillStringyAtMax: true } });
    const recs = recommendationsForProject(p);
    expect(recs.some(r => r.targetStep === 'temperature')).toBe(true);
  });

  it('temperature chosen at range edge → suggest retest', () => {
    const p = baseProject();
    complete(p, 'temperature', 'medium', {
      settings: { start: 230, end: 210, step: 5 },
      computed: { normalTemp: 230 }
    });
    const recs = recommendationsForProject(p);
    expect(recs.some(r => r.targetStep === 'temperature' && r.reason.includes('edge'))).toBe(true);
  });

  it('failed verification categories produce ranked causes', () => {
    const p = baseProject();
    complete(p, 'final-verification', 'medium', {
      result: { 'cat-corners': 'needs-adjustment' }
    });
    const recs = recommendationsForProject(p);
    expect(recs[0].targetStep).toBe('pressure-advance'); // top-ranked cause for corners
  });

  it('extreme pass-2 modifier → re-run pass 1', () => {
    const p = baseProject();
    complete(p, 'flow-pass2', 'medium', { result: { modifier: -9 } });
    expect(recommendationsForProject(p).some(r => r.targetStep === 'flow-pass1')).toBe(true);
  });
});

describe('range suggestions', () => {
  const printer: PrinterProfile = {
    id: 'x', name: 'X', manufacturer: '', nozzleDiameter: 0.4,
    maxNozzleTemp: 260, maxBedTemp: 100, extruderType: 'direct',
    retractionRange: { start: 0, end: 2 }, notes: '', createdAt: '', updatedAt: ''
  };

  it('temp range is clamped to printer max with a warning', () => {
    const s = suggestTempRange('PC', printer); // PC wants 310→260
    expect(s.start).toBe(260);
    expect(s.end).toBe(240); // tower must keep a usable descending span after clamping
    expect(s.step).toBe(5);
    expect(s.warnings.length).toBeGreaterThan(0);
    expect(validateTestRange(s.start, s.end, s.step).filter(i => i.level === 'error')).toHaveLength(0);
  });

  it('clamped temp tower keeps a ≥20 °C span on a hotter printer too', () => {
    const hot: PrinterProfile = { ...printer, maxNozzleTemp: 300 };
    const s = suggestTempRange('PPS', hot); // PPS wants 340→300
    expect(s.start).toBe(300);
    expect(s.end).toBe(280);
  });

  it('PA ranges differ by extruder and flexibility', () => {
    const dd = suggestPaRange('direct', getMaterial('PLA'));
    const bowden = suggestPaRange('bowden', getMaterial('PLA'));
    const flex = suggestPaRange('direct', getMaterial('TPU'));
    expect(bowden.end).toBeGreaterThan(dd.end);
    expect(flex.end).toBeGreaterThan(dd.end);
  });

  it('bowden wins the PA range for flexible filament, keeping the flexible warning', () => {
    const s = suggestPaRange('bowden', getMaterial('TPU'));
    expect(s.end).toBe(1.0);
    expect(s.warnings.join(' ')).toMatch(/flexible/i);
  });

  it('retraction suggestions respect flexible filament', () => {
    const s = suggestRetractionRange('direct', getMaterial('TPU'));
    expect(s.end).toBeLessThanOrEqual(2);
    expect(s.warnings.join(' ')).toMatch(/jam|flexible/i);
  });

  it('printer retraction override cannot raise the end above the flexible-safe cap', () => {
    const wide: PrinterProfile = { ...printer, retractionRange: { start: 1, end: 6 } };
    const s = suggestRetractionRange('direct', getMaterial('TPU'), wide);
    expect(s.end).toBeLessThanOrEqual(1.5);
    expect(s.warnings.join(' ')).toMatch(/jam|flexible/i);
  });

  it('flow method modifiers match slicer behavior', () => {
    expect(suggestFlowMethodDefaults('yolo').modifiers).toHaveLength(11);   // eleven blocks
    expect(suggestFlowMethodDefaults('pass1').modifiers).toHaveLength(9);   // nine blocks
    expect(suggestFlowMethodDefaults('pass2').modifiers).toEqual([-9, -8, -7, -6, -5, -4, -3, -2, -1, 0]);
  });
});

describe('nozzle-aware suggestions (dual-nozzle / X2D)', () => {
  const printer: PrinterProfile = {
    id: 'x2d', name: 'Bambu Lab X2D', manufacturer: 'Bambu Lab', nozzleDiameter: 0.4,
    maxNozzleTemp: 300, maxBedTemp: 100, extruderType: 'direct',
    retractionRange: { start: 0, end: 2 }, notes: '', createdAt: '', updatedAt: '',
    nozzles: [
      { label: 'Main (direct drive)', feed: 'direct' },
      { label: 'Auxiliary (bowden)', feed: 'bowden', maxSpeed: 200, maxAccel: 1000 }
    ]
  };

  it('resolves the project nozzle and effective feed', () => {
    expect(resolveNozzle({ nozzleIndex: 1 }, printer).feed).toBe('bowden');
    expect(resolveNozzle({ nozzleIndex: 1 }, printer).nozzle?.label).toBe('Auxiliary (bowden)');
    expect(resolveNozzle({}, printer).feed).toBe('direct'); // default = main nozzle
    // Legacy single-nozzle profile falls back to the printer's extruder type.
    const legacy: PrinterProfile = { ...printer, nozzles: undefined, extruderType: 'bowden' };
    expect(resolveNozzle({ nozzleIndex: 1 }, legacy).feed).toBe('bowden');
    expect(resolveNozzle({}, undefined).feed).toBe('direct');
  });

  it('aux/bowden nozzle gets the remote-extruder PA range with aux-specific warnings', () => {
    const aux = resolveNozzle({ nozzleIndex: 1 }, printer);
    const s = suggestPaRange(aux.feed, getMaterial('PETG'), false, aux.nozzle);
    expect(s.start).toBe(0);
    expect(s.end).toBe(1.0);
    expect(s.step).toBe(0.02);
    const text = s.warnings.join(' ');
    expect(text).toMatch(/0\.5 and 1\.0/);
    expect(text).toMatch(/MAIN hotend only/i);
  });

  it('main nozzle keeps direct-drive PA behavior', () => {
    const main = resolveNozzle({ nozzleIndex: 0 }, printer);
    const s = suggestPaRange(main.feed, getMaterial('PETG'), false, main.nozzle);
    expect(s.end).toBe(0.1);
    expect(s.step).toBe(0.002);
  });

  it('aux nozzle retraction suggests 2–6 step 0.5 and skips the main-path profile range', () => {
    const aux = resolveNozzle({ nozzleIndex: 1 }, printer);
    const s = suggestRetractionRange(aux.feed, getMaterial('PETG'), printer, aux.nozzle);
    expect(s.start).toBe(2);
    expect(s.end).toBe(6);
    expect(s.step).toBe(0.5);
    expect(s.warnings.join(' ')).toMatch(/10404/);
    // The saved profile range (0–2, main path) must not clobber the aux suggestion.
    expect(s.warnings.join(' ')).not.toMatch(/printer profile/);
  });

  it('flexible filament on the aux nozzle warns it is not rated for flexibles', () => {
    const aux = resolveNozzle({ nozzleIndex: 1 }, printer);
    const s = suggestRetractionRange(aux.feed, getMaterial('TPU'), printer, aux.nozzle);
    expect(s.end).toBeLessThanOrEqual(1.5); // flexible-safe cap still wins
    expect(s.warnings.join(' ')).toMatch(/not rated for flexible/i);
  });

  it('clamps the start when the flexible cap pulls the end below the profile start', () => {
    const wide: PrinterProfile = { ...printer, nozzles: undefined, retractionRange: { start: 2, end: 6 } };
    const s = suggestRetractionRange('direct', getMaterial('TPU'), wide);
    expect(s.end).toBeLessThanOrEqual(1.5);
    expect(s.start).toBeLessThan(s.end); // never a descending/empty suggestion
  });

  it('nozzle badge label resolves through the printer profile', () => {
    expect(nozzleBadgeLabel({ nozzleIndex: 1 }, printer)).toBe('Auxiliary (bowden)');
    expect(nozzleBadgeLabel({ nozzleIndex: 0 }, printer)).toBe('Main (direct drive)');
    expect(nozzleBadgeLabel({}, printer)).toBeNull();
    expect(nozzleBadgeLabel({ nozzleIndex: 1 }, undefined)).toBe('Nozzle 2'); // printer deleted
    expect(nozzleBadgeLabel({ nozzleIndex: 0 }, undefined)).toBeNull();
  });
});

describe('calibration definitions integrity', () => {
  it('every step in the default order has a definition with required fields', () => {
    for (const id of DEFAULT_ORDER) {
      const def = CALIBRATIONS[id];
      expect(def).toBeDefined();
      expect(def.purpose.length).toBeGreaterThan(20);
      expect(def.methods.length).toBeGreaterThan(0);
      expect(def.slicerDestination.note.length).toBeGreaterThan(0);
    }
  });

  it('dependencies only reference earlier steps in the default order', () => {
    for (const id of DEFAULT_ORDER) {
      const def = CALIBRATIONS[id];
      for (const dep of def.dependencies) {
        expect(DEFAULT_ORDER.indexOf(dep)).toBeLessThan(DEFAULT_ORDER.indexOf(id));
      }
    }
  });

  it('Bambu Studio Developer mode guidance covers all affected coached steps', () => {
    const bambu = getSlicerContent('bambu', '1.7+');
    expect(bambu.calibrationMenuPath).toMatch(/Developer mode/i);

    const developerModeSteps: CalibrationId[] = [
      'temperature',
      'flow-pass1',
      'flow-pass2',
      'pressure-advance',
      'retraction',
      'max-volumetric-speed'
    ];

    for (const id of developerModeSteps) {
      const instructions = bambu.perTest[id];
      expect(instructions, id).toBeDefined();
      expect(instructions?.available, id).toBe(true);
      expect(instructions?.builtIn, id).toBe(true);
      const text = [
        instructions?.menuPath,
        ...(instructions?.steps ?? []),
        ...(instructions?.gotchas ?? [])
      ].join(' ');
      expect(text, id).toMatch(/Developer mode/i);
      expect(text, id).toMatch(/non–Bambu-Lab printer profile/i);
    }
  });

  it('Bambu Studio flow guidance distinguishes coarse/fine from Orca YOLO and notes VFA exposure', () => {
    const bambu = getSlicerContent('bambu', '1.7+');
    const flowText = [
      ...(bambu.perTest['flow-pass1']?.steps ?? []),
      ...(bambu.perTest['flow-pass2']?.steps ?? [])
    ].join(' ');
    expect(flowText).toMatch(/coarse/i);
    expect(flowText).toMatch(/fine/i);
    expect(flowText).toMatch(/no YOLO/i);

    const maxFlowText = [
      ...(bambu.perTest['max-volumetric-speed']?.steps ?? []),
      ...(bambu.perTest['max-volumetric-speed']?.gotchas ?? [])
    ].join(' ');
    expect(maxFlowText).toMatch(/Max Flow Rate/i);
    expect(maxFlowText).toMatch(/VFA/i);
  });

  it('ooze-control is a fully defined optional step, outside the default order', () => {
    expect(DEFAULT_ORDER).not.toContain('ooze-control');
    const def = CALIBRATIONS['ooze-control'];
    expect(def).toBeDefined();
    expect(def.purpose.length).toBeGreaterThan(20);
    expect(def.methods.length).toBeGreaterThan(0);
    expect(def.slicerDestination.note.length).toBeGreaterThan(0);
    for (const slicer of ['orca', 'bambu'] as const) {
      const inst = getSlicerContent(slicer).perTest['ooze-control'];
      expect(inst, slicer).toBeDefined();
      expect(inst!.available, slicer).toBe(true);
      expect(inst!.steps.length, slicer).toBeGreaterThan(2);
    }
    const bambu = getSlicerContent('bambu').perTest['ooze-control']!;
    const text = [...bambu.steps, ...(bambu.gotchas ?? []), bambu.saveTo.note].join(' ');
    expect(text).toMatch(/10404/);
    expect(text).toMatch(/prime tower/i);
    expect(text).toMatch(/M104 S0/);
    expect(text).toMatch(/160–180/);
    expect(text).toMatch(/Bowden Extruder/);
  });

  it('Bambu dual-nozzle guidance covers nozzle selection, the "Off" gear, and the K scale warning', () => {
    const bambu = getSlicerContent('bambu');
    const pa = bambu.perTest['pressure-advance']!;
    const paText = [...pa.steps, ...(pa.gotchas ?? []), pa.saveTo.note].join(' ');
    expect(paText).toMatch(/nozzle selector/i);
    expect(paText).toMatch(/"Off"/);
    expect(paText).toMatch(/intentionally HIGHER/);
    expect(paText).toMatch(/MAIN hotend only/i);
    expect(paText).toMatch(/stored ON THE PRINTER/i);
    const retr = bambu.perTest.retraction!;
    const rText = [...retr.steps, ...(retr.gotchas ?? []), retr.saveTo.note].join(' ');
    expect(rText).toMatch(/10404/);
    expect(rText).toMatch(/Bowden Extruder/);
    expect(rText).toMatch(/0\.8 mm/);
  });
});
