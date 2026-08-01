import { h, field, numberInput, issueList, clear } from './dom';
import type {
  CalibrationId, CalibrationProject, ExtruderType, MaterialPreset, PrinterProfile, VerificationMark
} from '../types';
import {
  flowYolo, flowPercent, paTower, paFromSample, retractionFromHeight,
  mvsFromHeight, mvsProduction, volumetricFlow, maxSpeedForFlow, generateRange, roundTo,
  shrinkageFromMeasurement, shrinkageCombined, shrinkageFromScaleError,
  type CalcResult
} from '../logic/formulas';
import {
  suggestTempRange, suggestPaRange, suggestRetractionRange, suggestMvsRange, suggestFlowMethodDefaults,
  suggestChamberTemp, printerCanHeatChamber, resolveNozzle, FLEXIBLE_RETRACTION_MAX_MM
} from '../logic/ranges';
import { validateNumber, validateTestRange, validateAgainstPrinter, validateFlowRatio, type ValidationIssue } from '../logic/validation';
import {
  VERIFICATION_CATEGORIES, vendorNozzleWindowFor,
  DRYING_SCHEDULES, OOZE_LEVERS, OOZE_LEVER_EXCLUSIONS
} from '../data/calibrations';
import { loadSettings } from '../storage/store';

export interface TestCtx {
  project: CalibrationProject;
  printer?: PrinterProfile;
  material: MaterialPreset;
  method: string;
  coach: boolean;
}

export interface FormBundle {
  el: HTMLElement;
  collect(): { data: Record<string, never> | Record<string, unknown>; issues: ValidationIssue[] };
}

export interface ComputeOutput {
  calcs: CalcResult[];
  computed: Record<string, number | string>;
  finalsPatch: Partial<CalibrationProject['finals']>;
  /** Short lines shown in the "enter this in your slicer" panel. */
  enterInSlicer: { label: string; value: string }[];
  warnings: string[];
}

export interface TestController {
  settingsForm(ctx: TestCtx, prior: Record<string, unknown> | null): FormBundle;
  resultForm(ctx: TestCtx, settings: Record<string, unknown>, prior: Record<string, unknown> | null): FormBundle;
  compute(ctx: TestCtx, settings: Record<string, unknown>, result: Record<string, unknown>): ComputeOutput;
}

const num = (v: unknown): number => Number(v);

// ---------------------------------------------------------------------------
// Instrument primitives
//
// Presentation only. Nothing below is read by collect() or compute() — these
// helpers draw what the user already typed, they never decide anything.
// ---------------------------------------------------------------------------

/** Aviation numerals: fixed precision, never a bare "0" standing in for "unknown". */
function fmt(v: number, precision: number): string {
  return Number.isFinite(v) ? v.toFixed(precision) : '—';
}

/** A recessed sub-panel with an engraved legend — used for live range previews. */
function previewPanel(legend: string, body: HTMLElement): HTMLElement {
  return h('div', { class: 'panel' }, h('span', { class: 'placard' }, legend), body);
}

interface BandHandle {
  el: HTMLElement;
  /** Redraw. `measured` of null leaves the instrument unlit (rule #1). */
  update(measured: number | null, lo: number, hi: number): void;
}

/**
 * Deviation readout — product rule #3.
 *
 * The measured value is drawn against its suggested band with a hairline from
 * the band centre, so drift toward an edge is visible long before anything
 * turns amber. Amber only when the value actually leaves the band; red only
 * when it leaves by more than a full band width.
 */
function bandReadout(opts: {
  precision: number;
  unit?: string;
  /** Word for the reference range in the legend: "suggested", "tested", "acceptable". */
  bandNoun?: string;
  /** Fixed outer scale, when the instrument has one (e.g. the printed range). */
  domain?: { min: number; max: number };
  /** Sentence-case note appended when the value sits outside the band. */
  outsideNote?: string;
  /** Sentence-case note shown while nothing has been measured. */
  unlitNote?: string;
}): BandHandle {
  const unit = opts.unit ? ` ${opts.unit}` : '';
  const noun = opts.bandNoun ?? 'suggested';
  const unlitNote = opts.unlitNote ?? 'Not measured yet';

  const track = h('div', { class: 'band-track', 'aria-hidden': 'true' },
    h('span', { class: 'band-span' }),
    h('span', { class: 'band-drift' }),
    h('span', { class: 'band-mark' }));
  const loLabel = h('span', {}, '');
  const hiLabel = h('span', {}, '');
  const legend = h('p', { class: 'band-legend', 'aria-live': 'polite' }, `${unlitNote}.`);
  const el = h('div', { class: 'band is-unlit', style: '--lo:0%;--hi:100%;--at:50%;--mid:50%' },
    track,
    h('div', { class: 'band-scale', 'aria-hidden': 'true' }, loLabel, hiLabel),
    legend);

  const update = (measured: number | null, lo: number, hi: number): void => {
    const haveBand = Number.isFinite(lo) && Number.isFinite(hi) && hi > lo;
    const value = measured !== null && Number.isFinite(measured) ? measured : null;

    if (!haveBand) {
      el.className = 'band is-unlit';
      el.setAttribute('style', '--lo:0%;--hi:100%;--at:50%;--mid:50%');
      loLabel.textContent = '';
      hiLabel.textContent = '';
      legend.textContent = `${unlitNote}.`;
      return;
    }

    const width = hi - lo;
    const pad = width * 0.45 || 1;
    let min = opts.domain?.min ?? lo - pad;
    let max = opts.domain?.max ?? hi + pad;
    if (value !== null) {
      if (value < min) min = value - pad * 0.3;
      if (value > max) max = value + pad * 0.3;
    }
    const span = max - min || 1;
    const pct = (x: number): string =>
      `${Math.min(100, Math.max(0, ((x - min) / span) * 100)).toFixed(2)}%`;
    const mid = (lo + hi) / 2;

    el.setAttribute('style',
      `--lo:${pct(lo)};--hi:${pct(hi)};--at:${pct(value ?? mid)};--mid:${pct(mid)}`);
    loLabel.textContent = fmt(min, opts.precision);
    hiLabel.textContent = fmt(max, opts.precision);

    const range = `${noun} ${fmt(lo, opts.precision)}–${fmt(hi, opts.precision)}${unit}`;
    if (value === null) {
      el.className = 'band is-unlit';
      legend.textContent = `${unlitNote} — ${range}.`;
      return;
    }
    const outside = value < lo || value > hi;
    const far = value < lo - width || value > hi + width;
    el.className = `band ${far ? 'is-alert' : outside ? 'is-caution' : 'is-lit'}`;
    const base = `Measured ${fmt(value, opts.precision)} · ${range}.`;
    legend.textContent = outside && opts.outsideNote ? `${base} ${opts.outsideNote}` : base;
  };

  return { el, update };
}

interface GaugeHandle {
  el: HTMLElement;
  /** `null` leaves the dial dark — "not yet measured", never a fake zero. */
  update(value: number | null): void;
}

/**
 * One dial from the six-pack. Unlit until a value exists (product rule #1);
 * the needle settle plays once, when the face first lights.
 */
function gaugeInstrument(opts: {
  placard: string;
  unit: string;
  min: number;
  max: number;
  precision: number;
  /** Let the needle settle when this dial lights. Off for recalled values. */
  settle?: boolean;
}): GaugeHandle {
  const valueEl = h('b', { class: 'gauge-value' }, '—');
  const status = h('span', { class: 'sr-only' }, `${opts.placard}: not measured yet.`);
  const base = `gauge gauge-sm${opts.settle ? '' : ' no-settle'}`;

  const el = h('div', { class: `${base} is-unlit`, style: '--angle:-135deg' },
    h('div', { class: 'gauge-face' },
      h('span', { class: 'gauge-ticks', 'aria-hidden': 'true' }),
      h('span', { class: 'gauge-needle', 'aria-hidden': 'true' }),
      h('span', { class: 'gauge-hub', 'aria-hidden': 'true' }),
      h('span', { class: 'gauge-readout', 'aria-hidden': 'true' },
        valueEl, h('i', { class: 'gauge-unit' }, opts.unit))),
    h('span', { class: 'gauge-placard' }, opts.placard),
    status);

  const update = (value: number | null): void => {
    if (value === null || !Number.isFinite(value)) {
      el.className = `${base} is-unlit`;
      el.setAttribute('style', '--angle:-135deg');
      valueEl.textContent = '—';
      status.textContent = `${opts.placard}: not measured yet.`;
      return;
    }
    const p = Math.min(1, Math.max(0, (value - opts.min) / ((opts.max - opts.min) || 1)));
    el.className = `${base} is-lit`;
    el.setAttribute('style', `--angle:${(-135 + p * 270).toFixed(2)}deg`);
    valueEl.textContent = fmt(value, opts.precision);
    status.textContent = `${opts.placard}: ${fmt(value, opts.precision)} ${opts.unit}.`;
  };

  return { el, update };
}

// ---------------------------------------------------------------------------
// Material-conditioned coaching
//
// Pure functions: they take the project's material, printer and nozzle and
// return text. Nothing here is read by collect() or compute(), nothing here
// becomes a value, and nothing here is written to a slicer — these exist so
// the wizard can say something true about THIS filament on THIS machine
// instead of a generic sentence that is right for ABS and harmful for PLA.
//
// Every number traces to src/data/calibrations.ts (which names the Bambu
// Studio file it was read from), to src/data/slicers.ts, or to a preset value
// quoted in the comment above it. Where nothing answers, the text says so
// rather than guessing.
// ---------------------------------------------------------------------------

export interface CoachCallout {
  id: string;
  /** 'warn' paints amber — reserved for a real caution, per the panel rules. */
  tone: 'info' | 'warn';
  title: string;
  body: string[];
}

function calloutEl(c: CoachCallout): HTMLElement {
  return h('div', { class: c.tone === 'warn' ? 'callout callout-warn' : 'callout' },
    h('p', { class: 'co-title' }, c.title),
    c.body.map(p => h('p', {}, p)));
}

/**
 * What a wet or degraded spool looks like, and how to dry this one.
 *
 * Offered at the START of a session, because the whole point is that nothing
 * calibrated on a wet spool survives drying it — a session run on a wet spool
 * is not partially useful, it is entirely wasted.
 *
 * Silent for materials with no drying story, so the warning keeps its force.
 */
export function spoolConditionCallout(material: MaterialPreset): CoachCallout | null {
  const schedule = DRYING_SCHEDULES[material.id];
  if (!schedule && !material.hygroscopic) return null;

  const body = [
    'Extrude about 100 mm at printing temperature into open air and listen. Popping, crackling or sizzling means absorbed water is flashing to steam inside the melt — stop and dry the spool.',
    'Then look at the strand. Bubbles, foam, or a matte rough surface where it should be glossy is the same verdict, and so is a strand that curls violently or spits sideways.',
    'Now watch what happens when you stop commanding extrusion. If plastic keeps coming out by itself for several seconds after the command stops, that is the signature of steam pressure inside the melt specifically — not of a badly tuned retraction. It is generated downstream of the extruder, so no retraction value can retract it.'
  ];

  if (schedule) {
    const alt = schedule.altTemperatureC !== undefined && schedule.altHours !== undefined
      ? `, or ${schedule.altTemperatureC} °C for ${schedule.altHours} h if your dryer reaches it`
      : '';
    body.push(
      `Drying ${material.label}: ${schedule.temperatureC} °C for ${schedule.hours} h${alt} — the schedule the filament vendor publishes for this material. Do not go above ${schedule.softeningC} °C: ${material.label} softens at ${schedule.softeningC} °C and heat-distorts at ${schedule.heatDistortionC} °C, so a hotter dryer welds the spool to itself.`
    );
  } else {
    body.push(
      `Trim has no vendor drying schedule to quote for ${material.label}. Its own material notes carry one, and a schedule printed on the spool beats both.`
    );
  }

  body.push(
    'Finally, flex a length of the filament sharply. If it snaps rather than bends, the spool is UV- or heat-aged in a way no dryer reverses — calibrating it measures the damage, not the material.',
    'Ten minutes here is the cheapest insurance in the wizard: nothing calibrated on a wet spool transfers to the same spool once it is dry.'
  );

  return {
    id: 'spool-condition',
    tone: 'info',
    title: 'Old or unknown spool? Ten minutes here can save the session',
    body
  };
}

// "Can this machine heat its chamber?" is answered in one place only —
// printerCanHeatChamber in ../logic/ranges, imported above. A local copy used
// to live here and disagreed with it: a profile saying heatedChamber:false but
// carrying a stale non-zero maxChamberTemp read true here and false there. The
// canonical one is stricter and correct — an explicit "no heated chamber", or
// an explicit ceiling of 0, is final.

/**
 * Chamber guidance, per material, plus the interaction that catches people out:
 * a hot chamber cures warping and makes drool worse.
 *
 * "Set the chamber to max" is right for ABS and ASA and actively harmful for
 * PLA and PETG — a warm chamber softens low-temperature filament above the
 * melt zone, which is heat creep. So the advice is never global.
 *
 * The ADVICE comes from `MaterialPreset.chamber` and the NUMBER comes from
 * `suggestChamberTemp`, which owns the machine clamp. Nothing here computes or
 * caps a chamber temperature of its own: a chamber setpoint is a temperature a
 * printer executes, and this project has already shipped the same class of
 * defect three times by letting two code paths hold the same fact. This
 * function contributes only the ooze trade-off, which is its own domain.
 */
export function chamberOozeCallout(
  material: MaterialPreset, printer?: PrinterProfile
): CoachCallout | null {
  const advice = material.chamber.advice;
  const suggestion = suggestChamberTemp(material.id, printer);

  if (advice === 'unknown') {
    return {
      id: 'chamber-unknown', tone: 'info',
      title: `Chamber: no chamber guidance for ${material.label}`,
      body: [suggestion.headline, ...suggestion.warnings]
    };
  }

  if (advice === 'ambient') {
    if (!printerCanHeatChamber(printer)) return null;
    return {
      id: 'chamber-ambient', tone: 'warn',
      title: `Chamber: leave it off for ${material.label}`,
      body: [
        'This printer has a heated chamber, and that is exactly why this needs saying: a warm chamber heat-soaks the whole filament path, so the filament softens ABOVE the melt zone instead of in it. That is heat creep — grinding, under-extrusion and jams — and it happens with the chamber working perfectly.',
        suggestion.headline,
        ...suggestion.warnings,
        'Chamber heat is not a general-purpose quality setting. It buys warp resistance on high-temperature materials and costs reliability on everything else.'
      ]
    };
  }

  // advice === 'hot'
  if (!printerCanHeatChamber(printer)) {
    // Careful with the claim here. An absent chamber field means the PROFILE
    // does not record one — it is not evidence the machine has none, and saying
    // otherwise tells X2D owners (whose machine holds 60–65 °C, field-verified)
    // a falsehood about their own hardware. Two states, worded apart.
    const statesNone = printer?.heatedChamber === false || printer?.maxChamberTemp === 0;
    return {
      id: 'chamber-absent', tone: 'info',
      title: statesNone
        ? `Chamber: ${material.label} wants one, and this printer has none`
        : `Chamber: ${material.label} wants one, and this profile does not record one`,
      body: [
        suggestion.headline,
        ...(statesNone ? [] : ['If your printer does heat its chamber, fill in “Max chamber temp” and “Heated chamber” on its printer profile (Printers → edit → Advanced machine specs) and this step will name a number. Until then Trim says nothing about a chamber it has no evidence exists.']),
        `Printing without a heated chamber leaves you less room to drop the nozzle temperature than someone printing the same spool inside one. The normal cost of a cooler ${material.label} nozzle is weaker layer bonds, and a warm chamber is what pays that back — it keeps the layer below near its bonding window while the next one lands.`,
        'So with no chamber recorded, treat the cool end of the tower with more suspicion, and snap-test before you commit to it.'
      ]
    };
  }

  const body: string[] = [suggestion.headline, ...suggestion.warnings];
  body.push(
    `For ${material.label} that is the whole of it — the chamber is guidance, not a calibration step. There is no meaningful search space between "off" and the machine's limit, so no tower is worth burning on it.`,
    `That chamber is why ${material.label} is not warping on this printer — it cuts the thermal gradient that drives shrinkage stress. It is also why the ooze you do get ends up ON the part: in a warm chamber strings and blobs stay soft far longer, and tacky surfaces catch what would otherwise flick off cold.`,
    'The lever that buys it back is nozzle temperature. Because the chamber keeps the previous layer near its bonding window, you have MORE room to run the nozzle cooler than someone printing the same spool in open air — and nozzle temperature is the dominant ooze lever there is.',
    'Be clear about what that last point is: it follows from two documented facts (a heated chamber improves interlayer adhesion; nozzle temperature dominates ooze), but no vendor states it as advice. So pair it with the check.',
    'The check: after lowering the nozzle, confirm layer adhesion on the final verification print. Weak layers do not show on a temperature tower — they show when a part snaps in service.'
  );

  return {
    id: 'chamber-hot', tone: 'info',
    // Same rule as the headline: only claim "as hot as this machine allows"
    // when the machine's ceiling is what decided the number.
    title: suggestion.clamped
      ? `Chamber: run it warm — up to ${suggestion.suggestedC} °C, this material's ceiling — and expect more drool`
      : 'Chamber: run it as hot as this machine allows — and expect more drool',
    body
  };
}

/**
 * The vendor's own temperature window versus the temperature its preset runs.
 *
 * Two facts have to coexist: the preset default sits at the TOP of the
 * documented window (so it is the first ooze suspect on a generic spool), and
 * the bottom of the tower sits BELOW that window (where layer bonds fail
 * invisibly). Saying only the first would trade visible ooze for invisible
 * delamination, which is the worse failure.
 *
 * Null for materials Trim has no vendor window for.
 */
export function temperatureOozeCallout(
  material: MaterialPreset, rungs: number[]
): CoachCallout | null {
  const w = vendorNozzleWindowFor(material.id);
  if (!w) return null;

  const body = [
    `The filament vendor's own ${material.label} preset runs ${w.bambuDefault} °C, and its documented window for ${material.label} is ${w.low}–${w.high} °C. The default therefore sits at the top of the vendor's own range, not in the middle of it.`,
    `Generic unbranded spools are commonly specified a good deal cooler than a vendor's own modified formulation. If your spool has a printed temperature range, trust the spool over the preset.`,
    `That makes ${w.bambuDefault} °C the prime suspect when this filament oozes — a suspicion for this tower to settle, not a verdict. Opinion genuinely splits: plenty of generic spools run clean at ${w.bambuDefault} °C, and others look scorched there.`
  ];

  const under = rungs.filter(r => Number.isFinite(r) && r < w.low).sort((a, b) => b - a);
  if (under.length) {
    const list = under.length === 1
      ? `${under[0]} °C`
      : `${under.slice(0, -1).join(', ')} and ${under[under.length - 1]} °C`;
    body.push(
      `${list} ${under.length === 1 ? 'sits' : 'sit'} below Bambu's documented minimum of ${w.low} °C for ${material.label}. Bracketing below the floor is useful — you want to see where it breaks — but layer bonds can be weak down there even where the surface looks clean, so snap-test any block from that part of the tower before choosing it. Delamination is invisible on a temperature tower and only shows up when a part breaks in use.`
    );
  }

  return {
    id: 'temp-ooze-suspect', tone: 'info',
    title: `${w.bambuDefault} °C is the vendor default — and the first ooze suspect`,
    body
  };
}

/** Materials that ooze so little in good condition that visible drool is diagnostic. */
const LOW_OOZE_MATERIALS = new Set(['ABS', 'ASA']);

/**
 * The ordered ooze lever list, material- and feed-aware.
 *
 * Lives on the retraction step, which every project has — single-nozzle
 * included. The dual-nozzle ooze-control step covers the toolchange case only,
 * and this callout says so rather than duplicating it.
 */
export function oozeLeverCallout(args: {
  material: MaterialPreset;
  printer?: PrinterProfile;
  feed: ExtruderType;
}): CoachCallout {
  const { material, printer, feed } = args;
  const body: string[] = [
    'Ooze has an order of operations, and it is worth following downward rather than starting where the familiar setting is. Retraction is the third lever, not the first — reaching for it first is how people lose days.',
    'First, which ooze is it? Blobs and colour smears at TOOLCHANGES are a different problem with different fixes — prime tower, ramming, extruder-change retraction — and belong to the Dual-Nozzle Ooze Control step. Drool during ordinary travel within a single filament is what the list below addresses.'
  ];

  if (LOW_OOZE_MATERIALS.has(material.id)) {
    body.push(
      `${material.label} is intrinsically a low-ooze material — it strings noticeably less than PETG, and about as much as dry PLA. Conspicuous drool from ${material.label} is therefore an out-of-band signal, and the two things that put it out of band are moisture and a nozzle above the material's real window. Retraction geometry is a third-order explanation here.`
    );
  }

  body.push(...OOZE_LEVERS.map(l => `${l.rank}. ${l.name} — ${l.detail}`));

  // The X2D's bowden numbers are a SHORT-tube toolhead-bowden figure and are
  // not generic bowden advice: a long-PTFE machine (Ender-class) normally needs
  // 4–6 mm at 40–50 mm/s, so quoting 2 mm at it would start the tower far below
  // the useful band — and below what this same panel's own suggested range says.
  // So the machine-specific paragraph is gated on the machine.
  const isDualNozzleBowden = (printer?.nozzles?.length ?? 0) > 1 && feed === 'bowden';
  if (isDualNozzleBowden) {
    // Bambu Lab X2D 0.4 nozzle.json, arrays indexed by extruder VARIANT:
    // retraction_length ["0.8","0.8","2","2"], retraction_speed and
    // deretraction_speed ["30","30","20","20"] — the first two entries are the
    // direct-drive variants, the last two the bowden ones.
    body.push(
      'On this machine\'s bowden feed path the numbers themselves are different: the X2D ships 2 mm at 20 mm/s retract and 20 mm/s deretract for its bowden variants, against 0.8 mm at 30 mm/s for the direct-drive ones. That is a SHORT tube from a toolhead-mounted remote stepper — start from the bowden figure, and change length before speed.'
    );
  } else if (feed === 'bowden') {
    body.push(
      'On a bowden feed path retraction has to pull back the filament compressed inside the tube as well as the melt, so the distance is larger and the useful band wider than on direct drive — the suggested range above is where to start. Change length before speed, and do not copy a number from a different machine: the right distance scales with tube length, so a short toolhead-mounted bowden runs a fraction of what a long frame-to-hotend tube needs.'
    );
  }

  if (printer?.nozzles?.some(n => n.feed === 'bowden')) {
    // Process 0.20mm Standard @BBL X2D: travel_speed ["1000", …].
    // Machine fdm_bbl_3dp_002_common: wipe_distance ["2", …], z_hop ["0.4", …].
    body.push(
      'On the X2D specifically, levers 4 to 6 are close to exhausted before you touch them: the stock process profile already travels at 1000 mm/s, the machine already wipes 2 mm, and z-hop already sits at 0.4 mm on "Auto Lift". Temperature and retraction carry nearly all the weight on this printer.'
    );
  }

  body.push(...OOZE_LEVER_EXCLUSIONS);

  return {
    id: 'ooze-levers', tone: 'info',
    title: 'Fighting ooze? Work the levers in this order',
    body
  };
}

/** Materials whose aux-hotend use Trim can positively source from the vendor. */
const AUX_VENDOR_RECOMMENDED = new Set(['ABS', 'ASA']);

/**
 * Methodology notes for the flow steps.
 *
 * The load-bearing one is the first: every flow method here is judged by eye,
 * which is precisely why shrinkage cannot bias the result. That is a property
 * worth stating out loud, because a measured single-wall method — the obvious
 * "improvement" — would silently import the material's shrinkage as a flow
 * error and bake permanent over-extrusion into the profile.
 */
export function flowMethodCallouts(ctx: TestCtx): CoachCallout[] {
  const out: CoachCallout[] = [];
  const sel = resolveNozzle(ctx.project, ctx.printer);

  out.push({
    id: 'flow-visual', tone: 'info',
    title: 'This test is judged by eye, not with calipers — and that is deliberate',
    body: [
      'Every flow method Trim offers is scored on top-surface quality: gaps between lines, ridges, and how a fingernail drags. Nothing is measured with calipers, and that is exactly what keeps shrinkage out of the answer — shrinkage scales a whole part uniformly and does not change the ratio of deposited volume to swept volume inside a layer.',
      'The alternative is a trap worth naming. Calibrate flow by measuring a single wall instead, and a cooled ABS wall reads roughly 0.3–0.7% thin from shrinkage alone. You would read that as under-extrusion, raise the flow ratio to correct it, and bake permanent over-extrusion into the profile — which then corrupts the shrinkage step downstream. If you ever use a measured method, divide the shrinkage back out first.'
    ]
  });

  const shrink = ctx.project.finals.shrinkagePercent;
  if (shrink !== undefined && Number.isFinite(shrink) && shrink !== 100) {
    out.push({
      id: 'flow-shrinkage-live', tone: 'warn',
      title: 'A shrinkage compensation is already switched on',
      body: [
        `This project has ${shrink}% saved, so the slicer scales the geometry under these blocks by 100/${shrink} before printing them.`,
        'Your surface judgement still stands — that is the whole benefit of judging by eye. But do not turn any caliper reading taken off these blocks into a flow correction without dividing the compensation back out, and leave the compensation alone between passes so the two are comparable.'
      ]
    });
  }

  if (ctx.material.chamber.advice === 'hot') {
    out.push({
      id: 'flow-enclosure-judging', tone: 'info',
      title: `Judging ${ctx.material.label} blocks that cooled slowly`,
      body: [
        'A block that cools slowly self-levels. Its top reads glossier and smoother across a wider band of flow modifiers than the same block would in open air, which flattens the difference between neighbours and quietly biases a hurried judgement toward the high-flow end.',
        'So judge at a shallow raking angle in strong light and by fingernail, never from directly above. If two adjacent blocks genuinely tie, take the LOWER one — under-extrusion is the louder defect on these materials, so a real tie means the lower block is safe.'
      ]
    });
  }

  // Everything below states facts about an AUXILIARY hotend on a dual-nozzle
  // machine (the X2D's remote-fed right nozzle). A single-nozzle bowden printer
  // has no auxiliary and no vendor compatibility list, so a profile that merely
  // names one bowden nozzle must not be told any of it.
  if (sel.feed === 'bowden' && sel.nozzle && (ctx.printer?.nozzles?.length ?? 0) > 1) {
    if (ctx.material.flexible) {
      out.push({
        id: 'flow-aux-excluded', tone: 'warn',
        title: `${ctx.material.label} is not supported on the auxiliary hotend`,
        body: [
          `Flexible filament is the one hard exclusion on the X2D's auxiliary nozzle — the longer feed path's resistance is too high for it — so a flow ratio measured there has nowhere legitimate to go. Calibrate ${ctx.material.label} on the main (direct drive) nozzle instead.`
        ]
      });
    } else {
      const body = [
        `The flow ratio you are about to measure describes THIS feed path. A dual-nozzle filament preset stores it once per extruder variant, so the number belongs to the bowden variant this project targets — not to the machine as a whole, and never to the main nozzle.`,
        `Expect slightly softer detail here than the main nozzle gives. Bambu attributes that to the auxiliary's remote extrusion structure: a longer feed path means weaker extrusion response and less detail control. It is inherent to the bowden path, not a calibration failure — do not chase it with flow ratio, or you will trade a real dimensional error for a cosmetic one you cannot win.`
      ];
      if (AUX_VENDOR_RECOMMENDED.has(ctx.material.id)) {
        body.push(
          `${ctx.material.label} itself belongs here: Bambu's X2D filament-compatibility guide puts it on the Recommended list for the auxiliary hotend. Flexible filament is the one material it excludes outright.`
        );
      }
      out.push({
        id: 'flow-aux', tone: 'info',
        title: `This ratio belongs to ${sel.nozzle.label}`,
        body
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Temperature
// ---------------------------------------------------------------------------

/**
 * Entry-time limits for the three temperatures the temperature step collects.
 *
 * ALL THREE command the hotend — the first-layer and high-flow values are
 * carried into the profile and printed exactly like the normal one — so all
 * three are checked against the printer's rating, not just the normal
 * temperature. `null` means the (optional) field was left empty.
 */
export function temperatureEntryIssues(args: {
  normalTemp: number | null;
  firstLayerTemp: number | null;
  highFlowTemp: number | null;
  printer?: PrinterProfile;
}): ValidationIssue[] {
  const fields: { label: string; value: number | null }[] = [
    { label: 'Normal printing temp', value: args.normalTemp },
    { label: 'First-layer temp', value: args.firstLayerTemp },
    { label: 'High-flow temp', value: args.highFlowTemp }
  ];
  const issues: ValidationIssue[] = [];
  for (const { label, value } of fields) {
    if (value === null) continue;
    issues.push(...validateNumber(value, { label, min: 140, max: 500 }));
    // The printer check names the field: three temperatures on one form would
    // otherwise produce three indistinguishable "N °C exceeds…" messages.
    issues.push(...validateAgainstPrinter('nozzleTemp', value, args.printer)
      .map(i => ({ ...i, message: `${label}: ${i.message}` })));
  }
  return issues;
}

const temperatureController: TestController = {
  settingsForm(ctx, prior) {
    const sug = suggestTempRange(ctx.material.id, ctx.printer);
    const start = numberInput({ value: prior?.start ?? sug.start, step: 5 });
    const end = numberInput({ value: prior?.end ?? sug.end, step: 5 });
    const step = numberInput({ value: prior?.step ?? sug.step, step: 1, min: 1 });
    const preview = h('div', {});
    // The sub-floor caution names the actual rungs, so it is redrawn with the
    // plan rather than written once from the material default.
    const oozeHost = h('div', {});
    const refresh = () => {
      clear(preview);
      const r = generateRange(num(start.value), num(end.value), num(step.value), 0);
      if (r.values.length) {
        preview.append(
          h('p', { class: 'field-help' }, `${r.count} tower blocks: `,
            h('span', { class: 'value-chip' }, r.values.join(' · ') + ' °C')));
      }
      const warned = issueList(r.warnings.map(w => ({ level: 'warning' as const, message: w })));
      if (warned) preview.append(warned);
      clear(oozeHost);
      const ooze = temperatureOozeCallout(ctx.material, r.values);
      if (ooze) oozeHost.append(calloutEl(ooze));
    };
    [start, end, step].forEach(i => i.addEventListener('input', refresh));
    refresh();

    // Spool condition first: it is the only thing here that can invalidate the
    // whole session, and it is cheapest to act on before anything is printed.
    const spool = spoolConditionCallout(ctx.material);
    const chamber = chamberOozeCallout(ctx.material, ctx.printer);

    const el = h('div', {},
      spool ? calloutEl(spool) : null,
      sug.warnings.length ? issueList(sug.warnings.map(w => ({ level: 'warning' as const, message: w }))) : null,
      h('div', { class: 'field-row' },
        field('Start temperature (°C)', start, 'The HOTTER end — Orca towers print hottest block first (bottom).'),
        field('End temperature (°C)', end, 'The cooler end.'),
        field('Step (°C)', step, 'Orca uses 5 °C per block.')
      ),
      previewPanel('Tower plan', preview),
      oozeHost,
      chamber ? calloutEl(chamber) : null
    );
    return {
      el,
      collect() {
        const issues = [
          ...validateNumber(start.value, { label: 'Start temperature', min: 140, max: 500 }),
          ...validateNumber(end.value, { label: 'End temperature', min: 140, max: 500 }),
          ...validateTestRange(num(start.value), num(end.value), num(step.value), { label: 'Temperature range', maxSamples: 15 }),
          ...validateAgainstPrinter('nozzleTemp', Math.max(num(start.value), num(end.value)), ctx.printer)
        ];
        return { data: { start: num(start.value), end: num(end.value), step: num(step.value) }, issues };
      }
    };
  },

  resultForm(ctx, settings, prior) {
    const r = generateRange(num(settings.start), num(settings.end), num(settings.step), 0);
    const acceptable = new Set<number>((prior?.acceptableTemps as number[]) ?? []);
    const chipHost = h('div', { class: 'sample-grid', role: 'group', 'aria-label': 'Acceptable temperatures' });
    const normalSel = h('select', {}, h('option', { value: '' }, '— pick —'));

    const refreshNormalOptions = () => {
      const cur = normalSel.value;
      clear(normalSel);
      normalSel.append(h('option', { value: '' }, '— pick —'));
      const source = acceptable.size ? [...acceptable].sort((a, b) => a - b) : r.values;
      source.forEach(t => normalSel.append(h('option', { value: String(t), selected: String(t) === cur }, `${t} °C`)));
    };

    // Deviation readout: where the chosen temperature sits inside the window
    // the user actually marked acceptable (rule #3 — drift before alarm).
    const band = bandReadout({
      precision: 0, unit: '°C', bandNoun: 'acceptable',
      domain: r.values.length
        ? { min: Math.min(...r.values) - 5, max: Math.max(...r.values) + 5 }
        : undefined,
      unlitNote: 'Mark the acceptable blocks and pick a normal temperature',
      outsideNote: 'That is outside the blocks you marked acceptable.'
    });
    const refreshBand = () => {
      const acc = [...acceptable].sort((a, b) => a - b);
      const chosen = normalSel.value ? num(normalSel.value) : null;
      if (acc.length >= 2) band.update(chosen, acc[0], acc[acc.length - 1]);
      else if (acc.length === 1) band.update(chosen, acc[0] - 2.5, acc[0] + 2.5);
      else band.update(chosen, NaN, NaN);
    };

    r.values.forEach(t => {
      const chip = h('button', {
        type: 'button', class: 'sample-chip', 'aria-pressed': String(acceptable.has(t)),
        onClick: () => {
          if (acceptable.has(t)) acceptable.delete(t); else acceptable.add(t);
          chip.setAttribute('aria-pressed', String(acceptable.has(t)));
          refreshNormalOptions();
          refreshBand();
        }
      }, `${t} °C`);
      chipHost.append(chip);
    });
    refreshNormalOptions();
    if (prior?.normalTemp) normalSel.value = String(prior.normalTemp);
    normalSel.addEventListener('change', refreshBand);
    refreshBand();

    const adhesionChecked = h('input', { type: 'checkbox', checked: prior?.adhesionChecked ?? false });
    const firstLayer = numberInput({ value: prior?.firstLayerTemp ?? '', placeholder: 'optional', step: 5 });
    const highFlow = numberInput({ value: prior?.highFlowTemp ?? '', placeholder: 'optional', step: 5 });

    const unsure = ctx.coach ? h('details', { class: 'why' },
      h('summary', {}, 'I\'m not sure which blocks are best'),
      h('div', { class: 'why-body' },
        h('p', {}, h('strong', {}, 'Q1 — Strength first: '), 'flex each block with pliers. Cross out every block that cracks along a layer line with little force — those are too cold, no matter how clean they look.'),
        h('p', {}, h('strong', {}, 'Q2 — Of the survivors, look between the towers: '), 'heavy hairs/strings? Cross out the worst stringers (usually the hottest blocks).'),
        h('p', {}, h('strong', {}, 'Q3 — Check the overhang/bridge on what\'s left: '), 'droopy, saggy undersides = too hot. Mark everything still standing as acceptable.'),
        h('p', {}, h('strong', {}, 'Still several candidates? '), 'That\'s normal and good — mark them ALL acceptable and pick the middle one as your normal temperature (or the hottest acceptable one if you\'ll print fast).'),
        h('p', {}, h('strong', {}, 'Everything looks equally bad? '), 'Dry the filament and re-check the nozzle for partial clogs — a tower that\'s uniformly ugly usually isn\'t a temperature problem.')
      )) : null;

    const el = h('div', {},
      h('p', {}, 'Mark every temperature that produced an acceptable block (strength included), then choose your normal printing temperature.'),
      h('span', { class: 'placard' }, 'Printed blocks'),
      chipHost,
      band.el,
      unsure,
      h('div', { class: 'check-item' }, adhesionChecked,
        h('div', {}, h('strong', {}, 'I checked layer adhesion, not just looks'),
          h('p', { class: 'coach-note' }, 'The wizard will not auto-pick the prettiest block — strength decides first, looks second.'))),
      h('div', { class: 'field-row' },
        field('Normal printing temperature (°C)', normalSel, 'Middle of your acceptable range is a safe default; the hotter end if you\'ll print fast.'),
        field('First-layer temperature (°C)', firstLayer, 'Optional: many profiles run the first layer 5–10 °C hotter for adhesion.'),
        field('High-flow temperature (°C)', highFlow, 'Optional: a hotter setting you\'d use for fast printing; useful in the max-flow test later.')
      )
    );
    return {
      el,
      collect() {
        const issues: ValidationIssue[] = [];
        if (!normalSel.value) issues.push({ level: 'error', message: 'Pick a normal printing temperature.' });
        if (!acceptable.size) issues.push({ level: 'warning', message: 'No blocks marked acceptable — marking at least the chosen one helps future comparisons.' });
        if (!adhesionChecked.checked) issues.push({ level: 'warning', message: 'You haven\'t confirmed a strength/adhesion check. Looks alone can be misleading.' });
        issues.push(...temperatureEntryIssues({
          normalTemp: normalSel.value ? num(normalSel.value) : null,
          firstLayerTemp: firstLayer.value === '' ? null : num(firstLayer.value),
          highFlowTemp: highFlow.value === '' ? null : num(highFlow.value),
          printer: ctx.printer
        }));
        return {
          data: {
            acceptableTemps: [...acceptable].sort((a, b) => a - b),
            normalTemp: normalSel.value ? num(normalSel.value) : '',
            firstLayerTemp: firstLayer.value === '' ? '' : num(firstLayer.value),
            highFlowTemp: highFlow.value === '' ? '' : num(highFlow.value),
            adhesionChecked: adhesionChecked.checked
          }, issues
        };
      }
    };
  },

  compute(ctx, settings, result) {
    const normal = num(result.normalTemp);
    const computed: Record<string, number | string> = { normalTemp: normal };
    // Listed first-layer-first to match both slicers' Filament tab, which puts
    // "First layer" above "Other layers" in the Nozzle line — entering them in
    // screen order avoids mis-typing one into the other's box.
    const enterInSlicer: { label: string; value: string }[] = [];
    const finalsPatch: ComputeOutput['finalsPatch'] = { nozzleTemp: normal };
    if (result.firstLayerTemp !== '' && result.firstLayerTemp !== undefined) {
      computed.firstLayerTemp = num(result.firstLayerTemp);
      finalsPatch.firstLayerTemp = num(result.firstLayerTemp);
      enterInSlicer.push({ label: 'Nozzle temperature (first layer)', value: `${result.firstLayerTemp} °C` });
    }
    enterInSlicer.push({ label: 'Nozzle temperature (other layers)', value: `${normal} °C` });
    if (result.highFlowTemp !== '' && result.highFlowTemp !== undefined) {
      computed.highFlowTemp = num(result.highFlowTemp);
      finalsPatch.highFlowTemp = num(result.highFlowTemp);
    }
    const warnings: string[] = [];
    const acc = (result.acceptableTemps as number[]) ?? [];
    if (acc.length && (normal === Math.max(...acc) || normal === Math.min(...acc)) && acc.length > 2) {
      warnings.push('You chose an edge of your acceptable range — the middle is usually the safer default.');
    }
    // Choosing below the vendor's documented floor is a legitimate answer for a
    // generic spool and a real strength risk at the same time. The tower cannot
    // show delamination, so the caution travels with the value instead.
    const window = vendorNozzleWindowFor(ctx.material.id);
    if (window && Number.isFinite(normal) && normal < window.low) {
      warnings.push(
        `${normal} °C sits below the ${window.low} °C minimum the filament vendor documents for ${ctx.material.label}. ` +
        'That can genuinely be right for a generic spool — but weak layer bonds are invisible on a temperature tower, ' +
        'so snap-test a block from that part of the tower, and re-confirm layer adhesion on the final verification print before trusting this profile.'
      );
    }
    return { calcs: [], computed, finalsPatch, enterInSlicer, warnings };
  }
};

// ---------------------------------------------------------------------------
// Flow pass 1 & 2
// ---------------------------------------------------------------------------

function flowController(pass: 1 | 2 | 'verify'): TestController {
  return {
    settingsForm(ctx, prior) {
      const priorRatio = ctx.project.finals.flowRatio ?? ctx.material.startingFlowRatio;
      const oldRatio = numberInput({ value: prior?.oldRatio ?? priorRatio, step: 0.001 });
      const band = bandReadout({
        precision: 3, bandNoun: 'typical',
        domain: { min: 0.7, max: 1.3 },
        unlitNote: 'Enter the ratio saved in the profile',
        outsideNote: 'Outside the usual 0.90–1.10 window — check you entered a decimal, not a percentage.'
      });
      const refreshBand = () =>
        band.update(oldRatio.value === '' ? null : num(oldRatio.value), 0.9, 1.1);
      oldRatio.addEventListener('input', refreshBand);
      refreshBand();

      const el = h('div', {},
        field(`Current flow ratio in the slicer profile ${pass === 2 ? '(after Pass 1 was saved)' : pass === 'verify' ? '(your calibrated value)' : ''} *`, oldRatio,
          'Find it under Filament settings → Filament → Flow ratio. A decimal like 0.98 — if the field shows something like 98, that\'s a percentage from another slicer; enter 0.98.'),
        band.el,
        h('p', { class: 'field-help' },
          pass === 1
            ? 'The printed blocks carry their modifiers; you\'ll pick one after printing.'
            : pass === 'verify'
              ? 'The re-check prints the same fine blocks (−9% to 0%, 1% steps) relative to your SAVED value — with Pressure Advance now active. If the 0% block wins, your flow ratio is confirmed.'
              : 'Pass 2 blocks run −9% to 0% in 1% steps, relative to the SAVED Pass 1 value.'),
        // Methodology, the live shrinkage compensation, how to judge a slowly
        // cooled block, and which feed path this number belongs to.
        flowMethodCallouts(ctx).map(calloutEl)
      );
      return {
        el,
        collect() {
          const issues = validateFlowRatio(num(oldRatio.value));
          return { data: { oldRatio: num(oldRatio.value), typicalMvs: ctx.material.typicalMvs }, issues };
        }
      };
    },

    resultForm(ctx, settings, prior) {
      const mods = suggestFlowMethodDefaults(pass === 1 ? ctx.method : 'pass2').modifiers;
      let selected: number | null = (prior?.modifier as number) ?? null;
      const isYolo = pass === 1 && ctx.method.startsWith('yolo');
      const chips = h('div', { class: 'sample-grid', role: 'group', 'aria-label': 'Printed block modifiers' });
      mods.forEach(m => {
        const label = isYolo ? (m > 0 ? `+${m}` : `${m}`) : (m > 0 ? `+${m}%` : `${m}%`);
        const chip = h('button', {
          type: 'button', class: 'sample-chip', 'aria-pressed': String(selected === m),
          onClick: () => {
            selected = m;
            chips.querySelectorAll('.sample-chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
            chip.setAttribute('aria-pressed', 'true');
          }
        }, label);
        chips.append(chip);
      });

      const unsure = ctx.coach ? h('details', { class: 'why' },
        h('summary', {}, 'I\'m not sure which block is best'),
        h('div', { class: 'why-body' },
          h('p', {}, h('strong', {}, 'Q1: '), 'Tilt each block against the light. Do you see parallel grooves/gaps between lines? Those blocks are UNDER-extruded — eliminate them.'),
          h('p', {}, h('strong', {}, 'Q2: '), 'Run a fingernail across the tops. Ridgy, bumpy, "corduroy" texture that catches the nail = OVER-extruded — eliminate those too.'),
          h('p', {}, h('strong', {}, 'Q3: '), 'Usually 2–3 blocks remain. Pick the one closest to the middle of the survivors; when torn between two neighbors, pick the LOWER-flow one (slight under beats slight over for dimensional accuracy).'),
          h('p', {}, h('strong', {}, 'All blocks look identical? '), 'Your lighting is probably too flat — use one strong lamp at a shallow angle, or take a photo with flash from a low angle.')
        )) : null;

      const el = h('div', {},
        h('p', {}, `Pick the block with the smoothest, gap-free, ridge-free top surface. Labels match what's printed on each block (${isYolo ? 'absolute modifiers' : 'percent modifiers'}).`),
        h('span', { class: 'placard' }, 'Printed blocks'),
        chips, unsure
      );
      return {
        el,
        collect() {
          const issues: ValidationIssue[] = [];
          if (selected === null) issues.push({ level: 'error', message: 'Select the block you judged best.' });
          return { data: { modifier: selected as number }, issues };
        }
      };
    },

    compute(ctx, settings, result) {
      const old = num(settings.oldRatio);
      const mod = num(result.modifier);
      const isYolo = pass === 1 && ctx.method.startsWith('yolo');
      const calc = isYolo ? flowYolo(old, mod) : flowPercent(old, mod);
      const finalsPatch = { flowRatio: calc.rounded };
      const warnings = [...calc.warnings];
      if (pass === 'verify' && mod === 0) {
        warnings.push('The 0% block won — your saved flow ratio is confirmed under the new Pressure Advance. Nothing to change in the slicer.');
      } else if (pass === 'verify' && mod <= -3) {
        warnings.push(`The re-check moved your flow by ${mod}% — more than PA normally accounts for. Check that temperature, plate, and cooling matched the original flow test.`);
      }
      return {
        calcs: [calc],
        computed: { newFlowRatio: calc.rounded },
        finalsPatch,
        enterInSlicer: [{ label: 'Flow ratio (decimal — not a percentage)', value: String(calc.rounded) }],
        warnings
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Pressure advance
// ---------------------------------------------------------------------------

const paController: TestController = {
  settingsForm(ctx, prior) {
    const sel = resolveNozzle(ctx.project, ctx.printer);
    const extruder = sel.feed;
    const sug = suggestPaRange(extruder, ctx.material, false, sel.nozzle);
    const start = numberInput({ value: prior?.start ?? sug.start, step: 0.001 });
    const end = numberInput({ value: prior?.end ?? sug.end, step: 0.001 });
    const step = numberInput({ value: prior?.step ?? sug.step, step: 0.001 });
    const preview = h('div', {});
    const refresh = () => {
      clear(preview);
      const r = generateRange(num(start.value), num(end.value), num(step.value), 4);
      if (r.count > 0 && r.values.length) preview.append(h('p', { class: 'field-help' }, `${r.count} samples from ${r.values[0]} to ${r.values[r.values.length - 1]}.`));
      const warned = issueList(r.warnings.map(w => ({ level: 'warning' as const, message: w })));
      if (warned) preview.append(warned);
    };
    [start, end, step].forEach(i => i.addEventListener('input', refresh));
    refresh();

    const el = h('div', {},
      h('p', { class: 'field-help' },
        `Suggested range for ${sel.nozzle ? `${sel.nozzle.label} — ` : ''}${extruder === 'direct' ? 'direct drive' : 'Bowden'}${ctx.material.flexible ? ' + flexible filament' : ''}: ` +
        `${sug.start}–${sug.end} step ${sug.step}. Editable — high-flow hotends often need less.`),
      sug.warnings.length ? issueList(sug.warnings.map(w => ({ level: 'warning' as const, message: w }))) : null,
      h('div', { class: 'field-row' },
        field('Start PA', start), field('End PA', end), field('Step', step)
      ),
      previewPanel('Sample plan', preview)
    );
    return {
      el,
      collect() {
        const issues = [
          ...validateNumber(start.value, { label: 'Start PA', min: 0, max: 5 }),
          ...validateNumber(end.value, { label: 'End PA', min: 0, max: 5 }),
          ...validateTestRange(num(start.value), num(end.value), num(step.value), { label: 'PA range', maxSamples: 120 })
        ];
        return { data: { start: num(start.value), end: num(end.value), step: num(step.value) }, issues };
      }
    };
  },

  resultForm(ctx, settings, prior) {
    const method = ctx.method; // tower | pattern | line
    const el = h('div', {});
    let mode: 'height' | 'direct' | 'sample' = method === 'tower' ? 'height' : 'direct';

    const height = numberInput({ value: prior?.measuredHeight ?? '', step: 0.5, placeholder: 'e.g. 8' });
    const direct = numberInput({ value: prior?.directValue ?? '', step: 0.001, placeholder: 'e.g. 0.016' });
    const sampleNo = numberInput({ value: prior?.sampleNumber ?? '', step: 1, placeholder: 'e.g. 9' });
    const zeroBased = h('select', {},
      h('option', { value: 'zero', selected: prior?.numbering !== 'one' }, 'Zero-based — the FIRST sample equals the start value'),
      h('option', { value: 'one', selected: prior?.numbering === 'one' }, 'One-based — I counted the first sample as #1'));

    // Where the value you just read lands inside the range you actually printed.
    const lo = Math.min(num(settings.start), num(settings.end));
    const hi = Math.max(num(settings.start), num(settings.end));
    const band = bandReadout({
      precision: 3, bandNoun: 'printed range',
      unlitNote: 'Nothing read from the print yet',
      outsideNote: 'This falls outside the range you printed — re-run the test centred on it.'
    });
    const refreshBand = () => {
      let v: number | null = null;
      if (method === 'tower') {
        const mm = height.value === '' ? NaN : num(height.value);
        if (Number.isFinite(mm)) v = paTower(num(settings.start), num(settings.step), mm).rounded;
      } else if (mode === 'direct') {
        v = direct.value === '' ? null : num(direct.value);
      }
      band.update(v, lo, hi);
    };
    height.addEventListener('input', refreshBand);
    direct.addEventListener('input', refreshBand);

    if (method === 'tower') {
      el.append(
        h('p', {}, 'Examine the tower\'s corners. Find the height where corners are sharpest — no bulge, no gap after the corner — and measure that height from the base in millimeters.'),
        field('Best height (mm)', height, 'Measure with calipers or a steel rule. The tower raises PA once per millimeter of height.')
      );
    } else {
      const modeSel = h('select', {},
        h('option', { value: 'direct', selected: true }, 'I can read the printed PA value next to the best line'),
        h('option', { value: 'sample' }, 'I counted samples instead (labels unreadable)'));
      const directWrap = h('div', {}, field('PA value read from the print', direct, 'Both the line and pattern tests print the values on the plate — reading them directly avoids counting mistakes.'));
      const sampleWrap = h('div', { style: 'display:none' },
        field('Sample number of the best line', sampleNo),
        field('How did you count?', zeroBased, 'This matters: off-by-one here shifts the result a whole step.'));
      modeSel.addEventListener('change', () => {
        mode = modeSel.value as 'direct' | 'sample';
        directWrap.style.display = mode === 'direct' ? '' : 'none';
        sampleWrap.style.display = mode === 'sample' ? '' : 'none';
        refreshBand();
      });
      el.append(
        h('p', {}, 'Find the line/corner with the most even width: no bulging at the corner, no thin gaps right after it.'),
        field('How will you report the result?', modeSel),
        directWrap, sampleWrap
      );
    }

    el.append(band.el);
    refreshBand();

    if (ctx.coach) {
      el.append(h('details', { class: 'why' },
        h('summary', {}, 'I\'m not sure which sample is best'),
        h('div', { class: 'why-body' },
          h('p', {}, h('strong', {}, 'Q1: '), 'Look at the corners. Swollen/bulging outward with rounded blobs? PA too low there — look HIGHER in the print/values.'),
          h('p', {}, h('strong', {}, 'Q2: '), 'Corners look hollow, chamfered, or the line thins/breaks right after the turn? PA too high there — look LOWER.'),
          h('p', {}, h('strong', {}, 'Q3: '), 'Roughly even? You\'re in the right zone. Between two even-looking candidates, prefer the LOWER value — slightly low PA fails more gracefully than slightly high.'),
          h('p', {}, h('strong', {}, 'The whole print looks identical top to bottom? '), 'Your firmware may be ignoring PA (Marlin without Linear Advance enabled). Check the prerequisites again.')
        )));
    }

    return {
      el,
      collect() {
        const issues: ValidationIssue[] = [];
        const data: Record<string, unknown> = { mode };
        if (method === 'tower') {
          issues.push(...validateNumber(height.value, { label: 'Best height', min: 0, max: 200 }));
          data.measuredHeight = num(height.value);
        } else if (mode === 'direct') {
          issues.push(...validateNumber(direct.value, { label: 'PA value', min: 0, max: 5 }));
          data.directValue = num(direct.value);
        } else {
          issues.push(...validateNumber(sampleNo.value, { label: 'Sample number', min: 0, max: 500, integer: true }));
          data.sampleNumber = num(sampleNo.value);
          data.numbering = zeroBased.value;
        }
        return { data, issues };
      }
    };
  },

  compute(ctx, settings, result) {
    const start = num(settings.start), step = num(settings.step);
    let calc: CalcResult;
    if (ctx.method === 'tower') {
      calc = paTower(start, step, num(result.measuredHeight));
    } else if (result.mode === 'direct') {
      const v = num(result.directValue);
      calc = {
        inputs: { value: v }, formulaText: 'PA read directly from the printed label',
        substituted: `${v}`, raw: v, rounded: roundTo(v, 3), precision: 3, unit: '', warnings: []
      };
    } else {
      calc = paFromSample(start, step, num(result.sampleNumber), result.numbering !== 'one');
    }
    return {
      calcs: [calc],
      computed: { pressureAdvance: calc.rounded },
      finalsPatch: { pressureAdvance: calc.rounded },
      enterInSlicer: [
        { label: 'Enable pressure advance', value: 'checked' },
        { label: ctx.project.slicer.slicer === 'bambu' ? 'K factor (Flow Dynamics)' : 'Pressure advance', value: String(calc.rounded) }
      ],
      warnings: calc.warnings
    };
  }
};

// ---------------------------------------------------------------------------
// Retraction
// ---------------------------------------------------------------------------

/**
 * Entry-time caution when a retraction tower is planned past the distance
 * Trim will install for a flexible filament.
 *
 * A warning, not an error: an expert may still deliberately explore past the
 * cap. But they are told the consequence BEFORE the print, instead of finding
 * out only when the write path refuses the finished result — and the browser
 * build has no write path at all.
 */
export function flexibleRetractionEntryIssues(
  material: MaterialPreset, endMm: number
): ValidationIssue[] {
  if (!material.flexible || !Number.isFinite(endMm) || endMm <= FLEXIBLE_RETRACTION_MAX_MM) return [];
  return [{
    level: 'warning',
    message: `Flexible filament: Trim will not install a retraction above ${FLEXIBLE_RETRACTION_MAX_MM} mm. Testing past it wastes a print — and grinding ${material.label} in the extruder is how jams start.`
  }];
}

const retractionController: TestController = {
  settingsForm(ctx, prior) {
    const sel = resolveNozzle(ctx.project, ctx.printer);
    const extruder = sel.feed;
    const sug = suggestRetractionRange(extruder, ctx.material, ctx.printer, sel.nozzle);
    const start = numberInput({ value: prior?.start ?? sug.start, step: 0.1 });
    const end = numberInput({ value: prior?.end ?? sug.end, step: 0.1 });
    const step = numberInput({ value: prior?.step ?? sug.step, step: 0.05 });
    const speed = numberInput({ value: prior?.speed ?? '', placeholder: 'leave empty to keep profile default', step: 5 });
    const preview = h('div', {});
    const refresh = () => {
      clear(preview);
      const r = generateRange(num(start.value), num(end.value), num(step.value), 2);
      if (r.values.length) preview.append(h('p', { class: 'field-help' }, `${r.count} sections, ${r.values[0]} → ${r.values[r.values.length - 1]} mm.`));
      const warned = issueList(r.warnings.map(w => ({ level: 'warning' as const, message: w })));
      if (warned) preview.append(warned);
    };
    [start, end, step].forEach(i => i.addEventListener('input', refresh));
    refresh();

    // The ordered lever list lives here because this is the ooze step EVERY
    // project has: the dual-nozzle ooze step is only ever added to bowden-aux
    // projects, so a single-nozzle user fighting drool would otherwise be
    // handed the third lever and none of the two above it.
    const levers = oozeLeverCallout({ material: ctx.material, printer: ctx.printer, feed: extruder });
    const spool = spoolConditionCallout(ctx.material);

    const el = h('div', {},
      h('p', { class: 'field-help' }, `Suggested for ${sel.nozzle ? `${sel.nozzle.label} — ` : ''}${extruder === 'direct' ? 'direct drive' : 'Bowden'}: ${sug.start}–${sug.end} mm, step ${sug.step}.`),
      sug.warnings.length ? issueList(sug.warnings.map(w => ({ level: 'warning' as const, message: w }))) : null,
      calloutEl(levers),
      spool ? calloutEl(spool) : null,
      h('div', { class: 'field-row' },
        field('Start length (mm)', start), field('End length (mm)', end), field('Step (mm)', step)
      ),
      previewPanel('Tower plan', preview),
      field('Retraction speed for this test (mm/s)', speed, 'Optional. Test ONE variable at a time: run the distance tower first at the profile\'s default speed; only test speed afterwards if problems remain.'),
      h('div', { class: 'callout callout-warn' },
        h('p', { class: 'co-title' }, 'More is not better'),
        h('p', {}, 'Long retractions drag soft plastic into the cold zone: clogs, heat creep, and filament grinding. You\'re looking for the SHORTEST distance that\'s acceptably clean.'))
    );
    return {
      el,
      collect() {
        const issues = [
          ...validateNumber(start.value, { label: 'Start length', min: 0, max: 10 }),
          ...validateNumber(end.value, { label: 'End length', min: 0, max: 15 }),
          ...validateTestRange(num(start.value), num(end.value), num(step.value), { label: 'Retraction range', maxSamples: 60 })
        ];
        if (speed.value !== '') issues.push(...validateNumber(speed.value, { label: 'Retraction speed', min: 5, max: 120 }));
        if (num(end.value) > 8) issues.push({ level: 'warning', message: 'Testing beyond 8 mm invites clogs — only Bowden setups with long tubes should go there.' });
        issues.push(...flexibleRetractionEntryIssues(ctx.material, num(end.value)));
        return { data: { start: num(start.value), end: num(end.value), step: num(step.value), speed: speed.value === '' ? '' : num(speed.value) }, issues };
      }
    };
  },

  resultForm(ctx, settings, prior) {
    const byHeight = h('select', {},
      h('option', { value: 'height', selected: prior?.entry !== 'gcode' }, 'I measured the height where the tower becomes clean'),
      h('option', { value: 'gcode', selected: prior?.entry === 'gcode' }, 'I read the exact length from the G-code preview (Calib_Retraction_tower)'));
    const height = numberInput({ value: prior?.bestHeight ?? '', step: 0.5, placeholder: 'mm from base' });
    const gcodeLen = numberInput({ value: prior?.gcodeLength ?? '', step: 0.05, placeholder: 'mm of retraction' });
    const stillStringy = h('input', { type: 'checkbox', checked: prior?.stillStringyAtMax ?? false });
    const grinding = h('input', { type: 'checkbox', checked: prior?.grindingHeard ?? false });

    const heightWrap = h('div', {}, field('Lowest clean height (mm)', height, 'The LOWEST height where stringing stops being objectionable — not the very top.'));
    const gcodeWrap = h('div', { style: prior?.entry === 'gcode' ? '' : 'display:none' },
      field('Retraction length read from G-code (mm)', gcodeLen, 'In the sliced preview, search the G-code for "Calib_Retraction_tower" at your chosen height.'));
    // Where the resulting distance lands inside the tower you printed.
    const lo = Math.min(num(settings.start), num(settings.end));
    const hi = Math.max(num(settings.start), num(settings.end));
    const band = bandReadout({
      precision: 2, unit: 'mm', bandNoun: 'printed range',
      unlitNote: 'Nothing measured from the tower yet',
      outsideNote: 'This sits outside the tower you printed — re-run over a range that covers it.'
    });
    const refreshBand = () => {
      let v: number | null = null;
      if (byHeight.value === 'gcode') {
        v = gcodeLen.value === '' ? null : num(gcodeLen.value);
      } else {
        const mm = height.value === '' ? NaN : num(height.value);
        if (Number.isFinite(mm)) v = retractionFromHeight(num(settings.start), num(settings.step), mm).rounded;
      }
      band.update(v, lo, hi);
    };
    [height, gcodeLen].forEach(i => i.addEventListener('input', refreshBand));

    byHeight.addEventListener('change', () => {
      heightWrap.style.display = byHeight.value === 'height' ? '' : 'none';
      gcodeWrap.style.display = byHeight.value === 'gcode' ? '' : 'none';
      refreshBand();
    });
    if (prior?.entry === 'gcode') heightWrap.style.display = 'none';
    refreshBand();

    const el = h('div', {},
      field('How are you reporting the result?', byHeight),
      heightWrap, gcodeWrap,
      band.el,
      h('div', { class: 'check-item' }, stillStringy,
        h('div', {}, h('strong', {}, 'Strings persisted even in the top (longest-retraction) sections'),
          h('p', { class: 'coach-note' }, 'If checked, the app will suggest drying the filament and revisiting temperature rather than chasing more retraction.'))),
      h('div', { class: 'check-item' }, grinding,
        h('div', {}, h('strong', {}, 'I heard clicking/grinding during the print'),
          h('p', { class: 'coach-note' }, 'A sign the tested range went too far for this extruder.'))),
      ctx.coach ? h('details', { class: 'why' },
        h('summary', {}, 'What am I looking at?'),
        h('div', { class: 'why-body' },
          h('p', {}, h('strong', {}, 'Fine hairs '), 'that brush away = borderline; acceptable for most people.'),
          h('p', {}, h('strong', {}, 'Thick strings/branches '), '= clearly under-retracted at that height.'),
          h('p', {}, h('strong', {}, 'Gaps right after travels '), '= OVER-retracted (higher sections may show this — prefer a lower height).'),
          h('p', {}, h('strong', {}, 'Clean from the very bottom? '), 'Enter a small height anyway — the official guidance is ~0.2–0.4 mm minimum for direct drive rather than 0.')
        )) : null
    );
    return {
      el,
      collect() {
        const issues: ValidationIssue[] = [];
        const entry = byHeight.value;
        const data: Record<string, unknown> = {
          entry,
          stillStringyAtMax: stillStringy.checked,
          grindingHeard: grinding.checked
        };
        if (entry === 'height') {
          issues.push(...validateNumber(height.value, { label: 'Clean height', min: 0, max: 200 }));
          data.bestHeight = num(height.value);
        } else {
          issues.push(...validateNumber(gcodeLen.value, { label: 'Retraction length', min: 0, max: 15 }));
          data.gcodeLength = num(gcodeLen.value);
        }
        return { data, issues };
      }
    };
  },

  compute(ctx, settings, result) {
    let calc: CalcResult;
    if (result.entry === 'gcode') {
      const v = num(result.gcodeLength);
      calc = {
        inputs: { value: v }, formulaText: 'Length read from Calib_Retraction_tower G-code comment',
        substituted: `${v} mm`, raw: v, rounded: roundTo(v, 2), precision: 2, unit: 'mm', warnings: []
      };
    } else {
      calc = retractionFromHeight(num(settings.start), num(settings.step), num(result.bestHeight));
    }
    const warnings = [...calc.warnings];
    // The only place that sees the final rounded number on BOTH entry paths,
    // and the one whose output feeds the calc screen, the "values to enter"
    // panel, the "values recorded" panel and the saved attempt record. The
    // value itself is NOT clamped — the user's measurement stays theirs, and
    // the write path errors rather than silently rewriting, so both layers
    // tell the same story.
    if (ctx.material.flexible && calc.rounded > FLEXIBLE_RETRACTION_MAX_MM) {
      warnings.push(`${calc.rounded} mm exceeds the ${FLEXIBLE_RETRACTION_MAX_MM} mm limit Trim applies to flexible filament (${ctx.material.label}). Long retractions pull soft filament into the cold zone and jam the extruder — Trim will refuse to install this value. Use the lowest acceptable distance at or under ${FLEXIBLE_RETRACTION_MAX_MM} mm.`);
    }
    if (result.stillStringyAtMax) {
      warnings.push('Stringing persisted at max retraction — dry the filament and consider a cooler temperature before trusting this value.');
    }
    if (result.grindingHeard) {
      warnings.push('You heard grinding: don\'t use values from the top of the tested range; prefer the lowest acceptable distance.');
    }
    const enterInSlicer = [{ label: 'Retraction length', value: `${calc.rounded} mm` }];
    const finalsPatch: ComputeOutput['finalsPatch'] = { retractionDistance: calc.rounded };
    if (settings.speed !== '' && settings.speed !== undefined) {
      finalsPatch.retractionSpeed = num(settings.speed);
      enterInSlicer.push({ label: 'Retraction speed', value: `${settings.speed} mm/s` });
    }
    return { calcs: [calc], computed: { retractionDistance: calc.rounded }, finalsPatch, enterInSlicer, warnings };
  }
};

// ---------------------------------------------------------------------------
// Max volumetric speed
// ---------------------------------------------------------------------------

const mvsController: TestController = {
  settingsForm(ctx, prior) {
    const sug = suggestMvsRange(ctx.material.id, ctx.printer);
    const settings = loadSettings();
    const start = numberInput({ value: prior?.start ?? sug.start, step: 0.5 });
    const end = numberInput({ value: prior?.end ?? sug.end, step: 0.5 });
    const step = numberInput({ value: prior?.step ?? sug.step, step: 0.1 });
    const temp = numberInput({ value: prior?.temp ?? ctx.project.finals.highFlowTemp ?? ctx.project.finals.nozzleTemp ?? '', step: 5, placeholder: '°C used for the test' });
    const margin = numberInput({ value: prior?.margin ?? Math.round((1 - settings.mvsSafetyMargin) * 100), step: 5, min: 0, max: 50 });

    // calculator
    const lh = numberInput({ value: prior?.layerHeight ?? 0.2, step: 0.04 });
    const lw = numberInput({ value: prior?.lineWidth ?? (ctx.printer ? roundTo(ctx.printer.nozzleDiameter * 1.05, 2) : 0.42), step: 0.02 });
    const spd = numberInput({ value: 150, step: 10 });
    const calcOut = h('p', { class: 'field-help' });
    const demandValue = h('b', { class: 'readout-value' }, '—');
    const demandReadout = h('span', { class: 'readout is-unlit' },
      demandValue, h('i', { class: 'readout-unit' }, 'mm³/s'));
    const refreshCalc = () => {
      const r = volumetricFlow(num(lh.value), num(lw.value), num(spd.value));
      const ok = !r.warnings.length;
      demandReadout.className = ok ? 'readout' : 'readout is-unlit';
      demandValue.textContent = ok ? fmt(r.rounded, r.precision) : '—';
      calcOut.textContent = ok
        ? `${r.substituted} mm³/s — that's what printing at ${spd.value} mm/s actually demands.`
        : r.warnings[0];
    };
    [lh, lw, spd].forEach(i => i.addEventListener('input', refreshCalc));
    refreshCalc();

    const preview = h('div', {});
    const refresh = () => {
      clear(preview);
      const heightNeeded = (num(end.value) - num(start.value)) / num(step.value);
      if (Number.isFinite(heightNeeded) && heightNeeded > 0) {
        preview.append(h('p', { class: 'field-help' }, `Flow ramps ${start.value} → ${end.value} mm³/s over ${heightNeeded.toFixed(0)} mm of tower height (${step.value} mm³/s per mm).`));
      }
      const issues = validateTestRange(num(start.value), num(end.value), num(step.value), { label: 'Flow range', maxSamples: 100 });
      const l = issueList(issues.filter(i => i.level === 'warning')); if (l) preview.append(l);
    };
    [start, end, step].forEach(i => i.addEventListener('input', refresh));
    refresh();

    const el = h('div', {},
      h('div', { class: 'panel' },
        h('h3', {}, 'Flow demand'),
        h('p', { class: 'field-help' }, 'Work out what your normal printing speed actually asks for, so you can tell whether the measured ceiling is generous or tight.'),
        h('div', { class: 'field-row' },
          field('Layer height (mm)', lh), field('Line width (mm)', lw), field('Print speed (mm/s)', spd)),
        demandReadout,
        calcOut),
      h('div', { class: 'field-row' },
        field('Start (mm³/s)', start), field('End (mm³/s)', end), field('Step (mm³/s per mm)', step)
      ),
      previewPanel('Tower plan', preview),
      h('div', { class: 'field-row' },
        field('Test temperature (°C)', temp, 'Use your calibrated temp — or your high-flow temp if you set one. Max flow rises with temperature.'),
        field('Safety margin (%)', margin, 'Headroom kept below the measured max. Default 15% — the official guidance is 10–20%, more for critical parts. This is deliberately conservative: the test is a best-case scenario.')
      ),
      ctx.printer?.maxVolumetricFlow
        ? h('p', { class: 'field-help' }, `Printer profile limit: ${ctx.printer.maxVolumetricFlow} mm³/s — recommendations will never exceed it.`)
        : h('p', { class: 'field-help' }, 'No max flow set in the printer profile — consider adding the manufacturer\'s rating so recommendations can be capped.'),
      sug.warnings.length ? issueList(sug.warnings.map(w => ({ level: 'warning' as const, message: w }))) : null
    );
    return {
      el,
      collect() {
        const issues = [
          ...validateNumber(start.value, { label: 'Start flow', min: 0.5, max: 100 }),
          ...validateNumber(end.value, { label: 'End flow', min: 1, max: 120 }),
          ...validateTestRange(num(start.value), num(end.value), num(step.value), { label: 'Flow range', maxSamples: 100 }),
          ...validateNumber(margin.value, { label: 'Safety margin', min: 0, max: 50 })
        ];
        if (temp.value !== '') issues.push(...validateAgainstPrinter('nozzleTemp', num(temp.value), ctx.printer));
        return {
          data: {
            start: num(start.value), end: num(end.value), step: num(step.value),
            temp: temp.value === '' ? '' : num(temp.value),
            marginPct: num(margin.value),
            layerHeight: num(lh.value), lineWidth: num(lw.value),
            typicalMvs: ctx.material.typicalMvs
          }, issues
        };
      }
    };
  },

  resultForm(ctx, settings, prior) {
    const modeSel = h('select', {},
      h('option', { value: 'lastGood', selected: (prior?.mode ?? 'lastGood') === 'lastGood' }, 'Height where quality was still GOOD (just below first defects)'),
      h('option', { value: 'firstFail', selected: prior?.mode === 'firstFail' }, 'Height where the FIRST failure appeared'),
      h('option', { value: 'manual', selected: prior?.mode === 'manual' }, 'I\'ll enter a safe limit manually (mm³/s)'));
    const height = numberInput({ value: prior?.height ?? '', step: 0.5, placeholder: 'mm' });
    const manual = numberInput({ value: prior?.manualValue ?? '', step: 0.5, placeholder: 'mm³/s' });
    const clicking = h('input', { type: 'checkbox', checked: prior?.clickingHeard ?? false });

    const heightWrap = h('div', {}, field('Measured height (mm)', height, 'Calipers from the base to the point you identified.'));
    const manualWrap = h('div', { style: 'display:none' }, field('Safe limit (mm³/s)', manual));

    // Where the measured ceiling lands inside the flow ramp you printed.
    const lo = Math.min(num(settings.start), num(settings.end));
    const hi = Math.max(num(settings.start), num(settings.end));
    const band = bandReadout({
      precision: 1, unit: 'mm³/s', bandNoun: 'printed ramp',
      unlitNote: 'Nothing measured from the tower yet',
      outsideNote: 'This is outside the ramp you printed — the tower never reached it.'
    });
    const refreshBand = () => {
      let v: number | null = null;
      if (modeSel.value === 'manual') {
        v = manual.value === '' ? null : num(manual.value);
      } else {
        const mm = height.value === '' ? NaN : num(height.value);
        if (Number.isFinite(mm)) v = mvsFromHeight(num(settings.start), num(settings.step), mm).rounded;
      }
      band.update(v, lo, hi);
    };
    [height, manual].forEach(i => i.addEventListener('input', refreshBand));

    const sync = () => {
      heightWrap.style.display = modeSel.value === 'manual' ? 'none' : '';
      manualWrap.style.display = modeSel.value === 'manual' ? '' : 'none';
      refreshBand();
    };
    modeSel.addEventListener('change', sync); sync();

    const el = h('div', {},
      h('p', {}, 'Inspect the tower bottom-up: sheen change → rough/gappy walls → weak layers → clicking → failure. Report the point you\'re most confident about.'),
      field('What are you reporting?', modeSel),
      heightWrap, manualWrap,
      band.el,
      h('div', { class: 'check-item' }, clicking,
        h('div', {}, h('strong', {}, 'I heard extruder clicking during the print'),
          h('p', { class: 'coach-note' }, 'Note roughly where — clicking is the extruder losing the fight, a hard limit.'))),
      ctx.coach ? h('details', { class: 'why' },
        h('summary', {}, 'I\'m not sure where it failed'),
        h('div', { class: 'why-body' },
          h('p', {}, h('strong', {}, 'Q1: '), 'Any point where the surface goes from shiny to matte (or the reverse)? That\'s often the earliest warning — note that height.'),
          h('p', {}, h('strong', {}, 'Q2: '), 'Slide a fingertip up the wall: where does it turn rough, thin, or see-through?'),
          h('p', {}, h('strong', {}, 'Q3: '), 'Flex the tower gently near the top — if it feels papery or crackles, weakness started below there.'),
          h('p', {}, h('strong', {}, 'Pick the LOWEST of those heights'), ' and report it as "still good just below". When in doubt, err low: the safety margin protects you, but only if the base measurement isn\'t optimistic.')
        )) : null
    );
    return {
      el,
      collect() {
        const issues: ValidationIssue[] = [];
        const data: Record<string, unknown> = { mode: modeSel.value, clickingHeard: clicking.checked };
        if (modeSel.value === 'manual') {
          issues.push(...validateNumber(manual.value, { label: 'Safe limit', min: 0.5, max: 120 }));
          data.manualValue = num(manual.value);
        } else {
          issues.push(...validateNumber(height.value, { label: 'Measured height', min: 0, max: 300 }));
          data.height = num(height.value);
        }
        return { data, issues };
      }
    };
  },

  compute(ctx, settings, result) {
    const calcs: CalcResult[] = [];
    let measured: number;
    if (result.mode === 'manual') {
      measured = num(result.manualValue);
      calcs.push({
        inputs: { value: measured }, formulaText: 'Manually entered safe limit',
        substituted: `${measured} mm³/s`, raw: measured, rounded: roundTo(measured, 1), precision: 1, unit: 'mm³/s', warnings: []
      });
    } else {
      let h1 = num(result.height);
      const mCalc = mvsFromHeight(num(settings.start), num(settings.step), h1);
      if (result.mode === 'firstFail') {
        mCalc.warnings.push('You reported the FIRST FAILED height — the calculation steps one increment below it to get the last good flow.');
        const adjusted = mvsFromHeight(num(settings.start), num(settings.step), Math.max(0, h1 - 1));
        calcs.push(mCalc);
        measured = adjusted.rounded;
        calcs.push(adjusted);
      } else {
        calcs.push(mCalc);
        measured = mCalc.rounded;
      }
    }
    const marginFactor = 1 - num(settings.marginPct) / 100;
    const prod = mvsProduction(measured, marginFactor, ctx.printer?.maxVolumetricFlow);
    calcs.push(prod);

    const speedExample = maxSpeedForFlow(prod.rounded, num(settings.layerHeight) || 0.2, num(settings.lineWidth) || 0.42);

    const warnings = [...prod.warnings];
    if (result.clickingHeard && result.mode === 'lastGood') {
      warnings.push('You heard clicking — double-check your "still good" height sits clearly below where clicking began.');
    }
    return {
      calcs,
      computed: { measuredMax: measured, productionMvs: prod.rounded, exampleMaxSpeed: speedExample.rounded },
      finalsPatch: { maxVolumetricSpeed: prod.rounded },
      enterInSlicer: [{ label: 'Max volumetric speed', value: `${prod.rounded} mm³/s` }],
      warnings: warnings.concat([`At ${settings.layerHeight || 0.2} mm layers × ${settings.lineWidth || 0.42} mm lines, this supports about ${speedExample.rounded} mm/s.`])
    };
  }
};

// ---------------------------------------------------------------------------
// Shrinkage / dimensional accuracy
// ---------------------------------------------------------------------------

const SHRINK_PLATE_URL = 'https://www.printables.com/model/480907-shrinkage-calculator-dimensional-calibration-tool';
const CALIFLOWER_URL = 'https://vector3d.shop/products/califlower-calibration-tool-mk2';

const shrinkageController: TestController = {
  settingsForm(ctx, prior) {
    const toolLink = (url: string, label: string) =>
      h('a', { href: url, target: '_blank', rel: 'noopener' }, label);

    if (ctx.method === 'vernier-tool') {
      const el = h('div', {},
        h('p', {},
          'Download the free calibration plate by ap.engineering: ',
          toolLink(SHRINK_PLATE_URL, 'Shrinkage Calculator / Dimensional Calibration Tool (Printables)'), '.'),
        h('p', {}, 'Print it at 100% scale with your calibrated filament profile, shrinkage compensation set to 100% (off) — the test measures what the compensation SHOULD be, so it must not already be applied.'),
        h('p', { class: 'field-help' },
          'After full cooldown, measure the plate\'s features with calipers (squares, diamonds — nominal sizes 150/140/90/80/35/25 mm). ' +
          'The author\'s companion Google Sheet averages the scale error of every feature and separates out horizontal-size (radial) error; in the result step you can enter either the sheet\'s scale-error result, or two caliper measurements directly and let this wizard do the math.')
      );
      return { el, collect: () => ({ data: { entry: 'plate' }, issues: [] }) };
    }
    if (ctx.method === 'calilantern') {
      const el = h('div', {},
        h('p', {},
          'The CaliFlower MK2 is a paid tool by Vector3D: ',
          toolLink(CALIFLOWER_URL, 'vector3d.shop — CaliFlower Calibration Tool MK2'), '.'),
        h('p', {}, 'Print it at 100% scale with your calibrated filament profile, shrinkage compensation set to 100% (off). Measure with calipers per its instructions and run Vector3D\'s calculator — you\'ll enter the resulting shrinkage percentage(s) in the result step.'),
        h('p', { class: 'field-help' }, 'Let the part cool fully before measuring. The calculator also flags printer skew — worth fixing mechanically before compensating in the filament profile.')
      );
      return { el, collect: () => ({ data: { entry: 'direct' }, issues: [] }) };
    }
    const nomX = numberInput({ value: prior?.nominalX ?? 100, step: 1 });
    const nomY = numberInput({ value: prior?.nominalY ?? 100, step: 1 });
    const el = h('div', {},
      h('p', {}, 'Print a large, simple object of known size with your calibrated profile — shrinkage compensation set to 100% (off) — and measure it after full cooldown.'),
      h('div', { class: 'field-row' },
        field('Nominal X size (mm)', nomX, 'The design dimension along X. Bigger is better: ≥100 mm makes 0.5% shrinkage clearly measurable.'),
        field('Nominal Y size (mm)', nomY, 'The design dimension along Y.')
      )
    );
    return {
      el,
      collect() {
        const issues = [
          ...validateNumber(nomX.value, { label: 'Nominal X', min: 10, max: 500 }),
          ...validateNumber(nomY.value, { label: 'Nominal Y', min: 10, max: 500 })
        ];
        if (num(nomX.value) < 60 || num(nomY.value) < 60) {
          issues.push({ level: 'warning', message: 'Below ~60 mm, shrinkage differences approach caliper measurement noise — a larger object gives a much more trustworthy percentage.' });
        }
        return { data: { entry: 'measured', nominalX: num(nomX.value), nominalY: num(nomY.value) }, issues };
      }
    };
  },

  resultForm(ctx, settings, prior) {
    const entry = String(settings.entry ?? 'direct');
    const el = h('div', {});

    // --- plate: spreadsheet scale error OR two direct measurements ----------
    if (entry === 'plate') {
      let mode: 'sheet' | 'measure' = (prior?.plateMode as 'sheet' | 'measure') ?? 'sheet';
      const modeSel = h('select', {},
        h('option', { value: 'sheet', selected: mode === 'sheet' }, 'I used the author\'s spreadsheet — I\'ll enter its scale-error result'),
        h('option', { value: 'measure', selected: mode === 'measure' }, 'I\'ll enter caliper measurements and let the wizard calculate'));
      const scaleErr = numberInput({ value: prior?.scaleError ?? '', step: 0.01, placeholder: 'e.g. -0.54' });
      const nomA = numberInput({ value: prior?.nomA ?? 150, step: 1 });
      const measA = numberInput({ value: prior?.measA ?? '', step: 0.01, placeholder: 'e.g. 149.2' });
      const nomB = numberInput({ value: prior?.nomB ?? 140, step: 1 });
      const measB = numberInput({ value: prior?.measB ?? '', step: 0.01, placeholder: 'optional second feature' });

      const sheetWrap = h('div', {},
        field('Scale error from the spreadsheet (%)', scaleErr,
          'The sheet\'s "Calculated scale error" row (or "Avg scale error" if you skipped the radial-comp section), as a percentage — a small number near zero, usually negative (e.g. −0.67% shrinkage → enter -0.67). The wizard converts it: shrinkage% = 100 + error.'));
      const measureWrap = h('div', { style: 'display:none' },
        h('p', { class: 'field-help' }, 'Measure two of the plate\'s larger features (defaults: the 150 mm between-squares span and the 140 mm between-diamonds span). One feature works; two get averaged.'),
        h('div', { class: 'field-row' },
          field('Feature A nominal (mm)', nomA), field('Feature A measured (mm)', measA)),
        h('div', { class: 'field-row' },
          field('Feature B nominal (mm)', nomB), field('Feature B measured (mm)', measB, 'Leave empty to use feature A alone.')));
      const plateBand = bandReadout({
        precision: 2, unit: 'mm', bandNoun: 'within 0.5% of',
        unlitNote: 'Nothing measured yet',
        outsideNote: 'More than 0.5% off nominal — that is worth compensating for.'
      });
      const refreshPlateBand = () => {
        const nominal = num(nomA.value);
        if (!Number.isFinite(nominal) || nominal <= 0 || mode !== 'measure') {
          plateBand.update(null, NaN, NaN);
          return;
        }
        plateBand.update(measA.value === '' ? null : num(measA.value), nominal * 0.995, nominal * 1.005);
      };
      [nomA, measA].forEach(i => i.addEventListener('input', refreshPlateBand));

      const sync = () => {
        mode = modeSel.value as 'sheet' | 'measure';
        sheetWrap.style.display = mode === 'sheet' ? '' : 'none';
        measureWrap.style.display = mode === 'measure' ? '' : 'none';
        refreshPlateBand();
      };
      modeSel.addEventListener('change', sync); sync();

      measureWrap.append(plateBand.el);
      el.append(field('How are you reporting the result?', modeSel), sheetWrap, measureWrap);
      return {
        el,
        collect() {
          const issues: ValidationIssue[] = [];
          const data: Record<string, unknown> = { plateMode: mode };
          if (mode === 'sheet') {
            issues.push(...validateNumber(scaleErr.value, { label: 'Scale error', min: -10, max: 10 }));
            data.scaleError = num(scaleErr.value);
          } else {
            issues.push(...validateNumber(nomA.value, { label: 'Feature A nominal', min: 10, max: 500 }));
            issues.push(...validateNumber(measA.value, { label: 'Feature A measured', min: 1, max: 600 }));
            data.nomA = num(nomA.value); data.measA = num(measA.value);
            if (measB.value !== '') {
              issues.push(...validateNumber(nomB.value, { label: 'Feature B nominal', min: 10, max: 500 }));
              issues.push(...validateNumber(measB.value, { label: 'Feature B measured', min: 1, max: 600 }));
              data.nomB = num(nomB.value); data.measB = num(measB.value);
            } else {
              data.measB = '';
            }
          }
          return { data, issues };
        }
      };
    }

    // --- direct % (CaliFlower calculator) or measured object ----------------
    const direct = entry !== 'measured';
    const xIn = numberInput({ value: prior?.x ?? '', step: 0.01, placeholder: direct ? 'e.g. 99.4' : 'e.g. 99.42' });
    const yIn = numberInput({ value: prior?.y ?? '', step: 0.01, placeholder: 'optional — leave empty to reuse X' });

    // Deviation on the X axis: measured size against nominal ±0.5%, or the
    // reported shrinkage percentage against the range filaments normally land in.
    const nominalX = num(settings.nominalX);
    const xBand = direct
      ? bandReadout({
        precision: 2, unit: '%', bandNoun: 'usual',
        domain: { min: 97, max: 102 },
        unlitNote: 'Nothing entered yet',
        outsideNote: 'Outside what common filaments shrink — re-check the measurement before compensating.'
      })
      : bandReadout({
        precision: 2, unit: 'mm', bandNoun: 'within 0.5% of',
        unlitNote: 'Nothing measured yet',
        outsideNote: 'More than 0.5% off nominal — that is worth compensating for.'
      });
    const refreshXBand = () => {
      const v = xIn.value === '' ? null : num(xIn.value);
      if (direct) xBand.update(v, 99, 100.5);
      else if (Number.isFinite(nominalX) && nominalX > 0) xBand.update(v, nominalX * 0.995, nominalX * 1.005);
      else xBand.update(v, NaN, NaN);
    };
    xIn.addEventListener('input', refreshXBand);
    refreshXBand();

    el.append(
      direct
        ? h('p', {}, 'Enter the shrinkage percentage(s) from the tool\'s calculator (after measuring the fully cooled part).')
        : h('p', {}, `Measure the printed object with calipers — above the first layers, not across the base flare. Nominal sizes: X ${settings.nominalX} mm, Y ${settings.nominalY} mm.`),
      h('div', { class: 'field-row' },
        field(direct ? 'Shrinkage X (%)' : 'Measured X (mm)', xIn),
        field(direct ? 'Shrinkage Y (%)' : 'Measured Y (mm)', yIn, 'If your tool/measurement only gives one number, leave Y empty.')
      ),
      xBand.el
    );
    if (ctx.coach) {
      el.append(h('details', { class: 'why' },
        h('summary', {}, 'My X and Y disagree'),
        h('div', { class: 'why-body' },
          h('p', {}, 'Filament shrinks the same in every direction — it has no idea which way X is. A real X/Y difference means the PRINTER is drawing rectangles that aren\'t quite square or true to size: belt tension, frame squareness, or skew. Small differences (≤0.2%) are normal; beyond ~0.5%, fix the mechanics before compensating in the filament profile.')
        )));
    }
    return {
      el,
      collect() {
        const issues: ValidationIssue[] = [];
        if (direct) {
          issues.push(...validateNumber(xIn.value, { label: 'Shrinkage X', min: 90, max: 102 }));
          if (yIn.value !== '') issues.push(...validateNumber(yIn.value, { label: 'Shrinkage Y', min: 90, max: 102 }));
        } else {
          issues.push(...validateNumber(xIn.value, { label: 'Measured X', min: 1, max: 600 }));
          if (yIn.value !== '') issues.push(...validateNumber(yIn.value, { label: 'Measured Y', min: 1, max: 600 }));
        }
        return { data: { x: num(xIn.value), y: yIn.value === '' ? '' : num(yIn.value) }, issues };
      }
    };
  },

  compute(ctx, settings, result) {
    const calcs: CalcResult[] = [];
    let xPct: number, yPct: number;
    if (settings.entry === 'plate' && result.plateMode === 'sheet') {
      const c = shrinkageFromScaleError(num(result.scaleError));
      calcs.push(c);
      xPct = yPct = c.rounded;
    } else if (settings.entry === 'plate') {
      const ca = shrinkageFromMeasurement(num(result.nomA), num(result.measA));
      calcs.push(ca);
      xPct = ca.rounded;
      if (result.measB !== '' && result.measB !== undefined) {
        const cb = shrinkageFromMeasurement(num(result.nomB), num(result.measB));
        calcs.push(cb);
        yPct = cb.rounded;
      } else {
        yPct = xPct;
      }
    } else if (settings.entry === 'measured') {
      const cx = shrinkageFromMeasurement(num(settings.nominalX), num(result.x));
      calcs.push(cx);
      xPct = cx.rounded;
      if (result.y !== '' && result.y !== undefined) {
        const cy = shrinkageFromMeasurement(num(settings.nominalY), num(result.y));
        calcs.push(cy);
        yPct = cy.rounded;
      } else {
        yPct = xPct;
      }
    } else {
      xPct = roundTo(num(result.x), 2);
      yPct = result.y !== '' && result.y !== undefined ? roundTo(num(result.y), 2) : xPct;
    }
    const combined = shrinkageCombined(xPct, yPct);
    if (xPct !== yPct || calcs.length !== 1) calcs.push(combined);
    const warnings = [...new Set(calcs.flatMap(c => c.warnings))];
    return {
      calcs,
      computed: { shrinkageX: xPct, shrinkageY: yPct, shrinkagePercent: combined.rounded },
      finalsPatch: { shrinkagePercent: combined.rounded },
      enterInSlicer: [{ label: 'Shrinkage (XY) — a percentage', value: `${combined.rounded}%` }],
      warnings
    };
  }
};

// ---------------------------------------------------------------------------
// Dual-nozzle ooze control
// ---------------------------------------------------------------------------

const oozeControlController: TestController = {
  settingsForm(ctx, prior) {
    const primeTower = h('input', { type: 'checkbox', checked: prior?.primeTower ?? true });
    const primeVolume = numberInput({ value: prior?.primeVolume ?? '', placeholder: 'slicer default', step: 5, min: 0 });
    const auxRetraction = numberInput({
      value: prior?.auxRetraction ?? ctx.project.finals.retractionDistance ?? 2, step: 0.5, min: 0
    });
    const overrideSet = h('input', { type: 'checkbox', checked: prior?.overrideSet ?? false });
    const rammingTuned = h('input', { type: 'checkbox', checked: prior?.rammingTuned ?? false });

    // Two nozzles, two panels. The main dial stays dark until the retraction
    // test has actually been run — an unmeasured nozzle is never a fake zero.
    const mainRetraction = ctx.project.finals.retractionDistance;
    const mainGauge = gaugeInstrument({ placard: 'Main nozzle', unit: 'mm', min: 0, max: 8, precision: 2 });
    const auxGauge = gaugeInstrument({ placard: 'Aux nozzle', unit: 'mm', min: 0, max: 8, precision: 2, settle: true });
    mainGauge.update(typeof mainRetraction === 'number' ? mainRetraction : null);

    // Deviation readout for the aux override: most filaments land 2–4 mm.
    const auxBand = bandReadout({
      precision: 2, unit: 'mm', bandNoun: 'usual',
      domain: { min: 0, max: 8 },
      unlitNote: 'No override entered yet',
      outsideNote: 'Beyond the window most filaments need — move in 0.5 mm steps and re-check the toolchanges.'
    });
    const refreshAux = () => {
      const v = auxRetraction.value === '' ? null : num(auxRetraction.value);
      auxGauge.update(v);
      auxBand.update(v, 2, 4);
    };
    auxRetraction.addEventListener('input', refreshAux);
    refreshAux();

    const el = h('div', {},
      h('p', {}, 'Confirm each mitigation below, then print a small two-filament model with several toolchanges to verify.'),
      // The fork, stated on this side of it too. Everything in this step is a
      // toolchange defence; none of it touches drool inside one filament, and a
      // user who works the checklist for the wrong symptom finds that out only
      // after another print.
      calloutEl({
        id: 'ooze-fork', tone: 'info',
        title: 'This step covers toolchange ooze only',
        body: [
          'Every mitigation here — prime tower, per-extruder retraction override, aux K, ramming — acts at the hand-off between the two nozzles. If your blobs and strings appear during ordinary printing within a single filament, none of it will help.',
          'That case belongs to the temperature step, which owns the dominant lever, and the retraction step, which carries the full ordered lever list. Both are in every project, single-nozzle included.'
        ]
      }),
      h('div', { class: 'six-pack six-pack-2' }, mainGauge.el, auxGauge.el),
      h('p', { class: 'field-help' },
        typeof mainRetraction === 'number'
          ? 'The main nozzle carries the retraction distance you calibrated earlier. The auxiliary nozzle is a separate bowden path and needs its own value — they are rarely the same.'
          : 'The main nozzle is dark because the retraction test has not been run yet. The auxiliary nozzle is a separate bowden path and needs its own value regardless.'),
      h('div', { class: 'check-item' }, primeTower,
        h('div', {}, h('strong', {}, 'Prime tower is enabled'),
          ctx.coach ? h('p', { class: 'coach-note' }, 'The primary mitigation: every toolchange wipes and re-primes on the tower instead of on your part.') : null)),
      h('div', { class: 'field-row' },
        field('Prime volume (mm³, optional)', primeVolume, 'Per-filament prime volume. Leave empty to keep the slicer default; raise it for leaky pairings (PETG especially).'),
        field('Aux (Bowden Extruder) retraction override (mm)', auxRetraction, 'The value ticked under Filament settings → Setting Overrides → "Bowden Extruder" → Retraction → Length. Machine default is 2 mm; most filaments land between 2 and 4 mm.')
      ),
      auxBand.el,
      h('div', { class: 'check-item' }, overrideSet,
        h('div', {}, h('strong', {}, 'The bowden Length override is ticked and set — not left blank ("nil")'),
          ctx.coach ? h('p', { class: 'coach-note' }, 'Bambu Studio bug #10404: an unset bowden override silently falls back to the 0.8 mm MAIN default on the auxiliary nozzle.') : null)),
      h('div', { class: 'check-item' }, rammingTuned,
        h('div', {}, h('strong', {}, 'Developer-Mode ramming/precooling parameters adjusted (optional)'),
          ctx.coach ? h('p', { class: 'coach-note' }, 'Bambu Studio 2.5+ Developer Mode exposes ramming length, precooling temperature, and post-ramming travel time — worth raising for leaky pairings like PETG on the aux nozzle.') : null)),
      h('div', { class: 'callout' },
        h('p', { class: 'co-title' }, 'Why the idle nozzle oozes'),
        h('p', {}, 'On toolchange Bambu Studio emits M104 S0 for the inactive nozzle (letting it cool toward ~60 °C) and reheats it when needed again. The reheat causes a melt-zone pressure spike that oozes on resume — PETG worst. There is no official standby-temperature field.'),
        h('p', { class: 'field-help' }, 'Advanced users only: the change-filament G-code can be edited to hold the idle nozzle at ~160–180 °C instead — less thermal cycling, at the cost of some standing ooze.'))
    );
    return {
      el,
      collect() {
        const issues: ValidationIssue[] = [
          ...validateNumber(auxRetraction.value, { label: 'Aux retraction override', min: 0, max: 15 })
        ];
        if (primeVolume.value !== '') issues.push(...validateNumber(primeVolume.value, { label: 'Prime volume', min: 0, max: 999 }));
        if (!primeTower.checked) issues.push({ level: 'warning', message: 'Prime tower disabled — it is the primary ooze defense on dual-nozzle machines.' });
        if (!overrideSet.checked) issues.push({ level: 'warning', message: 'Bowden retraction override not confirmed as set — with bug #10404 the aux nozzle silently under-retracts at the 0.8 mm main default.' });
        return {
          data: {
            primeTower: primeTower.checked,
            primeVolume: primeVolume.value === '' ? '' : num(primeVolume.value),
            auxRetraction: num(auxRetraction.value),
            overrideSet: overrideSet.checked,
            rammingTuned: rammingTuned.checked
          }, issues
        };
      }
    };
  },

  resultForm(ctx, settings, prior) {
    let assessment: string | null = (prior?.assessment as string) ?? null;
    const options: { v: string; label: string }[] = [
      { v: 'good', label: '✓ Good — clean toolchanges, no blobs or bleed' },
      { v: 'acceptable', label: '~ Acceptable — minor hairs or marks, nothing on the part' },
      { v: 'bad', label: '✖ Bad — blobs, smears, or contamination on the part' }
    ];
    const chips = h('div', { class: 'sample-grid', role: 'radiogroup', 'aria-label': 'Remaining ooze assessment' },
      options.map(o => {
        const b = h('button', {
          type: 'button', class: 'sample-chip', 'aria-pressed': String(assessment === o.v),
          onClick: () => {
            assessment = o.v;
            chips.querySelectorAll('.sample-chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
            b.setAttribute('aria-pressed', 'true');
          }
        }, o.label);
        return b;
      }));
    const suspectMoisture = h('input', { type: 'checkbox', checked: prior?.suspectMoisture ?? false });

    const el = h('div', {},
      h('p', {}, 'Inspect the verification print around each toolchange, then rate the remaining ooze.'),
      h('span', { class: 'placard' }, 'Remaining ooze'),
      chips,
      h('div', { class: 'check-item' }, suspectMoisture,
        h('div', {}, h('strong', {}, 'I saw popping, steam, or bubbly extrusion'),
          h('p', { class: 'coach-note' }, 'Classic moisture signs — dry the filament before trusting any of these settings.')))
    );
    return {
      el,
      collect() {
        const issues: ValidationIssue[] = [];
        if (!assessment) issues.push({ level: 'error', message: 'Rate the remaining ooze (good / acceptable / bad).' });
        return { data: { assessment: assessment as string, suspectMoisture: suspectMoisture.checked }, issues };
      }
    };
  },

  compute(ctx, settings, result) {
    const assessment = String(result.assessment ?? '');
    const auxRetraction = num(settings.auxRetraction);
    const computed: Record<string, number | string> = {
      oozeAssessment: assessment,
      primeTower: settings.primeTower ? 'on' : 'off',
      auxRetraction,
      verdict: assessment === 'good'
        ? 'Ooze under control — clean toolchanges. Record these settings.'
        : assessment === 'acceptable'
          ? 'Minor remaining ooze — acceptable for most prints; the warnings below list the next knobs if you want it cleaner.'
          : 'Ooze is still winning — work through the suggestions below and re-run the verification print.'
    };
    if (settings.primeVolume !== '' && settings.primeVolume !== undefined) computed.primeVolume = num(settings.primeVolume);

    const enterInSlicer = [
      { label: 'Prime tower', value: settings.primeTower ? 'enabled' : 'disabled' },
      { label: 'Bowden Extruder retraction override (Length)', value: `${auxRetraction} mm` }
    ];
    if (computed.primeVolume !== undefined) enterInSlicer.push({ label: 'Prime volume', value: `${computed.primeVolume} mm³` });

    const warnings: string[] = [];
    if (assessment === 'bad') {
      warnings.push('Raise the aux retraction override in ~0.5 mm steps (most filaments land 2–4 mm, up to 6), increase prime volume, and try the Developer-Mode ramming/precooling parameters before anything exotic.');
    }
    if (result.suspectMoisture) {
      warnings.push('Popping or steam points at moisture — dry the filament and re-run; wet filament defeats every ooze setting.');
    }
    if (!settings.overrideSet) {
      warnings.push('The bowden retraction override was not confirmed as set. With Bambu Studio bug #10404 an unset ("nil") override falls back to the 0.8 mm MAIN default — tick Length under Setting Overrides → "Bowden Extruder".');
    }
    return { calcs: [], computed, finalsPatch: {}, enterInSlicer, warnings };
  }
};

// ---------------------------------------------------------------------------
// Final verification
// ---------------------------------------------------------------------------

const verificationController: TestController = {
  settingsForm(ctx, prior) {
    const model = h('input', { type: 'text', value: (prior?.model as string) ?? '', placeholder: 'e.g. 3DBenchy, my bracket v2' });
    const el = h('div', {},
      field('Verification model used', model, 'A torture-style model or a real part — printed with your NORMAL process profile and the newly saved filament preset.'));
    return {
      el,
      collect() {
        return { data: { model: model.value }, issues: model.value.trim() ? [] : [{ level: 'warning' as const, message: 'Recording which model you used helps future comparisons.' }] };
      }
    };
  },

  resultForm(ctx, settings, prior) {
    const marks = new Map<string, VerificationMark>();
    const el = h('div', {},
      h('p', {}, 'Inspect the print category by category. Nothing here is perfectly objective — mark honestly, "Acceptable" is a valid answer.'));
    // Annunciator per category: unlit until marked, red only for a real fault.
    const lampFor: Record<VerificationMark, string> = {
      pass: 'lamp lamp-ok',
      acceptable: 'lamp',
      'needs-adjustment': 'lamp lamp-alert',
      'not-tested': 'lamp lamp-unlit'
    };
    const options: { v: VerificationMark; label: string; cls: string; icon: string }[] = [
      { v: 'pass', label: 'Pass', cls: 'badge-ok', icon: '✓' },
      { v: 'acceptable', label: 'Acceptable', cls: 'badge-accent', icon: '~' },
      { v: 'needs-adjustment', label: 'Needs adjustment', cls: 'badge-bad', icon: '✖' },
      { v: 'not-tested', label: 'Not tested', cls: 'badge-info', icon: '·' }
    ];
    for (const cat of VERIFICATION_CATEGORIES) {
      const preset = (prior?.[`cat-${cat.id}`] as VerificationMark) ?? null;
      if (preset) marks.set(cat.id, preset);
      const lamp = h('span', { class: preset ? lampFor[preset] : 'lamp lamp-unlit', 'aria-hidden': 'true' });
      const group = h('div', { role: 'radiogroup', 'aria-label': cat.label, class: 'sample-grid' },
        options.map(o => {
          const b = h('button', {
            type: 'button', class: 'sample-chip', 'aria-pressed': String(preset === o.v),
            onClick: () => {
              marks.set(cat.id, o.v);
              group.querySelectorAll('.sample-chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
              b.setAttribute('aria-pressed', 'true');
              lamp.className = lampFor[o.v];
            }
          }, `${o.icon} ${o.label}`);
          return b;
        }));
      el.append(h('div', { class: 'eval-item' },
        h('div', { class: 'eval-icon' }, lamp),
        h('div', { style: 'flex:1' },
          h('h4', {}, cat.label),
          ctx.coach ? h('p', { class: 'eval-meaning' }, cat.coachHint) : null,
          group)));
    }
    return {
      el,
      collect() {
        const issues: ValidationIssue[] = [];
        const data: Record<string, unknown> = {};
        let any = false;
        for (const cat of VERIFICATION_CATEGORIES) {
          const m = marks.get(cat.id);
          if (m) { data[`cat-${cat.id}`] = m; any = true; }
          else data[`cat-${cat.id}`] = 'not-tested';
        }
        if (!any) issues.push({ level: 'error', message: 'Mark at least one category.' });
        return { data, issues };
      }
    };
  },

  compute(ctx, settings, result) {
    let pass = 0, acceptable = 0, fail = 0, notTested = 0;
    const failedCats: string[] = [];
    for (const cat of VERIFICATION_CATEGORIES) {
      const m = result[`cat-${cat.id}`] as VerificationMark;
      if (m === 'pass') pass++;
      else if (m === 'acceptable') acceptable++;
      else if (m === 'needs-adjustment') { fail++; failedCats.push(cat.label); }
      else notTested++;
    }
    const verdict = fail === 0
      ? (pass + acceptable > 0 ? 'Profile verified — no category needs adjustment.' : 'Nothing tested yet.')
      : `${fail} categor${fail === 1 ? 'y' : 'ies'} need attention: ${failedCats.join(', ')}.`;
    const warnings: string[] = [];
    if (fail > 0) warnings.push('See the ranked suggestions on the project page — they point to the calibration most likely responsible for each failed category. They are likelihoods, not verdicts.');
    return {
      calcs: [],
      computed: { pass, acceptable, needsAdjustment: fail, notTested, verdict },
      finalsPatch: {},
      enterInSlicer: [],
      warnings
    };
  }
};

export const CONTROLLERS: Record<CalibrationId, TestController> = {
  temperature: temperatureController,
  'flow-pass1': flowController(1),
  'flow-pass2': flowController(2),
  'pressure-advance': paController,
  'flow-verify': flowController('verify'),
  retraction: retractionController,
  'max-volumetric-speed': mvsController,
  shrinkage: shrinkageController,
  'ooze-control': oozeControlController,
  'final-verification': verificationController
};
