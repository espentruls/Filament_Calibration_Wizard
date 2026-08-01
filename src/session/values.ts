// ---------------------------------------------------------------------------
// Guided session — result inheritance and provenance.
//
// The core promise of the guided mode: "carries results forward between steps".
// Concretely, the pressure-advance test must run at the temperature and flow
// ratio THIS session already measured, not at material defaults — and the user
// must be able to see why every pre-filled number is what it is.
//
// Two rules shape everything here:
//
//   1. Nothing is invented. A value is only offered when a real source has it:
//      a completed calibration, an explicit override, the base profile, or a
//      documented material default. Otherwise the value stays ABSENT, which is
//      what lets the UI draw an unlit dial instead of a fake zero.
//
//   2. Provenance travels with the value. `ResolvedValue.candidates` keeps every
//      source that offered a number, winner first, so "no black boxes" survives
//      contact with pre-filling.
//
// The dependency graph is DERIVED from upstream's workflow registry, which is
// itself derived from `src/data/calibrations.ts`. This module adds no calibration
// facts of its own beyond display labels and two documented starting points that
// the existing test forms already use.
// ---------------------------------------------------------------------------

import type { ChamberAdvice, CalibrationId, CalibrationProject, MaterialPreset, PrinterProfile } from '../types';
import { CALIBRATIONS, DEFAULT_ORDER } from '../data/calibrations';
import { getMaterial } from '../data/materials';
import { printerCanHeatChamber, suggestChamberTemp } from '../logic/ranges';
import { validateAgainstPrinter } from '../logic/validation';
import {
  WORKFLOW_STEPS,
  getWorkingProfile,
  normalizeNozzleIndex,
  type NormalizedProfileKey,
  type TemporaryCalibrationProfile
} from '../automatedCalibration';
import {
  PROVENANCE_FROM_UPSTREAM,
  type ResolvedValue,
  type StepWorkingValues,
  type ValueCandidate,
  type ValueProvenance
} from './types';

// --- value metadata ---------------------------------------------------------

export interface ValueMeta {
  label: string;
  unit: string;
  /** Display precision. Formatting only — never fed back into any formula. */
  precision: number;
}

/**
 * Display metadata for the normalized keys. Labels match the ones the profile
 * generator already writes into slicer presets, so the same setting is never
 * called two different things in two places. Precision mirrors each producing
 * calibration's `resultPrecision`.
 */
export const VALUE_META: Record<NormalizedProfileKey, ValueMeta> = {
  nozzleTemp: { label: 'Nozzle temperature', unit: '°C', precision: 0 },
  firstLayerTemp: { label: 'First layer nozzle temperature', unit: '°C', precision: 0 },
  highFlowTemp: { label: 'High-flow temperature', unit: '°C', precision: 0 },
  bedTemp: { label: 'Bed temperature', unit: '°C', precision: 0 },
  flowRatio: { label: 'Flow ratio', unit: '', precision: 3 },
  pressureAdvance: { label: 'Pressure advance', unit: '', precision: 3 },
  retractionDistance: { label: 'Retraction length', unit: 'mm', precision: 2 },
  retractionSpeed: { label: 'Retraction speed', unit: 'mm/s', precision: 0 },
  maxVolumetricSpeed: { label: 'Maximum volumetric speed', unit: 'mm³/s', precision: 1 },
  shrinkagePercent: { label: 'Shrinkage (XY)', unit: '%', precision: 2 }
};

/** Canonical key order for display, matching `FinalValues`. */
export const CANONICAL_KEYS = Object.keys(VALUE_META) as NormalizedProfileKey[];

/**
 * Extra values a step records alongside the one upstream declares it produces.
 * The temperature test optionally captures a first-layer and a high-flow
 * temperature (see the temperature controller in `src/ui/testForms.ts`); both
 * land in `finals` and both are worth carrying forward. They are kept out of
 * upstream's `produces` on purpose — `applyStepResult` validates against that
 * list, and widening it would change upstream's validation.
 */
const COMPANION_PRODUCES: Partial<Record<CalibrationId, NormalizedProfileKey[]>> = {
  temperature: ['firstLayerTemp', 'highFlowTemp']
};

/**
 * Values that inform a step without being produced by one of its dependencies.
 * Max volumetric speed is measured at the HIGH-FLOW temperature when the temp
 * tower recorded one (the existing max-flow form already pre-fills it that way);
 * the final verification print is where every saved value is checked at once.
 */
const ADVISORY_INPUTS: Partial<Record<CalibrationId, NormalizedProfileKey[]>> = {
  'max-volumetric-speed': ['highFlowTemp'],
  'final-verification': ['firstLayerTemp', 'shrinkagePercent']
};

/** Every normalized key a step records when it completes. */
export function keysProducedBy(stepId: CalibrationId): NormalizedProfileKey[] {
  const core = WORKFLOW_STEPS[stepId]?.produces ?? [];
  return [...(core as NormalizedProfileKey[]), ...(COMPANION_PRODUCES[stepId] ?? [])];
}

/** Which steps can produce a key, in canonical plan order. */
export function stepsProducing(key: NormalizedProfileKey): CalibrationId[] {
  const ids = Object.keys(CALIBRATIONS) as CalibrationId[];
  const ordered = [...DEFAULT_ORDER, ...ids.filter((id) => !DEFAULT_ORDER.includes(id))];
  return ordered.filter((id) => keysProducedBy(id).includes(key));
}

/**
 * The values a step should inherit.
 *
 * `required` is the union of everything the step's TRANSITIVE dependencies
 * produce — upstream's `recalibrationDependsOn`, which is exactly the closure
 * derived from `calibrations.ts`. Transitive rather than direct is the point:
 * pressure advance depends on flow, and flow depends on temperature, so a
 * pressure-advance test must know BOTH — which is the concrete requirement this
 * whole feature exists to satisfy.
 */
export function inheritedInputsFor(stepId: CalibrationId): {
  required: NormalizedProfileKey[];
  optional: NormalizedProfileKey[];
} {
  const def = WORKFLOW_STEPS[stepId];
  const required = new Set<NormalizedProfileKey>();
  for (const dep of def?.recalibrationDependsOn ?? []) {
    for (const key of WORKFLOW_STEPS[dep]?.produces ?? []) {
      required.add(key as NormalizedProfileKey);
    }
  }
  const optional = (ADVISORY_INPUTS[stepId] ?? []).filter((k) => !required.has(k));
  return {
    required: CANONICAL_KEYS.filter((k) => required.has(k)),
    optional: CANONICAL_KEYS.filter((k) => optional.includes(k))
  };
}

// --- formatting -------------------------------------------------------------

/** `value + unit` for display. Percent binds tight, everything else is spaced. */
export function formatValue(key: NormalizedProfileKey, value: number): string {
  const meta = VALUE_META[key];
  const fixed = value.toFixed(meta.precision);
  if (!meta.unit) return fixed;
  if (meta.unit === '%') return `${fixed}%`;
  return `${fixed} ${meta.unit}`;
}

// --- resolution context -----------------------------------------------------

/**
 * Everything the resolver reads. Built once per session so a plan of ten steps
 * does not re-derive the same profile lookup ten times.
 */
export interface ValueContext {
  project: CalibrationProject;
  printer?: PrinterProfile;
  material: MaterialPreset;
  nozzleIndex: number;
  /**
   * True when this session's nozzle is the project's own nozzle, which is the
   * normal case. A project records its results (`steps` + `finals`) for exactly
   * one nozzle, so those results may only be read as calibrated values when the
   * indices match. For any OTHER nozzle the project's record is never read at
   * all — which is what keeps two nozzles from bleeding into each other.
   *
   * It does NOT mean "the working profile is irrelevant here": a measurement can
   * be written straight into the working profile for ANY nozzle, this one
   * included (see `calibratedCandidate`).
   */
  ownsProjectResults: boolean;
  workingProfile?: TemporaryCalibrationProfile;
}

export function buildValueContext(input: {
  project: CalibrationProject;
  printer?: PrinterProfile;
  nozzleIndex?: number;
  material?: MaterialPreset;
}): ValueContext {
  const projectNozzle = normalizeNozzleIndex(input.project.nozzleIndex);
  const nozzleIndex =
    input.nozzleIndex === undefined ? projectNozzle : normalizeNozzleIndex(input.nozzleIndex);
  return {
    project: input.project,
    printer: input.printer,
    material: input.material ?? getMaterial(input.project.filament.material),
    nozzleIndex,
    ownsProjectResults: nozzleIndex === projectNozzle,
    workingProfile: getWorkingProfile(input.project, nozzleIndex)
  };
}

// --- candidate gathering ----------------------------------------------------

const RANK: Record<Exclude<ValueProvenance, 'unset'>, number> = {
  calibrated: 0,
  'user-override': 1,
  carried: 2,
  'printer-default': 3,
  'material-default': 4
};

/**
 * The measurement the PROJECT itself recorded — the last completed step that
 * produces the key, paired with the value in `finals`. Only ever read for the
 * project's own nozzle; null for any other one.
 */
function projectResultCandidate(
  ctx: ValueContext,
  key: NormalizedProfileKey
): ValueCandidate | null {
  if (!ctx.ownsProjectResults) return null;
  const value = ctx.project.finals[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const plan = ctx.project.stepOrder ?? [];
  let stepId: CalibrationId | undefined;
  let at: string | undefined;
  for (const id of plan) {
    if (!keysProducedBy(id).includes(key)) continue;
    const st = ctx.project.steps[id];
    if (st?.status !== 'completed') continue;
    stepId = id;
    at = st.completedAt ?? st.current?.completedAt;
  }
  if (!stepId) return null;
  return {
    provenance: 'calibrated',
    value,
    at,
    stepId,
    detail: `Measured by the ${CALIBRATIONS[stepId].shortName} test in this session.`
  };
}

/**
 * The measurement the nozzle's WORKING PROFILE carries — what
 * `recordSessionResult` writes, straight into the profile with a
 * `calibration_result` provenance and without touching `steps`/`finals`.
 */
function profileResultCandidate(
  ctx: ValueContext,
  key: NormalizedProfileKey
): ValueCandidate | null {
  const wp = ctx.workingProfile;
  if (!wp) return null;
  const raw = wp.values[key];
  const prov = wp.provenance[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  if (prov?.source !== 'calibration_result') return null;
  const stepId = prov.stepId;
  return {
    provenance: 'calibrated',
    value: raw,
    at: prov.updatedAt,
    stepId,
    detail: stepId
      ? `Measured by the ${CALIBRATIONS[stepId].shortName} test on this nozzle.`
      : 'Measured on this nozzle in this session.'
  };
}

/**
 * The calibrated candidate, if any.
 *
 * The project's own record wins where it exists — the classic wizard is still
 * the authoritative way a result is saved for the project's nozzle, and it is
 * the only source that can name the step and time from the plan.
 *
 * The working profile is then a FALL-THROUGH for every nozzle, not just the
 * other ones. Reading it only in the "other nozzle" branch silently dropped
 * measurements: `recordSessionResult` targeting the project's OWN nozzle writes
 * a `calibration_result` into the profile without touching `finals`, this
 * function returned null because `finals[key]` was absent, and
 * `profileCandidates` discarded the entry on the assumption that this function
 * had already handled it — so the value was written and readable by neither.
 */
function calibratedCandidate(ctx: ValueContext, key: NormalizedProfileKey): ValueCandidate | null {
  return projectResultCandidate(ctx, key) ?? profileResultCandidate(ctx, key);
}

/** Candidates the per-nozzle working profile carries. */
function profileCandidates(ctx: ValueContext, key: NormalizedProfileKey): ValueCandidate[] {
  const wp = ctx.workingProfile;
  if (!wp) return [];
  const raw = wp.values[key];
  const prov = wp.provenance[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !prov) return [];
  // Measurements are handled by `calibratedCandidate`, which reads the project's
  // own record first and falls back to this profile — for EVERY nozzle, this one
  // included. Emitting them here as well would double-count them.
  if (prov.source === 'calibration_result') return [];

  const provenance = PROVENANCE_FROM_UPSTREAM[prov.source];
  const detail =
    provenance === 'user-override'
      ? 'You set this value for this session.'
      : provenance === 'carried'
        ? `Carried from the base filament profile${wp.sourceProfileName ? ` (${wp.sourceProfileName})` : ''}.`
        : provenance === 'printer-default'
          ? 'Taken from the printer profile.'
          : `${ctx.material.label} starting point — not measured yet.`;
  return [{ provenance, value: raw, at: prov.updatedAt, detail }];
}

/**
 * Documented material starting points. Only two exist, and both are values the
 * app already uses elsewhere rather than numbers invented here:
 *
 *   * flow ratio — `MaterialPreset.startingFlowRatio`, the same baseline the
 *     flow test form pre-fills;
 *   * shrinkage — 100%, i.e. no compensation, which is literally what the
 *     shipped slicer instructions tell the user to set before measuring.
 *
 * Temperatures deliberately get NO default: the material preset publishes a
 * range, not a value, and picking a point inside it would be a fabricated
 * measurement. They surface as a suggested band instead.
 */
function materialCandidate(ctx: ValueContext, key: NormalizedProfileKey): ValueCandidate | null {
  if (key === 'flowRatio') {
    return {
      provenance: 'material-default',
      value: ctx.material.startingFlowRatio,
      detail: `${ctx.material.label} starting flow ratio — not measured yet.`
    };
  }
  if (key === 'shrinkagePercent') {
    return {
      provenance: 'material-default',
      value: 100,
      detail: 'No shrinkage compensation, the state the shrinkage test starts from.'
    };
  }
  return null;
}

/** The material preset's published suggested band, where one exists. */
function suggestedRangeFor(
  ctx: ValueContext,
  key: NormalizedProfileKey
): { min: number; max: number } | undefined {
  if (key === 'nozzleTemp' || key === 'firstLayerTemp' || key === 'highFlowTemp') {
    return { min: ctx.material.nozzleTemp.min, max: ctx.material.nozzleTemp.max };
  }
  if (key === 'bedTemp') return { min: ctx.material.bedTemp.min, max: ctx.material.bedTemp.max };
  return undefined;
}

// --- resolution -------------------------------------------------------------

/**
 * Resolve one setting for one nozzle.
 *
 * Order of precedence: a measurement beats an override beats a carried base
 * value beats a printer default beats a material default. The one exception is
 * deliberate — an override recorded AFTER the measurement wins, because the user
 * changing a number on purpose is newer information than the print that produced
 * it. Both stay in `candidates`, so the UI can show what was overruled.
 */
export function resolveValue(
  ctx: ValueContext,
  key: NormalizedProfileKey,
  required = false
): ResolvedValue {
  const meta = VALUE_META[key];
  const candidates: ValueCandidate[] = [];
  const calibrated = calibratedCandidate(ctx, key);
  if (calibrated) candidates.push(calibrated);
  candidates.push(...profileCandidates(ctx, key));
  const material = materialCandidate(ctx, key);
  if (material && !candidates.some((c) => c.provenance === 'material-default')) {
    candidates.push(material);
  }
  candidates.sort((a, b) => RANK[a.provenance] - RANK[b.provenance]);

  // A later explicit override outranks the measurement it replaces.
  if (candidates.length > 1 && candidates[0].provenance === 'calibrated') {
    const override = candidates.find((c) => c.provenance === 'user-override');
    if (override?.at && candidates[0].at && override.at > candidates[0].at) {
      candidates.splice(candidates.indexOf(override), 1);
      candidates.unshift(override);
    }
  }

  const suggestedRange = suggestedRangeFor(ctx, key);
  const winner = candidates[0];

  if (!winner) {
    const band = suggestedRange
      ? ` The usual ${ctx.material.label} range is ${suggestedRange.min}–${suggestedRange.max} ${meta.unit}.`
      : '';
    return {
      key,
      label: meta.label,
      unit: meta.unit,
      precision: meta.precision,
      provenance: 'unset',
      explanation: `Not measured yet, and nothing carried it forward.${band}`,
      suggestedRange,
      candidates,
      required,
      satisfied: false
    };
  }

  let explanation = winner.detail;
  if (winner.provenance === 'user-override') {
    const replaced = candidates.find((c) => c.provenance === 'calibrated');
    if (replaced) {
      explanation += ` It replaces the ${formatValue(key, replaced.value)} measured earlier.`;
    }
  }

  return {
    key,
    label: meta.label,
    unit: meta.unit,
    precision: meta.precision,
    value: winner.value,
    provenance: winner.provenance,
    stepId: winner.stepId,
    at: winner.at,
    explanation,
    suggestedRange,
    candidates,
    required,
    satisfied: isSatisfying(winner.provenance),
    display: formatValue(key, winner.value)
  };
}

/**
 * Whether a provenance counts as real information for a step that depends on it.
 * A measurement, a deliberate override and a value carried from the base profile
 * all do. A material default does not — it is a placeholder, and treating it as
 * satisfied would let the guided flow run a pressure-advance test at a generic
 * flow ratio while claiming the result was inherited.
 */
export function isSatisfying(provenance: ValueProvenance): boolean {
  return (
    provenance === 'calibrated' ||
    provenance === 'user-override' ||
    provenance === 'carried' ||
    provenance === 'printer-default'
  );
}

/**
 * Every value a step should run with, resolved with provenance. Required inputs
 * come first (canonical order), then the advisory ones.
 */
export function resolveStepValues(ctx: ValueContext, stepId: CalibrationId): StepWorkingValues {
  const { required, optional } = inheritedInputsFor(stepId);
  const inherited = [
    ...required.map((k) => resolveValue(ctx, k, true)),
    ...optional.map((k) => resolveValue(ctx, k, false))
  ];
  const missing = inherited.filter((v) => v.required && !v.satisfied).map((v) => v.key);
  return {
    stepId,
    nozzleIndex: ctx.nozzleIndex,
    inherited,
    missing,
    produces: keysProducedBy(stepId),
    ready: missing.length === 0
  };
}

/** Every value known for this nozzle right now, canonical order. */
export function resolveAllValues(ctx: ValueContext): ResolvedValue[] {
  return CANONICAL_KEYS.map((k) => resolveValue(ctx, k, false));
}

// --- the build chamber ------------------------------------------------------

/**
 * The chamber recommendation for this session, shaped like a resolved value but
 * deliberately NOT one.
 *
 * It is not a `NormalizedProfileKey`, so it can never enter `finals`, a working
 * profile, an installed preset or the confidence score. That is the whole point:
 * there is no chamber calibration, no measurement behind the number, and nothing
 * to install — only an instruction the user carries out on the machine. Keeping
 * it out of the key space is what stops it from ever being written somewhere a
 * measured value belongs.
 *
 * The number itself is `suggestChamberTemp`'s, which clamps to the machine's own
 * stated ceiling; it is then put through the SAME `validateAgainstPrinter` gate a
 * nozzle or bed temperature goes through, and dropped if that gate objects. A
 * displayed temperature and an installed one get the same scrutiny.
 */
export interface ChamberAdvisory {
  advice: ChamberAdvice;
  label: string;
  unit: string;
  /** Absent when nothing could be sourced and clamped. 0 means "heater off". */
  value?: number;
  display?: string;
  /**
   * Where the number came from: `printer-default` when the machine's own ceiling
   * decided it, `material-default` when the material did, `unset` when there is
   * no number to explain.
   */
  provenance: 'printer-default' | 'material-default' | 'unset';
  explanation: string;
  warnings: string[];
  /** True when there is something to change on the machine right now. */
  actionable: boolean;
  /**
   * Machine-limit errors that made the number unusable. Non-empty means the
   * value was withheld rather than shown — it should always be empty in
   * practice, since the suggestion clamps first; it exists so a future change to
   * either side fails loudly instead of shipping an out-of-range temperature.
   */
  blockingIssues: string[];
}

export function resolveChamberAdvisory(ctx: ValueContext): ChamberAdvisory {
  const printer = ctx.printer;
  const s = suggestChamberTemp(ctx.material.id, printer);
  const label = 'Chamber temperature';
  const unit = '°C';

  const canHeat = printerCanHeatChamber(printer);

  let value = s.suggestedC;
  const blockingIssues: string[] = [];
  if (value !== undefined) {
    const errors = validateAgainstPrinter('chamberTemp', value, printer)
      .filter((i) => i.level === 'error');
    if (errors.length) {
      blockingIssues.push(...errors.map((i) => i.message));
      value = undefined;
    }
  }

  // A "leave it off" instruction is only worth showing when there is a heater to
  // leave off; a hot-chamber number is always worth showing.
  const actionable = value !== undefined && (s.advice === 'hot' || canHeat);

  const provenance = value === undefined
    ? 'unset'
    : s.advice === 'hot' && !s.clamped
      ? 'printer-default'
      : 'material-default';

  return {
    advice: s.advice,
    label,
    unit,
    value,
    display: value === undefined ? undefined : `${value} ${unit}`,
    provenance,
    explanation: s.headline,
    warnings: [...s.warnings, ...blockingIssues],
    actionable,
    blockingIssues
  };
}
