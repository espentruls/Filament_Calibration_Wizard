import { describe, expect, it } from 'vitest';
import { temperatureEntryIssues } from '../src/ui/testForms';
import type { PrinterProfile } from '../src/types';

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
