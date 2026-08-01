import type {
  CompatibilityEvidence, CompatibilityLevel, CompatibilityOverrideRecord, CompatibilityVerdict,
  ExtruderType, MaterialPreset, PrinterProfile
} from '../types';

export interface ValidationIssue {
  level: 'error' | 'warning';
  message: string;
}

export function validateNumber(value: unknown, opts: {
  label: string; min?: number; max?: number; integer?: boolean; required?: boolean;
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { label, min, max, integer, required = true } = opts;
  if (value === '' || value === null || value === undefined) {
    if (required) issues.push({ level: 'error', message: `${label} is required.` });
    return issues;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    issues.push({ level: 'error', message: `${label} must be a number.` });
    return issues;
  }
  if (integer && !Number.isInteger(n)) issues.push({ level: 'error', message: `${label} must be a whole number.` });
  if (min !== undefined && n < min) issues.push({ level: 'error', message: `${label} must be at least ${min}.` });
  if (max !== undefined && n > max) issues.push({ level: 'error', message: `${label} must be at most ${max}.` });
  return issues;
}

export function validateTestRange(start: number, end: number, step: number, opts?: { maxSamples?: number; label?: string }): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const label = opts?.label ?? 'Range';
  if (![start, end, step].every(Number.isFinite)) {
    issues.push({ level: 'error', message: `${label}: start, end and step must all be numbers.` });
    return issues;
  }
  if (step === 0) { issues.push({ level: 'error', message: `${label}: step cannot be zero (division by zero).` }); return issues; }
  if (step < 0) issues.push({ level: 'error', message: `${label}: enter the step as a positive number; direction comes from start/end.` });
  if (start === end) issues.push({ level: 'error', message: `${label}: start and end are equal — there is nothing to test.` });
  const samples = Math.floor(Math.abs(end - start) / Math.abs(step) + 1e-9) + 1; // same epsilon as generateRange
  const maxSamples = opts?.maxSamples ?? 100;
  if (samples > maxSamples) issues.push({ level: 'error', message: `${label}: ${samples} samples is too many for one print. Increase the step or narrow the range.` });
  else if (samples < 3) issues.push({ level: 'warning', message: `${label}: only ${samples} samples — consider a wider range or smaller step for a meaningful comparison.` });
  return issues;
}

/**
 * Check a value against the machine that will execute it.
 *
 * Chamber temperature is in the same union as nozzle and bed on purpose: it is a
 * temperature the printer physically holds, so anything the app suggests or
 * displays goes through the same gate rather than a parallel one. Its limit is
 * the only OPTIONAL one — `maxChamberTemp` is absent on every profile that never
 * learned it, and absent means "not stated", never "zero".
 */
export function validateAgainstPrinter(kind: 'nozzleTemp' | 'bedTemp' | 'mvs' | 'chamberTemp', value: number, printer: PrinterProfile | undefined): ValidationIssue[] {
  if (!printer) return [];
  const issues: ValidationIssue[] = [];
  if (kind === 'chamberTemp') {
    const limit = printer.maxChamberTemp;
    if (typeof limit === 'number' && Number.isFinite(limit) && value > limit) {
      issues.push({ level: 'error', message: `${value} °C exceeds this printer's max chamber temperature (${limit} °C).` });
    } else if (printer.heatedChamber === false && value > 0) {
      issues.push({ level: 'warning', message: `This printer profile has no heated chamber, so ${value} °C cannot be held. A passive enclosure still reduces warping.` });
    }
    return issues;
  }
  if (kind === 'nozzleTemp' && value > printer.maxNozzleTemp) {
    issues.push({ level: 'error', message: `${value} °C exceeds this printer's max nozzle temperature (${printer.maxNozzleTemp} °C). Printing hotter than the rating can destroy the hotend or release fumes.` });
  }
  if (kind === 'bedTemp' && value > printer.maxBedTemp) {
    issues.push({ level: 'error', message: `${value} °C exceeds this printer's max bed temperature (${printer.maxBedTemp} °C).` });
  }
  if (kind === 'mvs' && printer.maxVolumetricFlow && printer.maxVolumetricFlow > 0 && value > printer.maxVolumetricFlow) {
    issues.push({ level: 'warning', message: `${value} mm³/s is above the printer profile's rated max flow (${printer.maxVolumetricFlow} mm³/s). The app will not recommend a final value above the printer's limit.` });
  }
  return issues;
}

/** Flow ratio sanity: decimal near 1, never a percentage. */
export function validateFlowRatio(value: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!Number.isFinite(value) || value <= 0) {
    issues.push({ level: 'error', message: 'Flow ratio must be a positive number.' });
  } else if (value > 2) {
    issues.push({ level: 'error', message: `${value} looks like a percentage. Orca and Bambu Studio use a decimal — enter ${(value / 100).toFixed(2)} instead of ${value}.` });
  } else if (value < 0.7 || value > 1.3) {
    issues.push({ level: 'warning', message: 'Flow ratios outside 0.70–1.30 are very unusual — double-check the value.' });
  }
  return issues;
}

// ===========================================================================
// Nozzle / filament compatibility
// ===========================================================================
//
// Some filaments do not belong on some nozzles. On the machine this fork exists
// for, the auxiliary nozzle is bowden-fed and the vendor's own preset library
// marks flexibles as unusable there and several other materials as merely
// tolerated. Trim reads that out of the installed presets rather than
// carrying a list of its own, because a list goes stale the moment the vendor
// ships a new bundle and because a list cannot explain itself.
//
// Three rules govern everything below.
//
//   1. NOTHING HERE BLOCKS. Every verdict is a warning with an override; the
//      person who owns the printer is the authority on the printer. The one
//      thing the app insists on is that an override is RECORDED, so a report
//      written later cannot read as if the app had approved the combination.
//
//   2. SILENCE IS NOT APPROVAL. A preset that carries no compatibility record
//      resolves to 'unknown', never to 'clear'. Bambu annotates only its own
//      branded presets, so a Generic preset — which is what most people
//      actually calibrate — says nothing at all. Reading that as an all-clear
//      would be the app inventing a fact.
//
//   3. A VALUE SLOT IS NOT A NOZZLE. Every key read here is indexed by the
//      PHYSICAL extruder index (`nozzle_diameter` / `extruder_type` position),
//      never by a position in a filament preset's value array. A single-nozzle
//      machine can present three value slots — they are hotend variants of one
//      nozzle. See `machineNozzleCount` and `nozzleTopology`.
//
// The mechanisms, all verified against a real Bambu Studio bundle:
//
//   Gate A  extruder_variant_list (machine) ∩ filament_extruder_variant (preset)
//   Gate B  filament_printable — bitmask over the 0-based extruder index
//   Gate C  filament_extruder_compatibility — 3 bits per extruder:
//             0 printable · 1 error · 2 critical warning · 3 warning
//   Gate D  unprintable_filament_types (machine) — per extruder, by TYPE
//
// No single gate is sufficient: on the X2D, TPU passes Gate A (its legend does
// contain bowden slots) and is caught only by Gate B. On the H2C, Generic TPU
// passes Gate A on both nozzles and is caught only by Gates B and D.
// ---------------------------------------------------------------------------

/** Severity order. Higher wins. `clear` is the floor, `unknown` sits above it. */
export function compatibilityRank(level: CompatibilityLevel): number {
  switch (level) {
    case 'blocked': return 4;
    case 'critical': return 3;
    case 'caution': return 2;
    case 'unknown': return 1;
    case 'clear': return 0;
  }
}

// --- reading the installed presets ------------------------------------------
// Bambu writes every value as a STRING inside an array, integers included, so
// each reader parses defensively and returns "absent" rather than a guess. A
// key that is missing, malformed, or the literal "nil" is simply not read.

function record(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : null;
}

function strings(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/** First entry of a Bambu string-array integer key, or undefined. */
function firstInt(v: unknown): number | undefined {
  const s = strings(v)[0] ?? (typeof v === 'number' ? String(v) : undefined);
  if (s === undefined) return undefined;
  const n = Number.parseInt(s.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Machine-preset facts. Every array is indexed by PHYSICAL extruder. */
export interface MachinePresetFacts {
  /** `extruder_type`, e.g. ['Direct Drive', 'Bowden']. */
  extruderTypes: string[];
  /** `extruder_variant_list` — one comma-joined legend per physical extruder. */
  extruderVariantList: string[];
  /** `unprintable_filament_types` — comma-joined filament types per extruder. */
  unprintableFilamentTypes: string[];
  /** `nozzle_diameter` — the ONLY sound source of the physical nozzle count. */
  nozzleDiameters: string[];
}

export function readMachinePresetFacts(raw: unknown): MachinePresetFacts {
  const r = record(raw);
  return {
    extruderTypes: strings(r?.extruder_type),
    extruderVariantList: strings(r?.extruder_variant_list),
    unprintableFilamentTypes: strings(r?.unprintable_filament_types),
    nozzleDiameters: strings(r?.nozzle_diameter)
  };
}

/**
 * Physical nozzles on a machine preset, or undefined when it does not say.
 *
 * `nozzle_diameter` length == `extruder_type` length == `extruder_variant_list`
 * length == physical nozzle count. The width of any filament VALUE array says
 * nothing about it: a P2S presents three value slots on one physical nozzle.
 */
export function machineNozzleCount(facts: MachinePresetFacts | undefined): number | undefined {
  const n = facts?.nozzleDiameters.length ?? 0;
  if (n > 0) return n;
  const alt = facts?.extruderTypes.length ?? 0;
  return alt > 0 ? alt : undefined;
}

/** Filament-preset facts, as declared by the preset itself. */
export interface FilamentPresetFacts {
  name: string | null;
  filamentType: string | null;
  vendor: string | null;
  /** `filament_printable` bitmask over the 0-based extruder index. */
  printableMask: number | undefined;
  /** `filament_extruder_compatibility`, 3 bits per extruder. */
  extruderCompatibility: number | undefined;
  /** `filament_extruder_variant` — this preset's own slot legend. */
  extruderVariants: string[];
  /**
   * True when the preset carries a compatibility record at all. Level 0 means
   * "printable" ONLY when this is true; otherwise it means "never annotated",
   * which is not the same thing and must not be reported as an all-clear.
   */
  annotated: boolean;
  /**
   * The ancestor preset the compatibility keys were actually read from, when
   * this preset inherited rather than declared them. Null when it declared them
   * itself — the user is entitled to know which file was read.
   */
  inheritedFrom: string | null;
  /**
   * The nearest name in the inheritance chain of the "Vendor Material @Scope"
   * shape. A user's own clone is usually named freely ("Generic ABS Flow Rate
   * Calibrated"), which cannot be matched against a vendor library; its parent
   * can.
   */
  scopedName: string | null;
}

export function readFilamentPresetFacts(raw: unknown, fallbackName?: string): FilamentPresetFacts {
  const r = record(raw);
  const compat = firstInt(r?.filament_extruder_compatibility);
  const name = (typeof r?.name === 'string' ? r.name : null) ?? fallbackName ?? null;
  return {
    name,
    filamentType: strings(r?.filament_type)[0] ?? null,
    vendor: strings(r?.filament_vendor)[0] ?? null,
    printableMask: firstInt(r?.filament_printable),
    extruderCompatibility: compat,
    extruderVariants: strings(r?.filament_extruder_variant),
    annotated: compat !== undefined,
    inheritedFrom: null,
    scopedName: name && splitPresetName(name) ? name : null
  };
}

/** One preset in an `inherits` chain, as the scanner already gives them to us. */
export interface FilamentPresetChainNode {
  name: string;
  raw: unknown;
  parentName?: string | null;
}

/**
 * Facts resolved through the preset's `inherits` chain, first declaration wins.
 *
 * Necessary, not decorative: the preset a user actually calibrates is nearly
 * always a delta. The owner's own "Generic ABS Flow Rate Calibrated" declares a
 * slot legend and a flow ratio and nothing else — every compatibility key it
 * has comes from "Generic ABS @BBL X2D 0.4 nozzle" above it. Reading only the
 * declared keys would report "unknown" for a preset whose parent says plenty.
 *
 * The walk is depth-limited and cycle-guarded: a malformed `inherits` loop in a
 * scanned library must not hang the New Project screen.
 */
export function resolveFilamentPresetFacts(
  start: FilamentPresetChainNode,
  lookup: (name: string) => FilamentPresetChainNode | undefined,
  maxDepth = 12
): FilamentPresetFacts {
  let facts = readFilamentPresetFacts(start.raw, start.name);
  let node: FilamentPresetChainNode = start;
  const seen = new Set<string>([start.name]);
  for (let depth = 0; depth < maxDepth; depth++) {
    const parentName = node.parentName ?? null;
    if (!parentName || seen.has(parentName)) break;
    const parent = lookup(parentName);
    if (!parent) break;
    seen.add(parentName);
    const p = readFilamentPresetFacts(parent.raw, parent.name);
    if (facts.filamentType === null && p.filamentType !== null) facts.filamentType = p.filamentType;
    if (facts.vendor === null && p.vendor !== null) facts.vendor = p.vendor;
    if (!facts.extruderVariants.length && p.extruderVariants.length) facts.extruderVariants = p.extruderVariants;
    if (facts.printableMask === undefined && p.printableMask !== undefined) {
      facts.printableMask = p.printableMask;
      facts.inheritedFrom = facts.inheritedFrom ?? parent.name;
    }
    if (!facts.annotated && p.annotated) {
      facts.extruderCompatibility = p.extruderCompatibility;
      facts.annotated = true;
      facts.inheritedFrom = facts.inheritedFrom ?? parent.name;
    }
    if (facts.scopedName === null && p.scopedName !== null) facts.scopedName = p.scopedName;
    node = parent;
  }
  return facts;
}

/**
 * The compatibility level a `filament_extruder_compatibility` value declares for
 * one extruder: 0 printable · 1 error · 2 critical warning · 3 warning.
 */
export function decodeExtruderCompatibility(value: number, extruderIndex: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (!Number.isInteger(extruderIndex) || extruderIndex < 0 || extruderIndex > 9) return 0;
  return (value >>> (3 * extruderIndex)) & 0x7;
}

// --- the vendor-annotated sibling advisory ----------------------------------
// The gap this closes is the owner's own situation: their Generic ABS preset
// carries no compatibility record, so the four gates find nothing to read,
// while the vendor's own ABS preset for the same printer marks the auxiliary
// nozzle as "not recommended". Staying silent there answers the user's question
// with nothing; asserting it as fact would misreport whose preset it came from.
// So it is raised as an ADVISORY that names both presets and can never reach
// 'blocked'.

export interface PresetNameParts {
  /** The leading vendor token, e.g. "Generic" or "Bambu". */
  vendor: string;
  /** The material label between vendor and scope, e.g. "PLA Silk". */
  label: string;
  /** The `@…` scope suffix, e.g. "BBL X2D 0.4 nozzle". */
  scope: string;
}

/**
 * Split "Generic PLA Silk @BBL X2D 0.4 nozzle" into its three parts, or null
 * when the name is not of that shape. Deliberately exact: no fuzzy matching,
 * because the whole point is to link two specific presets by name.
 */
export function splitPresetName(name: string): PresetNameParts | null {
  const at = name.indexOf('@');
  if (at < 0) return null;
  const head = name.slice(0, at).trim();
  const scope = name.slice(at + 1).trim();
  if (!head || !scope) return null;
  const tokens = head.split(/\s+/);
  if (tokens.length < 2) return null;
  return { vendor: tokens[0], label: tokens.slice(1).join(' '), scope };
}

export interface VendorCompatibilityAdvisory {
  /** The preset the level was read from — never the user's own. */
  presetName: string;
  /** Capped at 'critical': someone else's preset cannot block your filament. */
  level: CompatibilityLevel;
}

/** The level a single annotated preset declares for one extruder, or null. */
function levelFromFacts(facts: FilamentPresetFacts, extruderIndex: number): CompatibilityLevel | null {
  if (facts.printableMask !== undefined && extruderIndex < 32
      && ((facts.printableMask >>> extruderIndex) & 1) === 0) return 'blocked';
  if (!facts.annotated) return null;
  switch (decodeExtruderCompatibility(facts.extruderCompatibility!, extruderIndex)) {
    case 1: return 'blocked';
    case 2: return 'critical';
    case 3: return 'caution';
    default: return null;
  }
}

/**
 * The vendor's own annotated preset for the same material label on the same
 * printer, when the user's preset carries no record of its own.
 *
 * Matched on the material LABEL, never on `filament_type`: Bambu PLA Silk and
 * Bambu PLA Basic are both type "PLA" but the first is unusable on the X2D
 * auxiliary and the second is fine, so a type-keyed lookup would condemn Basic
 * along with Silk.
 */
export function vendorAnnotatedSibling(
  target: { name: string; facts: FilamentPresetFacts },
  candidates: { name: string; facts: FilamentPresetFacts }[],
  extruderIndex: number
): VendorCompatibilityAdvisory | null {
  if (target.facts.annotated) return null; // it speaks for itself
  // A user's clone is named freely, so match on the nearest ANCESTOR name of
  // the vendor's "Vendor Material @Scope" shape when the clone has none.
  const mine = splitPresetName(target.facts.scopedName ?? target.name);
  // "@base" nodes are abstract and printer-agnostic: matching through one would
  // carry a level from a machine that is not the user's.
  if (!mine || mine.scope.toLowerCase() === 'base') return null;
  for (const c of candidates) {
    if (!c.facts.annotated) continue;
    const theirs = splitPresetName(c.facts.scopedName ?? c.name);
    if (!theirs) continue;
    if (theirs.scope !== mine.scope) continue;                        // same printer + nozzle
    if (theirs.label.toLowerCase() !== mine.label.toLowerCase()) continue; // same material label
    if (theirs.vendor.toLowerCase() === mine.vendor.toLowerCase()) continue; // a different vendor's
    const level = levelFromFacts(c.facts, extruderIndex);
    if (!level) continue;
    // Capped: this is an inference drawn from a preset that is not the user's.
    return { presetName: c.name, level: level === 'blocked' ? 'critical' : level };
  }
  return null;
}

// --- the verdict ------------------------------------------------------------

export interface NozzleCompatibilityQuery {
  /**
   * 0-based PHYSICAL extruder index — the position in the printer profile's
   * `nozzles` array, which is what every key read here is indexed by. Never a
   * filament preset's value-slot index.
   */
  extruderIndex: number;
  /** How the nozzle is named in the printer profile, for the copy. */
  nozzleLabel?: string;
  /** How filament reaches it. Only used for the material-level inference. */
  feed?: ExtruderType;
  material: Pick<MaterialPreset, 'id' | 'label' | 'flexible'>;
  machine?: MachinePresetFacts;
  filament?: FilamentPresetFacts;
  vendorAdvisory?: VendorCompatibilityAdvisory | null;
}

function splitList(csv: string | undefined): string[] {
  return (csv ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * What the installed preset data says about running this filament on this
 * physical nozzle — a warning with an override, never a refusal.
 */
export function nozzleFilamentVerdict(q: NozzleCompatibilityQuery): CompatibilityVerdict {
  const i = q.extruderIndex;
  const nozzle = q.nozzleLabel ?? `nozzle ${i + 1}`;
  const mat = q.material.label;
  const evidence: CompatibilityEvidence[] = [];

  // Every gate that fires records its own level; the strongest one decides, and
  // the rest stay in `evidence`. Collected rather than folded in place so that
  // "which source decided this" is answerable, and so an inferred level can
  // never be mistaken for a read one.
  const raised: { level: CompatibilityLevel; inferred: boolean }[] = [];
  const raise = (next: CompatibilityLevel, fromInference: boolean): void => {
    raised.push({ level: next, inferred: fromInference });
  };

  // Gate A — does this preset name any hotend variant this nozzle actually has?
  const nozzleVariants = splitList(q.machine?.extruderVariantList[i]);
  const presetVariants = q.filament?.extruderVariants ?? [];
  if (nozzleVariants.length && presetVariants.length) {
    const shared = nozzleVariants.filter(n =>
      presetVariants.some(p => p.trim().toLowerCase() === n.toLowerCase()));
    if (!shared.length) {
      raise('blocked', false);
      evidence.push({
        inferred: false,
        source: `extruder_variant_list[${i}] ∩ filament_extruder_variant`,
        detail: `This preset declares slots for ${presetVariants.join(', ')}, and ${nozzle} takes ${nozzleVariants.join(', ')}. They have none in common, so the slicer would not offer this filament on this nozzle at all.`
      });
    }
  }

  // Where the compatibility keys were physically read from, when the preset
  // under calibration inherited them rather than declaring them.
  const from = q.filament?.inheritedFrom ? `, inherited from ${q.filament.inheritedFrom}` : '';

  // Gate B — filament_printable, a bitmask over the extruder index.
  const mask = q.filament?.printableMask;
  if (mask !== undefined && i < 32) {
    const printable = ((mask >>> i) & 1) === 1;
    if (!printable) {
      raise('blocked', false);
      evidence.push({
        inferred: false,
        source: `filament_printable = ${mask}${from}`,
        detail: `The preset marks ${mat} as not supported by this extruder — the bit for ${nozzle} is clear.`
      });
    } else {
      evidence.push({
        inferred: false,
        source: `filament_printable = ${mask}${from}`,
        detail: `The preset marks ${mat} as printable on ${nozzle}.`
      });
    }
  }

  // Gate C — filament_extruder_compatibility, three bits per extruder.
  let readClear = false;
  if (q.filament?.annotated) {
    const c = decodeExtruderCompatibility(q.filament.extruderCompatibility!, i);
    const src = `filament_extruder_compatibility = ${q.filament.extruderCompatibility} (level ${c} on extruder ${i + 1})${from}`;
    if (c === 1) {
      raise('blocked', false);
      evidence.push({ inferred: false, source: src, detail: `The preset's own compatibility record marks ${mat} as unusable on ${nozzle}.` });
    } else if (c === 2) {
      raise('critical', false);
      evidence.push({ inferred: false, source: src, detail: `The preset's own compatibility record marks ${mat} as highly not recommended on ${nozzle}: expect critical print-quality problems.` });
    } else if (c === 3) {
      raise('caution', false);
      evidence.push({ inferred: false, source: src, detail: `The preset's own compatibility record marks ${mat} as not recommended on ${nozzle}: usable, with a higher failure rate.` });
    } else {
      readClear = true;
      evidence.push({ inferred: false, source: src, detail: `The preset's own compatibility record lists ${mat} as available on ${nozzle}.` });
    }
  }

  // Gate D — the machine forbids this filament TYPE on this extruder.
  const forbidden = splitList(q.machine?.unprintableFilamentTypes[i]);
  const type = q.filament?.filamentType;
  if (forbidden.length && type && forbidden.some(t => t.toLowerCase() === type.toLowerCase())) {
    raise('blocked', false);
    readClear = false;
    evidence.push({
      inferred: false,
      source: `unprintable_filament_types[${i}] = ${forbidden.join(',')}`,
      detail: `The machine preset lists ${type} among the filament types ${nozzle} cannot print.`
    });
  }

  // Material fallback — used where the preset data is silent, and marked as an
  // inference wherever it appears. Flexible filament down a long bowden path
  // buckles between the drive gears and the melt zone; the vendor's own preset
  // library agrees on the machines where it says anything at all.
  //
  // Scoped to a SECOND nozzle (index > 0) on purpose. A flexible on the only
  // nozzle of an ordinary bowden printer is a real difficulty but not a choice:
  // there is no other nozzle to move it to, and the app already says so in the
  // pressure-advance and retraction guidance. Raising a gate there would be
  // friction with no alternative to offer. On a second nozzle there IS an
  // alternative sitting unused, which is exactly the decision worth flagging.
  if (q.material.flexible && q.feed === 'bowden' && i > 0) {
    raise('critical', true);
    evidence.push({
      inferred: true,
      source: 'material property: flexible + bowden feed',
      detail: `${mat} is flexible and ${nozzle} is bowden-fed. Trim deduces this from the material and the feed path — it did not read it from a preset. Soft filament buckles in the tube instead of advancing, which grinds the filament and jams the feed path.`
    });
  }

  // Vendor-annotated sibling — an advisory about a DIFFERENT preset.
  if (q.vendorAdvisory && !q.filament?.annotated) {
    raise(q.vendorAdvisory.level, true);
    readClear = false;
    const mine = q.filament?.name ?? 'Your preset';
    evidence.push({
      inferred: true,
      source: `sibling preset: ${q.vendorAdvisory.presetName}`,
      detail: `${mine} carries no compatibility record. The vendor's own ${q.vendorAdvisory.presetName} marks this material as ${q.vendorAdvisory.level === 'critical' ? 'highly not recommended' : 'not recommended'} on ${nozzle}. That is a reading of the vendor's preset, not of yours — your filament may behave differently.`
    });
  }

  let winner: { level: CompatibilityLevel; inferred: boolean } = { level: 'unknown', inferred: false };
  for (const r of raised) {
    if (compatibilityRank(r.level) > compatibilityRank(winner.level)) winner = r;
  }
  // 'clear' is reachable ONLY through a compatibility record that was actually
  // read and actually said "available". Silence never lands here.
  const level: CompatibilityLevel = winner.level === 'unknown' && readClear ? 'clear' : winner.level;
  const inferred = level === 'clear' || level === 'unknown' ? false : winner.inferred;

  return {
    level,
    inferred,
    blocksCalibration: false,
    needsAcknowledgement: level === 'blocked' || level === 'critical' || level === 'caution',
    headline: compatibilityHeadline(level, inferred, mat, nozzle),
    evidence
  };
}

function compatibilityHeadline(
  level: CompatibilityLevel, inferred: boolean, mat: string, nozzle: string
): string {
  switch (level) {
    case 'blocked':
      return `The installed preset data marks ${mat} as unusable on ${nozzle}. You can calibrate it anyway — this is your printer — but expect it to fail.`;
    case 'critical':
      return inferred
        ? `Trim found no compatibility record for this pair and treats ${mat} on ${nozzle} as high-risk. That is its own reading, not the slicer's.`
        : `The installed preset data marks ${mat} as highly not recommended on ${nozzle}.`;
    case 'caution':
      return inferred
        ? `Your preset says nothing about ${nozzle}, but the vendor's own preset for ${mat} marks it as not recommended there.`
        : `The installed preset data marks ${mat} as not recommended on ${nozzle} — usable, with a higher failure rate.`;
    case 'clear':
      return `The installed preset data lists ${mat} as available on ${nozzle}.`;
    case 'unknown':
      return `Trim could not determine whether ${mat} works on ${nozzle}. Nothing was found to read, which is not the same as approval.`;
  }
}

/**
 * One sentence for a report or a later step, naming what the user overrode.
 *
 * The override is the user's to make. What the app owes them afterwards is a
 * record that says so plainly, so nothing downstream reads as an endorsement.
 */
export function compatibilityOverrideNote(rec: CompatibilityOverrideRecord | undefined): string | null {
  if (!rec) return null;
  const nozzle = rec.nozzleLabel ?? `nozzle ${rec.nozzleIndex + 1}`;
  const where = rec.presetName ? ` (read from ${rec.presetName})` : '';
  const basis = rec.inferred ? 'Trim inferred it' : 'it was read from the installed preset data';
  return `${rec.material} on ${nozzle} was flagged as ${rec.level}${where} — ${basis} — and you chose to calibrate it anyway. Every value in this project is therefore for a combination the data warns about; judge the results with that in mind.`;
}
