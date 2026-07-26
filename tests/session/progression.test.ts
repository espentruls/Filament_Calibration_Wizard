// ---------------------------------------------------------------------------
// Progression: what is ready, what is blocked and by what, what has gone stale.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';

import {
  buildValueContext,
  buildPlan,
  focusStep,
  nextActionable,
  progressPercent,
  recordSessionResult,
  resolveGuidedSession,
  setSessionOverride,
  startGuidedSession,
  stepBlockers,
  stepRecord,
  stepStaleness
} from '../../src/session';
import type { GeneratedJobRecord } from '../../src/automatedCalibration';
import {
  T,
  auxProject,
  completeStep,
  dualNozzlePrinter,
  makeProject,
  skipStep,
  tempAndFlowDone
} from './fixtures';

const printer = dualNozzlePrinter();
const ctxFor = (project = makeProject(), nozzleIndex?: number) =>
  buildValueContext({ project, printer, nozzleIndex });

describe('a fresh plan', () => {
  it('makes the first step ready and everything downstream blocked', () => {
    const plan = buildPlan(ctxFor());
    expect(plan[0].id).toBe('temperature');
    expect(plan[0].phase).toBe('ready');
    expect(plan.find((s) => s.id === 'flow-pass1')!.phase).toBe('blocked');
    expect(nextActionable(plan)).toBe('temperature');
    expect(focusStep(plan)).toBe('temperature');
    expect(progressPercent(plan)).toBe(0);
  });

  it('names the step AND the value that block a later test', () => {
    const blockers = stepBlockers(ctxFor(), 'pressure-advance');
    expect(blockers.filter((b) => b.kind === 'step').map((b) => b.stepId)).toEqual(['flow-pass1']);
    expect(blockers.filter((b) => b.kind === 'value').map((b) => b.key)).toEqual([
      'nozzleTemp',
      'flowRatio'
    ]);
    for (const b of blockers) expect(b.reason.length).toBeGreaterThan(0);
  });

  it('carries the plan the project actually has, marking opt-in steps optional', () => {
    const plan = buildPlan(buildValueContext({ project: auxProject(), printer, nozzleIndex: 1 }));
    const ooze = plan.find((s) => s.id === 'ooze-control')!;
    expect(ooze).toBeDefined();
    expect(ooze.optional).toBe(true);
    expect(ooze.needsSlicing).toBe(false);
    expect(plan.filter((s) => s.optional).map((s) => s.id)).toEqual(['ooze-control']);
  });
});

describe('progressing through the plan', () => {
  it('opens the next step as each one completes', () => {
    const project = makeProject();
    let plan = buildPlan(ctxFor(project));
    expect(nextActionable(plan)).toBe('temperature');

    completeStep(project, 'temperature', { nozzleTemp: 245 }, T.t1);
    plan = buildPlan(ctxFor(project));
    expect(plan.find((s) => s.id === 'temperature')!.phase).toBe('complete');
    expect(nextActionable(plan)).toBe('flow-pass1');

    completeStep(project, 'flow-pass1', { flowRatio: 0.955 }, T.t2);
    plan = buildPlan(ctxFor(project));
    // `nextActionable` follows the plan's order…
    expect(nextActionable(plan)).toBe('flow-pass2');
    // …but readiness follows the dependency graph in calibrations.ts, where
    // pressure advance depends on flow-pass1 and not on the optional fine pass.
    expect(plan.find((s) => s.id === 'pressure-advance')!.phase).toBe('ready');
    expect(plan.find((s) => s.id === 'retraction')!.phase).toBe('blocked');
    expect(plan.find((s) => s.id === 'retraction')!.missingInputs).toEqual(['pressureAdvance']);
  });

  it('lets a skipped dependency pass once its value is known another way', () => {
    const project = makeProject();
    skipStep(project, 'temperature');
    expect(buildPlan(ctxFor(project)).find((s) => s.id === 'flow-pass1')!.phase).toBe('blocked');

    startGuidedSession(project, { printer, now: T.t1 });
    setSessionOverride(project, { key: 'nozzleTemp', value: 240, now: T.t2 });
    const plan = buildPlan(ctxFor(project));
    expect(plan.find((s) => s.id === 'temperature')!.phase).toBe('skipped');
    expect(plan.find((s) => s.id === 'flow-pass1')!.phase).toBe('ready');
  });

  it('reports progress over the project\'s own plan', () => {
    const project = tempAndFlowDone();
    const plan = buildPlan(ctxFor(project));
    expect(progressPercent(plan)).toBe(Math.round((2 / plan.length) * 100));
  });

  it('focuses an in-progress step over a merely ready one', () => {
    const project = tempAndFlowDone();
    project.steps['flow-pass2'].status = 'in-progress';
    const plan = buildPlan(ctxFor(project));
    expect(focusStep(plan)).toBe('flow-pass2');
  });
});

describe('staleness', () => {
  it('does not call a result stale just because a dependency ran earlier', () => {
    const project = tempAndFlowDone();
    expect(stepStaleness(ctxFor(project), 'flow-pass1').stale).toBe(false);
  });

  it('marks a result stale when its dependency is recalibrated afterwards', () => {
    const project = tempAndFlowDone();
    completeStep(project, 'temperature', { nozzleTemp: 250 }, T.t3); // re-run, later

    const staleness = stepStaleness(ctxFor(project), 'flow-pass1');
    expect(staleness.stale).toBe(true);
    expect(staleness.reasons[0].kind).toBe('dependency-recalibrated');
    expect(staleness.reasons[0].stepId).toBe('temperature');

    const plan = buildPlan(ctxFor(project));
    expect(plan.find((s) => s.id === 'flow-pass1')!.phase).toBe('stale');
    expect(plan.find((s) => s.id === 'temperature')!.phase).toBe('complete');
  });

  it('propagates through the transitive closure', () => {
    const project = tempAndFlowDone();
    completeStep(project, 'pressure-advance', { pressureAdvance: 0.04 }, T.t3);
    expect(stepStaleness(ctxFor(project), 'pressure-advance').stale).toBe(false);

    completeStep(project, 'temperature', { nozzleTemp: 250 }, T.t4);
    const reasons = stepStaleness(ctxFor(project), 'pressure-advance').reasons;
    expect(reasons.map((r) => r.stepId)).toContain('temperature');
  });

  it('honours the user\'s own retest flag', () => {
    const project = tempAndFlowDone();
    project.steps['flow-pass1'].retestRecommended = true;
    const staleness = stepStaleness(ctxFor(project), 'flow-pass1');
    expect(staleness.stale).toBe(true);
    expect(staleness.reasons.map((r) => r.kind)).toContain('retest-flagged');
  });

  it('reuses upstream\'s fingerprint rule for a prepared job', () => {
    const project = tempAndFlowDone();
    startGuidedSession(project, { printer, now: T.t3 });
    completeStep(project, 'pressure-advance', { pressureAdvance: 0.04 }, T.t4);

    const job: GeneratedJobRecord = {
      id: 'job-1',
      stepId: 'pressure-advance',
      nozzleIndex: 0,
      createdAt: T.t4,
      engineId: 'installed_orca',
      engineVersion: null,
      slicerMode: 'installed_orca',
      status: 'prepared',
      inputFingerprint: 'built-from-different-values',
      outputPath: null,
      sliced: false,
      warnings: []
    };
    project.generatedJobs = [job];

    const reasons = stepStaleness(ctxFor(project), 'pressure-advance').reasons;
    expect(reasons.map((r) => r.kind)).toContain('inputs-changed');
  });

  it('never lets one nozzle\'s prepared job stale the other nozzle\'s step', () => {
    const project = tempAndFlowDone();
    startGuidedSession(project, { printer, now: T.t3 });
    completeStep(project, 'pressure-advance', { pressureAdvance: 0.04 }, T.t4);
    project.generatedJobs = [
      {
        id: 'job-aux',
        stepId: 'pressure-advance',
        nozzleIndex: 1,
        createdAt: T.t4,
        engineId: 'installed_orca',
        engineVersion: null,
        slicerMode: 'installed_orca',
        status: 'prepared',
        inputFingerprint: 'something-else-entirely',
        outputPath: null,
        sliced: false,
        warnings: []
      }
    ];
    const reasons = stepStaleness(ctxFor(project), 'pressure-advance').reasons;
    expect(reasons.map((r) => r.kind)).not.toContain('inputs-changed');
  });

  it('only ever calls a COMPLETED step stale', () => {
    const project = makeProject();
    expect(stepStaleness(ctxFor(project), 'temperature')).toEqual({ stale: false, reasons: [] });
  });
});

describe('a nozzle the project does not itself record', () => {
  it('derives completion from that nozzle\'s working profile alone', () => {
    const project = tempAndFlowDone();
    startGuidedSession(project, { printer, now: T.t3 });

    // Nothing recorded on nozzle 2 yet, even though nozzle 1 is well underway.
    expect(stepRecord(ctxFor(project, 1), 'temperature').status).toBe('not-started');

    recordSessionResult(project, {
      stepId: 'temperature',
      values: { nozzleTemp: 250 },
      nozzleIndex: 1,
      now: T.t4
    });
    expect(stepRecord(ctxFor(project, 1), 'temperature').status).toBe('completed');
    expect(stepRecord(ctxFor(project, 1), 'temperature').completedAt).toBe(T.t4);
    // …and the project's own nozzle is untouched.
    expect(stepRecord(ctxFor(project, 0), 'temperature').completedAt).toBe(T.t1);
  });

  it('says plainly that the view is nozzle-scoped', () => {
    const project = tempAndFlowDone();
    const session = resolveGuidedSession({ project, printer, nozzleIndex: 1 });
    expect(session.warnings.join(' ')).toContain('Auxiliary (bowden)');
    expect(session.nozzle.auxiliary).toBe(true);
    expect(session.nozzle.feed).toBe('bowden');
  });
});
