// ---------------------------------------------------------------------------
// Nozzle awareness across the guided session's stored state.
//
// The session state was designed nozzle-blind: one flat working profile per
// session, and jobs keyed by step alone. On a dual-nozzle machine (the Bambu
// X2D's direct-drive main + bowden-fed auxiliary — the reason this product
// exists) that is not merely incomplete, it collides: two nozzles that need
// different retraction distances had one slot to put them in.
//
// These tests pin the nozzle down at every point it has to travel through.
//
// The cases that covered the assisted auto-prepare path — workspace directory
// naming, job preparation, engine multi-extruder capability reporting and
// per-extruder preset projection — went with that path when it was deleted
// before release. What remains below is the state the guided session still
// persists.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';

import {
  buildWorkingProfile,
  beginSession,
  setWorkingProfile,
  ensureWorkingProfile,
  getWorkingProfile,
  listWorkingProfiles,
  primaryNozzleIndex,
  profileNozzleIndex,
  createTemporaryProfile,
  validateSession,
  loadSessionSafe,
  applyStepResult,
  applyValue,
  inputFingerprintForStep,
  markStaleJobs,
  printerNozzleCount
} from '../../src/automatedCalibration';
// Module-local helper: exercised here, but deliberately not part of the
// automatedCalibration barrel's public surface.
import { workingProfileNozzles } from '../../src/automatedCalibration/session';
import type { GeneratedJobRecord } from '../../src/automatedCalibration';
import { createProject } from '../../src/storage/store';
import type { CalibrationProject, PrinterProfile } from '../../src/types';

const AT = '2026-07-26T00:00:00.000Z';

// --- fixtures ---------------------------------------------------------------

function makeProject(over: Partial<CalibrationProject> = {}): CalibrationProject {
  const p = createProject({
    filament: {
      manufacturer: 'Acme', productLine: 'Basic', material: 'PLA',
      color: 'Black', diameter: 1.75, startingProfile: 'Generic PLA'
    },
    printerProfileId: 'printer-1',
    nozzleType: 'brass',
    slicer: { slicer: 'orca', version: '2.4.x' },
    notes: '',
    mode: 'coach'
  });
  return Object.assign(p, over);
}

/** A session spanning both nozzles of a dual-nozzle machine. */
function dualNozzleSession(): CalibrationProject {
  const project = makeProject();
  const main = buildWorkingProfile({
    projectId: project.id, displayName: 'PLA — main', nozzleIndex: 0, now: AT
  });
  const aux = buildWorkingProfile({
    projectId: project.id, displayName: 'PLA — auxiliary', nozzleIndex: 1, now: AT
  });
  beginSession(project, {
    slicerMode: 'manual_export',
    workingProfile: main,
    additionalProfiles: [aux]
  });
  return project;
}

const X2D: Pick<PrinterProfile, 'nozzles' | 'extruderCount'> = {
  nozzles: [
    { label: 'Main (direct drive)', feed: 'direct' },
    { label: 'Auxiliary (bowden)', feed: 'bowden' }
  ]
};

// --- 1. one working profile per nozzle --------------------------------------

describe('a session holds one working profile per nozzle', () => {
  it('keeps two nozzles’ retraction distances side by side', () => {
    const project = dualNozzleSession();
    // Direct-drive main: short retraction. Bowden auxiliary: much longer.
    setWorkingProfile(
      project,
      applyStepResult(getWorkingProfile(project, 0)!, 'retraction', { retractionDistance: 0.8 })
    );
    setWorkingProfile(
      project,
      applyStepResult(getWorkingProfile(project, 1)!, 'retraction', { retractionDistance: 4.5 })
    );

    expect(getWorkingProfile(project, 0)!.values.retractionDistance).toBe(0.8);
    expect(getWorkingProfile(project, 1)!.values.retractionDistance).toBe(4.5);
    // …and neither profile invented a composite value key.
    expect(Object.keys(getWorkingProfile(project, 0)!.values)).toEqual(['retractionDistance']);
  });

  it('stamps a nozzle on every created profile (absent = main)', () => {
    const created = createTemporaryProfile({ id: 'wp', displayName: 'w', projectId: 'p' });
    expect(created.nozzleIndex).toBe(0);
    expect(buildWorkingProfile({ projectId: 'p', displayName: 'w', nozzleIndex: 1 }).nozzleIndex).toBe(1);
    // A legacy profile with no index reads as the main nozzle.
    expect(profileNozzleIndex({ nozzleIndex: undefined })).toBe(0);
  });

  it('applyValue preserves the profile’s nozzle', () => {
    const aux = buildWorkingProfile({ projectId: 'p', displayName: 'w', nozzleIndex: 1 });
    const next = applyValue(aux, 'pressureAdvance', 0.32, 'calibration_result', { now: AT });
    expect(next.nozzleIndex).toBe(1);
  });

  it('replacing one nozzle’s profile leaves the other untouched', () => {
    const project = dualNozzleSession();
    const mainBefore = getWorkingProfile(project, 0)!;
    setWorkingProfile(
      project,
      applyStepResult(getWorkingProfile(project, 1)!, 'pressure-advance', { pressureAdvance: 0.35 })
    );
    expect(getWorkingProfile(project, 0)).toBe(mainBefore);
    expect(getWorkingProfile(project, 0)!.values.pressureAdvance).toBeUndefined();
    expect(getWorkingProfile(project, 1)!.values.pressureAdvance).toBe(0.35);
  });

  it('lists the nozzles it holds, primary first, without duplicates', () => {
    const project = dualNozzleSession();
    expect(workingProfileNozzles(project)).toEqual([0, 1]);
    expect(listWorkingProfiles(project)).toHaveLength(2);
    expect(primaryNozzleIndex(project)).toBe(0);
  });

  it('getWorkingProfile with no index still returns the session’s primary profile', () => {
    const project = dualNozzleSession();
    expect(getWorkingProfile(project)).toBe(project.workingProfile);
  });

  it('reports no profile (rather than an empty one) for an untouched nozzle', () => {
    const project = makeProject();
    beginSession(project, {
      slicerMode: 'manual_export',
      workingProfile: buildWorkingProfile({ projectId: project.id, displayName: 'w' })
    });
    expect(getWorkingProfile(project, 1)).toBeUndefined();
  });

  it('ensureWorkingProfile creates a nozzle’s profile on first use only', () => {
    const project = makeProject();
    beginSession(project, {
      slicerMode: 'manual_export',
      workingProfile: buildWorkingProfile({ projectId: project.id, displayName: 'w' })
    });
    const aux = ensureWorkingProfile(project, 1, { displayName: 'PLA — auxiliary' });
    expect(aux.nozzleIndex).toBe(1);
    expect(ensureWorkingProfile(project, 1)).toBe(aux); // idempotent
    expect(workingProfileNozzles(project)).toEqual([0, 1]);
    expect(validateSession(project)).toEqual([]);
  });

  it('a session started on the auxiliary nozzle keeps it as its primary', () => {
    const project = makeProject({ nozzleIndex: 1 });
    beginSession(project, {
      slicerMode: 'manual_export',
      workingProfile: buildWorkingProfile({ projectId: project.id, displayName: 'aux', nozzleIndex: 1 })
    });
    expect(primaryNozzleIndex(project)).toBe(1);
    expect(getWorkingProfile(project, 1)).toBe(project.workingProfile);
    expect(getWorkingProfile(project, 0)).toBeUndefined();
  });

  it('rejects two profiles claiming the same nozzle, and sets a corrupt session aside', () => {
    const project = dualNozzleSession();
    project.workingProfiles = [
      buildWorkingProfile({ projectId: project.id, displayName: 'dup', nozzleIndex: 0 })
    ];
    const errors = validateSession(project);
    expect(errors.join(' ')).toMatch(/two working profiles claim nozzle 1/);

    const stepsBefore = JSON.stringify(project.steps);
    const res = loadSessionSafe(project);
    expect(res.degraded).toBe(true);
    expect(project.workingProfiles).toBeUndefined();
    expect(JSON.stringify(project.steps)).toBe(stepsBefore); // real data untouched
  });
});

// --- 2. fingerprints and staleness are per nozzle ---------------------------

describe('a step’s input fingerprint is per nozzle', () => {
  it('the same values on a different nozzle fingerprint differently', () => {
    const main = buildWorkingProfile({ projectId: 'p', displayName: 'w', nozzleIndex: 0 });
    const aux = buildWorkingProfile({ projectId: 'p', displayName: 'w', nozzleIndex: 1 });
    const a = applyStepResult(main, 'flow-pass1', { flowRatio: 0.98 });
    const b = applyStepResult(aux, 'flow-pass1', { flowRatio: 0.98 });
    expect(inputFingerprintForStep(a, 'pressure-advance')).not.toBe(
      inputFingerprintForStep(b, 'pressure-advance')
    );
    // An explicit index overrides the profile's own.
    expect(inputFingerprintForStep(a, 'pressure-advance', 1)).toBe(
      inputFingerprintForStep(b, 'pressure-advance')
    );
  });
});

describe('markStaleJobs isolates the nozzles', () => {
  function job(over: Partial<GeneratedJobRecord>): GeneratedJobRecord {
    return {
      id: 'j', stepId: 'pressure-advance', createdAt: AT, engineId: 'manual_export',
      engineVersion: null, slicerMode: 'manual_export', status: 'sliced',
      inputFingerprint: 'x', outputPath: '/tmp/plate_1.gcode', sliced: true, warnings: [],
      ...over
    };
  }

  function sessionWithJobPerNozzle(): CalibrationProject {
    const project = dualNozzleSession();
    for (const n of [0, 1]) {
      setWorkingProfile(
        project,
        applyStepResult(getWorkingProfile(project, n)!, 'flow-pass1', { flowRatio: 0.98 })
      );
    }
    project.generatedJobs = [0, 1].map((n) =>
      job({
        id: `job-pa-n${n}`,
        nozzleIndex: n,
        inputFingerprint: inputFingerprintForStep(getWorkingProfile(project, n), 'pressure-advance', n)
      })
    );
    return project;
  }

  it('a new result on one nozzle does not stale the other nozzle’s jobs', () => {
    const project = sessionWithJobPerNozzle();
    // Re-measure flow on the AUXILIARY nozzle only.
    setWorkingProfile(
      project,
      applyStepResult(getWorkingProfile(project, 1)!, 'flow-verify', { flowRatio: 0.94 })
    );
    const stale = markStaleJobs(project);
    expect(stale).toEqual(['job-pa-n1']);
    expect(project.generatedJobs!.find((j) => j.id === 'job-pa-n0')!.status).toBe('sliced');
    expect(project.generatedJobs!.find((j) => j.id === 'job-pa-n1')!.status).toBe('stale');
  });

  it('leaves both alone when nothing changed', () => {
    expect(markStaleJobs(sessionWithJobPerNozzle())).toEqual([]);
  });

  it('treats a job with no nozzle index as the session’s primary nozzle', () => {
    const project = dualNozzleSession();
    setWorkingProfile(
      project,
      applyStepResult(getWorkingProfile(project, 0)!, 'flow-pass1', { flowRatio: 0.98 })
    );
    project.generatedJobs = [
      job({
        id: 'legacy',
        inputFingerprint: inputFingerprintForStep(getWorkingProfile(project, 0), 'pressure-advance')
      })
    ];
    expect(markStaleJobs(project)).toEqual([]);
  });
});

// --- 3. how many nozzles the printer has ------------------------------------

describe('a printer’s nozzle count is read, never assumed', () => {
  it('counts nozzles from the profile, then from extruderCount', () => {
    expect(printerNozzleCount(X2D)).toBe(2);
    expect(printerNozzleCount({ extruderCount: 2 })).toBe(2);
    expect(printerNozzleCount({ extruderCount: 1 })).toBe(1);
    // The nozzles array wins — it is the profile the user edited.
    expect(printerNozzleCount({ nozzles: [{}], extruderCount: 4 })).toBe(1);
  });

  it('reports an unknown nozzle count as unknown, never as 1', () => {
    expect(printerNozzleCount(undefined)).toBe(0);
    expect(printerNozzleCount({})).toBe(0);
    expect(printerNozzleCount({ extruderCount: null })).toBe(0);
  });
});
