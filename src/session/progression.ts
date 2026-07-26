// ---------------------------------------------------------------------------
// Guided session — progression, blocking and staleness.
//
// Answers the three questions a guided flow has to answer at every moment:
// what can I start now, what is waiting on what, and what have I already done
// that a later change has undermined.
//
// Staleness reuses upstream's concept rather than inventing a parallel one. It
// has two halves, both already defined elsewhere:
//
//   * VALUE staleness — upstream's `inputFingerprintForStep` + `jobIsStale`,
//     comparing a prepared job against the working profile it was prepared from;
//   * RESULT staleness — a completed step whose dependency finished LATER, which
//     the project already expresses through `steps[id].completedAt`. Nothing new
//     is persisted for it.
//
// Plus the user's own "retest this later" flag, which the classic wizard already
// writes and `applyRetestFlags` already maintains.
// ---------------------------------------------------------------------------

import type { CalibrationId, ConfidenceLevel, StepStatus } from '../types';
import { CALIBRATIONS, DEFAULT_ORDER } from '../data/calibrations';
import {
  WORKFLOW_STEPS,
  inputFingerprintForStep,
  jobIsStale,
  normalizeNozzleIndex
} from '../automatedCalibration';
import { keysProducedBy, resolveStepValues, type ValueContext } from './values';
import type {
  SessionStep,
  StaleReason,
  StepBlocker,
  StepPhase,
  StepStaleness
} from './types';

// --- per-step record --------------------------------------------------------

export interface StepRecord {
  status: StepStatus;
  completedAt?: string;
  confidence?: ConfidenceLevel;
  retestRecommended: boolean;
}

/**
 * A step's recorded state for the session's nozzle.
 *
 * For the project's own nozzle this is simply `project.steps[id]` — the
 * authoritative record the classic wizard writes and the dashboard reads.
 *
 * For any OTHER nozzle the project's step states describe a different feed path
 * and must not be reused, so completion is derived from that nozzle's working
 * profile instead: a step counts as complete once every value it produces
 * carries a `calibration_result` provenance naming it. A step that produces no
 * value (the ooze-control checklist, the final verification print) cannot be
 * derived that way and stays not-started — an honest "unknown", not a guess.
 */
export function stepRecord(ctx: ValueContext, stepId: CalibrationId): StepRecord {
  if (ctx.ownsProjectResults) {
    const st = ctx.project.steps[stepId];
    return {
      status: st?.status ?? 'not-started',
      completedAt: st?.completedAt ?? st?.current?.completedAt,
      confidence: st?.confidence ?? st?.current?.confidence,
      retestRecommended: st?.retestRecommended === true
    };
  }
  const wp = ctx.workingProfile;
  const produced = keysProducedBy(stepId);
  if (!wp || produced.length === 0) return { status: 'not-started', retestRecommended: false };
  const stamps: string[] = [];
  for (const key of produced) {
    const prov = wp.provenance[key];
    if (!prov || prov.source !== 'calibration_result' || prov.stepId !== stepId) {
      // Companion values (a first-layer temperature, say) are optional, so a
      // missing one must not hold the step open — only the declared outputs do.
      if ((WORKFLOW_STEPS[stepId]?.produces ?? []).includes(key)) {
        return { status: 'not-started', retestRecommended: false };
      }
      continue;
    }
    stamps.push(prov.updatedAt);
  }
  if (!stamps.length) return { status: 'not-started', retestRecommended: false };
  return {
    status: 'completed',
    completedAt: stamps.sort()[stamps.length - 1],
    retestRecommended: false
  };
}

// --- staleness --------------------------------------------------------------

/**
 * Whether a completed step's result has been undermined since it was recorded.
 * Only completed steps can go stale; anything else returns `stale: false`.
 */
export function stepStaleness(ctx: ValueContext, stepId: CalibrationId): StepStaleness {
  const record = stepRecord(ctx, stepId);
  if (record.status !== 'completed') return { stale: false, reasons: [] };
  const reasons: StaleReason[] = [];

  // 1. A dependency was recalibrated after this step ran.
  const deps = WORKFLOW_STEPS[stepId]?.recalibrationDependsOn ?? [];
  for (const dep of deps) {
    const depRecord = stepRecord(ctx, dep);
    if (depRecord.status !== 'completed') continue;
    if (!depRecord.completedAt || !record.completedAt) continue;
    if (depRecord.completedAt > record.completedAt) {
      reasons.push({
        kind: 'dependency-recalibrated',
        stepId: dep,
        detail: `${CALIBRATIONS[dep].shortName} was recalibrated after this result was recorded, so this test ran under different conditions.`
      });
    }
  }

  // 2. Upstream's fingerprint rule: a prepared job whose consumed inputs no
  //    longer match the working profile it was prepared from.
  const jobs = ctx.project.generatedJobs ?? [];
  if (jobs.length) {
    const fingerprint = inputFingerprintForStep(ctx.workingProfile, stepId, ctx.nozzleIndex);
    for (const job of jobs) {
      if (job.stepId !== stepId) continue;
      if (normalizeNozzleIndex(job.nozzleIndex) !== ctx.nozzleIndex) continue;
      if (job.status === 'stale' || jobIsStale(job, fingerprint)) {
        reasons.push({
          kind: 'inputs-changed',
          detail: 'The prepared test for this step was built from values that have since changed.'
        });
        break;
      }
    }
  }

  // 3. The user's own flag, as the wizard and Smart Recommendations set it.
  if (record.retestRecommended) {
    reasons.push({
      kind: 'retest-flagged',
      detail: 'This result is flagged for a retest.'
    });
  }

  return { stale: reasons.length > 0, reasons };
}

// --- blocking ---------------------------------------------------------------

/**
 * Why a step cannot start. Two independent gates, both advisory to the UI:
 * a dependency STEP in this project's plan that has not run, and a required
 * input VALUE that is unknown. A skipped dependency whose value is known
 * anyway does not block — the value is what the test actually needs.
 */
export function stepBlockers(ctx: ValueContext, stepId: CalibrationId): StepBlocker[] {
  const out: StepBlocker[] = [];
  const plan = ctx.project.stepOrder ?? [];
  for (const dep of CALIBRATIONS[stepId]?.dependencies ?? []) {
    if (!plan.includes(dep)) continue;
    const record = stepRecord(ctx, dep);
    if (record.status === 'completed' || record.status === 'skipped') continue;
    out.push({
      kind: 'step',
      stepId: dep,
      reason: `${CALIBRATIONS[dep].shortName} has not been run yet.`
    });
  }
  const values = resolveStepValues(ctx, stepId);
  for (const key of values.missing) {
    const label = values.inherited.find((v) => v.key === key)?.label ?? key;
    out.push({
      kind: 'value',
      key,
      reason: `${label} is not known yet, and this test needs it to be meaningful.`
    });
  }
  return out;
}

// --- plan -------------------------------------------------------------------

function phaseFor(record: StepRecord, blockers: StepBlocker[], staleness: StepStaleness): StepPhase {
  if (record.status === 'skipped') return 'skipped';
  if (record.status === 'completed') return staleness.stale ? 'stale' : 'complete';
  if (record.status === 'in-progress') return 'in-progress';
  return blockers.length ? 'blocked' : 'ready';
}

/** Build the session's ordered plan from the project's own `stepOrder`. */
export function buildPlan(ctx: ValueContext): SessionStep[] {
  const plan = ctx.project.stepOrder ?? [];
  return plan
    .filter((id) => CALIBRATIONS[id] !== undefined)
    .map((id, i) => {
      const def = CALIBRATIONS[id];
      const record = stepRecord(ctx, id);
      const blockers = stepBlockers(ctx, id);
      const staleness = stepStaleness(ctx, id);
      const values = resolveStepValues(ctx, id);
      return {
        id,
        name: def.name,
        shortName: def.shortName,
        icon: def.icon,
        position: i + 1,
        status: record.status,
        phase: phaseFor(record, blockers, staleness),
        blockedBy: blockers,
        missingInputs: values.missing,
        produces: values.produces,
        staleness,
        retestRecommended: record.retestRecommended,
        confidence: record.confidence,
        completedAt: record.completedAt,
        optional: !DEFAULT_ORDER.includes(id),
        needsSlicing: WORKFLOW_STEPS[id]?.needsSlicing === true
      } satisfies SessionStep;
    });
}

// --- selectors --------------------------------------------------------------

export function firstWithPhase(plan: SessionStep[], phase: StepPhase): CalibrationId | null {
  return plan.find((s) => s.phase === phase)?.id ?? null;
}

/** The first step that can be started right now. */
export function nextActionable(plan: SessionStep[]): CalibrationId | null {
  return firstWithPhase(plan, 'ready');
}

/**
 * The step the guided UI should open: whatever is already underway, else the
 * next one that can start, else the oldest result that needs re-running, else
 * the first thing that is waiting on something.
 */
export function focusStep(plan: SessionStep[]): CalibrationId | null {
  return (
    firstWithPhase(plan, 'in-progress') ??
    firstWithPhase(plan, 'ready') ??
    firstWithPhase(plan, 'stale') ??
    firstWithPhase(plan, 'blocked')
  );
}

/** Completed / total over the project's own plan, 0–100. */
export function progressPercent(plan: SessionStep[]): number {
  if (!plan.length) return 0;
  const done = plan.filter((s) => s.status === 'completed').length;
  return Math.round((done / plan.length) * 100);
}
