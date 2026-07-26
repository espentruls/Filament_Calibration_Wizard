// ---------------------------------------------------------------------------
// The guided session end to end: opening one over an existing project, running
// it on the manual path with the automation flag off, keeping two nozzles apart,
// and reporting a partially calibrated profile.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';

import {
  clearSessionOverride,
  recordSessionResult,
  resolveGuidedSession,
  resolveSessionNozzle,
  sessionActionsFor,
  sessionPartialProfile,
  sessionStepView,
  sessionValues,
  sessionValuesFor,
  setSessionOverride,
  startGuidedSession,
  syncSessionValues
} from '../../src/session';
import {
  getWorkingProfile,
  isAutomatedCalibrationEnabled,
  validateSession
} from '../../src/automatedCalibration';
import { workingProfileNozzles } from '../../src/automatedCalibration/session';
import { DEFAULT_EXPERIMENTAL_FEATURES } from '../../src/slicerIntegration/types';
import {
  T,
  auxProject,
  completeStep,
  dualNozzlePrinter,
  makeProject,
  singleNozzlePrinter,
  tempAndFlowDone
} from './fixtures';

const printer = dualNozzlePrinter();

describe('opening a session over an existing project', () => {
  it('needs no session data at all — the classic wizard\'s projects just work', () => {
    const project = tempAndFlowDone();
    const session = resolveGuidedSession({ project, printer });

    expect(session.started).toBe(false);
    expect(project.sessionStatus).toBeUndefined();
    expect(project.workingProfile).toBeUndefined();
    expect(session.status).toBe('created');
    expect(session.plan).toHaveLength(project.stepOrder.length);
    expect(session.completedStepIds).toEqual(['temperature', 'flow-pass1']);
    expect(session.nextActionableStepId).toBe('flow-pass2');
    expect(sessionValuesFor(session, 'pressure-advance').ready).toBe(true);
  });

  it('resolves without mutating a project that has no session', () => {
    const project = tempAndFlowDone();
    const before = JSON.stringify(project);
    resolveGuidedSession({ project, printer });
    expect(JSON.stringify(project)).toBe(before);
  });

  it('knows which nozzle it calibrates, from the project', () => {
    const aux = resolveGuidedSession({ project: auxProject('bambu'), printer });
    expect(aux.nozzle).toMatchObject({
      index: 1,
      label: 'Auxiliary (bowden)',
      feed: 'bowden',
      multiNozzle: true,
      auxiliary: true
    });

    const main = resolveGuidedSession({ project: makeProject(), printer });
    expect(main.nozzle).toMatchObject({ index: 0, feed: 'direct', auxiliary: false });
  });

  it('falls back honestly when there is no printer profile', () => {
    const session = resolveGuidedSession({ project: makeProject() });
    expect(session.nozzle.feed).toBe('direct');
    expect(session.nozzle.label).toBe('this nozzle');
    expect(session.warnings.join(' ')).toContain('No printer profile');
  });

  it('warns when the project targets a nozzle the printer does not have', () => {
    const project = makeProject({ nozzleIndex: 1 });
    const session = resolveGuidedSession({ project, printer: singleNozzlePrinter() });
    expect(session.warnings.join(' ')).toContain('describes 1 nozzle');
  });
});

describe('the manual path with the automation flag off', () => {
  it('is the default state of the app', () => {
    expect(DEFAULT_EXPERIMENTAL_FEATURES.automatedCalibration).toBe(false);
    expect(isAutomatedCalibrationEnabled(DEFAULT_EXPERIMENTAL_FEATURES)).toBe(false);
    // The persisted-flag path (no localStorage in node) must not throw either.
    expect(isAutomatedCalibrationEnabled()).toBe(false);
  });

  it('runs a whole calibration through, carrying every result forward', () => {
    const project = makeProject({}, 'orca');
    startGuidedSession(project, { printer, now: T.t1 });
    expect(project.slicerMode).toBe('manual_export');
    expect(project.sessionStatus).toBe('created');

    completeStep(project, 'temperature', { nozzleTemp: 245, highFlowTemp: 255 }, T.t1);
    syncSessionValues(project, { printer, now: T.t1 });
    completeStep(project, 'flow-pass1', { flowRatio: 0.955 }, T.t2);
    syncSessionValues(project, { printer, now: T.t2 });
    completeStep(project, 'pressure-advance', { pressureAdvance: 0.04 }, T.t3);
    syncSessionValues(project, { printer, now: T.t3 });

    const session = resolveGuidedSession({ project, printer });
    const view = sessionStepView(session, 'retraction')!;
    expect(view.step.phase).toBe('ready');
    expect(view.values.ready).toBe(true);
    expect(view.values.inherited.map((v) => [v.key, v.value])).toEqual(
      expect.arrayContaining([
        ['nozzleTemp', 245],
        ['flowRatio', 0.955],
        ['pressureAdvance', 0.04]
      ])
    );
    expect(view.actions.available).toBe(true);
    expect(view.actions.actions.some((a) => a.kind === 'carry-forward')).toBe(true);
  });

  it('keeps the persisted session valid by upstream\'s own rules', () => {
    const project = tempAndFlowDone();
    startGuidedSession(project, { printer, now: T.t3 });
    expect(validateSession(project)).toEqual([]);
  });

  it('survives a round trip through JSON, as IndexedDB storage would', () => {
    const project = tempAndFlowDone();
    startGuidedSession(project, { printer, now: T.t3 });
    setSessionOverride(project, { key: 'nozzleTemp', value: 240, now: T.t4 });

    const reloaded = JSON.parse(JSON.stringify(project));
    const session = resolveGuidedSession({ project: reloaded, printer });
    expect(session.started).toBe(true);
    const temp = sessionValues(session).find((v) => v.key === 'nozzleTemp')!;
    expect(temp.value).toBe(240);
    expect(temp.provenance).toBe('user-override');
  });

  it('starts idempotently', () => {
    const project = tempAndFlowDone();
    startGuidedSession(project, { printer, now: T.t3 });
    const id = project.workingProfile!.id;
    const timeline = project.timeline.length;
    startGuidedSession(project, { printer, now: T.t4 });
    expect(project.workingProfile!.id).toBe(id);
    expect(project.timeline.length).toBe(timeline);
  });
});

describe('overrides on the persisted session', () => {
  it('drops back to the measurement when the override is cleared', () => {
    const project = tempAndFlowDone();
    startGuidedSession(project, { printer, now: T.t3 });
    setSessionOverride(project, { key: 'nozzleTemp', value: 240, now: T.t4 });
    expect(sessionValues(resolveGuidedSession({ project, printer })).find((v) => v.key === 'nozzleTemp')!.value)
      .toBe(240);

    clearSessionOverride(project, { key: 'nozzleTemp' });
    const temp = sessionValues(resolveGuidedSession({ project, printer })).find((v) => v.key === 'nozzleTemp')!;
    expect(temp.value).toBe(245);
    expect(temp.provenance).toBe('calibrated');
    expect(validateSession(project)).toEqual([]);
  });

  it('leaves a measured value alone when asked to clear a non-override', () => {
    const project = tempAndFlowDone();
    startGuidedSession(project, { printer, now: T.t3 });
    const out = clearSessionOverride(project, { key: 'nozzleTemp' });
    expect(out.changedKeys).toEqual([]);
    expect(getWorkingProfile(project, 0)!.values.nozzleTemp).toBe(245);
  });
});

describe('per-nozzle isolation', () => {
  it('keeps two projects on the same printer completely separate', () => {
    const main = makeProject({ id: 'proj-main' });
    const aux = auxProject('bambu');
    aux.id = 'proj-aux';

    completeStep(main, 'temperature', { nozzleTemp: 245 }, T.t1);
    completeStep(main, 'flow-pass1', { flowRatio: 0.955 }, T.t2);
    completeStep(main, 'pressure-advance', { pressureAdvance: 0.04 }, T.t3);
    startGuidedSession(main, { printer, now: T.t3 });

    completeStep(aux, 'temperature', { nozzleTemp: 250 }, T.t4);
    completeStep(aux, 'flow-pass1', { flowRatio: 0.94 }, T.t5);
    completeStep(aux, 'pressure-advance', { pressureAdvance: 0.72 }, T.t6);
    startGuidedSession(aux, { printer, now: T.t6 });

    const mainSession = resolveGuidedSession({ project: main, printer });
    const auxSession = resolveGuidedSession({ project: aux, printer });

    const pa = (s: ReturnType<typeof resolveGuidedSession>) =>
      sessionValues(s).find((v) => v.key === 'pressureAdvance')!.value;
    // A bowden aux nozzle wants K roughly ten times the direct-drive main's —
    // if these ever bled into each other the product would be worthless.
    expect(pa(mainSession)).toBe(0.04);
    expect(pa(auxSession)).toBe(0.72);
    expect(mainSession.nozzle.index).toBe(0);
    expect(auxSession.nozzle.index).toBe(1);
    expect(auxSession.plan.map((s) => s.id)).toContain('ooze-control');
    expect(mainSession.plan.map((s) => s.id)).not.toContain('ooze-control');
  });

  it('keeps two nozzles of ONE project apart, in values and in profiles', () => {
    const project = tempAndFlowDone(); // nozzle 0: 245 °C, 0.955
    startGuidedSession(project, { printer, now: T.t3 });

    recordSessionResult(project, {
      stepId: 'temperature',
      values: { nozzleTemp: 250 },
      nozzleIndex: 1,
      now: T.t4
    });
    recordSessionResult(project, {
      stepId: 'pressure-advance',
      values: { pressureAdvance: 0.72 },
      nozzleIndex: 1,
      now: T.t5
    });

    expect(workingProfileNozzles(project)).toEqual([0, 1]);
    expect(getWorkingProfile(project, 0)!.values.nozzleTemp).toBe(245);
    expect(getWorkingProfile(project, 1)!.values.nozzleTemp).toBe(250);
    expect(getWorkingProfile(project, 0)!.values.pressureAdvance).toBeUndefined();

    const nozzle0 = resolveGuidedSession({ project, printer, nozzleIndex: 0 });
    const nozzle1 = resolveGuidedSession({ project, printer, nozzleIndex: 1 });
    expect(sessionValues(nozzle0).find((v) => v.key === 'nozzleTemp')!.value).toBe(245);
    expect(sessionValues(nozzle1).find((v) => v.key === 'nozzleTemp')!.value).toBe(250);
    // The project's own flow result belongs to nozzle 0 and must not leak.
    expect(sessionValues(nozzle1).find((v) => v.key === 'flowRatio')!.provenance).toBe(
      'material-default'
    );
    expect(validateSession(project)).toEqual([]);
  });

  it('keeps an override on one nozzle off the other', () => {
    const project = tempAndFlowDone();
    startGuidedSession(project, { printer, now: T.t3 });
    setSessionOverride(project, { key: 'nozzleTemp', value: 260, nozzleIndex: 1, now: T.t4 });

    expect(getWorkingProfile(project, 0)!.values.nozzleTemp).toBe(245);
    expect(getWorkingProfile(project, 1)!.values.nozzleTemp).toBe(260);
  });

  it('rejects a result that is not one of the step\'s outputs, without writing', () => {
    const project = tempAndFlowDone();
    startGuidedSession(project, { printer, now: T.t3 });
    const out = recordSessionResult(project, {
      stepId: 'temperature',
      values: { pressureAdvance: 0.72 },
      nozzleIndex: 1
    });
    expect(out.errors.length).toBeGreaterThan(0);
    expect(getWorkingProfile(project, 1)).toBeUndefined();
  });
});

describe('the partial profile', () => {
  it('reports nothing installable on an untouched project', () => {
    const session = resolveGuidedSession({ project: makeProject(), printer });
    const report = sessionPartialProfile(session);
    expect(report.installable).toBe(false);
    expect(report.complete).toBe(false);
    expect(report.values).toEqual([]);
    expect(report.summary).toContain('Nothing is measured yet');
  });

  it('offers temperature and flow before pressure advance is tackled', () => {
    const project = tempAndFlowDone();
    const report = sessionPartialProfile(resolveGuidedSession({ project, printer }));

    expect(report.installable).toBe(true);
    expect(report.complete).toBe(false);
    expect(report.calibratedKeys).toEqual([
      'nozzleTemp',
      'firstLayerTemp',
      'highFlowTemp',
      'flowRatio'
    ]);
    expect(report.values.every((v) => v.provenance === 'calibrated')).toBe(true);
    expect(report.missingKeys).toContain('pressureAdvance');
    expect(report.completedSteps).toEqual(['temperature', 'flow-pass1']);
    expect(report.remainingSteps).toContain('pressure-advance');
    expect(report.summary).toContain('nozzle temperature');
    expect(report.summary).toContain('Still open');
    expect(report.confidence).toBeGreaterThan(0);
  });

  it('never offers a material default as if it had been measured', () => {
    const report = sessionPartialProfile(
      resolveGuidedSession({ project: makeProject(), printer })
    );
    expect(report.calibratedKeys).not.toContain('flowRatio');
  });

  it('reports the auxiliary nozzle\'s own values only', () => {
    const project = tempAndFlowDone();
    startGuidedSession(project, { printer, now: T.t3 });
    recordSessionResult(project, {
      stepId: 'pressure-advance',
      values: { pressureAdvance: 0.72 },
      nozzleIndex: 1,
      now: T.t4
    });
    const report = sessionPartialProfile(
      resolveGuidedSession({ project, printer, nozzleIndex: 1 })
    );
    expect(report.nozzleIndex).toBe(1);
    expect(report.calibratedKeys).toEqual(['pressureAdvance']);
    expect(report.summary).toContain('Auxiliary (bowden)');
    // The project-wide confidence score describes the project's own nozzle.
    expect(report.confidence).toBeUndefined();
  });
});

describe('convenience helpers', () => {
  it('returns null for a step outside this project\'s plan', () => {
    const session = resolveGuidedSession({ project: makeProject(), printer });
    expect(sessionStepView(session, 'ooze-control')).toBeNull();
  });

  it('resolves a nozzle for a project without one', () => {
    expect(resolveSessionNozzle({}, undefined).index).toBe(0);
    expect(resolveSessionNozzle({ nozzleIndex: -3 }, printer).index).toBe(0);
  });

  it('exposes the same action plan through the session helper', () => {
    const project = auxProject('bambu');
    const session = resolveGuidedSession({ project, printer });
    const plan = sessionActionsFor(session, 'retraction');
    expect(plan.nozzleIndex).toBe(1);
    expect(plan.nozzleLabel).toBe('Auxiliary (bowden)');
    expect(plan.slicerLabel).toBe('Bambu Studio');
  });
});
