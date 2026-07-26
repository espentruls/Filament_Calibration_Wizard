// ---------------------------------------------------------------------------
// "What to change right now" — routing, not authoring.
//
// Every string the action plan shows must be traceable to src/data/slicers.ts.
// The suite pins that down literally: one test walks every action of every step
// of every slicer and asserts the wording exists verbatim in the shipped
// content. If someone later writes a menu path by hand, it fails.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';

import {
  alerts,
  buildActionPlan,
  buildValueContext,
  resolveSessionNozzle,
  valueActions
} from '../../src/session';
import { getSlicerContent, SLICER_CONTENT } from '../../src/data/slicers';
import { CALIBRATIONS } from '../../src/data/calibrations';
import type { CalibrationId, SlicerId } from '../../src/types';
import {
  T,
  auxProject,
  completeStep,
  dualNozzlePrinter,
  makeProject,
  singleNozzlePrinter,
  tempAndFlowDone
} from './fixtures';

const dual = dualNozzlePrinter();

function planFor(
  stepId: CalibrationId,
  project = makeProject(),
  printer = dual,
  nozzleIndex?: number
) {
  const ctx = buildValueContext({ project, printer, nozzleIndex });
  const nozzle = resolveSessionNozzle(project, printer, nozzleIndex);
  return buildActionPlan(ctx, nozzle, stepId);
}

describe('routing the shipped instructions', () => {
  it('quotes Orca\'s own menu path and numbered steps', () => {
    const plan = planFor('temperature');
    const content = getSlicerContent('orca', '2.4.x');
    expect(plan.available).toBe(true);
    expect(plan.slicerLabel).toBe('Orca Slicer');
    expect(plan.menuPath).toBe(content.perTest.temperature!.menuPath);
    expect(plan.verifiedOn).toBe(content.verifiedOn);

    const perform = plan.actions.filter((a) => a.kind === 'perform');
    expect(perform.map((a) => a.detail)).toEqual(content.perTest.temperature!.steps);
    expect(perform[0].path).toBe(content.perTest.temperature!.menuPath);
  });

  it('quotes the destination field for the result', () => {
    const plan = planFor('temperature');
    const save = getSlicerContent('orca', '2.4.x').perTest.temperature!.saveTo;
    const record = plan.actions.find((a) => a.kind === 'record')!;
    expect(record.path).toBe(save.path);
    expect(record.field).toBe(save.field);
    expect(record.detail).toBe(save.note);
    expect(record.value).toBeUndefined(); // nothing measured yet
  });

  it('surfaces what to switch off first as a caution', () => {
    const plan = planFor('flow-pass1');
    const disable = plan.actions.filter((a) => a.kind === 'disable');
    expect(disable.length).toBeGreaterThan(0);
    expect(disable.every((a) => a.severity !== 'info')).toBe(true);
    expect(disable.map((a) => a.detail)).toEqual(
      getSlicerContent('orca', '2.4.x').perTest['flow-pass1']!.disableFirst
    );
  });

  it('keeps the actions in working order: carry, disable, perform, record, trap', () => {
    const plan = planFor('pressure-advance', tempAndFlowDone());
    const kinds = [...new Set(plan.actions.map((a) => a.kind))];
    const rank = ['carry-forward', 'disable', 'perform', 'record', 'trap'];
    expect(kinds).toEqual(rank.filter((k) => kinds.includes(k as never)));
    expect(plan.actions.map((a) => a.order)).toEqual(plan.actions.map((_, i) => i));
  });
});

describe('carrying measured values into the slicer', () => {
  it('tells the user to check the temperature and flow before the PA test', () => {
    const plan = planFor('pressure-advance', tempAndFlowDone());
    const carried = plan.actions.filter((a) => a.kind === 'carry-forward');
    expect(carried.map((a) => a.value)).toEqual(['245 °C', '0.955']);

    const temp = carried[0];
    const tempSave = getSlicerContent('orca', '2.4.x').perTest.temperature!.saveTo;
    expect(temp.fromStepId).toBe('temperature');
    expect(temp.path).toBe(tempSave.path);
    expect(temp.field).toBe(tempSave.field);
  });

  it('has nothing to carry into the first step', () => {
    const plan = planFor('temperature', tempAndFlowDone());
    expect(plan.actions.filter((a) => a.kind === 'carry-forward')).toEqual([]);
  });

  it('never asks the user to type a material default in as if it were measured', () => {
    const plan = planFor('pressure-advance'); // untouched project
    expect(valueActions(plan)).toEqual([]);
  });
});

describe('the bowden auxiliary nozzle on Bambu Studio', () => {
  const project = auxProject('bambu');

  it('names the per-extruder column for the retraction override', () => {
    const plan = planFor('retraction', project, dual, 1);
    const record = plan.actions.find((a) => a.kind === 'record')!;
    expect(plan.feed).toBe('bowden');
    expect(record.nozzleColumn).toBe('Bowden Extruder');
    expect(record.path).toContain('Setting Overrides');
  });

  it('raises the #10404 trap to an alert', () => {
    const plan = planFor('retraction', project, dual, 1);
    const alerting = alerts(plan);
    expect(alerting.length).toBeGreaterThan(0);
    expect(alerting.some((a) => a.detail.includes('#10404'))).toBe(true);
    expect(
      alerting.some((a) =>
        a.detail.includes('silently falls back to the MAIN 0.8 mm default on the auxiliary nozzle')
      )
    ).toBe(true);
  });

  it('carries the trap forward wherever the aux retraction value is entered', () => {
    const done = auxProject('bambu');
    completeStep(done, 'temperature', { nozzleTemp: 245 }, T.t1);
    completeStep(done, 'flow-pass1', { flowRatio: 0.955 }, T.t2);
    completeStep(done, 'pressure-advance', { pressureAdvance: 0.72 }, T.t3);
    completeStep(done, 'retraction', { retractionDistance: 3, retractionSpeed: 30 }, T.t4);

    const plan = planFor('ooze-control', done, dual, 1);
    const carriedRetraction = plan.actions.find(
      (a) => a.kind === 'carry-forward' && a.value === '3.00 mm'
    )!;
    expect(carriedRetraction.nozzleColumn).toBe('Bowden Extruder');
    expect(carriedRetraction.detail).toContain('#10404');
    expect(carriedRetraction.severity).toBe('alert');
  });

  it('states that K lives on the printer and needs the pre-print gear off', () => {
    const plan = planFor('pressure-advance', project, dual, 1);
    const record = plan.actions.find((a) => a.kind === 'record')!;
    expect(record.detail).toContain('K values are stored ON THE PRINTER, keyed to filament + nozzle');
    expect(record.detail).toContain(
      'Manual K only applies when the pre-print calibration gear in the send-to-print dialog is set to "Off"'
    );
  });

  it('surfaces the X2D auxiliary limits and the K-scale warning', () => {
    const plan = planFor('pressure-advance', project, dual, 1);
    const traps = plan.actions.filter((a) => a.kind === 'trap').map((a) => a.detail);
    expect(traps.some((t) => t.includes('X2D auxiliary-nozzle limits'))).toBe(true);
    expect(traps.some((t) => t.includes('Never compare automatic and manual K numbers'))).toBe(true);
  });

  it('mentions the nozzle selector the dual-nozzle PA dialog actually has', () => {
    const plan = planFor('pressure-advance', project, dual, 1);
    const perform = plan.actions.filter((a) => a.kind === 'perform').map((a) => a.detail);
    expect(perform.some((s) => s.includes('the calibration dialog shows a nozzle selector'))).toBe(true);
  });

  it('says so, instead of guessing, when the content names no per-extruder column', () => {
    const plan = planFor('pressure-advance', project, dual, 1);
    const record = plan.actions.find((a) => a.kind === 'record')!;
    expect(record.nozzleColumn).toBeUndefined();
    expect(plan.gaps.join(' ')).toContain('do not name a per-extruder column');
  });
});

describe('the direct-drive main nozzle', () => {
  it('picks the direct-drive column, not the bowden one', () => {
    const plan = planFor('retraction', makeProject({}, 'bambu'), dual, 0);
    const record = plan.actions.find((a) => a.kind === 'record')!;
    expect(record.nozzleColumn).toBe('Direct Drive Extruder');
  });

  it('raises no per-extruder gap on a single-nozzle machine', () => {
    const plan = planFor('pressure-advance', makeProject({}, 'bambu'), singleNozzlePrinter(), 0);
    expect(plan.gaps.join(' ')).not.toContain('per-extruder column');
  });
});

describe('never inventing a slicer fact', () => {
  const slicers: { id: SlicerId; version: string }[] = [
    { id: 'orca', version: '2.4.x' },
    { id: 'bambu', version: '1.7+' }
  ];

  it('every action\'s wording appears verbatim in src/data/slicers.ts', () => {
    for (const { id, version } of slicers) {
      const haystack = JSON.stringify(SLICER_CONTENT.filter((c) => c.slicer === id));
      const project = auxProject(id);
      completeStep(project, 'temperature', { nozzleTemp: 245, highFlowTemp: 255 }, T.t1);
      completeStep(project, 'flow-pass1', { flowRatio: 0.955 }, T.t2);
      completeStep(project, 'pressure-advance', { pressureAdvance: 0.72 }, T.t3);
      completeStep(project, 'retraction', { retractionDistance: 3, retractionSpeed: 30 }, T.t4);
      completeStep(project, 'max-volumetric-speed', { maxVolumetricSpeed: 9 }, T.t5);

      for (const stepId of project.stepOrder) {
        const plan = planFor(stepId, project, dual, 1);
        expect(plan.slicerVersion).toBe(version);
        for (const action of plan.actions) {
          expect(haystack, `${id}/${stepId}/${action.id} detail`).toContain(
            JSON.stringify(action.detail).slice(1, -1)
          );
          if (action.path) {
            expect(haystack, `${id}/${stepId}/${action.id} path`).toContain(
              JSON.stringify(action.path).slice(1, -1)
            );
          }
          if (action.field) {
            expect(haystack, `${id}/${stepId}/${action.id} field`).toContain(
              JSON.stringify(action.field).slice(1, -1)
            );
          }
          if (action.nozzleColumn) {
            expect(haystack).toContain(action.nozzleColumn);
          }
        }
      }
    }
  });

  it('produces an auditable source reference for every action', () => {
    const plan = planFor('retraction', auxProject('bambu'), dual, 1);
    for (const action of plan.actions) {
      expect(action.source).toMatch(/^slicers\.ts · (orca|bambu) \S+ · [a-z-]+ · /);
    }
  });

  it('covers every calibration in both slicers without falling back to a gap', () => {
    for (const { id } of slicers) {
      const project = auxProject(id);
      for (const stepId of Object.keys(CALIBRATIONS) as CalibrationId[]) {
        const plan = planFor(stepId, project, dual, 1);
        expect(
          plan.gaps.some((g) => g.includes('have no entry for')),
          `${id}/${stepId}`
        ).toBe(false);
      }
    }
  });
});
