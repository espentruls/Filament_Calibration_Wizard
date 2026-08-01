// ---------------------------------------------------------------------------
// Optional steps in a project's plan.
//
// A project's `stepOrder` IS its plan: completion, the confidence score and the
// guided session all read it and nothing else. `DEFAULT_ORDER` is therefore not
// a menu of everything available — it is the set every project is born with, and
// adding to it would rewrite the plan of every project already saved (and drop
// every one of their confidence scores, since the score is computed over the
// project's own plan). Optional steps live outside it and are spliced in per
// project, on purpose.
//
// This module is the one place that splices, so the rule stays in one piece.
// ---------------------------------------------------------------------------

import { CALIBRATIONS, DEFAULT_ORDER } from '../data/calibrations';
import type { CalibrationId } from '../types';

/**
 * Where an optional step goes: immediately before final verification, which is
 * the step that checks everything else and so has to stay last.
 */
const ANCHOR: CalibrationId = 'final-verification';

/**
 * Every fully defined calibration that is NOT part of the default plan — the
 * steps a project can opt into. Derived, so a new optional calibration becomes
 * offerable by existing where it exists rather than by being listed twice.
 */
export function optionalStepIds(): CalibrationId[] {
  return (Object.keys(CALIBRATIONS) as CalibrationId[]).filter((id) => !DEFAULT_ORDER.includes(id));
}

/**
 * A copy of `plan` with `stepId` spliced in at its canonical position. Returns
 * an equal copy when the step is already there. Never mutates the input: the
 * caller may still cancel.
 */
export function withOptionalStep(plan: readonly CalibrationId[], stepId: CalibrationId): CalibrationId[] {
  const next = [...plan];
  if (next.includes(stepId)) return next;
  const at = next.indexOf(ANCHOR);
  next.splice(at === -1 ? next.length : at, 0, stepId);
  return next;
}

/** A copy of `plan` without `stepId`. Never mutates the input. */
export function withoutOptionalStep(plan: readonly CalibrationId[], stepId: CalibrationId): CalibrationId[] {
  return plan.filter((id) => id !== stepId);
}
