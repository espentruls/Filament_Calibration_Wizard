import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';

import {
  buildWorkingProfile,
  beginSession,
  canTransition,
  setSessionStatus,
  cancelSession,
  completeSession,
  validateWorkingProfile,
  validateSession,
  loadSessionSafe,
  hasAutomatedSession,
  isResumable,
  resumableSessions,
  getWorkingProfile,
  setWorkingProfile,
  applyStepResult
} from '../../src/automatedCalibration';
import { startGuidedSession } from '../../src/session/session';
import { createProject, saveProject, getProject } from '../../src/storage/store';
import type { CalibrationProject } from '../../src/types';

function makeProject(): CalibrationProject {
  return createProject({
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
}

function startedProject(): CalibrationProject {
  const p = makeProject();
  const wp = buildWorkingProfile({
    projectId: p.id,
    displayName: 'PLA working',
    sourceProfileName: 'Generic PLA',
    seeds: [
      { key: 'bedTemp', value: 60, source: 'material_default' },
      { key: 'nozzleTemp', value: 210, source: 'material_default' }
    ]
  });
  return beginSession(p, { slicerMode: 'installed_orca', engineId: 'installed_orca', workingProfile: wp });
}

describe('buildWorkingProfile', () => {
  it('creates a profile seeded with provenance-tagged values', () => {
    const wp = buildWorkingProfile({
      projectId: 'proj1',
      displayName: 'PLA',
      seeds: [{ key: 'bedTemp', value: 60, source: 'material_default' }]
    });
    expect(wp.createdForProjectId).toBe('proj1');
    expect(wp.values.bedTemp).toBe(60);
    expect(wp.provenance.bedTemp.source).toBe('material_default');
    expect(wp.id).toBeTruthy();
  });
});

describe('beginSession', () => {
  it('attaches an automated session without touching calibration results', () => {
    const p = makeProject();
    const stepsBefore = JSON.stringify(p.steps);
    const finalsBefore = JSON.stringify(p.finals);
    startAndAssert(p);
    // results untouched
    expect(JSON.stringify(p.steps)).toBe(stepsBefore);
    expect(JSON.stringify(p.finals)).toBe(finalsBefore);
  });

  function startAndAssert(p: CalibrationProject) {
    const wp = buildWorkingProfile({ projectId: p.id, displayName: 'w' });
    beginSession(p, { slicerMode: 'managed_orca', workingProfile: wp });
    expect(p.sessionStatus).toBe('created');
    expect(p.slicerMode).toBe('managed_orca');
    expect(p.workingProfile).toBe(wp);
    expect(p.generatedJobs).toEqual([]);
    expect(hasAutomatedSession(p)).toBe(true);
  }
});

describe('status transitions', () => {
  it('allows legal moves and same-status no-ops', () => {
    expect(canTransition('created', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'waiting_for_print')).toBe(true);
    expect(canTransition('waiting_for_result', 'completed')).toBe(true);
    expect(canTransition('failed', 'in_progress')).toBe(true);
    expect(canTransition('created', 'created')).toBe(true);
  });

  it('rejects illegal and post-terminal moves', () => {
    expect(canTransition('created', 'completed')).toBe(false);
    expect(canTransition('completed', 'in_progress')).toBe(false);
    expect(canTransition('cancelled', 'in_progress')).toBe(false);
  });

  it('setSessionStatus applies legal transitions and refuses illegal ones', () => {
    const p = startedProject();
    expect(setSessionStatus(p, 'in_progress').ok).toBe(true);
    expect(p.sessionStatus).toBe('in_progress');

    const bad = setSessionStatus(p, 'created');
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/cannot move/i);
    expect(p.sessionStatus).toBe('in_progress'); // unchanged
  });

  it('complete then no further transitions', () => {
    const p = startedProject();
    setSessionStatus(p, 'in_progress');
    expect(completeSession(p).ok).toBe(true);
    expect(p.sessionStatus).toBe('completed');
    expect(cancelSession(p).ok).toBe(false);
  });

  it('setSessionStatus on a project with no session fails cleanly', () => {
    const p = makeProject();
    const r = setSessionStatus(p, 'in_progress');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no automated session/i);
  });
});

describe('validation', () => {
  it('accepts a well-formed session', () => {
    expect(validateSession(startedProject())).toEqual([]);
  });

  it('flags provenance without a matching value', () => {
    const wp = buildWorkingProfile({ projectId: 'p', displayName: 'w' });
    // corrupt: provenance key with no value
    (wp.provenance as Record<string, unknown>).ghost = { source: 'user_input', updatedAt: 'x' };
    const errs = validateWorkingProfile(wp);
    expect(errs.some((e) => e.includes('ghost'))).toBe(true);
  });

  it('flags a missing working profile', () => {
    expect(validateWorkingProfile(undefined).length).toBeGreaterThan(0);
    expect(validateWorkingProfile(null).length).toBeGreaterThan(0);
  });
});

describe('loadSessionSafe (corruption recovery)', () => {
  it('passes a clean session through unchanged', () => {
    const p = startedProject();
    const res = loadSessionSafe(p);
    expect(res.automated).toBe(true);
    expect(res.degraded).toBe(false);
    expect(res.warnings).toEqual([]);
    expect(p.workingProfile).toBeDefined();
  });

  it('reports "no session" for a plain manual project', () => {
    const res = loadSessionSafe(makeProject());
    expect(res.automated).toBe(false);
    expect(res.degraded).toBe(false);
  });

  it('sets aside a corrupt session but preserves calibration data', () => {
    const p = startedProject();
    // Simulate corruption: session status present but working profile broken.
    (p as unknown as { workingProfile: unknown }).workingProfile = { id: '', values: null };
    const timelineBefore = p.timeline.length;
    const stepsBefore = JSON.stringify(p.steps);

    const res = loadSessionSafe(p);
    expect(res.automated).toBe(false);
    expect(res.degraded).toBe(true);
    expect(res.warnings.length).toBeGreaterThan(0);
    // session scaffolding stripped…
    expect(p.sessionStatus).toBeUndefined();
    expect(p.workingProfile).toBeUndefined();
    // …but real user data untouched.
    expect(JSON.stringify(p.steps)).toBe(stepsBefore);
    expect(p.timeline.length).toBe(timelineBefore);
  });
});

// ---------------------------------------------------------------------------
// One corrupt working profile must never take a VALID one with it.
//
// On a dual-nozzle machine (the Bambu X2D's direct-drive main + bowden-fed
// auxiliary) `workingProfiles` holds the auxiliary nozzle's measurements — the
// ONLY record of them. Discarding that array because a DIFFERENT nozzle's
// profile is malformed is silent, permanent data loss.
// ---------------------------------------------------------------------------

/** A dual-nozzle session with real measured values on BOTH nozzles. */
function dualNozzleMeasured(): CalibrationProject {
  const p = makeProject();
  const main = buildWorkingProfile({
    projectId: p.id, displayName: 'PLA — main (direct drive)', nozzleIndex: 0
  });
  const aux = buildWorkingProfile({
    projectId: p.id, displayName: 'PLA — auxiliary (bowden)', nozzleIndex: 1
  });
  beginSession(p, {
    slicerMode: 'installed_orca',
    engineId: 'installed_orca',
    workingProfile: applyStepResult(main, 'retraction', { retractionDistance: 0.8 }),
    additionalProfiles: [
      applyStepResult(
        applyStepResult(aux, 'retraction', { retractionDistance: 4.5 }),
        'pressure-advance',
        { pressureAdvance: 0.062 }
      )
    ]
  });
  return p;
}

/** Corrupt ONLY the primary (main-nozzle) profile, in place. */
function corruptPrimary(p: CalibrationProject): void {
  (p as unknown as { workingProfile: unknown }).workingProfile = { id: '', values: null };
}

describe('loadSessionSafe salvages each working profile independently', () => {
  it('REGRESSION: keeps the AUXILIARY nozzle’s measurements when only the primary is corrupt', () => {
    const p = dualNozzleMeasured();
    corruptPrimary(p);

    const res = loadSessionSafe(p);

    expect(res.degraded).toBe(true);
    // The corrupt primary is gone…
    expect(p.workingProfile).toBeUndefined();
    // …but the auxiliary nozzle's measurements SURVIVE. They are the only copy.
    const aux = getWorkingProfile(p, 1);
    expect(aux).toBeDefined();
    expect(aux!.values.retractionDistance).toBe(4.5);
    expect(aux!.values.pressureAdvance).toBe(0.062);
    expect(aux!.provenance.retractionDistance.source).toBe('calibration_result');
  });

  it('names precisely what was set aside, and does not implicate the survivor', () => {
    const p = dualNozzleMeasured();
    corruptPrimary(p);
    const { warnings } = loadSessionSafe(p);

    const aside = warnings.find((w) => /set aside/i.test(w))!;
    expect(aside).toMatch(/nozzle 1/);      // the corrupt one, named…
    expect(aside).not.toMatch(/nozzle 2/);  // …and only that one

    const kept = warnings.find((w) => /kept/i.test(w))!;
    expect(kept).toMatch(/nozzle 2/);
    expect(kept).toMatch(/"PLA — auxiliary \(bowden\)"/);
    expect(warnings.join(' ')).toMatch(/calibration results .*are unaffected/i);
  });

  it('drops only a corrupt EXTRA profile and leaves the session usable', () => {
    const p = dualNozzleMeasured();
    (p.workingProfiles as unknown[])[0] = { id: 'x', values: null };

    const res = loadSessionSafe(p);
    expect(res.degraded).toBe(true);
    expect(res.automated).toBe(true); // primary is fine — the session still runs
    expect(getWorkingProfile(p, 0)!.values.retractionDistance).toBe(0.8);
    expect(getWorkingProfile(p, 1)).toBeUndefined();
    expect(validateSession(p)).toEqual([]);
  });

  it('keeps BOTH nozzles’ measurements when only the session status is corrupt', () => {
    const p = dualNozzleMeasured();
    (p as unknown as { sessionStatus: unknown }).sessionStatus = 'exploded';

    const res = loadSessionSafe(p);
    expect(res.degraded).toBe(true);
    expect(res.automated).toBe(false);       // no usable session…
    expect(p.sessionStatus).toBeUndefined(); // …the bad status is set aside…
    // …but neither nozzle's measurements are.
    expect(getWorkingProfile(p, 0)!.values.retractionDistance).toBe(0.8);
    expect(getWorkingProfile(p, 1)!.values.retractionDistance).toBe(4.5);
  });

  it('a restarted session reattaches the salvaged auxiliary profile', () => {
    const p = dualNozzleMeasured();
    corruptPrimary(p);
    loadSessionSafe(p);

    // The user starts again on the main nozzle.
    startGuidedSession(p, { nozzleIndex: 0 });
    expect(hasAutomatedSession(p)).toBe(true);
    expect(getWorkingProfile(p, 0)!.values.retractionDistance).toBeUndefined();
    expect(getWorkingProfile(p, 1)!.values.retractionDistance).toBe(4.5);
    expect(validateSession(p)).toEqual([]);
  });

  it('recovery is idempotent: a second load salvages nothing and warns about nothing', () => {
    const p = dualNozzleMeasured();
    corruptPrimary(p);
    expect(loadSessionSafe(p).degraded).toBe(true);

    const second = loadSessionSafe(p);
    expect(second.degraded).toBe(false);
    expect(second.warnings).toEqual([]);
    expect(getWorkingProfile(p, 1)!.values.retractionDistance).toBe(4.5);
  });

  it('resolves two profiles claiming one nozzle by keeping the MEASURED one', () => {
    const p = dualNozzleMeasured();
    // Corruption duplicates the auxiliary nozzle: an empty record ahead of the
    // measured one. Reading finds the empty one first — so a naive "keep the
    // first" repair would quietly throw the measurements away.
    p.workingProfiles!.unshift(
      buildWorkingProfile({ projectId: p.id, displayName: 'empty duplicate', nozzleIndex: 1 })
    );

    const res = loadSessionSafe(p);
    expect(res.degraded).toBe(true);
    expect(res.automated).toBe(true);
    expect(getWorkingProfile(p, 1)!.values.retractionDistance).toBe(4.5);
    expect(getWorkingProfile(p, 1)!.values.pressureAdvance).toBe(0.062);
    expect(p.workingProfiles).toHaveLength(1);
    expect(res.warnings.join(' ')).toMatch(/"empty duplicate".*was set aside/);
    expect(validateSession(p)).toEqual([]);
  });

  it('a write after recovery does not hijack the empty primary slot', () => {
    const p = dualNozzleMeasured();
    corruptPrimary(p);
    loadSessionSafe(p);
    expect(p.workingProfile).toBeUndefined(); // the main nozzle's slot is empty

    // A writer updates the AUXILIARY nozzle — this is exactly what
    // `syncSessionValues` / `clearSessionOverride` do, and they run whether or
    // not the primary slot was refilled first. The auxiliary profile must not be
    // promoted into the main nozzle's slot while its own entry still stands, or
    // two records end up claiming nozzle 2 and the next load has to guess.
    setWorkingProfile(
      p,
      applyStepResult(getWorkingProfile(p, 1)!, 'flow-pass1', { flowRatio: 0.97 })
    );

    expect(validateSession(p).some((e) => /two working profiles/.test(e))).toBe(false);
    expect(getWorkingProfile(p, 0)).toBeUndefined();
    expect(getWorkingProfile(p, 1)!.values.flowRatio).toBe(0.97);
    expect(getWorkingProfile(p, 1)!.values.retractionDistance).toBe(4.5);
    // …so the next load has nothing left to set aside.
    expect(loadSessionSafe(p).degraded).toBe(false);
  });

  it('leaves a project with NOTHING salvageable as a clean manual project', () => {
    const p = dualNozzleMeasured();
    corruptPrimary(p);
    (p.workingProfiles as unknown[])[0] = { id: '', values: null };

    const res = loadSessionSafe(p);
    expect(res.degraded).toBe(true);
    expect(res.automated).toBe(false);
    expect(p.workingProfile).toBeUndefined();
    expect(p.workingProfiles).toBeUndefined();
    expect(p.sessionStatus).toBeUndefined();
    expect(p.generatedJobs).toBeUndefined();
  });

  it('a single-nozzle session with a corrupt profile leaves no session traces', () => {
    const p = makeProject();
    beginSession(p, {
      slicerMode: 'installed_orca',
      workingProfile: buildWorkingProfile({ projectId: p.id, displayName: 'w' })
    });
    expect(p.workingProfiles).toEqual([]); // the normal single-nozzle shape
    corruptPrimary(p);

    expect(loadSessionSafe(p).degraded).toBe(true);
    // No empty scaffolding left behind claiming the project still has a session.
    expect(p.workingProfiles).toBeUndefined();
    expect(loadSessionSafe(p)).toMatchObject({ automated: false, degraded: false, warnings: [] });
  });
});

describe('resume queries', () => {
  it('isResumable is true for in-progress sessions, false for terminal', () => {
    const p = startedProject();
    setSessionStatus(p, 'in_progress');
    expect(isResumable(p)).toBe(true);
    completeSession(p);
    expect(isResumable(p)).toBe(false);
  });

  it('resumableSessions filters a mixed list', () => {
    const active = startedProject();
    const done = startedProject();
    setSessionStatus(done, 'in_progress');
    completeSession(done);
    const manual = makeProject();
    const list = resumableSessions([active, done, manual]);
    expect(list).toContain(active);
    expect(list).not.toContain(done);
    expect(list).not.toContain(manual);
  });
});

describe('durability across a simulated restart (IndexedDB)', () => {
  it('a working profile and session survive save + reload', async () => {
    const p = startedProject();
    setSessionStatus(p, 'in_progress');
    await saveProject(p);

    const reloaded = await getProject(p.id);
    expect(reloaded).toBeDefined();
    expect(reloaded!.sessionStatus).toBe('in_progress');
    expect(reloaded!.slicerMode).toBe('installed_orca');
    expect(reloaded!.workingProfile?.values.nozzleTemp).toBe(210);
    expect(reloaded!.workingProfile?.provenance.nozzleTemp.source).toBe('material_default');
    expect(Array.isArray(reloaded!.generatedJobs)).toBe(true);

    // and the reloaded session validates + is resumable
    expect(validateSession(reloaded!)).toEqual([]);
    expect(isResumable(reloaded!)).toBe(true);
  });

  it('the auxiliary nozzle’s salvaged measurements survive save + reload', async () => {
    const p = dualNozzleMeasured();
    corruptPrimary(p);
    loadSessionSafe(p);
    await saveProject(p);

    const reloaded = (await getProject(p.id))!;
    const aux = getWorkingProfile(reloaded, 1)!;
    expect(aux.values.retractionDistance).toBe(4.5);
    expect(aux.values.pressureAdvance).toBe(0.062);
    // …and re-reading it does not degrade a second time.
    expect(loadSessionSafe(reloaded).degraded).toBe(false);
    expect(getWorkingProfile(reloaded, 1)!.values.retractionDistance).toBe(4.5);
  });
});
