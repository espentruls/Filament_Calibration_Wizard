// ---------------------------------------------------------------------------
// Shared fixtures for the guided-session tests.
//
// Projects are built through the real `createProject` factory and completed
// exactly the way the classic wizard completes them (status + completedAt +
// attempt + a finals patch), so the session engine is always tested against the
// shape the app actually persists — not against a convenient invention.
// ---------------------------------------------------------------------------

import { createProject } from '../../src/storage/store';
import type {
  CalibrationId,
  CalibrationProject,
  FinalValues,
  PrinterProfile,
  SlicerId
} from '../../src/types';

export const T = {
  t1: '2026-07-20T10:00:00.000Z',
  t2: '2026-07-20T11:00:00.000Z',
  t3: '2026-07-20T12:00:00.000Z',
  t4: '2026-07-20T13:00:00.000Z',
  t5: '2026-07-20T14:00:00.000Z',
  t6: '2026-07-20T15:00:00.000Z'
};

/** A Bambu X2D-shaped machine: direct-drive main + bowden-fed auxiliary. */
export function dualNozzlePrinter(over: Partial<PrinterProfile> = {}): PrinterProfile {
  return {
    id: 'printer-x2d',
    name: 'Bambu Lab X2D',
    manufacturer: 'Bambu Lab',
    nozzleDiameter: 0.4,
    maxNozzleTemp: 320,
    maxBedTemp: 120,
    extruderType: 'direct',
    retractionRange: { start: 0, end: 2 },
    nozzles: [
      { label: 'Main (direct drive)', feed: 'direct' },
      { label: 'Auxiliary (bowden)', feed: 'bowden', maxSpeed: 200, maxAccel: 1000 }
    ],
    extruderCount: 2,
    notes: '',
    createdAt: T.t1,
    updatedAt: T.t1,
    ...over
  };
}

/** A plain single-nozzle direct-drive machine. */
export function singleNozzlePrinter(over: Partial<PrinterProfile> = {}): PrinterProfile {
  return {
    id: 'printer-p1s',
    name: 'Bambu Lab P1S',
    manufacturer: 'Bambu Lab',
    nozzleDiameter: 0.4,
    maxNozzleTemp: 300,
    maxBedTemp: 100,
    extruderType: 'direct',
    retractionRange: { start: 0, end: 2 },
    extruderCount: 1,
    notes: '',
    createdAt: T.t1,
    updatedAt: T.t1,
    ...over
  };
}

export function makeProject(over: Partial<CalibrationProject> = {}, slicer: SlicerId = 'orca'): CalibrationProject {
  const p = createProject({
    filament: {
      manufacturer: 'Acme',
      productLine: 'Basic',
      material: 'PETG',
      color: 'Black',
      diameter: 1.75,
      startingProfile: 'Generic PETG'
    },
    printerProfileId: 'printer-x2d',
    nozzleType: 'hardened steel',
    slicer: { slicer, version: slicer === 'orca' ? '2.4.x' : '1.7+' },
    notes: '',
    mode: 'coach'
  });
  Object.assign(p, over);
  return p;
}

/**
 * A project targeting the bowden-fed auxiliary nozzle, with the opt-in
 * ooze-control step spliced in exactly where New Project puts it.
 */
export function auxProject(slicer: SlicerId = 'bambu'): CalibrationProject {
  const p = makeProject({ nozzleIndex: 1 }, slicer);
  const at = p.stepOrder.indexOf('final-verification');
  p.stepOrder.splice(at === -1 ? p.stepOrder.length : at, 0, 'ooze-control');
  return p;
}

/** Complete a step the way `completeStep` in the wizard does. */
export function completeStep(
  project: CalibrationProject,
  stepId: CalibrationId,
  finals: Partial<FinalValues>,
  at: string
): CalibrationProject {
  const st = project.steps[stepId];
  if (st.current) st.history.unshift(st.current);
  st.current = {
    id: `${stepId}-${at}`,
    startedAt: at,
    completedAt: at,
    method: 'test',
    settings: {},
    result: {},
    computed: {},
    prerequisitesConfirmed: [],
    notes: '',
    photoIds: []
  };
  st.status = 'completed';
  st.completedAt = at;
  Object.assign(project.finals, finals);
  return project;
}

export function skipStep(project: CalibrationProject, stepId: CalibrationId): CalibrationProject {
  project.steps[stepId].status = 'skipped';
  return project;
}

/**
 * A project where temperature and flow are locked in — the "I want to install a
 * partial profile before tackling pressure advance" situation.
 */
export function tempAndFlowDone(slicer: SlicerId = 'orca'): CalibrationProject {
  const p = makeProject({}, slicer);
  completeStep(p, 'temperature', { nozzleTemp: 245, firstLayerTemp: 250, highFlowTemp: 255 }, T.t1);
  completeStep(p, 'flow-pass1', { flowRatio: 0.955 }, T.t2);
  return p;
}
