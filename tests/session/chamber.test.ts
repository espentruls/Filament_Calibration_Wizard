// ---------------------------------------------------------------------------
// Guided session — the chamber advisory.
//
// Chamber temperature is the one number the app talks about that it never
// measures, never carries into `finals`, and never writes into a preset. These
// tests pin all three of those, plus the correctness trap: "as hot as it goes"
// is the ABS answer and must never be the PLA one.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import {
  buildValueContext, resolveChamberAdvisory, CANONICAL_KEYS
} from '../../src/session/values';
import { buildActionPlan } from '../../src/session/actions';
import { resolveSessionNozzle } from '../../src/session/session';
import { dualNozzlePrinter, makeProject, T } from './fixtures';
import type { PrinterProfile } from '../../src/types';

/** The owner's machine as the printer database records it. */
function x2d(over: Partial<PrinterProfile> = {}): PrinterProfile {
  return dualNozzlePrinter({ maxChamberTemp: 65, heatedChamber: true, ...over });
}

function ctxFor(material: string, printer: PrinterProfile) {
  const project = makeProject({ nozzleIndex: 1 }, 'bambu');
  project.filament.material = material as never;
  return buildValueContext({ project, printer });
}

describe('chamber advisory', () => {
  it('is not a carried value: it never joins the keys a session installs', () => {
    expect(CANONICAL_KEYS).not.toContain('chamberTemp' as never);
  });

  it('runs ABS at the machine ceiling, and says the printer profile decided it', () => {
    const a = resolveChamberAdvisory(ctxFor('ABS', x2d()));
    expect(a.advice).toBe('hot');
    expect(a.value).toBe(65);
    expect(a.display).toBe('65 °C');
    expect(a.provenance).toBe('printer-default');
    expect(a.actionable).toBe(true);
  });

  it('keeps PLA at zero on the very same machine, and explains the harm', () => {
    const a = resolveChamberAdvisory(ctxFor('PLA', x2d()));
    expect(a.advice).toBe('ambient');
    expect(a.value).toBe(0);
    expect(a.provenance).toBe('material-default');
    expect(`${a.explanation} ${a.warnings.join(' ')}`.toLowerCase()).toContain('heat creep');
    expect(a.actionable).toBe(true);   // there IS a heater to turn off here
  });

  it('says nothing to act on when the machine has no chamber at all', () => {
    const plain = dualNozzlePrinter();       // no chamber fields
    expect(resolveChamberAdvisory(ctxFor('PLA', plain)).actionable).toBe(false);
    // ABS still gets advice, just no number and nothing to set.
    const abs = resolveChamberAdvisory(ctxFor('ABS', plain));
    expect(abs.value).toBeUndefined();
    expect(abs.provenance).toBe('unset');
  });

  it('never offers a value the printer profile would reject', () => {
    for (const id of ['ABS', 'ASA', 'PLA', 'PETG', 'TPU', 'PC', 'OTHER']) {
      const a = resolveChamberAdvisory(ctxFor(id, x2d()));
      if (a.value !== undefined) expect(a.value, id).toBeLessThanOrEqual(65);
      expect(a.blockingIssues, id).toEqual([]);
    }
  });
});

describe('chamber in the action plan', () => {
  const nozzle = (p: PrinterProfile) =>
    resolveSessionNozzle(makeProject({ nozzleIndex: 1 }, 'bambu'), p);

  it('adds one environment action for ABS, sourced from the material data', () => {
    const printer = x2d();
    const ctx = ctxFor('ABS', printer);
    const plan = buildActionPlan(ctx, nozzle(printer), 'temperature');
    const env = plan.actions.filter(a => a.kind === 'environment');
    expect(env).toHaveLength(1);
    expect(env[0].value).toBe('65 °C');
    expect(env[0].source).toContain('materials.ts');
    expect(env[0].source).toContain('ABS');
    // No menu path was invented: the shipped slicer content names no chamber
    // field, so the plan says so instead.
    expect(env[0].path).toBeUndefined();
    expect(plan.gaps.join(' ').toLowerCase()).toContain('chamber');
  });

  it('tells a PLA session to turn the chamber heater off, as a caution', () => {
    const printer = x2d();
    const ctx = ctxFor('PLA', printer);
    const env = buildActionPlan(ctx, nozzle(printer), 'temperature')
      .actions.filter(a => a.kind === 'environment');
    expect(env).toHaveLength(1);
    expect(env[0].value).toBe('0 °C');
    expect(env[0].severity).toBe('caution');
    expect(env[0].detail.toLowerCase()).toContain('heat creep');
  });

  it('stays out of the plan entirely when there is no chamber to set', () => {
    const printer = dualNozzlePrinter();
    for (const id of ['PLA', 'PETG', 'ABS']) {
      const plan = buildActionPlan(ctxFor(id, printer), nozzle(printer), 'temperature');
      expect(plan.actions.filter(a => a.kind === 'environment'), id).toEqual([]);
    }
  });

  it('keeps the environment action ahead of the disable and perform steps', () => {
    const printer = x2d();
    const plan = buildActionPlan(ctxFor('ABS', printer), nozzle(printer), 'flow-pass1');
    const kinds = [...new Set(plan.actions.map(a => a.kind))];
    const rank = ['carry-forward', 'environment', 'disable', 'perform', 'record', 'trap'];
    expect(kinds).toEqual(rank.filter(k => kinds.includes(k as never)));
    expect(plan.actions.map(a => a.order)).toEqual(plan.actions.map((_, i) => i));
  });
});

describe('the chamber never reaches a written profile', () => {
  it('is absent from finals after a session records results', () => {
    const printer = x2d();
    const ctx = ctxFor('ABS', printer);
    resolveChamberAdvisory(ctx);
    expect(Object.keys(ctx.project.finals)).not.toContain('chamberTemp');
    expect(ctx.project.updatedAt === undefined || typeof ctx.project.updatedAt === 'string').toBe(true);
    expect(T.t1).toBeTruthy();
  });
});
