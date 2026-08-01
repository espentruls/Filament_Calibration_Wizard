import { describe, expect, it } from 'vitest';
import {
  FALLBACK_MAX_NOZZLE_TEMP, FALLBACK_MAX_BED_TEMP,
  limitProvenance, unpublishedLimitsNote, specFillBadgeText, x2dTemplateValues
} from '../src/ui/printers';
import { allPrinterSpecs, getPrinterSpec, profileValuesFromSpec } from '../src/data/printerDatabase';
import { printerCanHeatChamber, suggestChamberTemp } from '../src/logic/ranges';
import { chamberOozeCallout } from '../src/ui/testForms';
import { getMaterial } from '../src/data/materials';
import type { PrinterProfile, PrinterSpecification } from '../src/types';

// The shipped database is genuinely incomplete: the corrupted rows were
// replaced with null rather than guesses. These tests run against the real
// records, so they fail if the app ever starts inventing the missing limits.
const specs = allPrinterSpecs();
const withoutNozzleLimit = specs.find(s => s.maxNozzleTempC === null || s.maxNozzleTempC === undefined) as PrinterSpecification;
const withNozzleLimit = specs.find(s => typeof s.maxNozzleTempC === 'number') as PrinterSpecification;

describe('printer database provenance', () => {
  it('the shipped database really does lack nozzle limits for most printers', () => {
    const missing = specs.filter(s => s.maxNozzleTempC === null || s.maxNozzleTempC === undefined);
    expect(missing.length).toBeGreaterThan(specs.length / 2);
    expect(withNozzleLimit).toBeDefined();
  });

  it('reports a limit the record does not publish as NOT from the database', () => {
    const p = limitProvenance(withoutNozzleLimit).find(l => l.key === 'maxNozzleTemp');
    expect(p?.fromDatabase).toBe(false);
  });

  it('reports a limit the record does publish as from the database', () => {
    const p = limitProvenance(withNozzleLimit).find(l => l.key === 'maxNozzleTemp');
    expect(p?.fromDatabase).toBe(true);
  });

  it('names the unpublished limits and the fallback the app used instead', () => {
    const note = unpublishedLimitsNote(withoutNozzleLimit);
    expect(note).toBeTruthy();
    expect(note).toContain('Max nozzle temp');
    expect(note).toContain(String(FALLBACK_MAX_NOZZLE_TEMP));
    // It must not be readable as a specification.
    expect(note!.toLowerCase()).toContain('not from the database');
  });

  it('exposes the bed fallback too — the database is missing that limit just as often', () => {
    const noBed = specs.find(s => s.maxBedTempC === null || s.maxBedTempC === undefined) as PrinterSpecification;
    expect(noBed).toBeDefined();
    expect(limitProvenance(noBed).find(l => l.key === 'maxBedTemp')?.fromDatabase).toBe(false);
    expect(unpublishedLimitsNote(noBed)).toContain(String(FALLBACK_MAX_BED_TEMP));
  });

  it('the badge never claims the database filled a limit it does not carry', () => {
    const badge = specFillBadgeText(withoutNozzleLimit);
    expect(badge).toContain('Filled from database');
    expect(badge.toLowerCase()).toContain('not published');
  });

  it('a fully specified record gets the plain badge', () => {
    const complete = specs.find(s =>
      typeof s.maxNozzleTempC === 'number' && typeof s.maxBedTempC === 'number') as PrinterSpecification;
    expect(complete).toBeDefined();
    expect(unpublishedLimitsNote(complete)).toBeNull();
    expect(specFillBadgeText(complete).toLowerCase()).not.toContain('not published');
  });
});

// ---------------------------------------------------------------------------
// The "Quick-fill: Bambu Lab X2D" button — the fork's headline machine reached
// through the fork's own shortcut.
//
// It shipped without maxChamberTemp/heatedChamber, and everything in the
// per-material chamber model is gated on printerCanHeatChamber(). On a profile
// the button made, that reads false: no chamber number for ABS, the app stating
// the machine has no heated chamber, and — the part that can cost hardware — no
// PLA/PETG/TPU heat-creep warning anywhere at all. Nothing tested it.
// ---------------------------------------------------------------------------

describe('the Bambu Lab X2D quick-fill template', () => {
  /** The PrinterProfile the button's values produce, as saved. */
  function quickFillProfile(): PrinterProfile {
    const t = x2dTemplateValues();
    return {
      id: 'x2d-quick', name: t.name, manufacturer: t.manufacturer,
      nozzleDiameter: 0.4, maxNozzleTemp: t.maxNozzleTemp, maxBedTemp: 100,
      maxChamberTemp: t.maxChamberTemp, heatedChamber: t.heatedChamber,
      extruderType: t.extruderType, retractionRange: t.retractionRange,
      extruderCount: t.extruderCount, nozzles: t.nozzles,
      isManual: true, databasePrinterId: null,
      notes: '', createdAt: '', updatedAt: ''
    };
  }

  it('records the chamber the machine actually has', () => {
    const t = x2dTemplateValues();
    expect(t.maxChamberTemp).toBe(65);
    expect(t.heatedChamber).toBe(true);
    expect(printerCanHeatChamber(quickFillProfile())).toBe(true);
  });

  it('does not disagree with the printer-database record for the same machine', () => {
    // Two routes to an X2D profile (this button and the database combo box)
    // must not produce opposite chamber advice.
    const spec = getPrinterSpec('bambu-lab-x2d') as PrinterSpecification;
    const fromDb = profileValuesFromSpec(spec);
    const t = x2dTemplateValues();
    expect(t.maxChamberTemp).toBe(fromDb.maxChamberTemp);
    expect(t.heatedChamber).toBe(fromDb.heatedChamber);
    expect(t.extruderCount).toBe(fromDb.extruderCount);
  });

  it('delivers the heat-creep warning for PLA, PETG and TPU', () => {
    // The stated reason the per-material chamber model exists. The X2D holds
    // 65 °C, well above PLA's 35 °C and PETG's 50 °C ceilings, so a chamber left
    // hot from an ABS job is a real hazard on this machine.
    const p = quickFillProfile();
    for (const id of ['PLA', 'PETG', 'TPU']) {
      const callout = chamberOozeCallout(getMaterial(id), p);
      expect(callout, id).not.toBeNull();
      expect(callout!.id, id).toBe('chamber-ambient');
      expect(callout!.body.join(' '), id).toContain('heat creep');
      expect(suggestChamberTemp(id, p).suggestedC, id).toBe(0);
    }
  });

  it('names the ABS chamber number instead of denying the machine has one', () => {
    const p = quickFillProfile();
    const s = suggestChamberTemp('ABS', p);
    expect(s.suggestedC).toBe(65);
    const callout = chamberOozeCallout(getMaterial('ABS'), p);
    expect(callout!.id).toBe('chamber-hot');
    expect(callout!.body.join(' ')).not.toContain('Without a heated chamber');
  });

  it('still fills the dual-nozzle detail the database does not carry', () => {
    const t = x2dTemplateValues();
    expect(t.nozzles.map(n => n.feed)).toEqual(['direct', 'bowden']);
    expect(t.nozzles[1].maxSpeed).toBe(200);
  });
});

// A profile that genuinely records nothing about a chamber must not be reported
// as a machine WITHOUT one: absence of a field is not evidence about hardware.
describe('the "no chamber recorded" callout', () => {
  const bare: PrinterProfile = {
    id: 'bare', name: 'Hand-entered machine', manufacturer: '', nozzleDiameter: 0.4,
    maxNozzleTemp: 300, maxBedTemp: 110, extruderType: 'direct',
    retractionRange: { start: 0, end: 2 }, notes: '', createdAt: '', updatedAt: ''
  };

  it('speaks about the PROFILE when the chamber is simply unstated', () => {
    const c = chamberOozeCallout(getMaterial('ABS'), bare)!;
    expect(c.id).toBe('chamber-absent');
    expect(c.title).toContain('this profile does not record one');
    expect(c.title).not.toContain('this printer has none');
    // …and says how to fix it.
    expect(c.body.join(' ')).toContain('Max chamber temp');
  });

  it('speaks about the MACHINE only when the profile positively says so', () => {
    const c = chamberOozeCallout(getMaterial('ABS'), { ...bare, heatedChamber: false })!;
    expect(c.title).toContain('this printer has none');
    expect(c.body.join(' ')).not.toContain('Max chamber temp');
  });
});
