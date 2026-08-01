import { describe, it, expect } from 'vitest';
import { CALIBRATIONS, DEFAULT_ORDER } from '../src/data/calibrations';
import { getSlicerContent } from '../src/data/slicers';
import type { CalibrationId, SlicerId } from '../src/types';

// ---------------------------------------------------------------------------
// The order, and the reasoning that has to travel with it.
//
// DEFAULT_ORDER is not a preference. Five published sequences were compared
// against it (Ellis' Print Tuning Guide, Teaching Tech's calibration page, the
// OrcaSlicer wiki calibration guide, the Bambu Lab wiki, Maker's Muse) and the
// shape survived. What was missing was the REASONING: a step that cannot say
// what its result changes downstream is indistinguishable from an arbitrary
// list, and two of the explanations we did ship were wrong or silently
// contradicted the vendor documentation the user is most likely to read next.
//
// These tests pin the order itself, the direction of every dependency edge, and
// the specific claims that were corrected — including the verbatim vendor
// sentences, because a paraphrase of a vendor sentence is not citable.
// ---------------------------------------------------------------------------

/** The researched order. Changing it is allowed; changing it by accident is not. */
const ORDER_AS_SHIPPED: CalibrationId[] = [
  'temperature',
  'flow-pass1',
  'flow-pass2',
  'pressure-advance',
  'flow-verify',
  'retraction',
  'max-volumetric-speed',
  'shrinkage',
  'final-verification'
];

/** Verbatim from wiki.bambulab.com — quoted, never paraphrased. */
const BAMBU_PA_BEFORE_FLOW =
  'It is advisable to conduct a Flow Dynamics Calibration prior to the Flow Rate Calibration';
const BAMBU_RERUN_TRIGGER =
  'When the maximum volumetric speed or print temperature is changed in the filament settings';
const BAMBU_MVS_CLOG_WARNING =
  'An incorrect maximum volumetric speed can lead to nozzle clogging';

const orderText = (id: CalibrationId): string => CALIBRATIONS[id].whyThisOrder;

/** Everything the wizard can show for a step, in one string. */
const stepText = (id: CalibrationId): string => {
  const def = CALIBRATIONS[id];
  return [
    def.purpose,
    def.whyThisOrder,
    def.whyExpanded,
    ...def.prerequisites.map((p) => `${p.label} ${p.coachNote ?? ''}`),
    ...def.methods.map((m) => `${m.label} ${m.description}`),
    ...def.versionNotes,
    def.slicerDestination.note
  ].join(' ');
};

const prereqText = (id: CalibrationId): string =>
  CALIBRATIONS[id].prerequisites.map((p) => `${p.label} ${p.coachNote ?? ''}`).join(' ');

const slicerText = (slicer: SlicerId, id: CalibrationId): string => {
  const inst = getSlicerContent(slicer).perTest[id];
  if (!inst) return '';
  return [
    inst.menuPath,
    ...inst.steps,
    ...(inst.disableFirst ?? []),
    ...(inst.gotchas ?? []),
    inst.saveTo.note
  ].join(' ');
};

describe('the default calibration order', () => {
  it('ships the researched nine-step sequence, so a reorder is a deliberate act', () => {
    expect(DEFAULT_ORDER).toEqual(ORDER_AS_SHIPPED);
  });

  it('starts from the only step with no dependencies and gives every other step at least one', () => {
    expect(CALIBRATIONS.temperature.dependencies).toEqual([]);
    for (const id of DEFAULT_ORDER) {
      if (id === 'temperature') continue;
      expect(CALIBRATIONS[id].dependencies.length, id).toBeGreaterThan(0);
    }
  });

  it('keeps the three positions the sources agree on', () => {
    // Temperature first is the best-evidenced claim in the corpus and is
    // vendor-documented. Retraction after pressure advance is stated verbatim by
    // the Orca wiki. Shrinkage near the end is unanimous across all sources.
    expect(DEFAULT_ORDER[0]).toBe('temperature');
    expect(DEFAULT_ORDER.indexOf('retraction')).toBeGreaterThan(
      DEFAULT_ORDER.indexOf('pressure-advance')
    );
    expect(DEFAULT_ORDER.indexOf('shrinkage')).toBeGreaterThan(
      DEFAULT_ORDER.indexOf('flow-pass1')
    );
    expect(DEFAULT_ORDER[DEFAULT_ORDER.length - 1]).toBe('final-verification');
  });
});

describe('every step can say what its result changes downstream', () => {
  // A position is only defensible if the step can name the later steps its own
  // result moves. These are the claims each producing step has to make.
  const DOWNSTREAM_CLAIMS: Partial<Record<CalibrationId, RegExp[]>> = {
    temperature: [/flow/i, /pressure advance|flow dynamics/i, /melt|visc/i],
    'flow-pass1': [/pressure advance/i, /shrinkage|dimension/i, /under-extrusion|volumetric/i],
    'pressure-advance': [/flow/i, /retraction|travel/i],
    'flow-verify': [/confirm/i],
    'max-volumetric-speed': [/pressure advance|flow dynamics|K value/i],
    retraction: [/temperature/i, /pressure advance/i],
    shrinkage: [/flow/i, /temperature/i]
  };

  for (const [id, claims] of Object.entries(DOWNSTREAM_CLAIMS) as [CalibrationId, RegExp[]][]) {
    it(`${id} explains its position in terms of other steps`, () => {
      expect(orderText(id).length, id).toBeGreaterThan(80);
      for (const claim of claims) expect(orderText(id), `${id} ${claim}`).toMatch(claim);
    });
  }
});

describe('the question the owner actually asked: where are heatbed and first layer?', () => {
  it('is answered on the first step, which is where a user notices they are missing', () => {
    const t = orderText('temperature');
    expect(t).toMatch(/bed/i);
    expect(t).toMatch(/first layer/i);
    expect(t).toMatch(/not a calibration step/i);
  });

  it('says first-layer reliability is fixed once per printer and plate, not per spool', () => {
    const adhesion = CALIBRATIONS.temperature.prerequisites.find((p) => p.id === 'adhesion');
    expect(adhesion).toBeDefined();
    expect(adhesion!.coachNote).toMatch(/once/i);
    // Bambu's own framing: wash the plate first, because a first layer that does
    // not stick changes the calibration result.
    expect(adhesion!.coachNote).toMatch(/wash/i);
  });

  it('says plainly that retraction comes late rather than third', () => {
    const t = orderText('temperature');
    expect(t).toMatch(/retraction/i);
    expect(DEFAULT_ORDER.indexOf('retraction')).toBeGreaterThan(3);
  });
});

describe('contested ordering is named, not silently contradicted', () => {
  it('quotes Bambu\'s own sentence putting flow dynamics before flow rate', () => {
    expect(orderText('flow-pass1')).toContain(BAMBU_PA_BEFORE_FLOW);
  });

  it('explains why we run flow first and how the loop closes', () => {
    const t = orderText('flow-pass1');
    expect(t).toMatch(/circular/i);
    expect(t).toMatch(/re-check/i);
  });

  it('labels the flow re-check as our own step rather than sourced practice', () => {
    expect(orderText('flow-verify')).toMatch(/published guide/i);
  });

  it('no longer claims pressure advance is zero or default during the first flow pass', () => {
    // False on every current Bambu machine, which auto-calibrates flow dynamics
    // before a print — and wrong reasoning in safety-adjacent copy is corrosive.
    const t = CALIBRATIONS['flow-verify'].whyExpanded;
    expect(t).not.toMatch(/zero or default/i);
    expect(t).toMatch(/automatic|auto-calibrat/i);
    expect(t).toMatch(/Flow Dynamics/i);
  });
});

describe('the feedback edge our own order creates', () => {
  // Bambu list a changed max volumetric speed as a reason to re-run Flow
  // Dynamics. Our order changes MVS three steps AFTER calibrating K, so the
  // wizard walks the user into a state the vendor says needs a re-check. The
  // dependency array only points backwards, so this edge lives in the copy —
  // and it has to be in all three places a user could meet it.
  it('is stated on the step that causes it, with the vendor sentence quoted', () => {
    expect(stepText('max-volumetric-speed')).toContain(BAMBU_RERUN_TRIGGER);
    expect(orderText('max-volumetric-speed')).toMatch(/pressure advance|K value/i);
  });

  it('is caught by the final verification prerequisites', () => {
    const t = prereqText('final-verification');
    expect(t).toMatch(/max volumetric speed/i);
    expect(t).toMatch(/pressure advance|flow dynamics|K value/i);
  });

  it('reaches the click-by-click instructions in both slicers', () => {
    for (const slicer of ['orca', 'bambu'] as const) {
      expect(slicerText(slicer, 'max-volumetric-speed'), slicer).toMatch(
        /Flow Dynamics|pressure advance/i
      );
    }
  });

  it('quotes Bambu\'s clogging warning where the max-flow number is chosen', () => {
    expect(stepText('max-volumetric-speed')).toContain(BAMBU_MVS_CLOG_WARNING);
  });
});

describe('arriving with Bambu Studio\'s calibrations already run by hand', () => {
  it('treats an existing flow ratio as the baseline rather than something to discard', () => {
    const t = stepText('flow-pass1');
    expect(t).toMatch(/already ran|already calibrated|already have/i);
    expect(t).toMatch(/baseline|starting point|starts from/i);
  });

  it('names which Bambu dialog each of our two flow passes is', () => {
    expect(stepText('flow-pass1')).toMatch(/Coarse/);
    expect(stepText('flow-pass2')).toMatch(/Fine/);
  });

  it('warns that an automatic K value and a manual one are not the same number', () => {
    const t = stepText('pressure-advance') + ' ' + slicerText('bambu', 'pressure-advance');
    expect(t).toMatch(/automatic/i);
    expect(t).toMatch(/manual/i);
    expect(t).toMatch(/scale/i);
  });

  it('tells the user to check which nozzle a stored Flow Dynamics result belongs to', () => {
    const t = stepText('pressure-advance') + ' ' + slicerText('bambu', 'pressure-advance');
    expect(t).toMatch(/which nozzle/i);
  });

  it('switches the printer\'s own flow calibration off for every flow plate, in both slicers', () => {
    for (const slicer of ['orca', 'bambu'] as const) {
      for (const id of ['flow-pass1', 'flow-pass2', 'flow-verify'] as CalibrationId[]) {
        const inst = getSlicerContent(slicer).perTest[id];
        const t = [...(inst?.disableFirst ?? []), ...(inst?.steps ?? [])].join(' ');
        expect(t, `${slicer}/${id}`).toMatch(/Flow Calibration/i);
      }
    }
  });
});

describe('the printer can cross-apply a K value between nozzles by itself', () => {
  // The wizard's central invariant — a value calibrated for one nozzle never
  // lands on another — has been broken four times in this codebase's own code.
  // Bambu document an H2C setting that does it in the PRINTER, downstream of
  // anything this app controls, and it ships enabled. Silence there would let a
  // user do careful per-nozzle work that the machine then quietly undoes.
  const paText = slicerText('bambu', 'pressure-advance');

  it('tells the user the default matches on nozzle TYPE, not the specific nozzle', () => {
    expect(paText).toMatch(/type of filament and nozzle/i);
    expect(paText).toMatch(/enabled by default/i);
    expect(paText).toMatch(/nozzle TYPE, not/);
  });

  it('states both positions of the switch, so the user can decide either way', () => {
    expect(paText).toMatch(/[Dd]isabled/);
    expect(paText).toMatch(/exactly the ones recorded|exactly the same/i);
  });

  it('does not instruct the user to change it — which behaviour is right is their call', () => {
    expect(paText).not.toMatch(/you must (disable|turn off)/i);
    expect(paText).not.toMatch(/always (disable|turn off) (this|that)/i);
  });

  it('is labelled vendor-documented rather than verified, per the honesty commitment', () => {
    expect(paText).toMatch(/not verified on hardware/i);
  });
});
