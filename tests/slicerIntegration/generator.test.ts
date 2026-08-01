import { describe, expect, it } from 'vitest';
import { getAdapter } from '../../src/slicerIntegration/adapters';
import { buildPatchesFromProject, defaultTargetExtruder, generateProfile } from '../../src/slicerIntegration/generator';
import { validateGeneratedProfile } from '../../src/slicerIntegration/validation';
import type { ParsedFilamentProfile } from '../../src/slicerIntegration/types';
import type { CalibrationProject } from '../../src/types';
import { fixtureRaw, USER_FIXTURES } from './fixtures';

function parseFixture(file: string, slicer: Parameters<typeof getAdapter>[0]): ParsedFilamentProfile {
  const adapter = getAdapter(slicer);
  const raw = fixtureRaw(file);
  const parsed = adapter.parseProfile(
    { kind: 'detected', fileName: file, json: raw.json, infoText: raw.info, filePath: raw.path },
    raw
  );
  if (!parsed) throw new Error(`fixture did not parse: ${file}`);
  return parsed;
}

function makeProject(overrides: Partial<CalibrationProject['finals']> = {}): CalibrationProject {
  const finals = {
    nozzleTemp: 235,
    flowRatio: 0.97,
    pressureAdvance: 0.035,
    retractionDistance: 0.8,
    maxVolumetricSpeed: 15,
    ...overrides
  };
  const completed = { status: 'completed' as const, current: null, history: [] };
  return {
    id: 'proj-1', createdAt: '', updatedAt: '', calibrationDate: '2026-07-19',
    filament: {
      manufacturer: 'Overture', productLine: '', material: 'PETG',
      color: 'Black', diameter: 1.75, startingProfile: 'Generic PETG'
    },
    printerProfileId: 'printer-1', nozzleType: 'brass',
    slicer: { slicer: 'orca', version: '2.4.x' }, notes: '', mode: 'expert',
    stepOrder: ['temperature', 'flow-pass1', 'flow-pass2', 'pressure-advance', 'flow-verify', 'retraction', 'max-volumetric-speed', 'shrinkage', 'final-verification'],
    steps: {
      'temperature': { ...completed },
      'flow-pass1': { ...completed },
      'flow-pass2': { ...completed },
      'pressure-advance': { ...completed },
      'flow-verify': { ...completed },
      'retraction': { ...completed },
      'max-volumetric-speed': { ...completed },
      'shrinkage': { ...completed },
      // Optional dual-nozzle step: present in the map (every CalibrationId is)
      // but not calibrated, so it must never contribute a patch.
      'ooze-control': { status: 'not-started' as const, current: null, history: [] },
      'final-verification': { ...completed }
    },
    timeline: [], archived: false, finals
  };
}

describe('buildPatchesFromProject', () => {
  it('only patches values backed by completed steps', () => {
    const project = makeProject();
    project.steps['pressure-advance'].status = 'skipped';
    const patches = buildPatchesFromProject(project);
    expect(patches.map(p => p.presetKey)).not.toContain('pressure_advance');
    expect(patches.map(p => p.presetKey)).toContain('nozzle_temperature');
  });

  it('never patches retraction speed unless it was calibrated', () => {
    const patches = buildPatchesFromProject(makeProject());
    expect(patches.map(p => p.presetKey)).not.toContain('filament_retraction_speed');
    const withSpeed = buildPatchesFromProject(makeProject({ retractionSpeed: 35 }));
    expect(withSpeed.map(p => p.presetKey)).toContain('filament_retraction_speed');
  });

  it('adds enable_pressure_advance as a companion of pressure_advance', () => {
    const pa = buildPatchesFromProject(makeProject()).find(p => p.presetKey === 'pressure_advance');
    expect(pa?.companions).toEqual([{ presetKey: 'enable_pressure_advance', value: '1' }]);
  });

  it('patches shrinkage only when calibrated, as a percent string', () => {
    expect(buildPatchesFromProject(makeProject()).map(p => p.presetKey)).not.toContain('filament_shrink');
    const withShrink = buildPatchesFromProject(makeProject({ shrinkagePercent: 99.4 }))
      .find(p => p.presetKey === 'filament_shrink');
    expect(withShrink?.value).toBe(99.4);
    expect(withShrink?.valueSuffix).toBe('%');
  });

  it('flow ratio is offered when only the post-PA re-check completed it', () => {
    const project = makeProject();
    project.steps['flow-pass1'].status = 'skipped';
    project.steps['flow-pass2'].status = 'skipped';
    const patches = buildPatchesFromProject(project);
    expect(patches.map(p => p.presetKey)).toContain('filament_flow_ratio');
  });

  it('serializes filament_shrink with the % suffix into the generated preset', () => {
    const { file, slicer } = USER_FIXTURES[0];
    const parsed = parseFixture(file, slicer);
    const project = makeProject({ shrinkagePercent: 99.4 });
    const generated = generateProfile({
      slicerId: slicer, baseProfile: parsed.profile, newName: 'PF Shrink Test',
      patches: buildPatchesFromProject(project),
      targetExtruderIndex: 0, applyToAllExtruders: false, project
    }, parsed);
    const reparsed = JSON.parse(generated.serialized) as Record<string, unknown>;
    expect((reparsed.filament_shrink as string[])[0]).toBe('99.4%');
  });
});

describe('clone-and-patch round trips (all slicer fixtures)', () => {
  for (const { file, slicer } of USER_FIXTURES) {
    it(`round-trips ${file}`, () => {
      const parsed = parseFixture(file, slicer);
      const project = makeProject();
      const patches = buildPatchesFromProject(project);
      const generated = generateProfile({
        slicerId: slicer,
        baseProfile: parsed.profile,
        newName: 'PerfectFit - Test PETG',
        patches,
        targetExtruderIndex: 0,
        applyToAllExtruders: false,
        project
      }, parsed);

      // 1. serialize → parse again
      const reparsed = JSON.parse(generated.serialized) as Record<string, unknown>;
      const original = parsed.profile.rawProfile as Record<string, unknown>;

      // 2. expected fields changed
      expect(reparsed.name).toBe('PerfectFit - Test PETG');
      expect(reparsed.from).toBe('User');
      expect(reparsed.filament_settings_id).toEqual(['PerfectFit - Test PETG']);
      expect((reparsed.nozzle_temperature as string[])[0]).toBe('235');
      expect((reparsed.filament_flow_ratio as string[])[0]).toBe('0.97');

      // 3. identity of the source never leaks
      expect(reparsed.setting_id).toBeUndefined();
      expect(reparsed.user_id).toBeUndefined();

      // 4. version + inherits copied from base, never invented
      expect(reparsed.version).toEqual(original.version);
      expect(reparsed.inherits).toEqual(original.inherits);

      // 5. every unrelated field survives byte-identical. filament_id is
      //    deliberately regenerated (Bambu dedupes clones by filament_id).
      const patchedKeys = new Set([
        ...patches.map(p => p.presetKey),
        ...patches.flatMap(p => (p.companions ?? []).map(c => c.presetKey)),
        'name', 'from', 'filament_settings_id', 'setting_id', 'user_id', 'filament_id'
      ]);
      for (const key of Object.keys(original)) {
        if (patchedKeys.has(key)) continue;
        expect(reparsed[key], `field ${key} must be preserved`).toEqual(original[key]);
      }

      // 5b. the clone ALWAYS gets a fresh filament_id — Bambu keys filaments
      //     by it, hiding id collisions and ignoring presets without one
      //     (system leaves inherit theirs, so the clone would otherwise have
      //     none at all).
      expect(String(reparsed.filament_id)).toMatch(/^P[0-9a-f]{7}$/);
      if (typeof original.filament_id === 'string' && original.filament_id) {
        expect(reparsed.filament_id).not.toEqual(original.filament_id);
      }

      // 6. the base was not mutated
      expect(parsed.profile.rawProfile).toEqual(JSON.parse(fixtureRaw(file).json));
    });
  }

  it('preserves unknown/future fields exactly (synthetic fixture)', () => {
    const parsed = parseFixture('synthetic-unknown-fields.json', 'orca');
    const project = makeProject();
    const generated = generateProfile({
      slicerId: 'orca', baseProfile: parsed.profile, newName: 'PF Unknown Test',
      patches: buildPatchesFromProject(project), targetExtruderIndex: 0,
      applyToAllExtruders: false, project
    }, parsed);
    const reparsed = JSON.parse(generated.serialized) as Record<string, unknown>;
    expect(reparsed.future_quantum_extrusion_mode).toEqual(['entangled']);
    expect(reparsed.future_nested_object).toEqual({ depth: 2, values: [1, 2, 3], flag: true });
    expect(reparsed.future_plain_string).toBe('keep me exactly');
    expect(reparsed.future_number).toBe(42.5);
    expect(reparsed.future_null).toBeNull();
  });

  it('patches only the selected nozzle on the dual-nozzle Bambu fixture', () => {
    const parsed = parseFixture('bambu-user-full-pctg-dualnozzle.json', 'bambu');
    expect(parsed.extruderCount).toBe(2);
    const project = makeProject();
    const generated = generateProfile({
      slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF Dual Test',
      patches: buildPatchesFromProject(project), targetExtruderIndex: 1,
      applyToAllExtruders: false, project
    }, parsed);
    const reparsed = JSON.parse(generated.serialized) as Record<string, unknown>;
    const original = parsed.profile.rawProfile as Record<string, unknown>;
    const temps = reparsed.nozzle_temperature as string[];
    const origTemps = original.nozzle_temperature as string[];
    expect(temps).toHaveLength(2);
    expect(temps[1]).toBe('235');       // selected nozzle patched
    expect(temps[0]).toBe(origTemps[0]); // other nozzle untouched
    // retraction was 'nil' per extruder; only target index gets a value
    const retract = reparsed.filament_retraction_length as string[];
    const origRetract = original.filament_retraction_length as string[];
    expect(retract[1]).toBe('0.8');
    expect(retract[0]).toBe(origRetract[0]);
  });

  it('companion values follow per-extruder targeting on the dual-nozzle fixture', () => {
    const parsed = parseFixture('bambu-user-full-pctg-dualnozzle.json', 'bambu');
    const project = makeProject();
    const generated = generateProfile({
      slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF Dual Companion',
      patches: buildPatchesFromProject(project), targetExtruderIndex: 1,
      applyToAllExtruders: false, project
    }, parsed);
    const reparsed = JSON.parse(generated.serialized) as Record<string, unknown>;
    // The UN-calibrated nozzle 0 must not silently get PA enabled.
    expect(reparsed.enable_pressure_advance).toEqual(['0', '1']);
    expect(reparsed.pressure_advance).toEqual(['0.02', '0.035']);
    const compChange = generated.changedFields.find(c => c.presetKey === 'enable_pressure_advance');
    expect(compChange?.extruderIndex).toBe(1);
  });

  it('defaults the target extruder from the project nozzleIndex, clamped to the profile shape', () => {
    const parsed = parseFixture('bambu-user-full-pctg-dualnozzle.json', 'bambu');
    expect(parsed.extruderCount).toBe(2);
    expect(defaultTargetExtruder({ nozzleIndex: 1 }, parsed.extruderCount)).toBe(1);
    expect(defaultTargetExtruder({}, parsed.extruderCount)).toBe(0);
    expect(defaultTargetExtruder({ nozzleIndex: 1 }, 1)).toBe(0);   // single-extruder base
    expect(defaultTargetExtruder({ nozzleIndex: 5 }, parsed.extruderCount)).toBe(1); // clamp
  });

  it('padding-only normalization records the padded slot honestly (before = null)', () => {
    // pressure_advance is stored as a 1-element array in the dual-nozzle
    // fixture; patching the exact stored value at index 0 still widens it.
    const parsed = parseFixture('bambu-user-full-pctg-dualnozzle.json', 'bambu');
    const project = makeProject({ pressureAdvance: 0.02 });
    const generated = generateProfile({
      slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF Pad Honesty',
      patches: buildPatchesFromProject(project), targetExtruderIndex: 0,
      applyToAllExtruders: false, project
    }, parsed);
    const change = generated.changedFields.find(c => c.presetKey === 'pressure_advance');
    expect(change).toBeDefined();
    expect(change!.before).toBeNull();       // the padded slot did not exist before
    expect(change!.after).toBe('0.02');      // it received a copy of the last value
    expect(change!.extruderIndex).toBe(1);   // and it is the padded position, not the target
  });

  // Regression: the per-extruder-array path was fixed, but the ABSENT-key path
  // still filled every slot with the calibrated value. On a dual-nozzle Bambu
  // that wrote the bowden auxiliary's K onto the direct-drive main nozzle.
  describe('absent keys on a multi-nozzle base never leak into untargeted nozzles', () => {
    function dualWithout(...keys: string[]): ParsedFilamentProfile {
      const parsed = parseFixture('bambu-user-full-pctg-dualnozzle.json', 'bambu');
      const raw = parsed.profile.rawProfile as Record<string, unknown>;
      for (const k of keys) delete raw[k];
      expect(parsed.extruderCount).toBe(2);
      return parsed;
    }

    it('does not write a nil-invalid key at all, and says why', () => {
      // Base preset never overrode pressure advance; the project calibrated the
      // bowden aux nozzle (slot 2) at K 0.72 — a value that would wreck the
      // direct-drive main nozzle, whose own range is 0–0.1.
      const parsed = dualWithout('pressure_advance', 'enable_pressure_advance');
      const project = makeProject({ pressureAdvance: 0.72 });
      const generated = generateProfile({
        slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF Aux PA',
        patches: buildPatchesFromProject(project), targetExtruderIndex: 1,
        applyToAllExtruders: false, project
      }, parsed);
      const reparsed = JSON.parse(generated.serialized) as Record<string, unknown>;
      expect(reparsed.pressure_advance).toBeUndefined();
      expect(reparsed.enable_pressure_advance).toBeUndefined();
      expect(generated.changedFields.some(c => c.presetKey === 'pressure_advance')).toBe(false);
      expect(generated.changedFields.some(c => c.presetKey === 'enable_pressure_advance')).toBe(false);
      const skipped = (generated.skippedFields ?? []).find(s => s.presetKey === 'pressure_advance');
      expect(skipped).toBeDefined();
      expect(skipped!.reason).toContain('pressure_advance');
      expect(skipped!.reason).toContain('0.72');
    });

    // The whole point of the withholding rule is that the reported list matches
    // what is on disk. When the parent patch is withheld its companions are
    // withheld too — so they have to be reported too, or the user is told one
    // field is missing from the preset when two are.
    it('reports the companions it withheld with the parent, not just the parent', () => {
      const parsed = dualWithout('pressure_advance', 'enable_pressure_advance');
      const project = makeProject({ pressureAdvance: 0.72 });
      const generated = generateProfile({
        slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF Aux PA Companion',
        patches: buildPatchesFromProject(project), targetExtruderIndex: 1,
        applyToAllExtruders: false, project
      }, parsed);
      const reparsed = JSON.parse(generated.serialized) as Record<string, unknown>;
      expect(reparsed.enable_pressure_advance).toBeUndefined();

      const skipped = (generated.skippedFields ?? []);
      expect(skipped.map(s => s.presetKey)).toContain('enable_pressure_advance');
      const comp = skipped.find(s => s.presetKey === 'enable_pressure_advance')!;
      // It must explain that it went with pressure_advance, not invent a reason
      // of its own — the user's fix is "set pressure advance by hand", once.
      expect(comp.reason).toContain('pressure_advance');
    });

    it('every calibrated key is either written or reported skipped — never silently dropped', () => {
      const parsed = dualWithout('pressure_advance', 'enable_pressure_advance');
      const project = makeProject({ pressureAdvance: 0.72 });
      const patches = buildPatchesFromProject(project);
      const generated = generateProfile({
        slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF Aux PA Ledger',
        patches, targetExtruderIndex: 1, applyToAllExtruders: false, project
      }, parsed);
      const reparsed = JSON.parse(generated.serialized) as Record<string, unknown>;
      const skippedKeys = new Set((generated.skippedFields ?? []).map(s => s.presetKey));

      const owned = patches.flatMap(p => [p.presetKey, ...(p.companions ?? []).map(c => c.presetKey)]);
      expect(owned).toContain('enable_pressure_advance');
      for (const key of owned) {
        const written = reparsed[key] !== undefined;
        expect(skippedKeys.has(key), `${key}: written=${written}, reportedSkipped=${skippedKeys.has(key)}`)
          .toBe(!written);
      }
    });

    it('fills untargeted slots with the no-override sentinel and reports every slot', () => {
      const parsed = dualWithout('filament_retraction_length');
      const project = makeProject({ retractionDistance: 3.5 });
      const generated = generateProfile({
        slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF Aux Retract',
        patches: buildPatchesFromProject(project), targetExtruderIndex: 1,
        applyToAllExtruders: false, project
      }, parsed);
      const reparsed = JSON.parse(generated.serialized) as Record<string, unknown>;
      expect(reparsed.filament_retraction_length).toEqual(['nil', '3.5']);
      // The change list must account for BOTH slots, not just the target.
      const rows = generated.changedFields.filter(c => c.presetKey === 'filament_retraction_length');
      expect(rows.map(r => [r.extruderIndex, r.after])).toEqual(
        expect.arrayContaining([[0, 'nil'], [1, '3.5']]));
    });

    it('still writes every slot when the user asked for all extruders', () => {
      const parsed = dualWithout('pressure_advance', 'enable_pressure_advance');
      const project = makeProject({ pressureAdvance: 0.72 });
      const generated = generateProfile({
        slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF All PA',
        patches: buildPatchesFromProject(project), targetExtruderIndex: 0,
        applyToAllExtruders: true, project
      }, parsed);
      const reparsed = JSON.parse(generated.serialized) as Record<string, unknown>;
      expect(reparsed.pressure_advance).toEqual(['0.72', '0.72']);
      expect(reparsed.enable_pressure_advance).toEqual(['1', '1']);
      expect(generated.skippedFields ?? []).toEqual([]);
    });

    it('single-extruder bases still gain missing keys', () => {
      const parsed = parseFixture('flashforge-user-delta-pctg.json', 'flash-studio');
      expect(parsed.extruderCount).toBe(1);
      const project = makeProject({ pressureAdvance: 0.05 });
      const generated = generateProfile({
        slicerId: 'flash-studio', baseProfile: parsed.profile, newName: 'PF Single PA',
        patches: buildPatchesFromProject(project), targetExtruderIndex: 0,
        applyToAllExtruders: false, project
      }, parsed);
      const reparsed = JSON.parse(generated.serialized) as Record<string, unknown>;
      expect(reparsed.pressure_advance).toEqual(['0.05']);
      expect(generated.skippedFields ?? []).toEqual([]);
    });
  });

  // Regression: the rule above only guarded bases that already carry TWO or
  // more slots. A SINGLE-slot base has no untargeted slot at all, so the guard
  // never fired — and defaultTargetExtruder() clamps the calibrated nozzle to
  // 0, so cloneAndPatch could not even see which nozzle was calibrated. The
  // aux-nozzle values went straight into the one slot Orca-family get_at(i)
  // hands to EVERY nozzle: a bowden K of 0.72 on the direct-drive main hotend.
  describe('a base too narrow to address the calibrated nozzle writes nothing', () => {
    /** Bambu X2D shape: main direct-drive nozzle + bowden auxiliary. */
    function auxProject(finals: Partial<CalibrationProject['finals']> = {}): CalibrationProject {
      const p = makeProject({ pressureAdvance: 0.72, retractionDistance: 3.5, ...finals });
      p.nozzleIndex = 1; // the BOWDEN auxiliary nozzle
      return p;
    }

    /** The real UI path: profileWizard clamps the target the same way. */
    function generateAux(parsed: ParsedFilamentProfile, project: CalibrationProject, extra: {
      applyToAllExtruders?: boolean; bakePressureAdvanceGcode?: boolean;
    } = {}) {
      return generateProfile({
        slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF Aux Narrow Base',
        patches: buildPatchesFromProject(project),
        targetExtruderIndex: defaultTargetExtruder(project, parsed.extruderCount),
        applyToAllExtruders: false, project, ...extra
      }, parsed);
    }

    it('leaves a single-slot base byte-identical and reports every withheld key', () => {
      const parsed = parseFixture('orca-user-delta-pla.json', 'orca');
      expect(parsed.extruderCount).toBe(1);
      const before = JSON.parse(JSON.stringify(parsed.profile.rawProfile)) as Record<string, unknown>;
      const project = auxProject();
      const generated = generateAux(parsed, project);
      const reparsed = JSON.parse(generated.serialized) as Record<string, unknown>;

      // The main nozzle's own calibration survives untouched…
      expect(reparsed.pressure_advance).toEqual(before.pressure_advance);
      expect(reparsed.nozzle_temperature).toEqual(before.nozzle_temperature);
      expect(reparsed.enable_pressure_advance).toEqual(before.enable_pressure_advance);
      // …and keys the base never had are not invented.
      expect(reparsed.filament_retraction_length).toBeUndefined();

      // Every calibrated key is either written or reported — never dropped.
      const patches = buildPatchesFromProject(project);
      const owned = patches.flatMap(p => [p.presetKey, ...(p.companions ?? []).map(c => c.presetKey)]);
      const skippedKeys = new Set((generated.skippedFields ?? []).map(s => s.presetKey));
      expect(owned.length).toBeGreaterThan(0);
      for (const key of owned) expect(skippedKeys.has(key), key).toBe(true);

      // The reported change list matches the file exactly: nothing, and nothing.
      expect(generated.changedFields).toEqual([]);
    });

    it('names the nozzle and the value it refused to write', () => {
      const parsed = parseFixture('orca-user-delta-pla.json', 'orca');
      const generated = generateAux(parsed, auxProject());
      const pa = (generated.skippedFields ?? []).find(s => s.presetKey === 'pressure_advance');
      expect(pa).toBeDefined();
      expect(pa!.reason).toContain('nozzle 2');
      expect(pa!.reason).toContain('0.72');
      expect(pa!.reason).toContain('EVERY nozzle');
      const comp = (generated.skippedFields ?? []).find(s => s.presetKey === 'enable_pressure_advance');
      expect(comp?.reason).toContain('pressure_advance');
    });

    it('withholds the Bambu M900 bake with the value it would have carried', () => {
      const parsed = parseFixture('orca-user-delta-pla.json', 'bambu');
      const generated = generateAux(parsed, auxProject(), { bakePressureAdvanceGcode: true });
      const reparsed = JSON.parse(generated.serialized) as Record<string, unknown>;
      // Start g-code runs on whichever nozzle prints the filament, so baking
      // the aux K there is the same cross-nozzle write by another road.
      expect(JSON.stringify(reparsed.filament_start_gcode ?? '')).not.toContain('M900');
      expect((generated.skippedFields ?? []).map(s => s.presetKey)).toContain('filament_start_gcode');
      expect(generated.changedFields.some(c => c.presetKey === 'filament_start_gcode')).toBe(false);
    });

    it('applies the same rule when a 2-slot base cannot reach nozzle 3', () => {
      const parsed = parseFixture('bambu-user-full-pctg-dualnozzle.json', 'bambu');
      expect(parsed.extruderCount).toBe(2);
      const project = auxProject();
      project.nozzleIndex = 2; // a third nozzle the base has no slot for
      const generated = generateAux(parsed, project);
      expect((generated.skippedFields ?? []).map(s => s.presetKey)).toContain('pressure_advance');
      expect(generated.changedFields).toEqual([]);
    });

    it('still writes normally when the calibrated nozzle is the only nozzle', () => {
      const parsed = parseFixture('orca-user-delta-pla.json', 'orca');
      const project = makeProject({ pressureAdvance: 0.05 });
      project.nozzleIndex = 0;
      const generated = generateAux(parsed, project);
      const reparsed = JSON.parse(generated.serialized) as Record<string, unknown>;
      expect(reparsed.pressure_advance).toEqual(['0.05']);
      expect(generated.skippedFields ?? []).toEqual([]);
    });

    it('honours an explicit "apply to all extruders", which validation still blocks', () => {
      const parsed = parseFixture('orca-user-delta-pla.json', 'orca');
      const project = auxProject();
      const generated = generateAux(parsed, project, { applyToAllExtruders: true });
      // The user asserted every nozzle takes these values, so the write is honest.
      const reparsed = JSON.parse(generated.serialized) as Record<string, unknown>;
      expect(reparsed.pressure_advance).toEqual(['0.72']);
      expect(generated.skippedFields ?? []).toEqual([]);
      // …but the preset still cannot address nozzle 2, so install stays blocked.
      const result = validateGeneratedProfile(generated, { project, baseProfile: parsed.profile });
      expect(result.errors.some(e => e.code === 'BASE_CANNOT_ADDRESS_NOZZLE')).toBe(true);
      expect(result.valid).toBe(false);
    });
  });

  it('applies to all extruders when explicitly requested', () => {
    const parsed = parseFixture('bambu-user-full-pctg-dualnozzle.json', 'bambu');
    const project = makeProject();
    const generated = generateProfile({
      slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF Dual All',
      patches: buildPatchesFromProject(project), targetExtruderIndex: 0,
      applyToAllExtruders: true, project
    }, parsed);
    const temps = (JSON.parse(generated.serialized) as Record<string, unknown>).nozzle_temperature as string[];
    expect(temps).toEqual(['235', '235']);
  });

  it('rejects a target extruder beyond the profile shape', () => {
    const parsed = parseFixture('bambu-user-full-pctg-dualnozzle.json', 'bambu');
    const project = makeProject();
    expect(() => generateProfile({
      slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF Bad Tool',
      patches: buildPatchesFromProject(project), targetExtruderIndex: 5,
      applyToAllExtruders: false, project
    }, parsed)).toThrow(/does not exist/);
  });

  it('adds missing keys to delta presets sized to the extruder count', () => {
    const parsed = parseFixture('flashforge-user-delta-pctg.json', 'flash-studio');
    const project = makeProject();
    const generated = generateProfile({
      slicerId: 'flash-studio', baseProfile: parsed.profile, newName: 'PF Delta Add',
      patches: buildPatchesFromProject(project), targetExtruderIndex: 0,
      applyToAllExtruders: false, project
    }, parsed);
    const reparsed = JSON.parse(generated.serialized) as Record<string, unknown>;
    // filament_max_volumetric_speed did not exist in the 12-key delta preset
    expect(reparsed.filament_max_volumetric_speed).toEqual(['15']);
  });

  it('writes a fresh .info sidecar; a USER base chains to its system ancestor base_id', () => {
    const adapter = getAdapter('orca');
    const raw = fixtureRaw('orca-user-delta-pla.json', {
      dir_kind: 'user',
      info: 'sync_info = \nuser_id = 1234567890\nsetting_id = ba3183ad\nbase_id = EPLAEOSG00\nupdated_time = 1781473826\n'
    });
    const parsed = adapter.parseProfile(
      { kind: 'detected', fileName: raw.file_name, json: raw.json, infoText: raw.info, filePath: raw.path },
      raw
    )!;
    const generated = generateProfile({
      slicerId: 'orca', baseProfile: parsed.profile, newName: 'PF Info Test',
      patches: buildPatchesFromProject(makeProject()), targetExtruderIndex: 0,
      applyToAllExtruders: false, project: makeProject()
    }, parsed);
    expect(generated.infoText).toContain('sync_info = create');
    expect(generated.infoText).toContain('user_id = \n');
    // Cloning a USER preset must NOT reuse its cloud setting_id (ba3183ad);
    // it chains to the base's own system ancestor (EPLAEOSG00).
    expect(generated.infoText).toContain('base_id = EPLAEOSG00');
    expect(generated.infoText).not.toContain('base_id = ba3183ad');
  });

  it('a SYSTEM base uses its own setting_id as base_id', () => {
    const adapter = getAdapter('orca');
    const sys = JSON.parse(fixtureRaw('orca-system-elegoo-pla.json').json);
    sys.setting_id = 'GFSL99'; // system presets carry their setting_id inline
    const raw = fixtureRaw('orca-system-elegoo-pla.json', {
      dir_kind: 'system', account_id: null, vendor: 'Elegoo', writable: false,
      json: JSON.stringify(sys)
    });
    const parsed = adapter.parseProfile(
      { kind: 'detected', fileName: raw.file_name, json: raw.json, infoText: null, filePath: raw.path },
      raw
    )!;
    const generated = generateProfile({
      slicerId: 'orca', baseProfile: parsed.profile, newName: 'PF System Base',
      patches: buildPatchesFromProject(makeProject()), targetExtruderIndex: 0,
      applyToAllExtruders: false, project: makeProject()
    }, parsed);
    expect(generated.infoText).toContain('base_id = GFSL99');
  });
});

// Regression: cloning a stock Bambu leaf must produce a preset shaped like one
// Bambu Studio itself saves — fresh filament_id (leaves inherit theirs, so the
// clone had NONE and the signed-in slicer never showed it), inherits pointing
// at the concrete leaf by name (not its abstract "@base" parent), and a schema
// version filled from the resolved chain.
describe('system-leaf clones carry Bambu-native identity (H2S visibility bug)', () => {
  function parseSystemLeaf() {
    const adapter = getAdapter('bambu');
    const leaf = {
      type: 'filament', name: 'Generic ASA @BBL H2S 0.4 nozzle', from: 'system',
      instantiation: 'true', inherits: 'Generic ASA @base', setting_id: 'GFSA00_H2S',
      // The real file carries this and no filament_extruder_variant of its own
      // (verified against system/BBL/filament in a live Bambu Studio install:
      // all 138 H2S presets resolve their legend through an include template,
      // none declares one). The slot legend is what says which hardware each
      // value slot belongs to, so it has to come from a real source here too.
      include: ['fdm_filament_template_direct_dual'],
      compatible_printers: ['Bambu Lab H2S 0.4 nozzle'],
      nozzle_temperature: ['260', '260'],
      filament_max_volumetric_speed: ['12', '12']
      // deliberately NO filament_id and NO version — both live in @base
    };
    const raw = fixtureRaw('orca-system-elegoo-pla.json', {
      dir_kind: 'system', account_id: null, vendor: 'BBL', writable: false,
      file_name: 'Generic ASA @BBL H2S 0.4 nozzle.json',
      json: JSON.stringify(leaf)
    });
    const parsed = getAdapter('bambu').parseProfile(
      { kind: 'detected', fileName: raw.file_name, json: raw.json, infoText: null, filePath: raw.path },
      raw
    )!;
    // scanner inheritance resolution supplies the version from the @base chain
    parsed.profile.profileVersion = '2.3.0.2';
    void adapter;
    return parsed;
  }

  it('assigns a fresh filament_id even though the leaf declares none', () => {
    const parsed = parseSystemLeaf();
    const generated = generateProfile({
      slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF H2S ASA',
      patches: buildPatchesFromProject(makeProject()), targetExtruderIndex: 0,
      applyToAllExtruders: false, project: makeProject()
    }, parsed);
    const reparsed = JSON.parse(generated.serialized) as Record<string, unknown>;
    expect(String(reparsed.filament_id)).toMatch(/^P[0-9a-f]{7}$/);
  });

  it('inherits the concrete leaf by name and fills the resolved version', () => {
    const parsed = parseSystemLeaf();
    const generated = generateProfile({
      slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF H2S ASA',
      patches: buildPatchesFromProject(makeProject()), targetExtruderIndex: 0,
      applyToAllExtruders: false, project: makeProject()
    }, parsed);
    const reparsed = JSON.parse(generated.serialized) as Record<string, unknown>;
    expect(reparsed.inherits).toBe('Generic ASA @BBL H2S 0.4 nozzle');
    expect(reparsed.version).toBe('2.3.0.2');
  });

  it('strips Bambu system-preset plumbing and materializes the RESOLVED slot legend', () => {
    // Every preset Bambu Studio itself writes into an account folder lacks
    // type/instantiation/include and declares filament_extruder_variant;
    // presets that deviate are not shown (verified on a real 2.7.x account).
    // The legend written here is the one the `include` template supplied — it
    // is copied, never invented (see the legend-less cases below).
    const parsed = parseSystemLeaf();
    const generated = generateProfile({
      slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF H2S ASA',
      patches: buildPatchesFromProject(makeProject()), targetExtruderIndex: 0,
      applyToAllExtruders: false, project: makeProject()
    }, parsed);
    const reparsed = JSON.parse(generated.serialized) as Record<string, unknown>;
    expect(reparsed.type).toBeUndefined();
    expect(reparsed.instantiation).toBeUndefined();
    expect(reparsed.include).toBeUndefined();
    expect(reparsed.filament_extruder_variant).toEqual(['Direct Drive Standard', 'Direct Drive High Flow']);
  });

  it('does not strip type from non-Bambu (Orca-family) clones', () => {
    const parsed = parseFixture('orca-user-delta-pla.json', 'orca');
    const original = parsed.profile.rawProfile as Record<string, unknown>;
    const generated = generateProfile({
      slicerId: 'orca', baseProfile: parsed.profile, newName: 'PF Orca Clone',
      patches: buildPatchesFromProject(makeProject()), targetExtruderIndex: 0,
      applyToAllExtruders: false, project: makeProject()
    }, parsed);
    const reparsed = JSON.parse(generated.serialized) as Record<string, unknown>;
    if ('type' in original) expect(reparsed.type).toEqual(original.type);
    expect(reparsed.filament_extruder_variant).toEqual(original.filament_extruder_variant);
  });

  it('keeps inherits untouched when cloning a user preset', () => {
    const parsed = parseFixture('bambu-user-full-pctg-dualnozzle.json', 'bambu');
    const original = parsed.profile.rawProfile as Record<string, unknown>;
    const generated = generateProfile({
      slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF User Clone',
      patches: buildPatchesFromProject(makeProject()), targetExtruderIndex: 0,
      applyToAllExtruders: false, project: makeProject()
    }, parsed);
    const reparsed = JSON.parse(generated.serialized) as Record<string, unknown>;
    expect(reparsed.inherits).toEqual(original.inherits);
  });
});

// Bambu Studio ignores the native pressure_advance field for Bambu machines
// (proven: it never reaches the sliced g-code; Flow Dynamics owns PA). The
// opt-in bake writes the calibrated K into the filament start g-code as the
// exact command Orca emits for Bambu printers. Orca-family targets, which do
// honor the native field, must never get this injection (it would double-apply).
describe('Bambu Studio: bake pressure advance into start g-code (M900)', () => {
  const startGcode = (gen: ReturnType<typeof generateProfile>) =>
    ((JSON.parse(gen.serialized) as Record<string, unknown>).filament_start_gcode as string[] | undefined) ?? [];

  it('injects "M900 K<v> L1000 M10" for a Bambu target when opted in', () => {
    const parsed = parseFixture('bambu-user-full-pctg-dualnozzle.json', 'bambu');
    const generated = generateProfile({
      slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF PA Bake',
      patches: buildPatchesFromProject(makeProject()), targetExtruderIndex: 0,
      applyToAllExtruders: false, bakePressureAdvanceGcode: true, project: makeProject()
    }, parsed);
    expect(startGcode(generated).some(s => s.includes('M900 K0.035 L1000 M10'))).toBe(true);
  });

  it('does not inject when the toggle is off', () => {
    const parsed = parseFixture('bambu-user-full-pctg-dualnozzle.json', 'bambu');
    const generated = generateProfile({
      slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF No Bake',
      patches: buildPatchesFromProject(makeProject()), targetExtruderIndex: 0,
      applyToAllExtruders: false, bakePressureAdvanceGcode: false, project: makeProject()
    }, parsed);
    expect(startGcode(generated).some(s => s.includes('M900'))).toBe(false);
  });

  it('never injects for Orca-family targets even when requested (avoids double-apply)', () => {
    const parsed = parseFixture('orca-user-delta-pla.json', 'orca');
    const generated = generateProfile({
      slicerId: 'orca', baseProfile: parsed.profile, newName: 'PF Orca NoBake',
      patches: buildPatchesFromProject(makeProject()), targetExtruderIndex: 0,
      applyToAllExtruders: false, bakePressureAdvanceGcode: true, project: makeProject()
    }, parsed);
    expect(startGcode(generated).some(s => s.includes('M900'))).toBe(false);
  });

  it('preserves existing start g-code and replaces a prior baked line on regenerate', () => {
    const parsed = parseFixture('bambu-user-full-pctg-dualnozzle.json', 'bambu');
    // Simulate regenerating from a profile that already carries a stale bake,
    // written by the app BEFORE the 3.0.0 rename - so it carries the legacy
    // "; PerfectFit pressure advance" marker, not the current one. If the
    // stripper only matched the current marker this would silently stack a
    // second M900 on top of the stale one, handing the printer two conflicting
    // K values in a single start G-code. That is why the legacy marker is still
    // matched (never written) in generator.ts.
    (parsed.profile.rawProfile as Record<string, unknown>).filament_start_gcode =
      ['; my custom start\nM900 K9.9 L1000 M10 ; PerfectFit pressure advance'];
    const generated = generateProfile({
      slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF PA Rebake',
      patches: buildPatchesFromProject(makeProject()), targetExtruderIndex: 0,
      applyToAllExtruders: false, bakePressureAdvanceGcode: true, project: makeProject()
    }, parsed);
    const joined = startGcode(generated).join('\n');
    expect(joined).toContain('; my custom start');       // user content kept
    expect(joined).toContain('M900 K0.035 L1000 M10');   // new value applied
    expect(joined).not.toContain('K9.9');                // stale line removed, not stacked
  });

  it('does not inject when pressure advance was not calibrated', () => {
    const parsed = parseFixture('bambu-user-full-pctg-dualnozzle.json', 'bambu');
    const project = makeProject();
    project.steps['pressure-advance'].status = 'skipped';
    const generated = generateProfile({
      slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF PA Skipped',
      patches: buildPatchesFromProject(project), targetExtruderIndex: 0,
      applyToAllExtruders: false, bakePressureAdvanceGcode: true, project
    }, parsed);
    expect(startGcode(generated).some(s => s.includes('M900'))).toBe(false);
  });
});
