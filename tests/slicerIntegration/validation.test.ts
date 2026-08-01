import { describe, expect, it } from 'vitest';
import { getAdapter } from '../../src/slicerIntegration/adapters';
import { buildPatchesFromProject, defaultTargetExtruder, generateProfile } from '../../src/slicerIntegration/generator';
import { summarizeDiff, formatChange, fullJsonDiff } from '../../src/slicerIntegration/diff';
import { unacknowledgedWarnings, validateGeneratedProfile } from '../../src/slicerIntegration/validation';
import type { GeneratedFilamentProfile, ParsedFilamentProfile } from '../../src/slicerIntegration/types';
import type { CalibrationProject, PrinterProfile } from '../../src/types';
import { fixtureRaw } from './fixtures';

function parseFixture(
  file: string,
  slicer: Parameters<typeof getAdapter>[0] = 'orca',
  overrides: Parameters<typeof fixtureRaw>[1] = {}
): ParsedFilamentProfile {
  const raw = fixtureRaw(file, overrides);
  return getAdapter(slicer).parseProfile(
    { kind: 'detected', fileName: file, json: raw.json, infoText: raw.info, filePath: raw.path },
    raw
  )!;
}

function makeProject(finalsOverrides: Partial<CalibrationProject['finals']> = {}): CalibrationProject {
  const completed = { status: 'completed' as const, current: null, history: [] };
  return {
    id: 'proj-1', createdAt: '', updatedAt: '', calibrationDate: '',
    filament: { manufacturer: 'Elegoo', productLine: '', material: 'PLA', color: 'Grey', diameter: 1.75, startingProfile: '' },
    printerProfileId: 'pr', nozzleType: 'brass', slicer: { slicer: 'orca', version: '2.4.x' },
    notes: '', mode: 'expert',
    stepOrder: ['temperature', 'flow-pass1', 'flow-pass2', 'pressure-advance', 'flow-verify', 'retraction', 'max-volumetric-speed', 'shrinkage', 'final-verification'],
    steps: {
      'temperature': { ...completed }, 'flow-pass1': { ...completed }, 'flow-pass2': { ...completed },
      'pressure-advance': { ...completed }, 'flow-verify': { ...completed }, 'retraction': { ...completed },
      'max-volumetric-speed': { ...completed }, 'shrinkage': { ...completed },
      // Optional dual-nozzle step — carried but not calibrated here.
      'ooze-control': { status: 'not-started', current: null, history: [] },
      'final-verification': { ...completed }
    },
    timeline: [], archived: false,
    finals: { nozzleTemp: 215, flowRatio: 1.02, pressureAdvance: 0.04, retractionDistance: 0.9, maxVolumetricSpeed: 18, ...finalsOverrides }
  };
}

const printer: PrinterProfile = {
  id: 'pr', name: 'Elegoo Giga', manufacturer: 'Elegoo', nozzleDiameter: 0.4,
  maxNozzleTemp: 300, maxBedTemp: 100, maxVolumetricFlow: 20, extruderType: 'direct',
  retractionRange: { start: 0.5, end: 2 }, notes: '', createdAt: '', updatedAt: ''
};

function generate(project = makeProject()): { generated: GeneratedFilamentProfile; parsed: ParsedFilamentProfile } {
  const parsed = parseFixture('orca-user-delta-pla.json');
  const generated = generateProfile({
    slicerId: 'orca', baseProfile: parsed.profile, newName: 'PF Valid Test',
    patches: buildPatchesFromProject(project), targetExtruderIndex: 0,
    applyToAllExtruders: false, project
  }, parsed);
  return { generated, parsed };
}

describe('validation', () => {
  it('passes a clean generation', () => {
    const project = makeProject();
    const { generated, parsed } = generate(project);
    const result = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.preservedFieldCount).toBeGreaterThan(5);
  });

  it('passes a Bambu user base carrying filament_id (regenerated id is expected)', () => {
    const project = makeProject();
    const parsed = parseFixture('bambu-user-full-pctg-dualnozzle.json', 'bambu');
    const generated = generateProfile({
      slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF Bambu Id Test',
      patches: buildPatchesFromProject(project), targetExtruderIndex: 0,
      applyToAllExtruders: false, project
    }, parsed);
    const result = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
    expect(result.errors.filter(e => e.code === 'UNEXPECTED_CHANGE')).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('passes an Orca system base carrying filament_id', () => {
    const project = makeProject();
    const parsed = parseFixture('orca-system-elegoo-pla.json', 'orca', {
      dir_kind: 'system', account_id: null, vendor: 'Elegoo', writable: false
    });
    const generated = generateProfile({
      slicerId: 'orca', baseProfile: parsed.profile, newName: 'PF System Id Test',
      patches: buildPatchesFromProject(project), targetExtruderIndex: 0,
      applyToAllExtruders: false, project
    }, parsed);
    const result = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
    expect(result.errors.filter(e => e.code === 'UNEXPECTED_CHANGE')).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('passes when padding a short per-extruder array without changing the target value', () => {
    // The dual-nozzle fixture stores pressure_advance as a 1-element array;
    // patching the exact stored value still widens it to the extruder count.
    const project = makeProject({ pressureAdvance: 0.02 });
    const parsed = parseFixture('bambu-user-full-pctg-dualnozzle.json', 'bambu');
    const generated = generateProfile({
      slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF Pad Test',
      patches: buildPatchesFromProject(project), targetExtruderIndex: 0,
      applyToAllExtruders: false, project
    }, parsed);
    const result = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('blocks nozzle temperature above the printer maximum without clamping', () => {
    const project = makeProject({ nozzleTemp: 320 });
    const { generated, parsed } = generate(project);
    const result = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
    expect(result.valid).toBe(false);
    const e = result.errors.find(x => x.code === 'TEMP_OVER_PRINTER_MAX');
    expect(e?.message).toContain('320');
    expect(e?.message).toContain('300');
    // The value itself must NOT be clamped:
    expect((generated.data.nozzle_temperature as string[])[0]).toBe('320');
  });

  it('requires acknowledgement when MVS exceeds the printer capability', () => {
    const project = makeProject({ maxVolumetricSpeed: 25 });
    const { generated, parsed } = generate(project);
    const result = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
    expect(result.valid).toBe(true);
    const pending = unacknowledgedWarnings(result, []);
    expect(pending.some(w => w.code === 'MVS_OVER_PRINTER')).toBe(true);
    expect(unacknowledgedWarnings(result, ['MVS_OVER_PRINTER']).some(w => w.code === 'MVS_OVER_PRINTER')).toBe(false);
  });

  it('does not flag the baked M900 start g-code as a non-finite number', () => {
    const project = makeProject();
    const parsed = getAdapter('bambu').parseProfile(
      { kind: 'detected', fileName: 'bambu-user-full-pctg-dualnozzle.json',
        json: fixtureRaw('bambu-user-full-pctg-dualnozzle.json').json,
        infoText: fixtureRaw('bambu-user-full-pctg-dualnozzle.json').info,
        filePath: fixtureRaw('bambu-user-full-pctg-dualnozzle.json').path },
      fixtureRaw('bambu-user-full-pctg-dualnozzle.json')
    )!;
    const generated = generateProfile({
      slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF Bake Valid',
      patches: buildPatchesFromProject(project), targetExtruderIndex: 0,
      applyToAllExtruders: false, bakePressureAdvanceGcode: true, project
    }, parsed);
    // The g-code change is present but text-valued — must not error as numeric.
    expect(generated.changedFields.some(c => c.presetKey === 'filament_start_gcode')).toBe(true);
    const result = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
    expect(result.errors.some(e => e.code === 'NON_FINITE')).toBe(false);
  });

  it('detects field loss (round-trip preservation)', () => {
    const project = makeProject();
    const { generated, parsed } = generate(project);
    delete (generated.data as Record<string, unknown>).filament_density;
    generated.serialized = JSON.stringify(generated.data, null, 4);
    const result = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
    expect(result.errors.some(e => e.code === 'FIELD_LOST' && e.message.includes('filament_density'))).toBe(true);
  });

  it('detects unexpected drift beyond calibrated fields', () => {
    const project = makeProject();
    const { generated, parsed } = generate(project);
    (generated.data as Record<string, unknown>).slow_down_layer_time = ['99'];
    generated.serialized = JSON.stringify(generated.data, null, 4);
    const result = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
    expect(result.errors.some(e => e.code === 'UNEXPECTED_CHANGE')).toBe(true);
  });

  it('detects version drift', () => {
    const project = makeProject();
    const { generated, parsed } = generate(project);
    (generated.data as Record<string, unknown>).version = '999';
    generated.serialized = JSON.stringify(generated.data, null, 4);
    const result = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
    expect(result.errors.some(e => e.code === 'VERSION_DRIFT')).toBe(true);
  });

  it('blocks a clone without its own filament_id (Bambu hides those)', () => {
    const project = makeProject();
    const { generated, parsed } = generate(project);
    delete (generated.data as Record<string, unknown>).filament_id;
    generated.serialized = JSON.stringify(generated.data, null, 4);
    const result = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
    expect(result.errors.some(e => e.code === 'FILAMENT_ID_MISSING')).toBe(true);
  });

  it('blocks a clone whose filament_id collides with the base', () => {
    const project = makeProject();
    const { generated, parsed } = generate(project);
    const baseRaw = parsed.profile.rawProfile as Record<string, unknown>;
    if (typeof baseRaw.filament_id === 'string' && baseRaw.filament_id) {
      (generated.data as Record<string, unknown>).filament_id = baseRaw.filament_id;
      generated.serialized = JSON.stringify(generated.data, null, 4);
      const result = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
      expect(result.errors.some(e => e.code === 'FILAMENT_ID_COLLISION')).toBe(true);
    }
  });

  it('requires a system-base clone to inherit the leaf by name', () => {
    const project = makeProject();
    const { generated, parsed } = generate(project);
    parsed.profile.sourceType = 'system';
    // generator would have set inherits to the leaf name; simulate the old
    // (buggy) behavior of keeping the abstract parent
    (generated.data as Record<string, unknown>).inherits = 'Generic PLA @base';
    generated.serialized = JSON.stringify(generated.data, null, 4);
    const result = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
    expect(result.errors.some(e => e.code === 'INHERITS_DRIFT')).toBe(true);
  });

  it('warns about duplicate names at the destination', () => {
    const project = makeProject();
    const { generated, parsed } = generate(project);
    const result = validateGeneratedProfile(generated, {
      project, printer, baseProfile: parsed.profile,
      existingProfileNames: ['pf valid test']
    });
    expect(result.warnings.some(w => w.code === 'DUPLICATE_NAME')).toBe(true);
  });

  // Every limit below is checked against the value that will actually be
  // WRITTEN into the preset file — the printer executes the file, not the diff.
  describe('write-path limit checks', () => {
    function baseWith(patch: Record<string, unknown>, file = 'orca-user-delta-pla.json'): ParsedFilamentProfile {
      const raw = JSON.parse(fixtureRaw(file).json) as Record<string, unknown>;
      Object.assign(raw, patch);
      return parseFixture(file, 'orca', { json: JSON.stringify(raw) });
    }

    function generateFrom(parsed: ParsedFilamentProfile, project: CalibrationProject) {
      return generateProfile({
        slicerId: 'orca', baseProfile: parsed.profile, newName: 'PF Limit Test',
        patches: buildPatchesFromProject(project), targetExtruderIndex: 0,
        applyToAllExtruders: false, project
      }, parsed);
    }

    it('blocks a first-layer nozzle temperature above the printer maximum', () => {
      const project = makeProject({ firstLayerTemp: 500 });
      const { generated, parsed } = generate(project);
      expect((generated.data.nozzle_temperature_initial_layer as string[])[0]).toBe('500');
      const result = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
      const over = result.errors.find(e => e.code === 'TEMP_OVER_PRINTER_MAX');
      expect(over?.message).toContain('500');
      expect(over?.message).toContain('300');
      expect(result.errors.some(e => e.code === 'TEMP_IMPLAUSIBLE')).toBe(true);
      expect(result.valid).toBe(false);
    });

    it('checks a calibrated value even when it equals the base value', () => {
      // 500 °C in the base AND calibrated to 500 → no changed field at all.
      const parsed = baseWith({ nozzle_temperature: ['500'] });
      const project = makeProject({ nozzleTemp: 500 });
      const generated = generateFrom(parsed, project);
      expect(generated.changedFields.some(c => c.presetKey === 'nozzle_temperature')).toBe(false);
      const result = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
      expect(result.errors.some(e => e.code === 'TEMP_OVER_PRINTER_MAX')).toBe(true);
      expect(result.errors.some(e => e.code === 'TEMP_IMPLAUSIBLE')).toBe(true);
      expect(result.valid).toBe(false);
    });

    it('blocks a bed temperature above the printer maximum', () => {
      const parsed = baseWith({ hot_plate_temp: ['150'], hot_plate_temp_initial_layer: ['150'] });
      const project = makeProject();
      const generated = generateFrom(parsed, project);
      const result = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
      const e = result.errors.find(x => x.code === 'BED_TEMP_OVER_PRINTER_MAX');
      expect(e?.message).toContain('150');
      expect(e?.message).toContain('100');
      expect(result.valid).toBe(false);
    });

    it('blocks a chamber temperature above the printer maximum', () => {
      const parsed = baseWith({ chamber_temperature: ['90'] });
      const project = makeProject();
      const generated = generateFrom(parsed, project);
      const chamberPrinter: PrinterProfile = { ...printer, maxChamberTemp: 60 };
      const result = validateGeneratedProfile(generated, { project, printer: chamberPrinter, baseProfile: parsed.profile });
      const e = result.errors.find(x => x.code === 'CHAMBER_TEMP_OVER_PRINTER_MAX');
      expect(e?.message).toContain('90');
      expect(e?.message).toContain('60');
      expect(result.valid).toBe(false);
    });

    it('caps retraction length for flexible filament, naming the material and the cap', () => {
      const project = makeProject({ retractionDistance: 14 });
      project.filament.material = 'TPU';
      const { generated, parsed } = generate(project);
      expect((generated.data.filament_retraction_length as string[])[0]).toBe('14');
      const result = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
      const e = result.errors.find(x => x.code === 'RETRACT_OVER_FLEXIBLE_CAP');
      expect(e?.message).toContain('TPU');
      expect(e?.message).toContain('1.5');
      expect(e?.message).toContain('14');
      expect(result.valid).toBe(false);
    });

    it('keeps the ordinary retraction range for rigid filament', () => {
      const project = makeProject({ retractionDistance: 6 });
      const { generated, parsed } = generate(project);
      const result = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
      expect(result.errors.some(x => x.code.startsWith('RETRACT'))).toBe(false);
    });

    it('blocks a retraction speed outside the range the wizard will calibrate', () => {
      const project = makeProject({ retractionSpeed: 400 });
      const { generated, parsed } = generate(project);
      expect((generated.data.filament_retraction_speed as string[])[0]).toBe('400');
      const result = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
      const e = result.errors.find(x => x.code === 'RETRACT_SPEED_IMPLAUSIBLE');
      expect(e?.message).toContain('400');
      expect(result.valid).toBe(false);
    });

    it('ignores "nil" slots (no filament-level override) instead of reading them as 0', () => {
      const parsed = baseWith({ filament_retraction_speed: ['nil'] });
      const project = makeProject();
      const generated = generateFrom(parsed, project);
      const result = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
      expect(result.errors.some(x => x.code === 'RETRACT_SPEED_IMPLAUSIBLE')).toBe(false);
    });

    it('names the slot when a multi-nozzle preset carries the offending value', () => {
      const parsed = parseFixture('bambu-user-full-pctg-dualnozzle.json', 'bambu');
      (parsed.profile.rawProfile as Record<string, unknown>).nozzle_temperature = ['260', '500'];
      const project = makeProject();
      const generated = generateProfile({
        slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF Slot Test',
        patches: buildPatchesFromProject(project), targetExtruderIndex: 0,
        applyToAllExtruders: false, project
      }, parsed);
      const result = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
      const e = result.errors.find(x => x.code === 'TEMP_OVER_PRINTER_MAX');
      expect(e?.message).toContain('slot 2');
      expect(e?.message).toContain('500');
    });
  });

  // Orca-family get_at(i) falls back to element 0 when the array is shorter
  // than the extruder index, so a preset with fewer value slots than the
  // machine has nozzles applies its ONE value to EVERY nozzle. Calibrating the
  // bowden auxiliary nozzle against such a base would hand the direct-drive
  // main hotend the aux nozzle's pressure advance and retraction distance.
  describe('base preset slot width vs. the calibrated nozzle', () => {
    const x2dPrinter: PrinterProfile = {
      ...printer,
      extruderType: 'direct',
      nozzles: [
        { label: 'Main (direct drive)', feed: 'direct' },
        { label: 'Auxiliary (bowden)', feed: 'bowden' }
      ]
    };

    function auxProject(): CalibrationProject {
      const p = makeProject({
        nozzleTemp: 255, firstLayerTemp: 260, flowRatio: 0.94,
        pressureAdvance: 0.72, retractionDistance: 3.5
      });
      p.nozzleIndex = 1; // the bowden auxiliary nozzle
      return p;
    }

    it('blocks a single-slot base that cannot hold a value for the calibrated nozzle', () => {
      const project = auxProject();
      const parsed = parseFixture('orca-user-delta-pla.json');
      expect(parsed.extruderCount).toBe(1);
      const target = defaultTargetExtruder(project, parsed.extruderCount);
      expect(target).toBe(0); // clamped onto the MAIN nozzle's slot
      const generated = generateProfile({
        slicerId: 'orca', baseProfile: parsed.profile, newName: 'PF Aux On Narrow Base',
        patches: buildPatchesFromProject(project), targetExtruderIndex: target,
        applyToAllExtruders: false, project
      }, parsed);
      // The clamp is exactly why nothing may be written: the only slot there is
      // is the one EVERY nozzle reads, so the base's own main-nozzle values
      // stay untouched and the aux calibration is withheld and reported.
      expect(generated.data.pressure_advance).toEqual(['0.042']);
      expect(generated.data.filament_retraction_length).toBeUndefined();
      expect((generated.skippedFields ?? []).map(s => s.presetKey).sort()).toEqual([
        'enable_pressure_advance', 'filament_flow_ratio', 'filament_max_volumetric_speed',
        'filament_retraction_length', 'nozzle_temperature',
        'nozzle_temperature_initial_layer', 'pressure_advance'
      ]);
      // The reported change list must match the file exactly: nothing written,
      // nothing reported.
      expect(generated.changedFields).toEqual([]);

      const result = validateGeneratedProfile(generated, { project, printer: x2dPrinter, baseProfile: parsed.profile });
      const e = result.errors.find(x => x.code === 'BASE_CANNOT_ADDRESS_NOZZLE');
      expect(e?.message).toContain('nozzle 2');
      expect(result.valid).toBe(false);
    });

    it('lets the same project through on a base that carries a slot per nozzle', () => {
      const project = auxProject();
      const parsed = parseFixture('bambu-user-full-pctg-dualnozzle.json', 'bambu');
      expect(parsed.extruderCount).toBe(2);
      const generated = generateProfile({
        slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF Aux On Wide Base',
        patches: buildPatchesFromProject(project), targetExtruderIndex: defaultTargetExtruder(project, parsed.extruderCount),
        applyToAllExtruders: false, project
      }, parsed);
      expect((generated.data.pressure_advance as string[])[1]).toBe('0.72');
      const result = validateGeneratedProfile(generated, { project, printer: x2dPrinter, baseProfile: parsed.profile });
      expect(result.errors.some(x => x.code === 'BASE_CANNOT_ADDRESS_NOZZLE')).toBe(false);
    });

    it('warns when the base is narrower than the printer even if the target slot exists', () => {
      const project = makeProject(); // calibrates nozzle 1 (index 0)
      const parsed = parseFixture('orca-user-delta-pla.json');
      const generated = generateProfile({
        slicerId: 'orca', baseProfile: parsed.profile, newName: 'PF Narrow Base Main',
        patches: buildPatchesFromProject(project), targetExtruderIndex: 0,
        applyToAllExtruders: false, project
      }, parsed);
      const result = validateGeneratedProfile(generated, { project, printer: x2dPrinter, baseProfile: parsed.profile });
      expect(result.errors.some(x => x.code === 'BASE_CANNOT_ADDRESS_NOZZLE')).toBe(false);
      const w = result.warnings.find(x => x.code === 'BASE_NARROWER_THAN_PRINTER');
      expect(w?.requiresAcknowledgement).toBe(true);
      expect(unacknowledgedWarnings(result, []).some(x => x.code === 'BASE_NARROWER_THAN_PRINTER')).toBe(true);
    });

    it('stays silent on a single-nozzle printer with a single-slot base', () => {
      const project = makeProject();
      const { generated, parsed } = generate(project);
      const result = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
      expect(result.errors).toEqual([]);
      expect(result.warnings.some(x => x.code === 'BASE_NARROWER_THAN_PRINTER')).toBe(false);
    });
  });

  // Every machine-limit check is guarded by `printer &&`, so with no resolvable
  // printer profile they all evaluate to nothing. Silence there used to render
  // as "All checks passed — nothing conflicts with this printer".
  describe('no resolvable printer profile', () => {
    it('says the machine limits were skipped instead of passing silently', () => {
      const project = makeProject({ firstLayerTemp: 400 });
      const parsed = parseFixture('bambu-user-full-pctg-dualnozzle.json', 'bambu');
      const generated = generateProfile({
        slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF No Printer',
        patches: buildPatchesFromProject(project), targetExtruderIndex: 0,
        applyToAllExtruders: false, project
      }, parsed);
      // 400 °C really is written into the preset.
      expect((generated.data.nozzle_temperature_initial_layer as string[])[0]).toBe('400');

      const withPrinter = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
      expect(withPrinter.errors.some(e => e.code === 'TEMP_OVER_PRINTER_MAX')).toBe(true);

      const noPrinter = validateGeneratedProfile(generated, { project, printer: undefined, baseProfile: parsed.profile });
      const w = noPrinter.warnings.find(x => x.code === 'PRINTER_UNRESOLVED');
      expect(w?.requiresAcknowledgement).toBe(true);
      expect(w?.message).toContain('maximum nozzle temperature');
      expect(unacknowledgedWarnings(noPrinter, []).some(x => x.code === 'PRINTER_UNRESOLVED')).toBe(true);
    });

    it('does not raise it when a printer profile is present', () => {
      const project = makeProject();
      const { generated, parsed } = generate(project);
      const result = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
      expect(result.warnings.some(x => x.code === 'PRINTER_UNRESOLVED')).toBe(false);
    });
  });

  it('requires acknowledgement for a calibrated value that could not be written', () => {
    const parsed = parseFixture('bambu-user-full-pctg-dualnozzle.json', 'bambu');
    const raw = parsed.profile.rawProfile as Record<string, unknown>;
    delete raw.pressure_advance;
    delete raw.enable_pressure_advance;
    const project = makeProject({ pressureAdvance: 0.72 });
    const generated = generateProfile({
      slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF Skipped',
      patches: buildPatchesFromProject(project), targetExtruderIndex: 1,
      applyToAllExtruders: false, project
    }, parsed);
    const result = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
    const w = result.warnings.find(x => x.code.startsWith('FIELD_NOT_WRITTEN'));
    expect(w?.requiresAcknowledgement).toBe(true);
    expect(w?.message).toContain('pressure_advance');
    expect(unacknowledgedWarnings(result, []).some(x => x.code === w!.code)).toBe(true);
  });

  it('requires acknowledgement for cross-family base profiles', () => {
    const project = makeProject();
    const { generated, parsed } = generate(project);
    parsed.profile.materialType = 'TPU';
    const result = validateGeneratedProfile(generated, { project, printer, baseProfile: parsed.profile });
    expect(result.warnings.some(w => w.code === 'MATERIAL_FAMILY_MISMATCH' && w.requiresAcknowledgement)).toBe(true);
  });
});

describe('diff', () => {
  it('never reports unchanged fields and splits identity from calibration', () => {
    const project = makeProject();
    const { generated, parsed } = generate(project);
    const diff = summarizeDiff(parsed.profile.rawProfile as Record<string, unknown>, generated);
    expect(diff.unexpected).toEqual([]);
    expect(diff.identity.map(i => i.key)).toContain('name');
    expect(diff.calibrated.map(c => c.presetKey)).toContain('nozzle_temperature');
    // fields not touched must not appear anywhere
    const allKeys = [...diff.identity, ...diff.unexpected].map(e => e.key);
    expect(allKeys).not.toContain('filament_density');
  });

  it('formats changes with printer-default sentinel for nil', () => {
    expect(formatChange({ presetKey: 'filament_retraction_length', label: 'Retraction length', before: 'nil', after: '0.9', unit: 'mm' }))
      .toBe('Retraction length: (printer default) → 0.9 mm');
    expect(formatChange({ presetKey: 'nozzle_temperature', label: 'Nozzle temperature', before: '220', after: '215', unit: '°C', extruderIndex: 1 }))
      .toBe('Nozzle temperature (slot 2): 220 °C → 215 °C');
    // A slot left as "nil" must not read as a value ("→ nil mm").
    expect(formatChange({ presetKey: 'filament_retraction_length', label: 'Retraction length', before: null, after: 'nil', unit: 'mm', extruderIndex: 0 }))
      .toBe('Retraction length (slot 1): (printer default) → (no filament override)');
  });

  // The legend is what says which nozzle each value slot belongs to, so a
  // legend of the wrong LENGTH mislabels every slot after the gap. This is the
  // only backstop against that, and until now nothing exercised it.
  describe('EXTRUDER_VARIANT_SHAPE — the legend must be exactly as wide as the slots', () => {
    /** A 4-slot Bambu preset carrying `legend` as its declared slot legend. */
    function generateWithLegend(legend: string[]) {
      const body = {
        type: 'filament', name: 'Fake ABS @BBL X2D 0.4 nozzle', from: 'system',
        inherits: 'Fake ABS @base', filament_id: 'GFB99', version: '2.3.0.2',
        filament_type: ['ABS'],
        filament_extruder_variant: legend,
        nozzle_temperature: ['270', '270', '270', '270'],
        filament_flow_ratio: ['0.95', '0.95', '0.95', '0.95']
      };
      const parsed = parseFixture('bambu-user-full-pctg-dualnozzle.json', 'bambu', {
        dir_kind: 'system', vendor: 'BBL', writable: false,
        file_name: 'Fake ABS @BBL X2D 0.4 nozzle.json', json: JSON.stringify(body)
      });
      const project = makeProject();
      project.nozzleIndex = 0;
      const generated = generateProfile({
        slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PF legend shape',
        patches: buildPatchesFromProject(project), targetExtruderIndex: 0,
        applyToAllExtruders: false, calibratedNozzleFeed: 'direct', project
      }, parsed);
      return validateGeneratedProfile(generated, {
        project, printer, baseProfile: parsed.profile
      });
    }

    const FOUR = ['Direct Drive Standard', 'Direct Drive High Flow', 'Bowden Standard', 'Bowden High Flow'];

    it('accepts a legend exactly as wide as the value slots', () => {
      expect(generateWithLegend(FOUR).errors.map(e => e.code)).not.toContain('EXTRUDER_VARIANT_SHAPE');
    });

    it('rejects a legend SHORTER than the slot count', () => {
      // The exact shape of the old bug: a three-entry direct-drive list
      // stretched over a four-slot X2D preset.
      const r = generateWithLegend(FOUR.slice(0, 3));
      expect(r.valid).toBe(false);
      const e = r.errors.find(x => x.code === 'EXTRUDER_VARIANT_SHAPE');
      expect(e?.message).toContain('names 3 slot(s)');
      expect(e?.message).toContain('4 value slot(s)');
    });

    it('a legend LONGER than every value array widens the preset instead of desyncing', () => {
      // Documented asymmetry, not an untested branch: `extruderCountOf` counts
      // filament_extruder_variant among the per-slot arrays, so a legend with
      // more entries than any value array RAISES the slot count to its own
      // length rather than sitting above it. The two therefore cannot disagree
      // in that direction. Verified against a real Bambu library: of the 17
      // presets that declare a legend, zero have one wider than their value
      // arrays. The check's live direction is the one above — a legend too
      // SHORT, which is exactly the shape the old three-entry direct-drive list
      // took over a four-slot X2D preset.
      const r = generateWithLegend([...FOUR, 'Direct Drive TPU High Flow']);
      expect(r.errors.map(e => e.code)).not.toContain('EXTRUDER_VARIANT_SHAPE');
      expect(r.errors.map(e => e.code)).not.toContain('EXTRUDER_SHAPE');
    });
  });

  it('fullJsonDiff reports added/removed/changed only', () => {
    const d = fullJsonDiff({ a: 1, b: 2, c: 3 }, { a: 1, b: 9, d: 4 });
    expect(d).toEqual([
      { key: 'b', kind: 'changed', before: '2', after: '9' },
      { key: 'c', kind: 'removed', before: '3', after: null },
      { key: 'd', kind: 'added', before: null, after: '4' }
    ]);
  });
});
