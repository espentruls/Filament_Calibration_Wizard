import { describe, expect, it } from 'vitest';
import {
  FALLBACK_MAX_NOZZLE_TEMP, FALLBACK_MAX_BED_TEMP,
  limitProvenance, unpublishedLimitsNote, specFillBadgeText
} from '../src/ui/printers';
import { allPrinterSpecs } from '../src/data/printerDatabase';
import type { PrinterSpecification } from '../src/types';

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
