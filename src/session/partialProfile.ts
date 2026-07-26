// ---------------------------------------------------------------------------
// Guided session — partial profile report.
//
// A user very often wants temperature and flow locked into a real slicer preset
// before they go anywhere near pressure advance. That is not a compromise, it is
// how calibration is actually done over an evening, so the session has to be
// able to say — at any moment — exactly which values are measured, which are
// still open, and whether there is enough to install something useful.
//
// Only MEASURED values are reported. A material default or a carried base value
// is not a calibration result and must never be installed as if it were one.
// ---------------------------------------------------------------------------

import type { CalibrationId } from '../types';
import { CALIBRATIONS } from '../data/calibrations';
import { confidenceScore } from '../logic/confidence';
import type { NormalizedProfileKey } from '../automatedCalibration';
import { keysProducedBy, resolveValue, CANONICAL_KEYS, type ValueContext } from './values';
import { stepRecord } from './progression';
import type { PartialProfileReport, ResolvedValue, SessionNozzle } from './types';

/** "a", "a and b", "a, b and c" — sentence-case list joining. */
function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Labels read mid-sentence, so drop the leading capital of ordinary words. */
function midSentence(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? label[0].toLowerCase() + label.slice(1) : label;
}

/**
 * Which calibrated values exist for this nozzle right now, and what is missing.
 */
export function partialProfile(ctx: ValueContext, nozzle: SessionNozzle): PartialProfileReport {
  const plan = (ctx.project.stepOrder ?? []).filter((id) => CALIBRATIONS[id] !== undefined);

  const values: ResolvedValue[] = [];
  for (const key of CANONICAL_KEYS) {
    const resolved = resolveValue(ctx, key, false);
    if (resolved.provenance === 'calibrated') values.push(resolved);
  }
  const calibratedKeys = values.map((v) => v.key);
  const calibrated = new Set<NormalizedProfileKey>(calibratedKeys);

  const completedSteps: CalibrationId[] = [];
  const remainingSteps: CalibrationId[] = [];
  const missing = new Set<NormalizedProfileKey>();
  const everything = new Set<NormalizedProfileKey>();
  for (const id of plan) {
    const record = stepRecord(ctx, id);
    for (const key of keysProducedBy(id)) everything.add(key);
    if (record.status === 'completed') {
      completedSteps.push(id);
      continue;
    }
    if (record.status !== 'skipped') remainingSteps.push(id);
    for (const key of keysProducedBy(id)) {
      if (!calibrated.has(key)) missing.add(key);
    }
  }
  const missingKeys = CANONICAL_KEYS.filter((k) => missing.has(k));

  const complete = [...everything].every((k) => calibrated.has(k));
  const installable = values.length > 0;

  const have = joinList(values.map((v) => midSentence(v.label)));
  const open = joinList(missingKeys.map((k) => midSentence(resolveValue(ctx, k, false).label)));
  const summary = !installable
    ? `Nothing is measured yet on ${nozzle.label}.`
    : complete
      ? `Every value this plan produces is measured on ${nozzle.label}: ${have}.`
      : `Measured on ${nozzle.label}: ${have}. Still open: ${open}.`;

  return {
    nozzleIndex: ctx.nozzleIndex,
    values,
    calibratedKeys,
    missingKeys,
    completedSteps,
    remainingSteps,
    installable,
    complete,
    // The app's existing confidence score describes the project, which records
    // exactly one nozzle — so it is only meaningful for that nozzle.
    confidence: ctx.ownsProjectResults ? confidenceScore(ctx.project).score : undefined,
    summary
  };
}
