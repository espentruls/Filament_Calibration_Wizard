import { describe, it, expect } from 'vitest';
import { withOptionalStep, optionalStepIds } from '../src/logic/stepPlan';
import { DEFAULT_ORDER, CALIBRATIONS } from '../src/data/calibrations';
import type { CalibrationId } from '../src/types';

describe('adding an optional step to a plan', () => {
  it('puts it just before final verification, which stays last', () => {
    const plan = withOptionalStep([...DEFAULT_ORDER], 'ooze-control');
    expect(plan[plan.length - 1]).toBe('final-verification');
    expect(plan[plan.length - 2]).toBe('ooze-control');
  });

  it('never adds the same step twice', () => {
    const once = withOptionalStep([...DEFAULT_ORDER], 'ooze-control');
    expect(withOptionalStep(once, 'ooze-control')).toEqual(once);
  });

  it('appends when the plan has no final verification step', () => {
    const trimmed = DEFAULT_ORDER.filter(id => id !== 'final-verification');
    const plan = withOptionalStep(trimmed, 'ooze-control');
    expect(plan[plan.length - 1]).toBe('ooze-control');
  });

  it('does not mutate the plan it was given', () => {
    const original: CalibrationId[] = [...DEFAULT_ORDER];
    const copy = [...original];
    withOptionalStep(original, 'ooze-control');
    expect(original).toEqual(copy);
  });

  it('leaves the default order alone — a legacy project must never inherit this', () => {
    // Putting an optional step into DEFAULT_ORDER would splice a dual-nozzle
    // checklist into every project ever saved and drop every confidence score,
    // because the score is computed over the project's own plan.
    expect(DEFAULT_ORDER).not.toContain('ooze-control');
    for (const id of optionalStepIds()) expect(DEFAULT_ORDER).not.toContain(id);
  });

  it('offers only real, fully defined calibrations', () => {
    const ids = optionalStepIds();
    expect(ids).toContain('ooze-control');
    for (const id of ids) expect(CALIBRATIONS[id]).toBeDefined();
  });
});
