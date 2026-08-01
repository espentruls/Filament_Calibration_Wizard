import { describe, expect, it } from 'vitest';
import {
  CONTROLLERS, chamberOozeCallout, flowMethodCallouts, oozeLeverCallout,
  spoolConditionCallout, temperatureOozeCallout, type TestCtx
} from '../src/ui/testForms';
import { CALIBRATIONS, DRYING_SCHEDULES, OOZE_LEVERS } from '../src/data/calibrations';
import { getSlicerContent } from '../src/data/slicers';
import { getMaterial, MATERIALS } from '../src/data/materials';
import type { CalibrationProject, PrinterProfile } from '../src/types';

// ---------------------------------------------------------------------------
// Fixtures
//
// The X2D profile mirrors what the app's own quick-fill produces plus the two
// chamber specs from src/data/printers.json's bambu-lab-x2d record, so the
// chamber branches are exercised against the machine the fork exists for.
// ---------------------------------------------------------------------------

const x2d: PrinterProfile = {
  id: 'x2d', name: 'Bambu Lab X2D', manufacturer: 'Bambu Lab', nozzleDiameter: 0.4,
  maxNozzleTemp: 300, maxBedTemp: 110, extruderType: 'direct',
  retractionRange: { start: 2, end: 6 },
  maxChamberTemp: 65, heatedChamber: true,
  nozzles: [
    { label: 'Main (direct drive)', feed: 'direct' },
    { label: 'Auxiliary (bowden)', feed: 'bowden', maxSpeed: 200, maxAccel: 1000 }
  ],
  notes: '', createdAt: '', updatedAt: ''
};

/**
 * A single-nozzle bowden machine — the shape that must NOT be given the X2D's
 * numbers or told about an auxiliary hotend. 35 of the 379 records in
 * printers.json are bowden, plus any hand-entered profile.
 */
const enderBowden: PrinterProfile = {
  id: 'ender', name: 'Creality Ender 3', manufacturer: 'Creality', nozzleDiameter: 0.4,
  maxNozzleTemp: 260, maxBedTemp: 100, extruderType: 'bowden',
  retractionRange: { start: 1, end: 7 }, notes: '', createdAt: '', updatedAt: ''
};

/**
 * The same machine described in more detail — one nozzle, listed. This is the
 * shape that reaches the aux-hotend copy: `resolveNozzle` returns a real nozzle
 * object, so a guard on `sel.nozzle` alone lets it through.
 */
const enderBowdenListed: PrinterProfile = {
  ...enderBowden, id: 'ender-listed',
  nozzles: [{ label: 'Hotend', feed: 'bowden' }]
};

const openFrame: PrinterProfile = {
  id: 'of', name: 'Open frame', manufacturer: 'Generic', nozzleDiameter: 0.4,
  maxNozzleTemp: 300, maxBedTemp: 110, extruderType: 'direct',
  retractionRange: { start: 0, end: 2 }, heatedChamber: false,
  notes: '', createdAt: '', updatedAt: ''
};

function ctxFor(materialId: string, opts: {
  printer?: PrinterProfile;
  nozzleIndex?: number;
  finals?: CalibrationProject['finals'];
} = {}): TestCtx {
  const project = {
    id: 'p', createdAt: '', updatedAt: '', calibrationDate: '',
    filament: { manufacturer: '', productLine: '', material: materialId, color: '', diameter: 1.75, startingProfile: '' },
    printerProfileId: 'x2d', nozzleType: 'brass', nozzleIndex: opts.nozzleIndex,
    slicer: { slicer: 'bambu', version: '1.7+' },
    notes: '', mode: 'coach', stepOrder: [], steps: {}, timeline: [], archived: false,
    finals: opts.finals ?? {}
  } as unknown as CalibrationProject;
  return {
    project, printer: opts.printer ?? x2d, material: getMaterial(materialId),
    method: 'yolo', coach: true
  };
}

const text = (c: { title: string; body: string[] } | null): string =>
  c ? [c.title, ...c.body].join(' ') : '';

// ---------------------------------------------------------------------------
// 4 — old / unknown spool
// ---------------------------------------------------------------------------

describe('spool condition triage', () => {
  it('gives ABS the drying schedule Bambu ships, with the softening ceiling', () => {
    // fdm_filament_abs.json: drying 65 °C/12 h (AMS 2 Pro) or 80 °C/8 h (AMS HT),
    // softening 80 °C, heat-distortion 90 °C.
    const t = text(spoolConditionCallout(getMaterial('ABS')));
    expect(t).toContain('65');
    expect(t).toContain('12');
    expect(t).toContain('80');
    expect(t).toContain('8');
    expect(t).toContain('90');
  });

  it('lists the symptoms that separate a wet spool from a mis-tuned one', () => {
    const t = text(spoolConditionCallout(getMaterial('ABS'))).toLowerCase();
    expect(t).toContain('popping');
    expect(t).toContain('bubbl');
    // The ooze-specific signature: extrusion carries on after the command stops.
    expect(t).toMatch(/after (the|you stop)/);
    // Degradation a dryer cannot reverse.
    expect(t).toContain('snap');
  });

  it('covers ASA too, with ASA\'s own numbers', () => {
    const t = text(spoolConditionCallout(getMaterial('ASA')));
    expect(t).toContain('65');
    expect(t).toContain('85'); // ASA softening temperature, not ABS's 80
  });

  it('stays quiet for materials that do not arrive wet', () => {
    expect(spoolConditionCallout(getMaterial('PLA'))).toBeNull();
  });

  it('does not put ABS drying numbers on another material', () => {
    const petg = spoolConditionCallout(getMaterial('PETG'));
    expect(petg).not.toBeNull();
    // PETG is hygroscopic so it gets the triage, but no invented schedule:
    // its numbers live in the material preset's own warnings.
    expect(DRYING_SCHEDULES['PETG']).toBeUndefined();
    expect(text(petg)).not.toContain('80 °C');
  });
});

// ---------------------------------------------------------------------------
// 2 — hot chamber / ooze interaction
// ---------------------------------------------------------------------------

describe('chamber guidance is per material', () => {
  it('never tells a low-temperature material to run a hot chamber', () => {
    for (const id of ['PLA', 'PLA+', 'PETG', 'PCTG', 'TPU']) {
      expect(getMaterial(id).chamber.advice, id).toBe('ambient');
      const c = chamberOozeCallout(getMaterial(id), x2d);
      expect(c?.tone, id).toBe('warn');
      expect(text(c).toLowerCase(), id).toContain('heat creep');
      expect(text(c).toLowerCase(), id).not.toContain('as hot as');
    }
  });

  it('tells ABS and ASA to run the chamber as hot as the machine allows', () => {
    for (const id of ['ABS', 'ASA']) {
      expect(getMaterial(id).chamber.advice, id).toBe('hot');
      const c = chamberOozeCallout(getMaterial(id), x2d);
      expect(c?.tone, id).toBe('info');
      expect(text(c), id).toContain('65'); // the machine's own maximum
    }
  });

  it('never suggests a chamber above the machine rating', () => {
    const cool = { ...x2d, maxChamberTemp: 45 };
    const t = text(chamberOozeCallout(getMaterial('ABS'), cool));
    expect(t).toContain('45');
    expect(t).not.toContain('65 °C');
  });

  it('explains the trade the owner actually hit: no warping, more drool', () => {
    const t = text(chamberOozeCallout(getMaterial('ABS'), x2d)).toLowerCase();
    expect(t).toContain('warp');
    expect(t).toContain('ooze');
    // The lever the hot chamber buys back, and the check that keeps it honest.
    expect(t).toContain('nozzle temperature');
    expect(t).toContain('layer adhesion');
  });

  it('says the opposite when there is no chamber to pay for a cooler nozzle', () => {
    const t = text(chamberOozeCallout(getMaterial('ABS'), openFrame)).toLowerCase();
    expect(t).toContain('less room');
  });

  it('withholds rather than guesses for a material with no vendor data', () => {
    expect(getMaterial('OTHER').chamber.advice).toBe('unknown');
    expect(chamberOozeCallout(getMaterial('OTHER'), x2d)?.tone).toBe('info');
    expect(text(chamberOozeCallout(getMaterial('OTHER'), x2d)).toLowerCase())
      .toContain('no chamber guidance');
  });
});

// ---------------------------------------------------------------------------
// 1 + 2 — temperature as the dominant ooze lever
// ---------------------------------------------------------------------------

describe('temperature step ooze framing', () => {
  const rungs = [270, 265, 260, 255, 250, 245, 240, 235, 230];

  it('names 270 as the prime ooze suspect, inside Bambu\'s own window', () => {
    const t = text(temperatureOozeCallout(getMaterial('ABS'), rungs));
    expect(t).toContain('270');
    expect(t).toContain('240');
    expect(t).toContain('280');
    expect(t.toLowerCase()).toContain('suspect');
  });

  it('flags rungs below the vendor floor as a strength risk, not a win', () => {
    const c = temperatureOozeCallout(getMaterial('ABS'), rungs);
    const below = c!.body.find(b => b.includes('235') && b.includes('230'));
    expect(below).toBeDefined();
    expect(below!.toLowerCase()).toContain('snap');
  });

  it('says nothing about the floor when the tower stays inside it', () => {
    const c = temperatureOozeCallout(getMaterial('ABS'), [270, 265, 260, 255, 250, 245, 240]);
    expect(c!.body.some(b => b.toLowerCase().includes('below bambu'))).toBe(false);
  });

  it('stays quiet for materials with no vendor ooze story here', () => {
    expect(temperatureOozeCallout(getMaterial('PLA'), [230, 225, 220])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 1 — the ordered ooze lever list, on a step every project has
// ---------------------------------------------------------------------------

describe('ooze levers', () => {
  it('is ordered by effect size, drying first and z-hop last', () => {
    expect(OOZE_LEVERS[0].name.toLowerCase()).toContain('dry');
    expect(OOZE_LEVERS[OOZE_LEVERS.length - 1].name.toLowerCase()).toContain('z-hop');
    expect(OOZE_LEVERS.map(l => l.rank)).toEqual(OOZE_LEVERS.map((_, i) => i + 1));
  });

  it('marks coasting unavailable instead of sending users hunting for it', () => {
    const t = text(oozeLeverCallout({ material: getMaterial('ABS'), printer: x2d, feed: 'direct' })).toLowerCase();
    expect(t).toContain('coasting');
    expect(t).toMatch(/no coasting|does not exist|neither .* ships/);
  });

  it('says plainly that pressure advance is not an ooze lever', () => {
    const t = text(oozeLeverCallout({ material: getMaterial('ABS'), printer: x2d, feed: 'direct' }));
    expect(t.toLowerCase()).toContain('pressure advance');
    expect(t.toLowerCase()).toMatch(/not an ooze lever|does not change/);
  });

  it('tells an ABS user that conspicuous ooze is out of band for this material', () => {
    const t = text(oozeLeverCallout({ material: getMaterial('ABS'), printer: x2d, feed: 'direct' })).toLowerCase();
    expect(t).toContain('low-ooze');
    expect(t).toMatch(/moisture|dry/);
  });

  it('quotes the bowden aux retraction speed the machine actually ships', () => {
    // Bambu Lab X2D 0.4 nozzle.json: retraction_speed ["30","30","20","20"].
    const t = text(oozeLeverCallout({ material: getMaterial('ABS'), printer: x2d, feed: 'bowden' }));
    expect(t).toContain('20 mm/s');
    expect(t).not.toContain('30 mm/s default');
  });

  it('warns that the cheap levers are already exhausted on the X2D', () => {
    const t = text(oozeLeverCallout({ material: getMaterial('ABS'), printer: x2d, feed: 'bowden' }));
    expect(t).toContain('1000 mm/s'); // travel_speed in 0.20mm Standard @BBL X2D
    expect(t).toContain('2 mm');      // wipe_distance in fdm_bbl_3dp_002_common
  });

  // The X2D's bowden numbers describe a SHORT tube from a toolhead-mounted
  // remote stepper. A long-PTFE machine needs several times that, so quoting
  // "2 mm at 20 mm/s" at an Ender-class printer starts the tower far below the
  // useful band — and below what the same panel's own suggested range says.
  it('does not quote the X2D bowden numbers at a single-nozzle bowden printer', () => {
    const t = text(oozeLeverCallout({ material: getMaterial('ABS'), printer: enderBowden, feed: 'bowden' }));
    expect(t).not.toContain('X2D');
    expect(t).not.toContain('2 mm at 20 mm/s');
    // It still gets bowden-specific guidance, just not another machine's numbers.
    expect(t.toLowerCase()).toContain('bowden');
    expect(t.toLowerCase()).toContain('tube length');
  });

  it('does not tell a single-nozzle printer about an auxiliary hotend it lacks', () => {
    for (const p of [enderBowden, enderBowdenListed]) {
      const cs = flowMethodCallouts(ctxFor('ABS', { printer: p }));
      const t = cs.map(text).join(' ');
      expect(t, p.id).not.toContain('auxiliary');
      expect(t, p.id).not.toContain('X2D');
      expect(cs.some(c => c.id === 'flow-aux'), p.id).toBe(false);
    }
  });

  it('does not exclude flexibles from an "auxiliary hotend" a single-nozzle printer has not got', () => {
    // The same branch's other half: TPU is excluded from the X2D's aux nozzle,
    // which says nothing about a single-nozzle bowden machine that prints it.
    const cs = flowMethodCallouts(ctxFor('TPU', { printer: enderBowdenListed }));
    expect(cs.some(c => c.id === 'flow-aux-excluded')).toBe(false);
  });

  it('still says all of it on the dual-nozzle machine it is about', () => {
    const t = text(oozeLeverCallout({ material: getMaterial('ABS'), printer: x2d, feed: 'bowden' }));
    expect(t).toContain('X2D');
    expect(flowMethodCallouts(ctxFor('ABS', { nozzleIndex: 1 })).some(c => c.id === 'flow-aux')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3 — flow methodology
// ---------------------------------------------------------------------------

describe('flow step methodology notes', () => {
  it('states that the flow judgement is visual, so shrinkage cannot bias it', () => {
    const cs = flowMethodCallouts(ctxFor('ABS'));
    const t = cs.map(c => text(c)).join(' ').toLowerCase();
    expect(t).toContain('caliper');
    expect(t).toContain('shrink');
  });

  it('warns when a shrinkage compensation is already live under the blocks', () => {
    const cs = flowMethodCallouts(ctxFor('ABS', { finals: { shrinkagePercent: 99.4 } }));
    const warn = cs.find(c => c.tone === 'warn');
    expect(warn).toBeDefined();
    expect(text(warn!)).toContain('99.4');
  });

  it('says nothing about a live compensation when there is none', () => {
    const cs = flowMethodCallouts(ctxFor('ABS'));
    expect(cs.some(c => text(c).includes('99.4'))).toBe(false);
  });

  it('gives ABS the raking-light tie-break so a hot chamber does not flatter high flow', () => {
    const t = flowMethodCallouts(ctxFor('ABS')).map(text).join(' ').toLowerCase();
    expect(t).toContain('raking');
    expect(t).toContain('lower');
  });

  it('names the slot the ratio belongs to when calibrating the bowden aux', () => {
    const t = flowMethodCallouts(ctxFor('ABS', { nozzleIndex: 1 })).map(text).join(' ');
    expect(t).toContain('Auxiliary (bowden)');
  });

  it('records that ABS on the aux hotend is vendor-recommended, and not to chase detail with flow', () => {
    const t = flowMethodCallouts(ctxFor('ABS', { nozzleIndex: 1 })).map(text).join(' ');
    expect(t).toMatch(/Recommended list|recommends/);
    expect(t.toLowerCase()).toContain('do not chase it with flow ratio');
  });

  it('does not claim aux support for a filament the vendor excludes there', () => {
    // TPU is the one hard exclusion on the X2D auxiliary hotend, and the repo
    // already refuses it in suggestPaRange / suggestRetractionRange.
    const t = flowMethodCallouts(ctxFor('TPU', { nozzleIndex: 1 })).map(text).join(' ');
    expect(t).not.toMatch(/Recommended list/);
    expect(t.toLowerCase()).toContain('not supported');
  });
});

// ---------------------------------------------------------------------------
// 6 — every instruction traces to the presets, the slicer content, or research
// ---------------------------------------------------------------------------

describe('static copy corrections', () => {
  it('does not call ABS, ASA or PETG semi-crystalline', () => {
    const shrink = CALIBRATIONS['shrinkage'];
    const all = [shrink.purpose, shrink.whyExpanded, ...shrink.evaluationGuide.map(e => e.meaning)].join(' ');
    expect(all).not.toMatch(/Semi-crystalline materials \(PETG, ABS/);
    expect(all.toLowerCase()).toContain('amorphous');
  });

  it('names ABS and ASA among the materials that arrive wet', () => {
    const dry = CALIBRATIONS['temperature'].prerequisites.find(p => p.id === 'dry');
    expect(dry?.coachNote).toContain('ABS');
    const dry2 = CALIBRATIONS['retraction'].prerequisites.find(p => p.id === 'dry2');
    expect(dry2?.coachNote).toContain('ABS');
  });

  it('routes toolchange ooze away from the retraction step and drool away from ooze-control', () => {
    const retraction = CALIBRATIONS['retraction'];
    expect(retraction.prerequisites.some(p => p.id === 'ooze-kind')).toBe(true);
    const oozeKind = retraction.prerequisites.find(p => p.id === 'ooze-kind')!;
    expect(oozeKind.coachNote?.toLowerCase()).toContain('toolchange');
    const ooze = CALIBRATIONS['ooze-control'];
    expect([ooze.purpose, ooze.whyThisOrder, ooze.whyExpanded].join(' ')).toMatch(/retraction step|temperature step/i);
  });

  it('corrects the aux retraction speed in the Bambu retraction instructions', () => {
    const steps = getSlicerContent('bambu').perTest['retraction']?.steps.join(' ') ?? '';
    expect(steps).not.toContain('The 30 mm/s default retraction speed is fine.');
    expect(steps).toContain('20 mm/s');
  });

  it('keeps the field-validated ABS presets untouched', () => {
    const abs = getMaterial('ABS');
    expect(abs.nozzleTemp).toEqual({ min: 230, max: 270 });
    expect(abs.bedTemp).toEqual({ min: 90, max: 110 });
    expect(abs.towerRange).toEqual({ start: 270, end: 230, step: 5 });
    expect(abs.startingFlowRatio).toBe(0.95);
  });

  it('gives the retraction step real in-print ooze coverage, not only travel stringing', () => {
    const r = CALIBRATIONS['retraction'];
    const all = [
      r.purpose, r.whyExpanded, r.slicerDestination.note,
      ...r.evaluationGuide.map(e => `${e.title} ${e.look} ${e.meaning}`),
      ...r.versionNotes
    ].join(' ').toLowerCase();
    expect(all).toContain('wipe');
    expect(all).toContain('z-hop');
    expect(all).toContain('travel speed');
  });

  it('warns every flow step about a shrinkage compensation left switched on', () => {
    for (const id of ['flow-pass1', 'flow-pass2', 'flow-verify'] as const) {
      const prereqs = CALIBRATIONS[id].prerequisites
        .map(p => `${p.label} ${p.coachNote ?? ''}`).join(' ').toLowerCase();
      expect(prereqs, id).toContain('shrinkage');
    }
  });

  it('tells users of BOTH slicers that coasting is not a setting they have', () => {
    for (const slicer of ['orca', 'bambu'] as const) {
      const r = getSlicerContent(slicer).perTest['retraction'];
      const all = [...(r?.steps ?? []), ...(r?.gotchas ?? [])].join(' ').toLowerCase();
      expect(all, slicer).toContain('coasting');
    }
  });

  // Chamber guidance has exactly ONE source: MaterialPreset.chamber, with the
  // machine clamp in suggestChamberTemp. This asserts the callout reads that
  // source rather than carrying a second copy that can drift out of step.
  it('reads chamber advice from the material preset, not a table of its own', () => {
    for (const m of MATERIALS) expect(m.chamber?.advice, m.id).toBeDefined();
    const hot = getMaterial('ABS');
    expect(text(chamberOozeCallout(hot, { ...x2d, maxChamberTemp: 55 }))).toContain('55');
  });

  it('never quotes a drying temperature above the material\'s own softening point', () => {
    for (const [id, s] of Object.entries(DRYING_SCHEDULES)) {
      expect(s.temperatureC, id).toBeLessThanOrEqual(s.softeningC);
      if (s.altTemperatureC !== undefined) {
        expect(s.altTemperatureC, id).toBeLessThanOrEqual(s.softeningC);
      }
      expect(s.softeningC, id).toBeLessThan(s.heatDistortionC);
    }
  });

  it('does not hand the enclosure judging note to a material printed in open air', () => {
    const t = flowMethodCallouts(ctxFor('PLA')).map(text).join(' ').toLowerCase();
    expect(t).not.toContain('raking');
  });

  it('forks toolchange ooze away from travel ooze in the lever callout', () => {
    const t = text(oozeLeverCallout({ material: getMaterial('ABS'), printer: x2d, feed: 'bowden' }));
    expect(t.toLowerCase()).toContain('toolchange');
  });

  it('states the fork on the ooze-control side too, in both slicers', () => {
    for (const slicer of ['orca', 'bambu'] as const) {
      const steps = getSlicerContent(slicer).perTest['ooze-control']?.steps.join(' ').toLowerCase() ?? '';
      expect(steps, slicer).toContain('toolchange ooze');
      expect(steps, slicer).toContain('temperature step');
      expect(steps, slicer).toContain('retraction step');
    }
  });

  it('quotes Bambu\'s own X2D toolchange baseline rather than describing it abstractly', () => {
    // Generic ABS @BBL X2D 0.4 nozzle.json retraction_distances_when_ec ["3","3","4","4"]
    // and filament_cooling_before_tower ["10",…]; machine wipe_distance ["2",…].
    const g = getSlicerContent('bambu').perTest['ooze-control']?.gotchas?.join(' ') ?? '';
    expect(g).toContain('3 mm');
    expect(g).toContain('4 mm');
    expect(g).toContain('2 mm');
    expect(g.toLowerCase()).toContain('flow blocker');
  });
});

// ---------------------------------------------------------------------------
// The sub-floor temperature caution has to travel with the VALUE, because the
// tower it was measured on cannot show the failure it warns about.
// ---------------------------------------------------------------------------

describe('choosing a temperature below the vendor floor', () => {
  const settings = { start: 270, end: 230, step: 5 };

  it('warns and sends the user to the adhesion re-check', () => {
    const out = CONTROLLERS['temperature'].compute(ctxFor('ABS'), settings, {
      normalTemp: 235, acceptableTemps: [235], firstLayerTemp: '', highFlowTemp: '', adhesionChecked: true
    });
    const w = out.warnings.join(' ');
    expect(w).toContain('235');
    expect(w).toContain('240');
    expect(w.toLowerCase()).toContain('layer adhesion');
    expect(w.toLowerCase()).toContain('verification');
  });

  it('stays quiet inside the documented window', () => {
    const out = CONTROLLERS['temperature'].compute(ctxFor('ABS'), settings, {
      normalTemp: 245, acceptableTemps: [245], firstLayerTemp: '', highFlowTemp: '', adhesionChecked: true
    });
    expect(out.warnings.some(m => m.includes('240 °C minimum'))).toBe(false);
  });

  it('says nothing for a material with no documented window here', () => {
    const out = CONTROLLERS['temperature'].compute(ctxFor('PLA'), { start: 230, end: 190, step: 5 }, {
      normalTemp: 190, acceptableTemps: [190], firstLayerTemp: '', highFlowTemp: '', adhesionChecked: true
    });
    expect(out.warnings.join(' ')).not.toContain('documents');
  });
});
