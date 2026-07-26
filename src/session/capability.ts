// ---------------------------------------------------------------------------
// Guided session — the auto-preparation gate (progressive enhancement).
//
// ONE module answers one question: could this step, for this nozzle, in this
// project's slicer, be prepared automatically right now? Everything the guided
// screen shows about automation comes from here. (This file absorbed the former
// `engineAvailability.ts`: two gates that disagreed were worse than either.)
//
// The guided session runs on the MANUAL path: the user prints the slicer's own
// built-in test and enters what they see. That path works today — browser or
// desktop, no OrcaSlicer install, `automatedCalibration` off (its default).
// Automatic preparation is an ENHANCEMENT layered on top, never a requirement,
// so a "no" here costs the user nothing except a sentence explaining itself.
//
// Five rules shape it:
//
//   1. A "no" always carries a REASON with a stable code. Silently hiding an
//      affordance teaches the user nothing.
//
//   2. Some noes are PERMANENT and must not be dressed up as setup problems.
//      PerfectFit's engine layer drives OrcaSlicer and nothing else — Bambu
//      Studio is a hand-off destination by design, not a slicer we automate.
//      Telling a Bambu Studio user "no OrcaSlicer installation was found" would
//      send them installing software that still would not help. They get the
//      truth once, calmly, plus the thing PerfectFit DOES automate for them:
//      writing their calibrated values into a filament preset and installing it.
//
//   3. Nozzle honesty outranks convenience. If the printer has two nozzles and
//      the engine has not been SHOWN to slice for a chosen extruder, the answer
//      is no — with that reason. Quietly slicing the main nozzle's g-code for a
//      bowden auxiliary nozzle is the exact failure this product exists to
//      prevent, and a wrong "yes" here would cause it.
//
//   4. Probing an installation touches the filesystem, so it happens once per
//      session and is cached — never once per render. Concurrent askers share
//      one in-flight probe, and `peekSessionCapability` answers a render pass
//      synchronously from the cache.
//
//   5. Nothing here slices, prepares, or persists anything. The positive answer
//      is a typed hand-off and a full stop.
//
// Discovery itself is NOT reimplemented here: engines come from upstream's
// `discoverEngines` / `EngineNativeBridge`, and desktop detection is the same
// `window.__TAURI__` test the app already uses in `slicerIntegration/bridge.ts`
// (reached through the injectable bridge so tests never touch `window`).
//
// Slicer NAMES come from `src/data/slicers.ts`; every other sentence here
// describes PerfectFit's own state (flags, engines, nozzles, assets). No menu
// path, field name or slicer behaviour is ever written in this file.
// ---------------------------------------------------------------------------

import type { CalibrationId, SlicerId } from '../types';
import { CALIBRATIONS } from '../data/calibrations';
import { getSlicerContent } from '../data/slicers';
import type { ExperimentalFeatures } from '../slicerIntegration/types';
import {
  WORKFLOW_STEPS,
  discoverEngines,
  emptyEngineCapabilities,
  getAsset,
  inputFingerprintForStep,
  isAutomatedCalibrationEnabled,
  multiExtruderSupport,
  nativeEngineBridge,
  normalizeNozzleIndex,
  printerNozzleCount,
  resolveAsset,
  resourcesRootFromExe,
  type AssetType,
  type CapabilityResult,
  type EngineId,
  type EngineNativeBridge,
  type EngineStatus,
  type NozzleCountSource,
  type SlicingEngineCapabilities
} from '../automatedCalibration';
import type { ValueContext } from './values';
import type {
  ActionSeverity,
  CapabilityAlternative,
  CapabilityCode,
  CapabilityReason,
  SessionCapability,
  SessionNozzle
} from './types';

// --- what PerfectFit's engine layer actually drives --------------------------

/**
 * The slicers the automated pipeline can drive. This is upstream's deliberate
 * architecture, not an oversight and not a gap waiting to be filled: the engine
 * layer ships `managed_orca` / `installed_orca` engines plus `manual_export`,
 * and treats Bambu Studio as a hand-off destination rather than something to
 * automate (it declines to reverse-engineer its protocols).
 *
 * Kept as data so the honest answer and the shipped engines cannot drift apart.
 * Widen this list the moment an engine for another slicer exists, never before.
 */
export const AUTOMATABLE_SLICERS: readonly SlicerId[] = ['orca'];

/** Whether auto-preparation could EVER apply to this slicer. `undefined` means
 *  the caller did not name one, which is not the same as "no". */
export function slicerIsAutomatable(slicer: SlicerId | null | undefined): boolean {
  return slicer === undefined || slicer === null ? true : AUTOMATABLE_SLICERS.includes(slicer);
}

/** The shipped display name for a slicer. Falls back to the raw id rather than
 *  inventing a product name. */
function slicerLabel(slicer: SlicerId, version?: string): string {
  return getSlicerContent(slicer, version)?.slicerLabel ?? slicer;
}

// --- reasons ----------------------------------------------------------------

function reason(
  code: CapabilityCode,
  message: string,
  severity: ActionSeverity = 'info',
  permanent = false
): CapabilityReason {
  return { code, message, severity, permanent };
}

/**
 * The Bambu Studio answer (and any future slicer the engine layer does not
 * drive). Deliberately worded so it cannot be mistaken for a missing install or
 * a switch left off: there is nothing to fix, and the sentence says so.
 */
function notDrivenReason(slicer: SlicerId, version?: string): CapabilityReason {
  const label = slicerLabel(slicer, version);
  // Both product names come from the slicer data, so the panel cannot name the
  // same program two ways in two sentences.
  const driven = slicerLabel('orca');
  return reason(
    'slicer-not-driven',
    `PerfectFit's automatic test preparation drives ${driven} only — it does not slice through ${label}, by design rather than by omission, so no installation or setting switches it on. Every test in this session is printed from ${label} and measured by you.`,
    'info',
    true
  );
}

/** What PerfectFit automates instead, for a slicer it does not slice through. */
function presetAlternative(slicer: SlicerId, version?: string): CapabilityAlternative {
  const label = slicerLabel(slicer, version);
  return {
    kind: 'install-preset',
    title: `Install a calibrated ${label} preset`,
    detail: `What PerfectFit does automate for ${label} is the preset: once a value is measured it writes it into a filament preset for this nozzle and installs it, so nothing has to be typed in by hand.`
  };
}

// --- results ----------------------------------------------------------------

/** What the machine can do right now, for one nozzle. Step-independent. */
export interface EngineAvailability {
  /**
   * True only when a validated, slice-capable engine exists AND it can serve
   * this nozzle. Step-level questions add their own checks on top of this.
   */
  available: boolean;
  /** The slicer this answer was computed for, when the caller named one. */
  slicer: SlicerId | null;
  /**
   * False when PerfectFit's engine layer does not drive this slicer at all —
   * a permanent architectural answer, not a setup problem. See
   * `AUTOMATABLE_SLICERS`.
   */
  automatable: boolean;
  /** Whether the experimental `automatedCalibration` flag is on. */
  flagEnabled: boolean;
  /**
   * True only when the Tauri desktop shell was actually seen. With the flag off
   * (or the slicer not driven at all) nothing is probed, so it stays false —
   * "not known to be desktop" rather than a claim either way.
   */
  desktop: boolean;
  /** True when the engine registry was actually consulted for this answer. */
  probed: boolean;
  engineId: EngineId | null;
  engineName: string | null;
  engineVersion: string | null;
  /** `resources/` root of the detected install, for locating test models. */
  resourceRoot: string | null;
  capabilities: SlicingEngineCapabilities;
  nozzleIndex: number;
  /** Physical nozzles on this printer; 0 when the profile does not say. */
  nozzleCount: number;
  /** The engine's honest answer about THIS nozzle. */
  nozzleSupport: CapabilityResult;
  reasons: CapabilityReason[];
  /** What PerfectFit automates instead, when the answer is a permanent no. */
  alternative?: CapabilityAlternative;
  /** Upstream's own diagnostics notes, kept out of `reasons` to avoid repeats. */
  diagnosticWarnings: string[];
  /** Epoch ms of the probe this answer came from. */
  probedAt: number;
  /** True when served from the session cache — no filesystem was touched. */
  cached: boolean;
}

/** The per-step answer, derived purely from an availability. */
export interface StepAutoPrepareAnswer {
  stepId: CalibrationId;
  nozzleIndex: number;
  /** Offer an auto-prepare affordance only when this is true. */
  canAutoPrepare: boolean;
  engineId: EngineId | null;
  /** Non-empty in every case, positive or negative. */
  reasons: CapabilityReason[];
  /** The single line to show when there is only room for one. */
  headline: string;
  /** What PerfectFit automates instead, when the answer is a permanent no. */
  alternative?: CapabilityAlternative;
  /** The machine-level answer this was derived from. */
  availability: EngineAvailability;
}

export interface EngineAvailabilityInput {
  /** The session's slicer. Omitted means "not stated", never "not driven". */
  slicer?: SlicerId;
  /** The slicer version, only ever used to pick the shipped display name. */
  slicerVersion?: string;
  /** The printer being calibrated — read only for its nozzle count. */
  printer?: NozzleCountSource;
  /** Which physical nozzle the session targets. Defaults to 0. */
  nozzleIndex?: number;
  /** Explicit flags keep the call pure; omitted reads the persisted set. */
  features?: ExperimentalFeatures;
  /** Injectable native bridge, so tests never touch `window`. */
  bridge?: EngineNativeBridge;
  /** Cache lifetime in ms. Defaults to `ENGINE_PROBE_TTL_MS`. */
  maxAgeMs?: number;
  /** Ignore any cached answer and probe again (e.g. "I just installed Orca"). */
  refresh?: boolean;
  /** Injectable clock, for tests. */
  now?: number;
}

/** Extra knobs the guided screen may pass through to the gate. */
export interface CapabilityOptions {
  /** Pass explicit flags to keep the call pure; omitted reads the persisted set. */
  features?: ExperimentalFeatures;
  /** Injectable native bridge, so tests never touch `window`. */
  bridge?: EngineNativeBridge;
  /** Cache lifetime in ms. Defaults to `ENGINE_PROBE_TTL_MS`. */
  maxAgeMs?: number;
  /** Ignore any cached answer and probe again. */
  refresh?: boolean;
  /** Injectable clock, for tests. */
  now?: number;
}

/**
 * How long a probe stays fresh. Long enough that a screen full of steps and a
 * few navigations cost one filesystem probe; short enough that installing
 * OrcaSlicer mid-session is noticed without restarting the app. `refresh: true`
 * (or `invalidateEngineAvailability()`) short-circuits it.
 */
export const ENGINE_PROBE_TTL_MS = 5 * 60_000;

/**
 * Asset kinds the engine layer can actually turn into a sliceable project today
 * — `InstalledOrcaEngine.prepareProject` accepts a complete Orca project
 * template and rejects everything else (`UNSUPPORTED_ASSET`), because a bare
 * model still needs its test parameters generated.
 *
 * Kept here as data rather than assumed, so promising automation and being able
 * to deliver it cannot drift apart. Widen this list the moment the engine
 * widens, never before.
 */
export const PREPARABLE_ASSET_TYPES: AssetType[] = ['project-template'];

// --- session cache ----------------------------------------------------------

interface CacheEntry {
  at: number;
  value?: EngineAvailability;
  inFlight?: Promise<EngineAvailability>;
}

// Bridges are identified by an id from a WeakMap, so the cache itself never
// holds a bridge (or a window) alive, and two different fakes in two tests can
// never read each other's answers.
const BRIDGE_IDS = new WeakMap<EngineNativeBridge, string>();
let bridgeSeq = 0;
const CACHE = new Map<string, CacheEntry>();

function bridgeId(bridge: EngineNativeBridge): string {
  let id = BRIDGE_IDS.get(bridge);
  if (!id) {
    id = `bridge-${++bridgeSeq}`;
    BRIDGE_IDS.set(bridge, id);
  }
  return id;
}

/** Cache identity: the same bridge, nozzle and printer shape give the same
 *  answer. Neither the flag nor the slicer reaches the cache — both short-circuit
 *  before any probe, cost nothing to recompute, and must never outlive a change. */
function cacheKey(bridge: EngineNativeBridge, nozzleIndex: number, nozzleCount: number): string {
  return `${bridgeId(bridge)}|n${nozzleIndex}|of${nozzleCount}`;
}

/**
 * Drop cached probes. Call after the user installs a slicer, points PerfectFit
 * at an executable, or changes the automated-calibration flag. With no argument
 * every cached probe is dropped.
 */
export function invalidateEngineAvailability(bridge?: EngineNativeBridge): void {
  if (!bridge) {
    CACHE.clear();
    return;
  }
  const prefix = `${bridgeId(bridge)}|`;
  for (const key of [...CACHE.keys()]) if (key.startsWith(prefix)) CACHE.delete(key);
}

// --- the probe --------------------------------------------------------------

function readFlag(features?: ExperimentalFeatures): boolean {
  try {
    return isAutomatedCalibrationEnabled(features) === true;
  } catch {
    // Reading persisted flags cannot be allowed to break the guided session;
    // an unreadable flag is an off flag.
    return false;
  }
}

interface ProbeBase {
  slicer: SlicerId | null;
  automatable: boolean;
  flagEnabled: boolean;
  nozzleIndex: number;
  nozzleCount: number;
  probedAt: number;
}

function unavailable(
  base: ProbeBase,
  reasons: CapabilityReason[],
  extra: Partial<EngineAvailability> = {}
): EngineAvailability {
  return {
    available: false,
    slicer: base.slicer,
    automatable: base.automatable,
    flagEnabled: base.flagEnabled,
    desktop: false,
    probed: false,
    engineId: null,
    engineName: null,
    engineVersion: null,
    resourceRoot: null,
    capabilities: emptyEngineCapabilities(),
    nozzleIndex: base.nozzleIndex,
    nozzleCount: base.nozzleCount,
    nozzleSupport: { supported: false, reasons: reasons.map((r) => r.message) },
    reasons,
    diagnosticWarnings: [],
    probedAt: base.probedAt,
    cached: false,
    ...extra
  };
}

/**
 * The permanent "we do not drive this slicer" answer. Checked BEFORE the
 * feature flag on purpose: telling a Bambu Studio user that automated slicing
 * is switched off invites them to switch it on, which would change nothing.
 */
function notDrivenAnswer(base: ProbeBase, version?: string): EngineAvailability {
  const slicer = base.slicer as SlicerId;
  return unavailable(base, [notDrivenReason(slicer, version)], {
    alternative: presetAlternative(slicer, version)
  });
}

function flagOffAnswer(base: ProbeBase): EngineAvailability {
  return unavailable(base, [
    reason(
      'flag-off',
      'Automated slicing is switched off, so every test runs on the manual path — print the slicer\'s own test and enter what you see.'
    )
  ]);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function baseFor(input: EngineAvailabilityInput, now: number): ProbeBase {
  const slicer = input.slicer ?? null;
  return {
    slicer,
    automatable: slicerIsAutomatable(slicer),
    flagEnabled: false,
    nozzleIndex: normalizeNozzleIndex(input.nozzleIndex),
    nozzleCount: printerNozzleCount(input.printer),
    probedAt: now
  };
}

/**
 * The machine-level answer for one nozzle, cached per session.
 *
 * Short-circuits, in order: a slicer PerfectFit does not drive at all, then the
 * flag. Neither touches the bridge, reads the filesystem, or consults the cache
 * — and one of the two is the state of the app for nearly every user. Never
 * rejects: a failed probe resolves to a "no" carrying the failure.
 */
export function probeEngineAvailability(
  input: EngineAvailabilityInput = {}
): Promise<EngineAvailability> {
  const now = input.now ?? Date.now();
  const base = baseFor(input, now);

  if (!base.automatable) return Promise.resolve(notDrivenAnswer(base, input.slicerVersion));
  if (!readFlag(input.features)) return Promise.resolve(flagOffAnswer(base));

  const bridge = input.bridge ?? nativeEngineBridge;
  const key = cacheKey(bridge, base.nozzleIndex, base.nozzleCount);
  const maxAge = input.maxAgeMs ?? ENGINE_PROBE_TTL_MS;
  const entry = CACHE.get(key);

  if (!input.refresh && entry && now - entry.at <= maxAge) {
    if (entry.value) return Promise.resolve({ ...entry.value, cached: true });
    // A probe is already running for this nozzle: share it rather than starting
    // a second filesystem scan because two step tiles rendered at once.
    if (entry.inFlight) return entry.inFlight.then((value) => ({ ...value, cached: true }));
  }

  const inFlight = runProbe(bridge, input.printer, { ...base, flagEnabled: true })
    .then((value) => {
      // A failure is not an answer worth keeping: it says nothing about the
      // machine, so it is retried next time rather than cached for the session.
      if (value.reasons.some((r) => r.code === 'probe-failed')) CACHE.delete(key);
      else CACHE.set(key, { at: value.probedAt, value });
      return value;
    })
    .catch((err: unknown) => {
      // Defensive: runProbe is written not to reject. If it ever does, the cache
      // must not keep a poisoned promise around.
      CACHE.delete(key);
      return unavailable({ ...base, flagEnabled: true }, [
        reason('probe-failed', `Checking for a slicer failed, so this session stays on the manual path. (${errorText(err)})`, 'caution')
      ]);
    });

  CACHE.set(key, { at: now, inFlight });
  return inFlight;
}

/**
 * The cached answer, synchronously, for a render pass that must not await. The
 * two short-circuit answers (slicer not driven, flag off) always answer because
 * they cost nothing; otherwise this returns null when no fresh probe exists yet
 * — render the manual path and let `probeEngineAvailability` fill it in.
 */
export function peekEngineAvailability(
  input: EngineAvailabilityInput = {}
): EngineAvailability | null {
  const now = input.now ?? Date.now();
  const base = baseFor(input, now);

  if (!base.automatable) return notDrivenAnswer(base, input.slicerVersion);
  if (!readFlag(input.features)) return flagOffAnswer(base);

  const bridge = input.bridge ?? nativeEngineBridge;
  const entry = CACHE.get(cacheKey(bridge, base.nozzleIndex, base.nozzleCount));
  const maxAge = input.maxAgeMs ?? ENGINE_PROBE_TTL_MS;
  if (!entry?.value || now - entry.at > maxAge) return null;
  return { ...entry.value, cached: true };
}

/** True when the engine is the kind that actually slices (manual export is the
 *  manual path wearing an engine's clothes, not automation). */
function isSlicingEngine(status: EngineStatus): boolean {
  return status.engineId !== 'manual_export';
}

async function runProbe(
  bridge: EngineNativeBridge,
  printer: NozzleCountSource | undefined,
  base: ProbeBase
): Promise<EngineAvailability> {
  const { nozzleIndex, nozzleCount } = base;

  let desktop = false;
  try {
    desktop = bridge.isDesktop() === true;
  } catch (err) {
    return unavailable(base, [
      reason(
        'probe-failed',
        `PerfectFit could not tell whether it is running on the desktop, so this session stays on the manual path. (${errorText(err)})`,
        'caution'
      )
    ]);
  }

  if (!desktop) {
    return unavailable(
      base,
      [
        reason(
          'not-desktop',
          'Automated slicing needs the PerfectFit desktop app. In the browser every test runs on the manual path, which needs no slicer installation.'
        )
      ],
      { nozzleSupport: multiExtruderSupport(null, printer, nozzleIndex) }
    );
  }

  let engines: EngineStatus[];
  let diagnosticWarnings: string[];
  try {
    const diagnostics = await discoverEngines(bridge, { printer, nozzleIndex });
    engines = diagnostics.engines;
    diagnosticWarnings = diagnostics.warnings;
  } catch (err) {
    return unavailable(
      base,
      [
        reason(
          'probe-failed',
          `Looking for an installed slicer failed, so this session stays on the manual path. (${errorText(err)})`,
          'caution'
        )
      ],
      { desktop: true }
    );
  }

  const candidates = engines.filter(isSlicingEngine);
  const usable = candidates.find((e) => e.detected && e.valid && e.capabilities.slice);

  if (!usable) {
    const found = candidates.find((e) => e.detected);
    const detail = found ? [...found.errors, ...found.warnings].join(' ').trim() : '';
    let noEngine: CapabilityReason;
    if (!found) {
      noEngine = reason(
        'no-engine',
        `No ${slicerLabel('orca')} installation was found, so this session stays on the manual path — print the slicer's own test and enter what you see.`
      );
    } else if (found.valid) {
      // Present and sound, but it does not claim it can slice. Believing it
      // anyway is how a "prepared" test turns out to be nothing at all.
      noEngine = reason(
        'engine-unusable',
        `${found.displayName} was found but does not report that it can slice a project, so this session stays on the manual path.${detail ? ` ${detail}` : ''}`,
        'caution'
      );
    } else {
      noEngine = reason(
        'engine-unusable',
        `${found.displayName} was found but could not be validated, so this session stays on the manual path.${detail ? ` ${detail}` : ''}`,
        'caution'
      );
    }
    return unavailable(base, [noEngine], {
      desktop: true,
      probed: true,
      diagnosticWarnings,
      nozzleSupport: multiExtruderSupport(null, printer, nozzleIndex)
    });
  }

  const nozzleSupport =
    usable.nozzleSupport ?? multiExtruderSupport(usable.capabilities, printer, nozzleIndex);
  const resourceRoot = usable.executablePath ? resourcesRootFromExe(usable.executablePath) : null;

  const found: Partial<EngineAvailability> = {
    desktop: true,
    probed: true,
    engineId: usable.engineId,
    engineName: usable.displayName,
    engineVersion: usable.version,
    resourceRoot,
    capabilities: usable.capabilities,
    nozzleSupport,
    diagnosticWarnings
  };

  if (!nozzleSupport.supported) {
    return unavailable(base, [nozzleReason(usable.displayName, nozzleIndex, nozzleCount, nozzleSupport)], found);
  }

  return {
    ...unavailable(base, [], found),
    available: true,
    reasons: [
      reason(
        'available',
        `${usable.displayName} is installed and can prepare tests for nozzle ${nozzleIndex + 1}.`
      )
    ]
  };
}

/**
 * The nozzle "no", worded for the case that actually bites: a machine with a
 * second, differently-fed nozzle. The engine's own sentence is carried through
 * rather than paraphrased, so an out-of-range nozzle and an engine that simply
 * cannot target one read as the different problems they are.
 */
function nozzleReason(
  engineName: string,
  nozzleIndex: number,
  nozzleCount: number,
  support: CapabilityResult
): CapabilityReason {
  const detail = support.reasons.join(' ').trim();
  if (nozzleCount > 0 && nozzleIndex >= nozzleCount) {
    return reason('nozzle-unsupported', detail || `Nozzle ${nozzleIndex + 1} is not on this printer.`);
  }
  const head =
    nozzleCount > 1
      ? `This printer has ${nozzleCount} nozzles and ${engineName} has not been shown to slice for a chosen one, so nozzle ${nozzleIndex + 1} stays on the manual path.`
      : `${engineName} cannot prepare a test for nozzle ${nozzleIndex + 1}, so it stays on the manual path.`;
  return reason('nozzle-unsupported', detail ? `${head} ${detail}` : head);
}

// --- per-step answers -------------------------------------------------------

function stepName(stepId: CalibrationId): string {
  return CALIBRATIONS[stepId]?.shortName ?? stepId;
}

function answer(
  availability: EngineAvailability,
  stepId: CalibrationId,
  canAutoPrepare: boolean,
  reasons: CapabilityReason[]
): StepAutoPrepareAnswer {
  const list = reasons.length
    ? reasons
    : [reason('probe-failed', 'PerfectFit could not work out whether this test can be prepared automatically, so it stays on the manual path.', 'caution')];
  return {
    stepId,
    nozzleIndex: availability.nozzleIndex,
    canAutoPrepare,
    engineId: canAutoPrepare ? availability.engineId : null,
    reasons: list,
    headline: list[0].message,
    alternative: availability.alternative,
    availability
  };
}

/**
 * Derive one step's answer from an already-probed availability. Pure and
 * synchronous: a plan screen probes ONCE and derives an answer per step.
 *
 * Layered from the cheapest, most decisive check outward — the slicer, the flag,
 * then whether the step is even a test print, then the machine, then what this
 * particular test needs from the engine.
 */
export function stepAutoPrepareFrom(
  availability: EngineAvailability,
  stepId: CalibrationId
): StepAutoPrepareAnswer {
  const no = (reasons: CapabilityReason[]): StepAutoPrepareAnswer =>
    answer(availability, stepId, false, reasons);

  // The two short-circuits answer for every step at once, with the sentence the
  // probe already chose (the slicer outranks the flag there). Both are the same
  // statement whatever the step is, and a per-step variation of "we do not drive
  // this slicer" would turn one calm sentence into a drumbeat.
  if (!availability.automatable || !availability.flagEnabled) return no(availability.reasons);

  const definition = WORKFLOW_STEPS[stepId];
  if (!definition) {
    return no([
      reason('step-unsupported', `PerfectFit has no automated workflow entry for "${stepId}", so it stays on the manual path.`, 'caution')
    ]);
  }

  if (!definition.needsSlicing) {
    return no([
      reason(
        'step-not-sliced',
        `${stepName(stepId)} is a checklist against the slicer and printer rather than a sliced test print, so there is nothing to prepare automatically.`,
        'info',
        true
      )
    ]);
  }

  if (!availability.available) return no(availability.reasons);

  const engineName = availability.engineName ?? 'The detected engine';

  // A test that cannot become g-code cannot be printed, whatever else the engine
  // reports it can do.
  if (!availability.capabilities.exportGcode) {
    return no([
      reason(
        'step-unsupported',
        `${stepName(stepId)} has to be sliced to g-code, and ${engineName} does not report that it can export g-code — so this test stays on the manual path.`
      )
    ]);
  }

  const asset = getAsset(stepId);
  if (!asset) {
    return no([
      reason(
        'step-unsupported',
        `PerfectFit has no test model registered for ${stepName(stepId).toLowerCase()}, so this test stays on the manual path.`
      )
    ]);
  }

  if (!PREPARABLE_ASSET_TYPES.includes(asset.assetType)) {
    return no([
      reason(
        'step-unsupported',
        `${stepName(stepId)} needs its test parameters generated into the model, which ${engineName} cannot do yet — so this test stays on the manual path.`
      )
    ]);
  }

  const required = asset.compatibility?.requiredSlicerFeatures ?? [];
  if (required.length) {
    return no([
      reason(
        'step-unsupported',
        `${stepName(stepId)} needs slicer features ${engineName} has not been shown to have (${required.join(', ')}), so this test stays on the manual path.`
      )
    ]);
  }

  const resolution = resolveAsset(stepId, {
    slicerResourceRoot: availability.resourceRoot ?? undefined
  });
  if (!resolution.available) {
    return no([
      reason(
        'asset-unavailable',
        resolution.remedy ??
          `PerfectFit could not find the test model for ${stepName(stepId).toLowerCase()} in an allowed location, so this test stays on the manual path.`
      )
    ]);
  }

  return answer(availability, stepId, true, [
    reason('available', `${engineName} can prepare the ${stepName(stepId).toLowerCase()} test for nozzle ${availability.nozzleIndex + 1}.`)
  ]);
}

/**
 * "Can this step be auto-prepared right now?" — the machine-level call, for
 * callers that have no session in hand. Probes once per session (see the cache)
 * and never throws.
 */
export async function canAutoPrepareStep(
  stepId: CalibrationId,
  input: EngineAvailabilityInput = {}
): Promise<StepAutoPrepareAnswer> {
  return stepAutoPrepareFrom(await probeEngineAvailability(input), stepId);
}

/** The same answer for a whole plan, from a single probe. */
export async function canAutoPrepareSteps(
  stepIds: CalibrationId[],
  input: EngineAvailabilityInput = {}
): Promise<StepAutoPrepareAnswer[]> {
  const availability = await probeEngineAvailability(input);
  return stepIds.map((id) => stepAutoPrepareFrom(availability, id));
}

// --- the session-shaped gate (what the guided screen calls) -----------------

function inputFor(
  ctx: ValueContext,
  nozzle: SessionNozzle,
  opts: CapabilityOptions
): EngineAvailabilityInput {
  return {
    slicer: ctx.project.slicer.slicer,
    slicerVersion: ctx.project.slicer.version,
    printer: ctx.printer,
    nozzleIndex: nozzle.index,
    features: opts.features,
    bridge: opts.bridge,
    maxAgeMs: opts.maxAgeMs,
    refresh: opts.refresh,
    now: opts.now
  };
}

/** Dress a step answer in the session's own vocabulary, adding the typed
 *  hand-off — and only ever adding it when the answer is genuinely yes. */
function sessionCapabilityFrom(
  ctx: ValueContext,
  nozzle: SessionNozzle,
  stepId: CalibrationId,
  step: StepAutoPrepareAnswer
): SessionCapability {
  const a = step.availability;
  const engineId = step.engineId;
  const can = step.canAutoPrepare && engineId !== null;

  return {
    stepId,
    nozzleIndex: nozzle.index,
    mode: can ? 'assisted' : 'manual',
    manualPathAvailable: true,
    canAutoPrepare: can,
    engineId: can ? engineId : null,
    flagEnabled: a.flagEnabled,
    desktop: a.desktop,
    automatable: a.automatable,
    // Only report a nozzle verdict an engine actually gave: with the flag off,
    // or a slicer PerfectFit does not drive, no engine was ever asked.
    nozzleSupport: a.probed ? a.nozzleSupport : undefined,
    reasons: step.reasons.map((r) => r.message),
    reasonDetails: step.reasons,
    headline: step.headline,
    alternative: step.alternative,
    handoff: can
      ? {
        engineId: engineId as EngineId,
        projectId: ctx.project.id,
        stepId,
        nozzleIndex: nozzle.index,
        inputFingerprint: inputFingerprintForStep(ctx.workingProfile, stepId, nozzle.index)
      }
      : null
  };
}

/**
 * Resolve whether this step can be auto-prepared for this nozzle right now.
 *
 * The slicer and the flag are checked FIRST and short-circuit: for a slicer
 * PerfectFit does not drive, or with automated calibration off, nothing probes
 * for engines and nothing touches the native bridge. Otherwise the probe behind
 * this is cached per session, so calling it once per render costs one
 * filesystem scan, not one per draw.
 */
export async function resolveSessionCapability(
  ctx: ValueContext,
  nozzle: SessionNozzle,
  stepId: CalibrationId,
  opts: CapabilityOptions = {}
): Promise<SessionCapability> {
  const availability = await probeEngineAvailability(inputFor(ctx, nozzle, opts));
  return sessionCapabilityFrom(ctx, nozzle, stepId, stepAutoPrepareFrom(availability, stepId));
}

/**
 * The same answer synchronously, for a render pass that must not await. Returns
 * null only when an engine probe is genuinely needed and has not run yet —
 * draw the manual path, then call `resolveSessionCapability` and redraw.
 */
export function peekSessionCapability(
  ctx: ValueContext,
  nozzle: SessionNozzle,
  stepId: CalibrationId,
  opts: CapabilityOptions = {}
): SessionCapability | null {
  const availability = peekEngineAvailability(inputFor(ctx, nozzle, opts));
  if (!availability) return null;
  return sessionCapabilityFrom(ctx, nozzle, stepId, stepAutoPrepareFrom(availability, stepId));
}
