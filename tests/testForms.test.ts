import { describe, expect, it } from 'vitest';
import {
  CONTROLLERS, flexibleRetractionEntryIssues, temperatureEntryIssues, type TestCtx
} from '../src/ui/testForms';
import { FLEXIBLE_RETRACTION_MAX_MM, flexibleRetractionCaution } from '../src/logic/ranges';
import { FLEXIBLE_RETRACTION_MAX_MM as VALIDATION_FLEXIBLE_CAP } from '../src/slicerIntegration/validation';
import { getMaterial } from '../src/data/materials';
import type { CalibrationProject, PrinterProfile } from '../src/types';

// A modest hotend: 240 °C is the whole point of the profile's existence.
const printer: PrinterProfile = {
  id: 'pr', name: 'Ender 3 v2', manufacturer: 'Creality', nozzleDiameter: 0.4,
  maxNozzleTemp: 240, maxBedTemp: 100, extruderType: 'bowden',
  retractionRange: { start: 1, end: 6 }, notes: '', createdAt: '', updatedAt: ''
};

const errors = (issues: { level: string; message: string }[]) =>
  issues.filter(i => i.level === 'error').map(i => i.message);

describe('temperature entry limits', () => {
  it('blocks a normal printing temperature above the printer maximum', () => {
    const msgs = errors(temperatureEntryIssues({
      normalTemp: 260, firstLayerTemp: null, highFlowTemp: null, printer
    }));
    expect(msgs.some(m => m.includes('260') && m.includes('240'))).toBe(true);
  });

  it('blocks a FIRST-LAYER temperature above the printer maximum', () => {
    const msgs = errors(temperatureEntryIssues({
      normalTemp: 230, firstLayerTemp: 500, highFlowTemp: null, printer
    }));
    expect(msgs.some(m => m.includes('First-layer') && m.includes('500') && m.includes('240'))).toBe(true);
  });

  it('blocks a HIGH-FLOW temperature above the printer maximum', () => {
    const msgs = errors(temperatureEntryIssues({
      normalTemp: 230, firstLayerTemp: null, highFlowTemp: 300, printer
    }));
    expect(msgs.some(m => m.includes('High-flow') && m.includes('300') && m.includes('240'))).toBe(true);
  });

  it('keeps the plain numeric bounds on the optional fields', () => {
    const msgs = errors(temperatureEntryIssues({
      normalTemp: 230, firstLayerTemp: 20, highFlowTemp: 900, printer: undefined
    }));
    expect(msgs.some(m => m.includes('First-layer temp') && m.includes('140'))).toBe(true);
    expect(msgs.some(m => m.includes('High-flow temp') && m.includes('500'))).toBe(true);
  });

  it('passes values inside the printer rating and reports nothing for empty fields', () => {
    expect(temperatureEntryIssues({
      normalTemp: 230, firstLayerTemp: 235, highFlowTemp: 240, printer
    })).toEqual([]);
    expect(temperatureEntryIssues({
      normalTemp: null, firstLayerTemp: null, highFlowTemp: null, printer
    })).toEqual([]);
  });

  it('says nothing about the printer limit when no printer profile is selected', () => {
    expect(temperatureEntryIssues({
      normalTemp: 400, firstLayerTemp: 400, highFlowTemp: 400, printer: undefined
    })).toEqual([]);
  });
});

// The install path refuses a retraction above 1.5 mm on flexible filament
// (RETRACT_OVER_FLEXIBLE_CAP). Everything upstream of it — the tower plan, the
// computed result, the "values to enter" panel, the report — has to say the
// same thing, or the app tells a TPU user to set a distance it will not install
// and the browser build (no install path at all) never mentions it.
describe('flexible-filament retraction cap', () => {
  const bowden: PrinterProfile = {
    id: 'pr', name: 'Bowden rig', manufacturer: 'Generic', nozzleDiameter: 0.4,
    maxNozzleTemp: 300, maxBedTemp: 110, extruderType: 'bowden',
    retractionRange: { start: 0, end: 0 }, notes: '', createdAt: '', updatedAt: ''
  };

  function ctxFor(materialId: string): TestCtx {
    const project = {
      id: 'p', createdAt: '', updatedAt: '', calibrationDate: '',
      filament: { manufacturer: 'X', productLine: '', material: materialId, color: '', diameter: 1.75, startingProfile: '' },
      printerProfileId: 'pr', nozzleType: 'brass', slicer: { slicer: 'orca', version: '2.4.x' },
      notes: '', mode: 'expert', stepOrder: [], steps: {}, timeline: [], archived: false, finals: {}
    } as unknown as CalibrationProject;
    return { project, printer: bowden, material: getMaterial(materialId), method: '', coach: false };
  }

  const capWarnings = (out: { warnings: string[] }) =>
    out.warnings.filter(w => w.includes(String(FLEXIBLE_RETRACTION_MAX_MM)));

  it('is one constant shared by the suggestion layer and the write path', () => {
    expect(FLEXIBLE_RETRACTION_MAX_MM).toBe(1.5);
    expect(VALIDATION_FLEXIBLE_CAP).toBe(FLEXIBLE_RETRACTION_MAX_MM);
  });

  it('warns when a measured tower height computes past the cap', () => {
    // Range widened to 6 mm by hand; the height entered lands at 3.5 mm.
    const settings = { start: 0, end: 6, step: 0.1, speed: '' };
    const out = CONTROLLERS['retraction'].compute(ctxFor('TPU'), settings, { entry: 'height', bestHeight: 35 });
    expect(out.finalsPatch.retractionDistance).toBe(3.5); // the measurement stands
    expect(capWarnings(out).length).toBeGreaterThan(0);
    expect(capWarnings(out)[0]).toContain('TPU');
  });

  it('warns on the g-code entry path too', () => {
    const settings = { start: 0, end: 6, step: 0.1, speed: '' };
    const out = CONTROLLERS['retraction'].compute(ctxFor('TPU'), settings, { entry: 'gcode', gcodeLength: 4.5 });
    expect(out.finalsPatch.retractionDistance).toBe(4.5);
    expect(capWarnings(out).length).toBeGreaterThan(0);
  });

  it('stays quiet for flexible filament at or under the cap', () => {
    const settings = { start: 0, end: 1.5, step: 0.1, speed: '' };
    const out = CONTROLLERS['retraction'].compute(ctxFor('TPU'), settings, { entry: 'gcode', gcodeLength: 1.2 });
    expect(capWarnings(out)).toEqual([]);
  });

  it('stays quiet for rigid filament at the same distance', () => {
    const settings = { start: 0, end: 6, step: 0.1, speed: '' };
    const out = CONTROLLERS['retraction'].compute(ctxFor('PLA'), settings, { entry: 'gcode', gcodeLength: 4.5 });
    expect(capWarnings(out)).toEqual([]);
  });

  it('warns at the tower-planning stage, before the print is wasted', () => {
    const tpu = flexibleRetractionEntryIssues(getMaterial('TPU'), 6);
    expect(tpu.length).toBe(1);
    expect(tpu[0].level).toBe('warning'); // an expert may still explore past it
    expect(tpu[0].message).toContain(String(FLEXIBLE_RETRACTION_MAX_MM));
    expect(flexibleRetractionEntryIssues(getMaterial('TPU'), FLEXIBLE_RETRACTION_MAX_MM)).toEqual([]);
    expect(flexibleRetractionEntryIssues(getMaterial('PLA'), 6)).toEqual([]);
  });

  it('travels with the value on the outputs the browser build actually produces', () => {
    // No install path exists in the browser, so the report/card/clipboard are
    // the deliverable — the caution has to be on them.
    expect(flexibleRetractionCaution('TPU', 4.5)).toContain(String(FLEXIBLE_RETRACTION_MAX_MM));
    expect(flexibleRetractionCaution('TPU', 1.5)).toBeNull();
    expect(flexibleRetractionCaution('PLA', 4.5)).toBeNull();
    expect(flexibleRetractionCaution('TPU', undefined)).toBeNull();
  });
});
