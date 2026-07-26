// ---------------------------------------------------------------------------
// Result inheritance and provenance — the core promise of the guided session.
//
// "Carries results forward between steps" means one concrete thing: the
// pressure-advance test must run at the temperature and flow ratio this session
// already measured, not at material defaults. And because the product promises
// no black boxes, every pre-filled number has to be able to say where it came
// from.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';

import {
  buildValueContext,
  formatValue,
  inheritedInputsFor,
  isSatisfying,
  keysProducedBy,
  recordSessionResult,
  resolveStepValues,
  resolveValue,
  setSessionOverride,
  startGuidedSession,
  stepsProducing,
  syncSessionValues,
  VALUE_META
} from '../../src/session';
import { getWorkingProfile } from '../../src/automatedCalibration';
import {
  T,
  auxProject,
  completeStep,
  dualNozzlePrinter,
  makeProject,
  tempAndFlowDone
} from './fixtures';

const printer = dualNozzlePrinter();
const ctxFor = (project = makeProject(), nozzleIndex?: number) =>
  buildValueContext({ project, printer, nozzleIndex });

describe('inherited input graph', () => {
  it('gives pressure advance BOTH the temperature and the flow ratio', () => {
    // Temperature is only a transitive dependency (pressure advance depends on
    // flow, flow depends on temperature) — the whole point of the closure.
    const { required } = inheritedInputsFor('pressure-advance');
    expect(required).toContain('nozzleTemp');
    expect(required).toContain('flowRatio');
  });

  it('gives retraction the pressure advance it was tuned against', () => {
    const { required } = inheritedInputsFor('retraction');
    expect(required).toEqual(expect.arrayContaining(['nozzleTemp', 'flowRatio', 'pressureAdvance']));
  });

  it('gives the dual-nozzle ooze checklist everything upstream of it', () => {
    const { required } = inheritedInputsFor('ooze-control');
    expect(required).toEqual(
      expect.arrayContaining([
        'nozzleTemp',
        'flowRatio',
        'pressureAdvance',
        'retractionDistance',
        'retractionSpeed'
      ])
    );
  });

  it('treats the high-flow temperature as advisory for max volumetric speed', () => {
    const { required, optional } = inheritedInputsFor('max-volumetric-speed');
    expect(required).toEqual(expect.arrayContaining(['nozzleTemp', 'flowRatio']));
    expect(optional).toEqual(['highFlowTemp']);
  });

  it('requires nothing for the first step', () => {
    expect(inheritedInputsFor('temperature').required).toEqual([]);
  });

  it('counts the temperature test\'s companion values as things it produces', () => {
    expect(keysProducedBy('temperature')).toEqual(['nozzleTemp', 'firstLayerTemp', 'highFlowTemp']);
    expect(stepsProducing('flowRatio')).toEqual(['flow-pass1', 'flow-pass2', 'flow-verify']);
  });
});

describe('an untouched project', () => {
  it('leaves an unmeasured value ABSENT rather than zero', () => {
    const temp = resolveValue(ctxFor(), 'nozzleTemp');
    expect(temp.value).toBeUndefined();
    expect(temp.provenance).toBe('unset');
    expect(temp.satisfied).toBe(false);
    expect(temp.display).toBeUndefined();
  });

  it('offers the material band for a temperature instead of inventing a number', () => {
    const temp = resolveValue(ctxFor(), 'nozzleTemp');
    expect(temp.suggestedRange).toEqual({ min: 220, max: 260 }); // PETG
    expect(temp.explanation).toContain('220–260');
  });

  it('offers the material flow ratio, but does not let it satisfy a dependency', () => {
    const flow = resolveValue(ctxFor(), 'flowRatio');
    expect(flow.value).toBe(0.95); // PETG startingFlowRatio
    expect(flow.provenance).toBe('material-default');
    expect(flow.satisfied).toBe(false);
  });

  it('reports pressure advance as not ready, naming what is missing', () => {
    const values = resolveStepValues(ctxFor(), 'pressure-advance');
    expect(values.ready).toBe(false);
    expect(values.missing).toEqual(['nozzleTemp', 'flowRatio']);
  });
});

describe('carrying results forward', () => {
  it('runs pressure advance at the temperature and flow this session measured', () => {
    const project = tempAndFlowDone();
    const values = resolveStepValues(ctxFor(project), 'pressure-advance');
    expect(values.ready).toBe(true);
    expect(values.missing).toEqual([]);

    const temp = values.inherited.find((v) => v.key === 'nozzleTemp')!;
    expect(temp.value).toBe(245);
    expect(temp.provenance).toBe('calibrated');
    expect(temp.stepId).toBe('temperature');
    expect(temp.at).toBe(T.t1);
    expect(temp.display).toBe('245 °C');
    expect(temp.explanation).toContain('Temperature');

    const flow = values.inherited.find((v) => v.key === 'flowRatio')!;
    expect(flow.value).toBe(0.955);
    expect(flow.provenance).toBe('calibrated');
    expect(flow.stepId).toBe('flow-pass1');
    expect(flow.display).toBe('0.955');
  });

  it('attributes a re-measured value to the LAST step that produced it', () => {
    const project = tempAndFlowDone();
    completeStep(project, 'flow-pass2', { flowRatio: 0.945 }, T.t3);
    const flow = resolveValue(ctxFor(project), 'flowRatio');
    expect(flow.value).toBe(0.945);
    expect(flow.stepId).toBe('flow-pass2');
    expect(flow.at).toBe(T.t3);
  });

  it('carries the high-flow temperature into the max-flow test as advisory', () => {
    const project = tempAndFlowDone();
    const values = resolveStepValues(ctxFor(project), 'max-volumetric-speed');
    const hf = values.inherited.find((v) => v.key === 'highFlowTemp')!;
    expect(hf.value).toBe(255);
    expect(hf.required).toBe(false);
    expect(hf.provenance).toBe('calibrated');
  });

  it('does not carry a value from a step that has not completed', () => {
    const project = makeProject();
    project.finals.nozzleTemp = 245; // written, but the step never completed
    const temp = resolveValue(ctxFor(project), 'nozzleTemp');
    expect(temp.provenance).toBe('unset');
    expect(temp.value).toBeUndefined();
  });
});

describe('a measurement written straight into the working profile', () => {
  // `recordSessionResult` writes into the nozzle's working profile without
  // touching `steps`/`finals`. Until this was fixed it was only ever readable
  // for a nozzle OTHER than the project's own: on the project's own nozzle the
  // resolver looked in `finals`, found nothing, and reported the value as unset
  // while `recordSessionResult` had already reported success. Written, and
  // readable by neither branch.

  it('reads back on the project\'s OWN nozzle, so reported success means readable', () => {
    const project = makeProject(); // nozzleIndex absent => the project's nozzle is 0
    const out = recordSessionResult(project, {
      stepId: 'temperature',
      values: { nozzleTemp: 251 },
      nozzleIndex: 0,
      now: T.t2
    });
    expect(out.errors).toEqual([]);
    expect(out.changedKeys).toEqual(['nozzleTemp']);
    expect(getWorkingProfile(project, 0)!.values.nozzleTemp).toBe(251);

    const temp = resolveValue(ctxFor(project), 'nozzleTemp');
    expect(temp.value).toBe(251);
    expect(temp.provenance).toBe('calibrated');
    expect(temp.stepId).toBe('temperature');
    expect(temp.at).toBe(T.t2);
    expect(temp.display).toBe('251 °C');
    expect(temp.satisfied).toBe(true);
  });

  it('reads back when the nozzle is left implicit rather than named', () => {
    const project = makeProject();
    recordSessionResult(project, {
      stepId: 'flow-pass1',
      values: { flowRatio: 0.96 },
      now: T.t2
    });
    const flow = resolveValue(ctxFor(project), 'flowRatio');
    expect(flow.value).toBe(0.96);
    expect(flow.provenance).toBe('calibrated');
    expect(flow.stepId).toBe('flow-pass1');
  });

  it('reads back on a bowden auxiliary project recording its own nozzle', () => {
    // The X2D case: the project itself targets nozzle 2, so that nozzle IS the
    // one it owns — the same branch that used to swallow the measurement.
    const project = auxProject();
    recordSessionResult(project, {
      stepId: 'pressure-advance',
      values: { pressureAdvance: 0.04 },
      now: T.t2
    });
    const pa = resolveValue(ctxFor(project), 'pressureAdvance');
    expect(pa.value).toBe(0.04);
    expect(pa.provenance).toBe('calibrated');
    expect(pa.display).toBe('0.040');
    expect(pa.explanation).toContain('this nozzle');
  });

  it('carries forward into the next step instead of leaving it blocked', () => {
    const project = makeProject();
    recordSessionResult(project, {
      stepId: 'temperature',
      values: { nozzleTemp: 251 },
      nozzleIndex: 0,
      now: T.t2
    });
    const values = resolveStepValues(ctxFor(project), 'flow-pass1');
    expect(values.missing).toEqual([]);
    expect(values.ready).toBe(true);
  });

  it('still keeps the project\'s own recorded result authoritative', () => {
    // The classic wizard remains the way a result is saved for the project's
    // nozzle: it alone can name the step and the time from the plan.
    const project = tempAndFlowDone();
    recordSessionResult(project, {
      stepId: 'temperature',
      values: { nozzleTemp: 251 },
      nozzleIndex: 0,
      now: T.t3
    });
    const temp = resolveValue(ctxFor(project), 'nozzleTemp');
    expect(temp.value).toBe(245);
    expect(temp.at).toBe(T.t1);
    expect(temp.stepId).toBe('temperature');
  });

  it('never lets one nozzle read the other nozzle\'s measurement', () => {
    const project = makeProject(); // owns nozzle 0
    recordSessionResult(project, {
      stepId: 'temperature',
      values: { nozzleTemp: 251 },
      nozzleIndex: 1,
      now: T.t2
    });
    expect(resolveValue(ctxFor(project, 0), 'nozzleTemp').provenance).toBe('unset');
    expect(resolveValue(ctxFor(project, 1), 'nozzleTemp').value).toBe(251);
  });

  it('is superseded by a later override on the same nozzle', () => {
    const project = makeProject();
    recordSessionResult(project, {
      stepId: 'temperature',
      values: { nozzleTemp: 251 },
      nozzleIndex: 0,
      now: T.t2
    });
    setSessionOverride(project, { key: 'nozzleTemp', value: 240, now: T.t3 });

    const temp = resolveValue(ctxFor(project), 'nozzleTemp');
    expect(temp.value).toBe(240);
    expect(temp.provenance).toBe('user-override');
    // A working profile holds ONE slot per key, so here the override takes the
    // measurement's place rather than sitting above it — unlike a wizard result,
    // which lives in `finals` and stays visible as the value that was replaced.
    expect(temp.candidates.map((c) => c.provenance)).toEqual(['user-override']);
  });

  it('does not turn an unrecorded value into a measurement', () => {
    const project = makeProject();
    recordSessionResult(project, {
      stepId: 'temperature',
      values: { nozzleTemp: 251 },
      nozzleIndex: 0,
      now: T.t2
    });
    const pa = resolveValue(ctxFor(project), 'pressureAdvance');
    expect(pa.provenance).toBe('unset');
    expect(pa.value).toBeUndefined();
  });
});

describe('overrides', () => {
  it('lets a later override supersede a measurement, and says what it replaced', () => {
    const project = tempAndFlowDone();
    startGuidedSession(project, { printer, now: T.t3 });
    setSessionOverride(project, { key: 'nozzleTemp', value: 240, now: T.t4 });

    const temp = resolveValue(ctxFor(project), 'nozzleTemp');
    expect(temp.value).toBe(240);
    expect(temp.provenance).toBe('user-override');
    expect(temp.satisfied).toBe(true);
    expect(temp.explanation).toContain('245 °C');
    expect(temp.candidates.map((c) => c.provenance)).toEqual(['user-override', 'calibrated']);
  });

  it('lets a newer measurement win over an older override', () => {
    const project = makeProject();
    startGuidedSession(project, { printer, now: T.t1 });
    setSessionOverride(project, { key: 'nozzleTemp', value: 240, now: T.t2 });
    completeStep(project, 'temperature', { nozzleTemp: 250 }, T.t3);

    const temp = resolveValue(ctxFor(project), 'nozzleTemp');
    expect(temp.value).toBe(250);
    expect(temp.provenance).toBe('calibrated');
    expect(temp.candidates[1].provenance).toBe('user-override');
  });

  it('unblocks a step whose dependency was skipped but whose value is known', () => {
    const project = makeProject();
    startGuidedSession(project, { printer, now: T.t1 });
    setSessionOverride(project, { key: 'nozzleTemp', value: 240, now: T.t2 });
    const values = resolveStepValues(ctxFor(project), 'flow-pass1');
    expect(values.missing).toEqual([]);
    expect(values.ready).toBe(true);
  });
});

describe('the working profile snapshot', () => {
  it('writes measurements into the profile with their provenance', () => {
    const project = tempAndFlowDone();
    const out = startGuidedSession(project, { printer, now: T.t3 });
    expect(out.changedKeys).toEqual(
      expect.arrayContaining(['nozzleTemp', 'firstLayerTemp', 'highFlowTemp', 'flowRatio'])
    );
    const wp = getWorkingProfile(project, 0)!;
    expect(wp.values.nozzleTemp).toBe(245);
    expect(wp.provenance.nozzleTemp.source).toBe('calibration_result');
    expect(wp.provenance.nozzleTemp.stepId).toBe('temperature');
  });

  it('never materializes a material default into the profile', () => {
    const project = makeProject();
    startGuidedSession(project, { printer, now: T.t1 });
    const wp = getWorkingProfile(project, 0)!;
    expect(wp.values.flowRatio).toBeUndefined();
    expect(wp.values.shrinkagePercent).toBeUndefined();
  });

  it('is idempotent — syncing twice changes nothing the second time', () => {
    const project = tempAndFlowDone();
    startGuidedSession(project, { printer, now: T.t3 });
    const again = syncSessionValues(project, { printer, now: T.t4 });
    expect(again.changedKeys).toEqual([]);
  });
});

describe('formatting', () => {
  it('formats each value at its calibration\'s precision', () => {
    expect(formatValue('nozzleTemp', 245)).toBe('245 °C');
    expect(formatValue('flowRatio', 0.95)).toBe('0.950');
    expect(formatValue('pressureAdvance', 0.72)).toBe('0.720');
    expect(formatValue('retractionDistance', 2.5)).toBe('2.50 mm');
    expect(formatValue('maxVolumetricSpeed', 9)).toBe('9.0 mm³/s');
    expect(formatValue('shrinkagePercent', 99.4)).toBe('99.40%');
  });

  it('labels every normalized key', () => {
    for (const meta of Object.values(VALUE_META)) expect(meta.label.length).toBeGreaterThan(0);
  });

  it('treats only real information as satisfying a dependency', () => {
    expect(isSatisfying('calibrated')).toBe(true);
    expect(isSatisfying('user-override')).toBe(true);
    expect(isSatisfying('carried')).toBe(true);
    expect(isSatisfying('material-default')).toBe(false);
    expect(isSatisfying('unset')).toBe(false);
  });
});
