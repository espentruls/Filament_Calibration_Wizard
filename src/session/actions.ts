// ---------------------------------------------------------------------------
// Guided session — "what to change right now".
//
// Turns a step + a nozzle into a precise, ordered list of things to do in the
// slicer: which slicer, which menu path, which exact field, which value, and —
// on a dual-nozzle machine — WHICH NOZZLE COLUMN.
//
// Every path, field name, caveat and gotcha in the output is copied verbatim
// from `src/data/slicers.ts`, which is version-aware and wiki-verified. This
// module ROUTES that content; it never writes slicer facts. Where the shipped
// data has no answer, the plan says so in `gaps` instead of inventing a menu
// path — the app's standing rule.
//
// Order of the list follows the order the work actually happens in:
//
//   1. carry-forward — values earlier steps measured that must already be saved
//      in the preset before this test is meaningful (the "flow ratio is
//      calibrated AND saved" prerequisite, made actionable);
//   2. disable — settings the slicer content says to switch off first;
//   3. perform — the test's own numbered steps;
//   4. record — where this test's result will go afterwards, carrying at least
//      the severity the same sentence has when the content also lists it as a
//      gotcha (see `saveToSeverity`);
//   5. trap — the gotchas, with known bugs raised to alert.
// ---------------------------------------------------------------------------

import type { CalibrationId, ExtruderType, SlicerTestInstructions } from '../types';
import { CALIBRATIONS } from '../data/calibrations';
import { getSlicerContent } from '../data/slicers';
import { resolveChamberAdvisory, resolveStepValues, stepsProducing, type ValueContext } from './values';
import type {
  ActionSeverity,
  SessionAction,
  SessionActionPlan,
  SessionNozzle
} from './types';

/**
 * The per-extruder column names Bambu Studio's Setting Overrides selector uses.
 * Both strings appear verbatim in `src/data/slicers.ts`; a column is only ever
 * named in the output when the shipped content for that very field names it, so
 * this map selects between documented labels rather than supplying one.
 */
const EXTRUDER_COLUMNS: Record<ExtruderType, string> = {
  direct: 'Direct Drive Extruder',
  bowden: 'Bowden Extruder'
};

/**
 * Markers that promote an instruction from "worth knowing" to "this will bite
 * you". Both come from the shipped content itself: `KNOWN BUG` prefixes the
 * Bambu Studio #10404 note, where an unset bowden retraction override silently
 * falls back to the main nozzle's 0.8 mm — the exact failure this product exists
 * to prevent.
 */
const ALERT_MARKERS = ['KNOWN BUG', '#10404'];

function severityFor(text: string, fallback: ActionSeverity): ActionSeverity {
  return ALERT_MARKERS.some((m) => text.includes(m)) ? 'alert' : fallback;
}

/**
 * Severity for a `saveTo`-derived instruction (the `record` action and the
 * `carry-forward` actions that quote the same destination note).
 *
 * A sentence the shipped content ALSO lists as a gotcha must not read quieter
 * when it turns up inside a save destination. Bambu Studio's pressure-advance
 * destination is the case that matters for a dual-nozzle session: its note ends
 * with the very caveat the same step lists as a gotcha — a manually measured K
 * applies only with the pre-print calibration gear set to "Off" — and a K that
 * is silently ignored is not an 'info'. It stayed 'info' purely because the
 * default fallback for a destination is 'info' while a gotcha's is 'caution'.
 *
 * No wording is added here and no severity is asserted: the content decides, by
 * repeating itself. `severityFor` still has the last word, so a note carrying a
 * known-bug marker is an 'alert' either way.
 */
function saveToSeverity(text: string, gotchas: string[] | undefined): ActionSeverity {
  const echoesGotcha = (gotchas ?? []).some((g) => g.length > 0 && text.includes(g));
  return severityFor(text, echoesGotcha ? 'caution' : 'info');
}

/** The documented column for this nozzle's feed, when the text names it. */
function nozzleColumnIn(texts: (string | undefined)[], feed: ExtruderType): string | undefined {
  const want = EXTRUDER_COLUMNS[feed];
  return texts.some((t) => typeof t === 'string' && t.includes(want)) ? want : undefined;
}

/** True when a saveTo destination is a real place rather than the "nothing to
 *  save" placeholder the verification steps carry. */
function hasDestination(save: SlicerTestInstructions['saveTo'] | undefined): boolean {
  return !!save && save.path !== '—' && save.scope !== 'calibration-only';
}

/**
 * Where the shipped slicer content says chamber temperature lives, if anywhere.
 *
 * Nothing in `slicers.ts` names a chamber field today, so this returns undefined
 * and the plan records a gap. It is a lookup rather than a constant so that the
 * day the shipped content gains one, the action starts carrying the real path
 * instead of a path this module made up.
 */
function chamberDestination(
  content: ReturnType<typeof getSlicerContent>
): { path: string; field: string; stepId: CalibrationId } | undefined {
  for (const [stepId, inst] of Object.entries(content.perTest) as [CalibrationId, SlicerTestInstructions][]) {
    const save = inst?.saveTo;
    if (!save || !hasDestination(save)) continue;
    if (/chamber/i.test(save.field)) return { path: save.path, field: save.field, stepId };
  }
  return undefined;
}

/**
 * Build the ordered action list for one step on one nozzle.
 */
export function buildActionPlan(
  ctx: ValueContext,
  nozzle: SessionNozzle,
  stepId: CalibrationId
): SessionActionPlan {
  const project = ctx.project;
  const content = getSlicerContent(project.slicer.slicer, project.slicer.version);
  const instructions = content.perTest[stepId];
  const actions: SessionAction[] = [];
  const gaps: string[] = [];
  let order = 0;

  const base = {
    slicer: content.slicer,
    slicerLabel: content.slicerLabel,
    slicerVersion: content.version
  };
  const push = (a: Omit<SessionAction, 'order'>): void => {
    actions.push({ ...a, order: order++ });
  };

  // --- 1. carry the measured values forward --------------------------------
  // Only measurements and explicit overrides are worth an instruction: a value
  // that merely carried over from the base profile is already in the preset,
  // and a material default is not something to type in as if it were measured.
  const values = resolveStepValues(ctx, stepId);
  const carry = values.inherited.filter(
    (v) => v.value !== undefined && (v.provenance === 'calibrated' || v.provenance === 'user-override')
  );
  for (const value of carry) {
    const producer = value.stepId ?? stepsProducing(value.key).slice(-1)[0];
    const producerInstructions = producer ? content.perTest[producer] : undefined;
    const save = producerInstructions?.saveTo;
    if (!producer || !hasDestination(save)) {
      gaps.push(
        `The shipped ${content.slicerLabel} ${content.version} instructions do not name a place to save ${value.label}, so PerfectFit shows the value without a menu path rather than guessing one.`
      );
      continue;
    }
    const detail = save!.note;
    push({
      id: `${stepId}:carry:${value.key}`,
      kind: 'carry-forward',
      title: `Check that ${value.label.toLowerCase()} is saved in the preset`,
      ...base,
      path: save!.path,
      field: save!.field,
      value: value.display,
      nozzleColumn: nozzleColumnIn([save!.path, save!.field, detail], nozzle.feed),
      detail,
      severity: saveToSeverity(`${save!.path} ${detail}`, producerInstructions?.gotchas),
      source: `slicers.ts · ${content.slicer} ${content.version} · ${producer} · saveTo`,
      fromStepId: producer
    });
  }

  // --- 1b. the build chamber ------------------------------------------------
  // A machine setting, not a preset one, and the one place where "as hot as it
  // goes" is right for ABS and damaging for PLA. It comes before the test's own
  // steps because the chamber has to be at temperature before anything prints.
  const chamber = resolveChamberAdvisory(ctx);
  if (chamber.actionable && chamber.display) {
    const dest = chamberDestination(content);
    const off = chamber.advice === 'ambient';
    push({
      id: `${stepId}:chamber`,
      kind: 'environment',
      title: off
        ? 'Turn chamber heating off before printing'
        : 'Bring the chamber up to temperature before printing',
      ...base,
      path: dest?.path,
      field: dest?.field,
      value: chamber.display,
      detail: [chamber.explanation, ...chamber.warnings].join(' '),
      // Leaving a chamber hot for a low-Tg filament ends in a jam, so that half
      // is a caution; a warm chamber for ABS is ordinary setup.
      severity: off ? 'caution' : 'info',
      source: `materials.ts · ${ctx.material.id} · chamber`,
      fromStepId: stepId
    });
    if (!dest) {
      gaps.push(
        `The shipped ${content.slicerLabel} ${content.version} instructions do not name where chamber temperature is set, so PerfectFit gives the number without a menu path rather than guessing one.`
      );
    }
  }

  // --- no shipped instructions for this test -------------------------------
  if (!instructions) {
    gaps.push(
      `The shipped instructions for ${content.slicerLabel} ${content.version} have no entry for the ${CALIBRATIONS[stepId].name} test, so PerfectFit has no verified menu path to show for it.`
    );
    return plan(nozzle, stepId, content, undefined, actions, gaps);
  }
  if (!instructions.available) {
    gaps.push(
      `${content.slicerLabel} ${content.version} has no built-in ${CALIBRATIONS[stepId].shortName} test — follow the steps below instead.`
    );
  }

  // --- 2. switch these off first -------------------------------------------
  for (const [i, text] of (instructions.disableFirst ?? []).entries()) {
    push({
      id: `${stepId}:disable:${i}`,
      kind: 'disable',
      title: 'Turn this off before printing the test',
      ...base,
      detail: text,
      severity: severityFor(text, 'caution'),
      source: `slicers.ts · ${content.slicer} ${content.version} · ${stepId} · disableFirst[${i}]`,
      fromStepId: stepId
    });
  }

  // --- 3. run the test ------------------------------------------------------
  for (const [i, text] of instructions.steps.entries()) {
    push({
      id: `${stepId}:perform:${i}`,
      kind: 'perform',
      title: i === 0 ? 'Set up and run the test' : `Step ${i + 1}`,
      ...base,
      path: i === 0 ? instructions.menuPath : undefined,
      nozzleColumn: nozzleColumnIn([text], nozzle.feed),
      detail: text,
      severity: severityFor(text, 'info'),
      source: `slicers.ts · ${content.slicer} ${content.version} · ${stepId} · steps[${i}]`,
      fromStepId: stepId
    });
  }

  // --- 4. where this test's own result goes --------------------------------
  if (hasDestination(instructions.saveTo)) {
    const save = instructions.saveTo;
    const column = nozzleColumnIn([save.path, save.field, save.note], nozzle.feed);
    push({
      id: `${stepId}:record`,
      kind: 'record',
      // No value yet: this is where the number will go once the print is judged.
      title: 'Save the result here afterwards',
      ...base,
      path: save.path,
      field: save.field,
      nozzleColumn: column,
      detail: save.note,
      severity: saveToSeverity(`${save.path} ${save.note}`, instructions.gotchas),
      source: `slicers.ts · ${content.slicer} ${content.version} · ${stepId} · saveTo`,
      fromStepId: stepId
    });
    if (nozzle.auxiliary && !column) {
      gaps.push(
        `The shipped instructions for this test do not name a per-extruder column, so PerfectFit cannot say which nozzle column ${nozzle.label} uses here. Check the slicer's own extruder selector before entering the value.`
      );
    }
  }

  // --- 5. traps -------------------------------------------------------------
  for (const [i, text] of (instructions.gotchas ?? []).entries()) {
    push({
      id: `${stepId}:trap:${i}`,
      kind: 'trap',
      title: severityFor(text, 'caution') === 'alert' ? 'Known trap' : 'Worth knowing',
      ...base,
      nozzleColumn: nozzleColumnIn([text], nozzle.feed),
      detail: text,
      severity: severityFor(text, 'caution'),
      source: `slicers.ts · ${content.slicer} ${content.version} · ${stepId} · gotchas[${i}]`,
      fromStepId: stepId
    });
  }

  return plan(nozzle, stepId, content, instructions, actions, gaps);
}

function plan(
  nozzle: SessionNozzle,
  stepId: CalibrationId,
  content: ReturnType<typeof getSlicerContent>,
  instructions: SlicerTestInstructions | undefined,
  actions: SessionAction[],
  gaps: string[]
): SessionActionPlan {
  return {
    stepId,
    nozzleIndex: nozzle.index,
    nozzleLabel: nozzle.label,
    feed: nozzle.feed,
    slicer: content.slicer,
    slicerLabel: content.slicerLabel,
    slicerVersion: content.version,
    verifiedOn: content.verifiedOn,
    docsUrl: content.docsUrl,
    calibrationMenuPath: content.calibrationMenuPath,
    menuPath: instructions?.menuPath,
    available: instructions?.available === true,
    actions,
    gaps
  };
}

/** The actions that carry a value into the slicer, i.e. the ones with a number
 *  attached. Handy for a compact "change these now" strip in the UI. */
export function valueActions(plan: SessionActionPlan): SessionAction[] {
  return plan.actions.filter((a) => a.value !== undefined);
}

/** Every alert-level instruction in the plan — the traps that bite silently. */
export function alerts(plan: SessionActionPlan): SessionAction[] {
  return plan.actions.filter((a) => a.severity === 'alert');
}
