// ---------------------------------------------------------------------------
// The slot-mapping invariant, tested against REAL Bambu Lab X2D system presets.
//
// Fixture provenance: copied byte-for-byte from a real Bambu Studio install
// (system/BBL/filament). They are Bambu's own vendor presets, kept here only as
// read-only test fixtures — see tests/slicerIntegration/fixtures.ts.
//
// The shape that breaks naive code: on the X2D a filament preset's per-slot
// arrays are indexed by EXTRUDER VARIANT, not by nozzle number —
//   slot 0 Direct Drive Standard   (MAIN nozzle)
//   slot 1 Direct Drive High Flow  (MAIN nozzle)
//   slot 2 Bowden Standard         (AUXILIARY nozzle)
//   slot 3 Bowden High Flow        (AUXILIARY nozzle)
// and the legend that says so is NOT on the leaf preset: it arrives through
// `"include": ["fdm_filament_template_direct_bowden"]`.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { getAdapter } from '../../src/slicerIntegration/adapters';
import { buildPatchesFromProject, generateProfile } from '../../src/slicerIntegration/generator';
import { validateGeneratedProfile } from '../../src/slicerIntegration/validation';
import {
  BAMBU_INCLUDE_TEMPLATE_VARIANTS, classifyExtruderVariant, resolveSlotLegend, resolveTargetSlot
} from '../../src/slicerIntegration/orcaFamily';
import type { ParsedFilamentProfile } from '../../src/slicerIntegration/types';
import type { CalibrationProject, PrinterProfile } from '../../src/types';
import {
  applyToAllAvailability, slotMeaningParagraph, slotOptionLabel
} from '../../src/ui/profileWizard';
import { fixtureJson, fixtureRaw } from './fixtures';

const X2D_ABS = 'bambu-system-abs-x2d-4slot.json';
const H2S_2SLOT = 'bambu-user-full-pctg-dualnozzle.json';

function parseFixture(file: string, slicer: Parameters<typeof getAdapter>[0] = 'bambu'): ParsedFilamentProfile {
  const raw = fixtureRaw(file);
  const parsed = getAdapter(slicer).parseProfile(
    { kind: 'detected', fileName: file, json: raw.json, infoText: raw.info, filePath: raw.path },
    raw
  );
  if (!parsed) throw new Error(`fixture did not parse: ${file}`);
  return parsed;
}

/** The owner's machine: direct-drive main (index 0) + bowden auxiliary (index 1). */
const x2dPrinter: PrinterProfile = {
  id: 'printer-x2d', name: 'Bambu Lab X2D', manufacturer: 'Bambu Lab',
  nozzleDiameter: 0.4, maxNozzleTemp: 300, maxBedTemp: 120,
  maxChamberTemp: 65, heatedChamber: true,
  extruderType: 'direct', retractionRange: { start: 0.4, end: 4 },
  nozzles: [
    { label: 'Main (left, direct drive)', feed: 'direct' },
    { label: 'Auxiliary (right, bowden)', feed: 'bowden' }
  ],
  notes: '', createdAt: '', updatedAt: ''
};

/** A finished ABS calibration. Aux values are deliberately bowden-sized. */
function auxProject(overrides: Partial<CalibrationProject['finals']> = {}): CalibrationProject {
  const completed = { status: 'completed' as const, current: null, history: [] };
  const p: CalibrationProject = {
    id: 'proj-x2d', createdAt: '', updatedAt: '', calibrationDate: '2026-08-01',
    filament: {
      manufacturer: 'Generic', productLine: '', material: 'ABS',
      color: 'Black', diameter: 1.75, startingProfile: 'Generic ABS'
    },
    printerProfileId: 'printer-x2d', nozzleType: 'brass',
    slicer: { slicer: 'bambu', version: '2.5.3' }, notes: '', mode: 'expert',
    stepOrder: ['temperature', 'flow-pass1', 'pressure-advance', 'retraction', 'max-volumetric-speed'],
    steps: {
      'temperature': { ...completed },
      'flow-pass1': { ...completed },
      'flow-pass2': { ...completed },
      'pressure-advance': { ...completed },
      'flow-verify': { ...completed },
      'retraction': { ...completed },
      'max-volumetric-speed': { ...completed },
      'shrinkage': { status: 'not-started', current: null, history: [] },
      'ooze-control': { status: 'not-started', current: null, history: [] },
      'final-verification': { ...completed }
    },
    timeline: [], archived: false,
    nozzleIndex: 1, // the BOWDEN auxiliary nozzle
    finals: {
      nozzleTemp: 255, firstLayerTemp: 260, flowRatio: 0.94,
      pressureAdvance: 0.72, retractionDistance: 3.5, maxVolumetricSpeed: 12,
      ...overrides
    }
  };
  return p;
}

function generateAgainst(parsed: ParsedFilamentProfile, project: CalibrationProject, opts: {
  targetExtruderIndex: number; feed?: 'direct' | 'bowden' | null; hotendFlow?: 'standard' | 'high';
  applyToAllExtruders?: boolean; bake?: boolean; physicalNozzleCount?: number;
}) {
  return generateProfile({
    slicerId: 'bambu', baseProfile: parsed.profile, newName: 'PerfectFit - Generic ABS X2D aux',
    patches: buildPatchesFromProject(project),
    targetExtruderIndex: opts.targetExtruderIndex,
    applyToAllExtruders: opts.applyToAllExtruders ?? false,
    calibratedNozzleFeed: opts.feed,
    calibratedHotendFlow: opts.hotendFlow,
    physicalNozzleCount: opts.physicalNozzleCount,
    bakePressureAdvanceGcode: opts.bake,
    project
  }, parsed);
}

/** Every preset key this project's completed steps would write. */
function ownedKeys(project: CalibrationProject): string[] {
  return buildPatchesFromProject(project)
    .flatMap(p => [p.presetKey, ...(p.companions ?? []).map(c => c.presetKey)]);
}

// --- the fixture is really the shape we think it is -------------------------

describe('the real X2D preset shape', () => {
  it('carries four value slots, no legend of its own, and pulls one in via include', () => {
    const parsed = parseFixture(X2D_ABS);
    const raw = parsed.profile.rawProfile as Record<string, unknown>;
    expect(parsed.extruderCount).toBe(4);
    expect(raw.filament_extruder_variant).toBeUndefined();
    expect(raw.include).toEqual(['fdm_filament_template_direct_bowden']);
    // Corroborates the variant reading: bowden slots need more retraction.
    expect(raw.retraction_distances_when_ec).toEqual(['3', '3', '4', '4']);
  });

  it('does not count the AMS drying arrays as value slots', () => {
    // Bambu's fdm_filament_common declares these four wide (one per AMS dryer
    // device). A preset that carries them resolved would otherwise report four
    // value slots on a single-nozzle machine, and every slot index after that
    // would address hardware that does not exist.
    const parsed = parseFixture(H2S_2SLOT);
    const raw = parsed.profile.rawProfile as Record<string, unknown>;
    raw.filament_dev_ams_drying_temperature = ['65', '80', '65', '75'];
    raw.filament_dev_ams_drying_time = ['12', '8.0', '12', '8.0'];
    const reparsed = getAdapter('bambu').parseProfile({
      kind: 'detected', fileName: H2S_2SLOT, json: JSON.stringify(raw), infoText: null, filePath: null
    })!;
    expect(reparsed.extruderCount).toBe(2);
  });

  it('the include-template legend table matches the real template files verbatim', () => {
    const bowden = JSON.parse(fixtureJson('bambu-template-direct-bowden.json')) as Record<string, unknown>;
    const dual = JSON.parse(fixtureJson('bambu-template-direct-dual.json')) as Record<string, unknown>;
    expect(BAMBU_INCLUDE_TEMPLATE_VARIANTS['fdm_filament_template_direct_bowden'])
      .toEqual(bowden.filament_extruder_variant);
    expect(BAMBU_INCLUDE_TEMPLATE_VARIANTS['fdm_filament_template_direct_dual'])
      .toEqual(dual.filament_extruder_variant);
    // The template ships retraction UNSET on every slot — Bambu bug #10404's
    // precondition. The aux slot must receive a concrete number from us.
    expect(bowden.filament_retraction_length).toEqual(['nil', 'nil', 'nil', 'nil']);
  });
});

// --- legend resolution ------------------------------------------------------

describe('resolveSlotLegend', () => {
  it('resolves the X2D legend through the included template', () => {
    const legend = resolveSlotLegend(parseFixture(X2D_ABS));
    expect(legend?.names).toEqual([
      'Direct Drive Standard', 'Direct Drive High Flow', 'Bowden Standard', 'Bowden High Flow'
    ]);
    expect(legend?.source).toBe('include-template');
    expect(legend?.matchesSlotCount).toBe(true);
    expect(legend?.mixedFeed).toBe(true);
  });

  it('prefers a legend the preset declares itself', () => {
    const legend = resolveSlotLegend(parseFixture(H2S_2SLOT));
    expect(legend?.names).toEqual(['Direct Drive Standard', 'Direct Drive High Flow']);
    expect(legend?.source).toBe('declared');
    expect(legend?.mixedFeed).toBe(false);
  });

  it('classifies each variant name by feed path and flow class', () => {
    expect(classifyExtruderVariant('Bowden Standard')).toMatchObject({ feed: 'bowden', flow: 'standard' });
    expect(classifyExtruderVariant('Bowden High Flow')).toMatchObject({ feed: 'bowden', flow: 'high' });
    expect(classifyExtruderVariant('Direct Drive Standard')).toMatchObject({ feed: 'direct', flow: 'standard' });
    expect(classifyExtruderVariant('Direct Drive High Flow')).toMatchObject({ feed: 'direct', flow: 'high' });
    expect(classifyExtruderVariant('Direct Drive TPU High Flow')).toMatchObject({ feed: 'direct', flow: 'high' });
    expect(classifyExtruderVariant('Something Nobody Shipped Yet')).toMatchObject({ feed: null, flow: null });
  });
});

// --- (physical nozzle + hotend type) -> slot --------------------------------

describe('resolveTargetSlot', () => {
  const base = () => parseFixture(X2D_ABS);

  it('maps the auxiliary bowden nozzle to Bowden Standard (slot 3 of 4), NOT slot 2', () => {
    const r = resolveTargetSlot({ base: base(), nozzleIndex: 1, nozzleFeed: 'bowden' });
    expect(r.kind).toBe('variant');
    if (r.kind !== 'variant') return;
    expect(r.slot).toBe(2);
    expect(r.variantName).toBe('Bowden Standard');
  });

  it('maps a high-flow auxiliary hotend to Bowden High Flow', () => {
    const r = resolveTargetSlot({ base: base(), nozzleIndex: 1, nozzleFeed: 'bowden', hotendFlow: 'high' });
    expect(r.kind === 'variant' && r.slot).toBe(3);
    expect(r.kind === 'variant' && r.variantName).toBe('Bowden High Flow');
  });

  it('maps the main direct-drive nozzle to Direct Drive Standard', () => {
    const r = resolveTargetSlot({ base: base(), nozzleIndex: 0, nozzleFeed: 'direct' });
    expect(r.kind === 'variant' && r.slot).toBe(0);
    expect(r.kind === 'variant' && r.variantName).toBe('Direct Drive Standard');
  });

  it('refuses to guess when the feed path of the calibrated nozzle is unknown', () => {
    const r = resolveTargetSlot({ base: base(), nozzleIndex: 1, nozzleFeed: null });
    expect(r.kind).toBe('unresolved');
    expect(r.kind === 'unresolved' && r.code).toBe('FEED_UNKNOWN');
  });

  it('refuses when the legend has no slot for this nozzle’s feed path', () => {
    // A bowden aux nozzle against an all-direct-drive preset: there is no
    // honest slot, so the answer is a refusal, never slot 1.
    const r = resolveTargetSlot({ base: parseFixture(H2S_2SLOT), nozzleIndex: 1, nozzleFeed: 'bowden' });
    expect(r.kind).toBe('unresolved');
    expect(r.kind === 'unresolved' && r.code).toBe('NO_SLOT_FOR_FEED');
  });

  it('falls back to the slot index only on a preset with no legend at all', () => {
    const parsed = parseFixture(H2S_2SLOT);
    delete (parsed.profile.rawProfile as Record<string, unknown>).filament_extruder_variant;
    const r = resolveTargetSlot({ base: parsed, nozzleIndex: 1, nozzleFeed: 'direct' });
    expect(r.kind).toBe('positional');
    expect(r.kind === 'positional' && r.slot).toBe(1);
  });
});

// --- THE HEADLINE: a bowden calibration must land in a bowden slot ----------

describe('an auxiliary (bowden) calibration written to the real X2D ABS preset', () => {
  it('lands in the Bowden Standard slot and leaves both Direct Drive slots untouched', () => {
    const parsed = parseFixture(X2D_ABS);
    const project = auxProject();
    const gen = generateAgainst(parsed, project, { targetExtruderIndex: 2, feed: 'bowden' });
    const out = JSON.parse(gen.serialized) as Record<string, unknown>;

    // Nozzle temperature: aux slot calibrated, both main-nozzle slots as shipped.
    expect(out.nozzle_temperature).toEqual(['270', '270', '255', '270']);
    expect(out.nozzle_temperature_initial_layer).toEqual(['260', '260', '260', '260']);
    // Flow ratio: the owner's actual complaint. 0.94 must not reach a main slot.
    expect(out.filament_flow_ratio).toEqual(['0.95', '0.95', '0.94', '0.95']);
    expect(out.filament_max_volumetric_speed).toEqual(['15', '15', '12', '15']);

    // Bambu bug #10404: the included template ships retraction as nil on every
    // slot, and an unset bowden slot silently falls back to the direct-drive
    // default. The aux slot must carry a concrete number; the main slots must
    // keep the "no filament override" sentinel, not inherit a bowden distance.
    expect(out.filament_retraction_length).toEqual(['nil', 'nil', '3.5', 'nil']);

    // The legend written into the clone names the real hardware, four wide.
    expect(out.filament_extruder_variant).toEqual([
      'Direct Drive Standard', 'Direct Drive High Flow', 'Bowden Standard', 'Bowden High Flow'
    ]);

    // Every reported change that carries a NUMBER is at the bowden slot; the
    // only entries elsewhere are the "nil" sentinels a from-scratch key puts in
    // the slots this calibration did not target.
    for (const c of gen.changedFields) {
      if (c.extruderIndex === undefined || c.extruderIndex === 2) continue;
      expect(c.after, `${c.presetKey} slot ${c.extruderIndex + 1}`).toBe('nil');
    }
    expect(gen.changedFields.some(c => c.extruderIndex === 2 && c.after === '3.5')).toBe(true);
  });

  it('end to end: the slot the wizard resolves is NOT the slot the index would give', () => {
    const parsed = parseFixture(X2D_ABS);
    const project = auxProject();
    // What the wizard now does: resolve the slot from the legend, by name.
    const pick = resolveTargetSlot({
      base: parsed, nozzleIndex: project.nozzleIndex!, nozzleFeed: 'bowden',
      nozzleLabel: x2dPrinter.nozzles![1].label
    });
    expect(pick.kind).toBe('variant');
    if (pick.kind !== 'variant') return;
    // What the old nozzleIndex-as-array-index mapping gave: slot 2 of 4,
    // "Direct Drive High Flow" — a MAIN-nozzle variant.
    const positional = Math.min(project.nozzleIndex!, parsed.extruderCount - 1);
    expect(positional).toBe(1);
    expect(pick.legend.names[positional]).toBe('Direct Drive High Flow');
    expect(pick.slot).not.toBe(positional);

    const gen = generateAgainst(parsed, project, {
      targetExtruderIndex: pick.slot, feed: 'bowden',
      hotendFlow: undefined
    });
    const out = JSON.parse(gen.serialized) as Record<string, unknown>;
    expect((out.filament_flow_ratio as string[])[pick.slot]).toBe('0.94');
    expect((out.filament_flow_ratio as string[])[positional]).toBe('0.95');
  });

  it('passes validation and never trips the cross-nozzle guards', () => {
    const parsed = parseFixture(X2D_ABS);
    const project = auxProject();
    const gen = generateAgainst(parsed, project, { targetExtruderIndex: 2, feed: 'bowden' });
    const result = validateGeneratedProfile(gen, {
      project, printer: x2dPrinter, baseProfile: parsed.profile
    });
    expect(result.errors.map(e => e.code)).toEqual([]);
  });

  it('refuses the whole write when asked to target a Direct Drive slot', () => {
    // This is exactly what the old positional mapping did: nozzleIndex 1 -> slot 1.
    const parsed = parseFixture(X2D_ABS);
    const before = JSON.parse(JSON.stringify(parsed.profile.rawProfile)) as Record<string, unknown>;
    const project = auxProject();
    const gen = generateAgainst(parsed, project, { targetExtruderIndex: 1, feed: 'bowden' });
    const out = JSON.parse(gen.serialized) as Record<string, unknown>;

    expect(out.nozzle_temperature).toEqual(before.nozzle_temperature);
    expect(out.filament_flow_ratio).toEqual(before.filament_flow_ratio);
    expect(out.filament_retraction_length).toBeUndefined();
    expect(gen.changedFields).toEqual([]);

    const reasons = (gen.skippedFields ?? []).map(s => s.reason).join('\n');
    expect(reasons).toContain('Bowden');
    expect(reasons).toContain('Direct Drive High Flow');
    // Every calibrated key is reported, never silently dropped.
    const owned = buildPatchesFromProject(project)
      .flatMap(p => [p.presetKey, ...(p.companions ?? []).map(c => c.presetKey)]);
    const skippedKeys = new Set((gen.skippedFields ?? []).map(s => s.presetKey));
    for (const k of owned) expect(skippedKeys.has(k), k).toBe(true);
  });

  it('refuses when the calibrated nozzle’s feed path is unknown', () => {
    const parsed = parseFixture(X2D_ABS);
    const gen = generateAgainst(parsed, auxProject(), { targetExtruderIndex: 2, feed: null });
    expect(gen.changedFields).toEqual([]);
    expect((gen.skippedFields ?? []).length).toBeGreaterThan(0);
    expect((gen.skippedFields ?? [])[0].reason).toMatch(/feed path|which nozzle/i);
  });

  it('withholds the M900 bake on a dual-feed preset (start g-code is whole-filament)', () => {
    // The base must DECLARE pressure_advance, or the array write is withheld
    // for an unrelated reason ("no neutral value for the untargeted slots") and
    // its own refusal note would satisfy a loose assertion here — certifying a
    // rule this test never exercised. Real X2D presets declare no
    // pressure_advance at all, so it is added explicitly.
    const parsed = parseFixture(X2D_ABS);
    (parsed.profile.rawProfile as Record<string, unknown>).pressure_advance =
      ['0.02', '0.02', '0.05', '0.05'];
    const gen = generateAgainst(parsed, auxProject(), {
      targetExtruderIndex: 2, feed: 'bowden', bake: true
    });
    const out = JSON.parse(gen.serialized) as Record<string, unknown>;
    // Precondition: the array write DID happen, so the withheld-PA branch of
    // the refusal cannot be what produced the note below.
    expect(out.pressure_advance).toEqual(['0.02', '0.02', '0.72', '0.05']);
    expect((gen.skippedFields ?? []).some(s => s.presetKey === 'pressure_advance')).toBe(false);

    expect((out.filament_start_gcode as string[]).join('\n')).not.toContain('M900');
    const note = (gen.skippedFields ?? []).find(s => s.presetKey === 'filament_start_gcode');
    // The phrase that only the DUAL-FEED branch produces. "every nozzle" is
    // shared with the withheld-PA branch and would pass either way.
    expect(note?.reason).toContain('more than one feed path');
    expect(note?.reason).toContain('Bowden Standard');
  });

  it('still withholds the M900 bake when "apply to all value slots" is ticked', () => {
    // filament_start_gcode has no per-slot form, so "apply to all" cannot make
    // the bake safe — it used to switch this refusal off entirely.
    const parsed = parseFixture(X2D_ABS);
    (parsed.profile.rawProfile as Record<string, unknown>).pressure_advance =
      ['0.02', '0.02', '0.05', '0.05'];
    const gen = generateAgainst(parsed, auxProject(), {
      targetExtruderIndex: 2, feed: 'bowden', bake: true, applyToAllExtruders: true
    });
    const out = JSON.parse(gen.serialized) as Record<string, unknown>;
    expect((out.filament_start_gcode as string[]).join('\n')).not.toContain('M900');
    expect((gen.skippedFields ?? []).some(s =>
      s.presetKey === 'filament_start_gcode' && s.reason.includes('more than one feed path'))).toBe(true);
  });
});

// --- "apply to all value slots" must not be a way round the feed-path rule --

describe('“apply to all value slots” on a MIXED-FEED preset', () => {
  const base = () => parseFixture(X2D_ABS);

  it('writes nothing at all — the flag cannot cross a feed path', () => {
    const parsed = base();
    const before = JSON.parse(JSON.stringify(parsed.profile.rawProfile)) as Record<string, unknown>;
    const project = auxProject();
    const gen = generateAgainst(parsed, project, {
      targetExtruderIndex: 2, feed: 'bowden', applyToAllExtruders: true, bake: true
    });
    const out = JSON.parse(gen.serialized) as Record<string, unknown>;

    // Slots 1 and 2 are Direct Drive Standard / High Flow — the MAIN nozzle,
    // whose stock retraction is 0.8 mm and whose PA band is 0–0.1. None of the
    // bowden numbers may reach them.
    expect(out.nozzle_temperature).toEqual(before.nozzle_temperature);
    expect(out.filament_flow_ratio).toEqual(before.filament_flow_ratio);
    expect(out.filament_retraction_length).toBeUndefined();
    expect(out.pressure_advance).toBeUndefined();
    expect((out.filament_start_gcode as string[]).join('\n')).not.toContain('M900');
    expect(gen.changedFields).toEqual([]);

    // Every withheld key is reported: the file and the report must agree.
    const skippedKeys = new Set((gen.skippedFields ?? []).map(s => s.presetKey));
    for (const k of ownedKeys(project)) expect(skippedKeys.has(k), k).toBe(true);
    const reasons = (gen.skippedFields ?? []).map(s => s.reason).join('\n');
    expect(reasons).toContain('apply to all value slots');
    expect(reasons).toContain('Direct Drive Standard');
  });

  it('is refused the same way when the calibrated nozzle’s feed is unknown', () => {
    const parsed = base();
    const gen = generateAgainst(parsed, auxProject(), {
      targetExtruderIndex: 2, feed: null, applyToAllExtruders: true
    });
    expect(gen.changedFields).toEqual([]);
    expect((gen.skippedFields ?? []).length).toBeGreaterThan(0);
  });

  it('is still allowed on a SINGLE-feed preset, where it means "every hotend"', () => {
    // The escape is legitimate across hotend variants of one feed path; only
    // the cross-feed case is refused. Regression guard against over-blocking.
    const parsed = parseFixture(H2S_2SLOT);
    const project = auxProject();
    project.nozzleIndex = 0;
    const gen = generateAgainst(parsed, project, {
      targetExtruderIndex: 0, feed: 'direct', applyToAllExtruders: true
    });
    const out = JSON.parse(gen.serialized) as Record<string, unknown>;
    expect(out.nozzle_temperature).toEqual(['255', '255']);
    expect((gen.skippedFields ?? [])).toEqual([]);
  });
});

// --- a legend that cannot be READ is never INVENTED -------------------------

describe('a Bambu preset whose slot legend cannot be resolved', () => {
  const LEGENDLESS: { file: string; slots: number; what: string }[] = [
    { file: 'bambu-system-pla-hs-x2d-2slot-nolegend.json', slots: 2, what: 'two slots, on an X2D' },
    { file: 'bambu-system-tpu-h2d-3slot-nolegend.json', slots: 3, what: 'three slots, on an H2D' }
  ];

  for (const { file, slots, what } of LEGENDLESS) {
    describe(`${file} (${what})`, () => {
      it('really is legend-less and really is multi-slot', () => {
        const parsed = parseFixture(file);
        const raw = parsed.profile.rawProfile as Record<string, unknown>;
        expect(parsed.extruderCount).toBe(slots);
        expect(raw.filament_extruder_variant).toBeUndefined();
        expect(raw.include).toBeUndefined();
        expect(resolveSlotLegend(parsed)).toBe(null);
      });

      it('writes NO filament_extruder_variant — a fabricated legend mislabels hardware', () => {
        const parsed = parseFixture(file);
        const gen = generateAgainst(parsed, auxProject(), { targetExtruderIndex: 1, feed: 'bowden' });
        const out = JSON.parse(gen.serialized) as Record<string, unknown>;
        expect(out.filament_extruder_variant).toBeUndefined();
      });

      it('withholds every calibrated key, and reports every one of them', () => {
        const parsed = parseFixture(file);
        const before = JSON.parse(JSON.stringify(parsed.profile.rawProfile)) as Record<string, unknown>;
        const project = auxProject();
        const gen = generateAgainst(parsed, project, { targetExtruderIndex: 1, feed: 'bowden' });
        const out = JSON.parse(gen.serialized) as Record<string, unknown>;

        expect(gen.changedFields).toEqual([]);
        for (const k of ownedKeys(project)) {
          expect(out[k], k).toEqual(before[k]); // undefined stays undefined
        }
        const skippedKeys = new Set((gen.skippedFields ?? []).map(s => s.presetKey));
        for (const k of ownedKeys(project)) expect(skippedKeys.has(k), k).toBe(true);
        expect((gen.skippedFields ?? [])[0].reason).toContain('could not establish what each slot means');
      });

      it('validation blocks it rather than passing a preset with no legend', () => {
        const parsed = parseFixture(file);
        const project = auxProject();
        const gen = generateAgainst(parsed, project, { targetExtruderIndex: 1, feed: 'bowden' });
        const result = validateGeneratedProfile(gen, {
          project, printer: x2dPrinter, baseProfile: parsed.profile
        });
        expect(result.valid).toBe(false);
        expect(result.errors.map(e => e.code)).toContain('EXTRUDER_VARIANT_MISSING');
      });
    });
  }

  it('a SINGLE-slot Bambu preset still gets its one slot named', () => {
    // One slot has no mapping to get wrong, and a Bambu user preset without a
    // legend is not shown at all — so this case must keep working.
    const parsed = parseFixture(X2D_ABS);
    const raw = parsed.profile.rawProfile as Record<string, unknown>;
    delete raw.include;
    for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) raw[k] = [v[0]];
    const single = getAdapter('bambu').parseProfile({
      kind: 'detected', fileName: 'single.json', json: JSON.stringify(raw), infoText: null, filePath: null
    })!;
    expect(single.extruderCount).toBe(1);
    const project = auxProject();
    project.nozzleIndex = 0;
    const gen = generateAgainst(single, project, { targetExtruderIndex: 0, feed: 'direct' });
    const out = JSON.parse(gen.serialized) as Record<string, unknown>;
    expect(out.filament_extruder_variant).toEqual(['Direct Drive Standard']);
    expect((out.nozzle_temperature as string[])[0]).toBe('255');
  });
});

// --- a legend that names hotends cannot address one of two nozzles ----------

describe('a single-feed legend on a machine with two physical nozzles (H2D)', () => {
  // The H2D has two direct-drive toolheads and its filament presets carry the
  // 2-slot direct-dual legend. Its own machine preset proves the slots are not
  // nozzles: extruder_variant_list lists the same Standard/High Flow pair for
  // each nozzle, so both read whichever slot matches their fitted hotend.
  const h2dPrinter: PrinterProfile = {
    ...x2dPrinter, id: 'printer-h2d', name: 'Bambu Lab H2D', maxNozzleTemp: 350,
    nozzles: [
      { label: 'Left (direct drive)', feed: 'direct' },
      { label: 'Right (direct drive)', feed: 'direct' }
    ]
  };

  it('refuses instead of sending both nozzles to the same slot', () => {
    const parsed = parseFixture(H2S_2SLOT);
    const right = resolveTargetSlot({
      base: parsed, nozzleIndex: 1, nozzleFeed: 'direct', physicalNozzleCount: 2
    });
    const left = resolveTargetSlot({
      base: parsed, nozzleIndex: 0, nozzleFeed: 'direct', physicalNozzleCount: 2
    });
    expect(right.kind).toBe('unresolved');
    expect(right.kind === 'unresolved' && right.code).toBe('SLOT_SHARED_BY_NOZZLES');
    expect(left.kind).toBe('unresolved');
  });

  it('the same preset on a SINGLE-nozzle machine still resolves normally', () => {
    // The H2S is one nozzle with interchangeable hotends: there the two slots
    // really are that nozzle's Standard and High Flow variants.
    const r = resolveTargetSlot({
      base: parseFixture(H2S_2SLOT), nozzleIndex: 0, nozzleFeed: 'direct', physicalNozzleCount: 1
    });
    expect(r.kind).toBe('variant');
    expect(r.kind === 'variant' && r.slot).toBe(0);
  });

  it('the write path refuses too, and writes nothing', () => {
    const parsed = parseFixture(H2S_2SLOT);
    const before = JSON.parse(JSON.stringify(parsed.profile.rawProfile)) as Record<string, unknown>;
    const project = auxProject();
    const gen = generateAgainst(parsed, project, {
      targetExtruderIndex: 0, feed: 'direct', physicalNozzleCount: 2
    });
    const out = JSON.parse(gen.serialized) as Record<string, unknown>;
    expect(out.nozzle_temperature).toEqual(before.nozzle_temperature);
    expect(gen.changedFields).toEqual([]);
    const reasons = (gen.skippedFields ?? []).map(s => s.reason).join('\n');
    expect(reasons).toContain('hotend variants, not nozzles');
    void h2dPrinter;
  });
});

// --- the refusal report must name the right hardware ------------------------

describe('withheld-field reports distinguish VALUE SLOTS from NOZZLES', () => {
  it('never invents a nozzle number the machine does not have', () => {
    // The X2D has two nozzles. Slot indices run 1–4. Before this rule the
    // report said "nozzle 3" and "nozzle 1, 2, 4".
    const parsed = parseFixture(X2D_ABS);
    const gen = generateAgainst(parsed, auxProject(), {
      targetExtruderIndex: 2, feed: 'bowden', bake: true
    });
    const notes = gen.skippedFields ?? [];
    expect(notes.length).toBeGreaterThan(0);
    for (const s of notes) {
      expect(s.reason, s.presetKey).not.toMatch(/nozzle 3\b/);
      expect(s.reason, s.presetKey).not.toMatch(/nozzle 4\b/);
      // Any NUMBERED slot reference is spelled "value slot N", never bare.
      expect(s.reason.replace(/value slot \d+/g, ''), s.presetKey).not.toMatch(/slot \d/);
    }
    // The one nozzle number that IS legitimate is the calibrated one.
    expect(notes.map(s => s.reason).join('\n')).toContain('nozzle 2');
  });

  it('never recommends “apply to all” on a preset spanning two feed paths', () => {
    const parsed = parseFixture(X2D_ABS);
    const gen = generateAgainst(parsed, auxProject(), { targetExtruderIndex: 2, feed: 'bowden' });
    for (const s of gen.skippedFields ?? []) {
      expect(s.reason, s.presetKey).not.toMatch(/re-run with “apply to all/);
      expect(s.reason, s.presetKey).not.toMatch(/apply to all extruders/);
    }
    expect((gen.skippedFields ?? []).map(s => s.reason).join('\n'))
      .toContain('Do NOT use “apply to all value slots” here');
  });

  it('does not tell a single-slot user to find a preset with N slots for nozzle N', () => {
    // On the X2D nozzle 2 needs FOUR slots, not two, so the old advice ("pick a
    // preset that carries 2 value slots") was wrong as well as unhelpful.
    const parsed = parseFixture(X2D_ABS);
    const raw = parsed.profile.rawProfile as Record<string, unknown>;
    delete raw.include;
    for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) raw[k] = [v[0]];
    const single = getAdapter('bambu').parseProfile({
      kind: 'detected', fileName: 'single.json', json: JSON.stringify(raw), infoText: null, filePath: null
    })!;
    const gen = generateAgainst(single, auxProject(), { targetExtruderIndex: 0, feed: 'bowden' });
    const reasons = (gen.skippedFields ?? []).map(s => s.reason).join('\n');
    expect(reasons).toContain('cannot hold a value for nozzle 2');
    expect(reasons).not.toMatch(/carries 2 value slots/);
  });
});

describe('a main (direct drive) calibration on the same X2D preset', () => {
  it('lands in Direct Drive Standard and leaves both Bowden slots unset', () => {
    const parsed = parseFixture(X2D_ABS);
    const project = auxProject({ retractionDistance: 0.8 });
    project.nozzleIndex = 0;
    const pick = resolveTargetSlot({ base: parsed, nozzleIndex: 0, nozzleFeed: 'direct' });
    expect(pick.kind === 'variant' && pick.variantName).toBe('Direct Drive Standard');
    const gen = generateAgainst(parsed, project, {
      targetExtruderIndex: pick.kind === 'variant' ? pick.slot : 0, feed: 'direct'
    });
    const out = JSON.parse(gen.serialized) as Record<string, unknown>;
    expect(out.nozzle_temperature).toEqual(['255', '270', '270', '270']);
    // The bowden slots keep the no-override sentinel, so the auxiliary keeps
    // running the machine's own retraction rather than a direct-drive number.
    expect(out.filament_retraction_length).toEqual(['0.8', 'nil', 'nil', 'nil']);
  });
});

describe('a second real X2D preset behaves identically', () => {
  it('maps the auxiliary to Bowden Standard and preserves the bowden-only keys', () => {
    const parsed = parseFixture('bambu-system-support-abs-x2d-4slot.json');
    expect(parsed.extruderCount).toBe(4);
    const pick = resolveTargetSlot({ base: parsed, nozzleIndex: 1, nozzleFeed: 'bowden' });
    expect(pick.kind === 'variant' && pick.variantName).toBe('Bowden Standard');
    const gen = generateAgainst(parsed, auxProject(), {
      targetExtruderIndex: pick.kind === 'variant' ? pick.slot : 0, feed: 'bowden'
    });
    const out = JSON.parse(gen.serialized) as Record<string, unknown>;
    expect((out.filament_flow_ratio as string[])[2]).toBe('0.94');
    // Bambu's own per-variant differentiation must survive untouched.
    expect(out.retraction_distances_when_ec).toEqual(['3', '3', '4', '4']);
  });
});

// --- the same refusal on a preset that cannot serve a bowden nozzle ---------

describe('a bowden calibration against an all-direct-drive preset', () => {
  it('writes nothing and names the mismatch', () => {
    const parsed = parseFixture(H2S_2SLOT);
    const before = JSON.parse(JSON.stringify(parsed.profile.rawProfile)) as Record<string, unknown>;
    const gen = generateAgainst(parsed, auxProject(), { targetExtruderIndex: 1, feed: 'bowden' });
    const out = JSON.parse(gen.serialized) as Record<string, unknown>;
    expect(out.pressure_advance).toEqual(before.pressure_advance);
    expect(out.nozzle_temperature).toEqual(before.nozzle_temperature);
    expect(gen.changedFields).toEqual([]);
    expect((gen.skippedFields ?? []).length).toBeGreaterThan(0);
  });
});

// --- the wizard's own explanation of the model ------------------------------

describe('the slot-selector copy the user reads before choosing', () => {
  it('does not teach that a slot is a tool on a mixed-feed preset', () => {
    const legend = resolveSlotLegend(parseFixture(X2D_ABS))!;
    const p = slotMeaningParagraph(legend, 4);
    // The sentence that produced this bug class: "on dual-nozzle printers each
    // slot is a tool", followed by "slot 1 is Standard, slot 2 is High Flow".
    expect(p).not.toMatch(/each slot is a tool/i);
    expect(p).not.toMatch(/slot 2 is High Flow/i);
    // What it must say instead.
    expect(p).toContain('two different feed paths');
    expect(p).toContain('slot order is not nozzle order');
    expect(p).toContain('Bowden Standard');
  });

  it('names the slots from the legend on a single-feed preset', () => {
    const legend = resolveSlotLegend(parseFixture(H2S_2SLOT))!;
    const p = slotMeaningParagraph(legend, 2);
    expect(p).toContain('Direct Drive Standard, Direct Drive High Flow');
    expect(p).not.toMatch(/each slot is a tool/i);
  });

  it('never equates a slot number with a nozzle number when there is no legend', () => {
    const p = slotMeaningParagraph(null, 2);
    expect(p).toContain('does not say what they mean');
    expect(p).not.toMatch(/nozzle 1|nozzle 2/);
    // The dropdown labels must not either.
    expect(slotOptionLabel(null, 0)).toBe('Value slot 1');
    expect(slotOptionLabel(null, 1)).toBe('Value slot 2');
  });

  it('labels dropdown entries from the legend when one resolves', () => {
    const legend = resolveSlotLegend(parseFixture(X2D_ABS))!;
    expect(slotOptionLabel(legend, 2)).toBe('Slot 3 — Bowden Standard');
  });
});

// --- the escape hatch must not be the only enabled control on a refusal -----

describe('when “apply to all value slots” may be offered', () => {
  it('is withheld on a mixed-feed preset, with the reason named', () => {
    const legend = resolveSlotLegend(parseFixture(X2D_ABS))!;
    const a = applyToAllAvailability(legend, true);
    expect(a.available).toBe(false);
    expect(a.reason).toContain('two different feed paths');
  });

  it('is withheld while the slot mapping is unresolved', () => {
    // It used to be the one enabled control beside the blocking error, and
    // ticking it cleared the refusal and every cross-nozzle guard behind it.
    const legend = resolveSlotLegend(parseFixture(H2S_2SLOT))!;
    const a = applyToAllAvailability(legend, false);
    expect(a.available).toBe(false);
    expect(a.reason).toContain('cannot tell which slot');
  });

  it('is still offered where it means something — one feed path, slot resolved', () => {
    const legend = resolveSlotLegend(parseFixture(H2S_2SLOT))!;
    expect(applyToAllAvailability(legend, true)).toEqual({ available: true });
  });
});
