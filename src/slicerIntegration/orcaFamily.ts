// ---------------------------------------------------------------------------
// Shared Orca-family preset engine.
//
// All five supported slicers are PrusaSlicer→Bambu→Orca lineage and share the
// user filament preset JSON shape verified in docs/SLICER_PROFILE_RESEARCH.md:
//   - identity fields: name / from / inherits / version / filament_settings_id
//   - all setting values are arrays of strings, one entry per extruder
//   - "nil" is the "no filament-level override" sentinel
//   - delta presets store only overridden keys; full presets store everything
//
// This module is pure data transformation: no filesystem access, safe in the
// browser build. Unknown fields must survive parse → clone → patch → serialize.
// ---------------------------------------------------------------------------

import type { ExtruderType } from '../types';
import type {
  DetectedFilamentProfile, HotendFlowClass, IntegrationSlicerId, NormalizedMaterial,
  ParsedFilamentProfile, ProfileFieldChange, ProfileSource, CalibratedFieldPatch,
  SkippedFieldNote
} from './types';

// --- material normalization -------------------------------------------------

const MATERIAL_ALIASES: Record<string, NormalizedMaterial> = {
  'PLA': { canonical: 'PLA', family: 'PLA' },
  'PLA+': { canonical: 'PLA+', family: 'PLA' },
  'PLA PLUS': { canonical: 'PLA+', family: 'PLA' },
  'PLA-CF': { canonical: 'PLA-CF', family: 'PLA' },
  'PLA AERO': { canonical: 'PLA Aero', family: 'PLA' },
  'PLA SILK': { canonical: 'PLA Silk', family: 'PLA' },
  'PETG': { canonical: 'PETG', family: 'PETG' },
  'PETG-HF': { canonical: 'PETG-HF', family: 'PETG' },
  'PETG HF': { canonical: 'PETG-HF', family: 'PETG' },
  'PETG-CF': { canonical: 'PETG-CF', family: 'PETG' },
  'PCTG': { canonical: 'PCTG', family: 'PCTG' },
  'ABS': { canonical: 'ABS', family: 'ABS' },
  'ABS-GF': { canonical: 'ABS-GF', family: 'ABS' },
  'ASA': { canonical: 'ASA', family: 'ASA' },
  'ASA-AERO': { canonical: 'ASA Aero', family: 'ASA' },
  'TPU': { canonical: 'TPU', family: 'TPU' },
  'TPU-AMS': { canonical: 'TPU', family: 'TPU' },
  'TPU 95A': { canonical: 'TPU', family: 'TPU' },
  'PA': { canonical: 'PA', family: 'PA' },
  'PA-CF': { canonical: 'PA-CF', family: 'PA' },
  'PA-GF': { canonical: 'PA-GF', family: 'PA' },
  'PA6-CF': { canonical: 'PA6-CF', family: 'PA' },
  'PAHT-CF': { canonical: 'PAHT-CF', family: 'PA' },
  'PPA-CF': { canonical: 'PPA-CF', family: 'PPA' },
  'PPA-GF': { canonical: 'PPA-GF', family: 'PPA' },
  'PPS': { canonical: 'PPS', family: 'PPS' },
  'PPS-CF': { canonical: 'PPS-CF', family: 'PPS' },
  'PC': { canonical: 'PC', family: 'PC' },
  'PC-CF': { canonical: 'PC-CF', family: 'PC' },
  'PP': { canonical: 'PP', family: 'PP' },
  'PVA': { canonical: 'PVA', family: 'PVA' },
  'HIPS': { canonical: 'HIPS', family: 'HIPS' },
  'PE': { canonical: 'PE', family: 'PE' },
  'PHA': { canonical: 'PHA', family: 'PHA' },
  'BVOH': { canonical: 'BVOH', family: 'BVOH' },
  'EVA': { canonical: 'EVA', family: 'EVA' },
  'PET-CF': { canonical: 'PET-CF', family: 'PET' },
  'SBS': { canonical: 'SBS', family: 'SBS' }
};

/**
 * Normalize a material label to a canonical token + family. Never guesses
 * across families: an unknown label maps to itself as its own family.
 */
export function normalizeMaterial(raw: string | null | undefined): NormalizedMaterial | null {
  if (!raw) return null;
  const key = raw.trim().toUpperCase();
  if (MATERIAL_ALIASES[key]) return MATERIAL_ALIASES[key];
  // Tolerate exact canonical tokens with decorations like "Generic PLA".
  for (const alias of Object.keys(MATERIAL_ALIASES).sort((a, b) => b.length - a.length)) {
    if (key === `GENERIC ${alias}`) return MATERIAL_ALIASES[alias];
  }
  return { canonical: raw.trim(), family: raw.trim().toUpperCase() };
}

/** Same canonical material (PLA+ ≠ PLA, PETG-HF ≠ PETG). */
export function sameMaterial(a: string | null, b: string | null): boolean {
  const na = normalizeMaterial(a); const nb = normalizeMaterial(b);
  return !!na && !!nb && na.canonical.toUpperCase() === nb.canonical.toUpperCase();
}

/** Same broad family (PLA+ and PLA Silk are both PLA-family). */
export function sameMaterialFamily(a: string | null, b: string | null): boolean {
  const na = normalizeMaterial(a); const nb = normalizeMaterial(b);
  return !!na && !!nb && na.family === nb.family;
}

// --- parsing ---------------------------------------------------------------

type PresetJson = Record<string, unknown>;

function firstString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return null;
}

function stringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return [];
}

/** Nozzle diameters mentioned in compatible printer preset names, e.g. "… 0.4 nozzle". */
export function nozzlesFromPrinterNames(names: string[]): number[] {
  const out = new Set<number>();
  for (const n of names) {
    const m = /(\d+\.\d+)\s*nozzle/i.exec(n);
    if (m) out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

/** Printer model portion of a compatible-printer preset name (strips nozzle suffix). */
export function printerModelsFromNames(names: string[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    out.add(n.replace(/\s+\d+\.\d+\s*nozzle.*$/i, '').trim());
  }
  return [...out];
}

/**
 * Array-valued keys that are NOT indexed by extruder, so their length says
 * nothing about how many value slots a preset has.
 *
 * The drying keys are indexed by AMS dryer device and are four wide in Bambu's
 * own `fdm_filament_common`; a preset that carries them resolved would look
 * like a four-slot preset even on a single-nozzle machine. Shape alone cannot
 * tell them apart from a real four-slot variant array, so they have to be named.
 */
const NON_EXTRUDER_ARRAY_KEYS = new Set([
  'compatible_printers', 'compatible_prints', 'filament_settings_id',
  'filament_dev_ams_drying_temperature', 'filament_dev_ams_drying_time',
  'filament_dev_ams_drying_ams_limitations', 'filament_flush_temp_fast'
]);

/** Widest per-extruder array length among setting values. */
export function extruderCountOf(data: PresetJson): number {
  let max = 1;
  for (const [k, v] of Object.entries(data)) {
    if (NON_EXTRUDER_ARRAY_KEYS.has(k)) continue;
    if (Array.isArray(v) && v.length > max && v.every(x => typeof x === 'string')) max = v.length;
  }
  return max;
}

// --- extruder-variant slot legend -------------------------------------------
//
// A Bambu-lineage filament preset's per-slot arrays are indexed by EXTRUDER
// VARIANT, not by nozzle number. The legend that names each slot lives in
// `filament_extruder_variant`. On the Bambu Lab X2D no filament preset declares
// it — it arrives through `"include": ["fdm_filament_template_direct_bowden"]`,
// where the four slots are
//   0 Direct Drive Standard / 1 Direct Drive High Flow  → MAIN nozzle
//   2 Bowden Standard       / 3 Bowden High Flow        → AUXILIARY nozzle
// Reading that array by nozzle index puts a bowden calibration on a direct-drive
// hotend, which is the whole reason this module resolves the legend by NAME.

/**
 * Legends supplied by Bambu's `include` templates. Copied verbatim from the
 * template presets, which ship as fixtures (bambu-template-direct-bowden.json,
 * bambu-template-direct-dual.json) and are asserted against this table by
 * tests/slicerIntegration/x2dSlotMapping.test.ts. These two are the only
 * `include` targets that exist across a full Bambu Studio filament library.
 */
export const BAMBU_INCLUDE_TEMPLATE_VARIANTS: Record<string, string[]> = {
  fdm_filament_template_direct_bowden: [
    'Direct Drive Standard', 'Direct Drive High Flow', 'Bowden Standard', 'Bowden High Flow'
  ],
  fdm_filament_template_direct_dual: [
    'Direct Drive Standard', 'Direct Drive High Flow'
  ]
};

/** One slot of the legend, read as hardware rather than as a position. */
export interface ExtruderVariant {
  name: string;
  /** Feed path this slot describes; null when the name is not recognizable. */
  feed: ExtruderType | null;
  /** Hotend flow class; null when the name is not recognizable. */
  flow: HotendFlowClass | null;
}

export interface SlotLegend {
  names: string[];
  variants: ExtruderVariant[];
  /** Where the legend came from — a preset's own key wins over a template. */
  source: 'declared' | 'include-template' | 'scanner';
  /** True when the legend is exactly as wide as the preset's value slots. */
  matchesSlotCount: boolean;
  /** True when the legend describes more than one feed path (e.g. the X2D). */
  mixedFeed: boolean;
}

/**
 * Read one variant name as hardware. The name is the only meaning a slot has:
 * `Bambu TPU 85A @BBL H2D 0.4 nozzle` ships a one-slot legend whose slot 0 is
 * "Direct Drive TPU High Flow", so position carries nothing.
 */
export function classifyExtruderVariant(name: string): ExtruderVariant {
  const n = name.trim().toLowerCase();
  const feed: ExtruderType | null =
    n.includes('bowden') ? 'bowden' : n.includes('direct drive') ? 'direct' : null;
  const flow: HotendFlowClass | null =
    n.includes('high flow') ? 'high' : n.includes('standard') ? 'standard' : null;
  return { name, feed, flow };
}

function legendFrom(names: string[], source: SlotLegend['source'], slotCount: number): SlotLegend {
  const variants = names.map(classifyExtruderVariant);
  const feeds = new Set(variants.map(v => v.feed).filter((f): f is ExtruderType => f !== null));
  return {
    names: [...names],
    variants,
    source,
    matchesSlotCount: names.length === slotCount,
    mixedFeed: feeds.size > 1
  };
}

/**
 * The slot legend for a parsed preset, or null when none can be established.
 *
 * Order: a legend the scanner already resolved → the preset's own
 * `filament_extruder_variant` → the legend of an `include`d Bambu template.
 * Never invented: an unrecognized `include` yields null, and callers must
 * refuse rather than guess (see resolveTargetSlot / cloneAndPatch).
 */
export function resolveSlotLegend(base: ParsedFilamentProfile): SlotLegend | null {
  const slots = base.extruderCount;
  const provided = base.resolvedExtruderVariants;
  if (Array.isArray(provided) && provided.length > 0 && provided.every(x => typeof x === 'string')) {
    return legendFrom(provided, 'scanner', slots);
  }
  const raw = base.profile.rawProfile as PresetJson;
  const declared = raw?.filament_extruder_variant;
  if (Array.isArray(declared) && declared.length > 0 && declared.every(x => typeof x === 'string')) {
    return legendFrom(declared as string[], 'declared', slots);
  }
  // Bambu applies `include` templates in order, later entries winning.
  const includes = stringArray(raw?.include);
  for (let i = includes.length - 1; i >= 0; i--) {
    const tpl = BAMBU_INCLUDE_TEMPLATE_VARIANTS[includes[i]];
    if (tpl) return legendFrom(tpl, 'include-template', slots);
  }
  return null;
}

export type SlotTargetResolution =
  | {
      kind: 'variant';
      slot: number;
      variantName: string;
      legend: SlotLegend;
      /** Every slot that serves the calibrated nozzle's feed path. */
      candidates: number[];
    }
  | { kind: 'positional'; slot: number; legend: SlotLegend | null }
  | {
      kind: 'unresolved';
      code: 'FEED_UNKNOWN' | 'NO_SLOT_FOR_FEED' | 'VARIANT_UNRECOGNISED' | 'SLOT_SHARED_BY_NOZZLES';
      reason: string;
      legend: SlotLegend | null;
    };

/** "Direct Drive"/"Bowden" as the legend itself words it. */
function feedWord(feed: ExtruderType): string {
  return feed === 'bowden' ? 'Bowden' : 'Direct Drive';
}

/**
 * Which value slot a calibration belongs in, resolved from the preset's own
 * legend by NAME — never from the nozzle's index.
 *
 * Refuses (kind 'unresolved') rather than guessing when the legend describes
 * more than one feed path and the calibrated nozzle's feed is unknown, or when
 * no slot serves that feed path at all. A positional answer is only returned
 * for presets that carry no legend to read.
 */
export function resolveTargetSlot(args: {
  base: ParsedFilamentProfile;
  /** Physical nozzle, in the SLICER's index space (0 = first/main). */
  nozzleIndex: number;
  /** How filament reaches that nozzle. Unknown = null/undefined. */
  nozzleFeed?: ExtruderType | null;
  /** Standard vs high-flow hotend on that nozzle. Defaults to standard. */
  hotendFlow?: HotendFlowClass;
  /** Printer-profile label for that nozzle, used in refusal messages. */
  nozzleLabel?: string | null;
  /**
   * How many PHYSICAL nozzles the printer profile declares. A legend that
   * describes only ONE feed path names hotend variants, not nozzles: on a
   * machine with two nozzles both of them read whichever slot matches the
   * hotend fitted to them, so no slot belongs to one nozzle alone. 0/undefined
   * = the printer profile does not say, which asserts nothing.
   */
  physicalNozzleCount?: number;
}): SlotTargetResolution {
  const slots = Math.max(1, args.base.extruderCount);
  const legend = resolveSlotLegend(args.base);
  const positional = Math.max(0, Math.min(args.nozzleIndex, slots - 1));
  const usable = legend && legend.matchesSlotCount ? legend : null;
  const nozzleName = args.nozzleLabel ? ` (${args.nozzleLabel})` : '';
  const nozzles = args.physicalNozzleCount ?? 0;

  // One slot: there is nothing to choose. Whether that slot may legally hold
  // this nozzle's value is a separate question, answered by cloneAndPatch's
  // "base cannot address this nozzle" rule and by validation.
  if (slots === 1) return { kind: 'positional', slot: 0, legend };
  if (!usable) return { kind: 'positional', slot: positional, legend };

  const feed = args.nozzleFeed ?? null;
  const candidates = feed
    ? usable.variants.map((v, i) => ({ v, i })).filter(({ v }) => v.feed === feed).map(({ i }) => i)
    : [];

  if (feed && candidates.length === 0) {
    return {
      kind: 'unresolved', code: 'NO_SLOT_FOR_FEED', legend: usable,
      reason: `This preset has no value slot for a ${feedWord(feed)} feed path — its slots are ${usable.names.join(', ')}. Nozzle ${args.nozzleIndex + 1}${nozzleName} is ${feedWord(feed)}-fed, so nothing calibrated for it can be written here. Pick a base preset made for this machine.`
    };
  }

  // Every slot is the same feed path, so the legend distinguishes HOTENDS, not
  // nozzles — and this machine has more than one nozzle. The Bambu Lab H2D is
  // the shipped example: two direct-drive toolheads, and its filament presets
  // carry the two-slot "Direct Drive Standard / Direct Drive High Flow" legend
  // that BOTH nozzles read. Its own machine preset says so —
  // extruder_variant_list lists the same Standard/High Flow pair for each
  // nozzle. There is no slot exclusive to one of them, so a per-nozzle answer
  // would be a claim the legend cannot support.
  if (!usable.mixedFeed && nozzles > 1) {
    return {
      kind: 'unresolved', code: 'SLOT_SHARED_BY_NOZZLES', legend: usable,
      reason: `Every value slot in this preset describes the same feed path (${usable.names.join(', ')}), so its slots are hotend variants, not nozzles — but this printer profile declares ${nozzles} physical nozzles. Both nozzles read whichever slot matches the hotend fitted to them, so no slot belongs to nozzle ${args.nozzleIndex + 1}${nozzleName} alone and a value written for it would reach the other nozzle too. Set this value by hand in the slicer for the nozzle you calibrated, or apply it to every slot only if it really holds for both nozzles.`
    };
  }

  if (!feed) {
    if (usable.mixedFeed) {
      return {
        kind: 'unresolved', code: 'FEED_UNKNOWN', legend: usable,
        reason: `This preset's value slots are per feed path (${usable.names.join(', ')}), but Trim could not determine which feed path nozzle ${args.nozzleIndex + 1}${nozzleName} uses — the printer profile for this project does not describe that nozzle. Slot order is not nozzle order on this machine, so there is no safe guess. Add the nozzle's feed type to the printer profile, or pick the slot by hand below.`
      };
    }
    return { kind: 'positional', slot: positional, legend: usable };
  }

  const wanted = args.hotendFlow ?? 'standard';
  const exact = candidates.find(i => usable.variants[i].flow === wanted);
  const slot = exact ?? candidates[0];
  return { kind: 'variant', slot, variantName: usable.names[slot], legend: usable, candidates };
}

const MATERIAL_KEY = 'filament_type';
const VENDOR_KEY = 'filament_vendor';

/**
 * Parse Orca-family filament preset JSON into a DetectedFilamentProfile.
 * Throws on invalid JSON; marks unrecognized schemas instead of guessing.
 */
export function parseOrcaFamilyProfile(
  slicerId: IntegrationSlicerId,
  source: ProfileSource,
  sourceType: DetectedFilamentProfile['sourceType'],
  writable: boolean
): ParsedFilamentProfile {
  const data = JSON.parse(source.json) as PresetJson;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('Preset is not a JSON object');
  }

  const warnings: string[] = [];
  const name = typeof data.name === 'string' && data.name
    ? data.name
    : source.fileName.replace(/\.json$/i, '');
  const schemaRecognized =
    typeof data.name === 'string' ||
    typeof data.inherits === 'string' ||
    MATERIAL_KEY in data ||
    'filament_settings_id' in data;
  if (!schemaRecognized) {
    warnings.push('This file does not look like an Orca-family filament preset. It can be inspected but not used as a base profile.');
  }
  const from = firstString(data.from);
  if (sourceType === 'unknown' && from) {
    sourceType = from.toLowerCase() === 'system' ? 'system' : 'user';
  }

  const compatible = stringArray(data.compatible_printers);
  const material = firstString(data[MATERIAL_KEY]);
  const inherits = typeof data.inherits === 'string' && data.inherits ? data.inherits : null;

  const profile: DetectedFilamentProfile = {
    id: `${slicerId}:${sourceType}:${source.filePath ?? name}`,
    slicerId,
    name,
    vendor: firstString(data[VENDOR_KEY]),
    materialType: material,
    colorName: firstString(data.default_filament_colour) || null,
    sourceType,
    filePath: source.filePath ?? null,
    parentProfileName: inherits,
    compatiblePrinterNames: compatible,
    compatiblePrinterModels: printerModelsFromNames(compatible),
    compatibleNozzleDiameters: nozzlesFromPrinterNames(compatible),
    profileVersion: typeof data.version === 'string' ? data.version : null,
    rawProfile: data,
    infoSidecar: source.infoText ?? null,
    writable,
    warnings
  };

  return {
    profile,
    extruderCount: extruderCountOf(data),
    isDelta: !!inherits,
    schemaRecognized
  };
}

// --- fingerprinting --------------------------------------------------------

/** Stable, cheap fingerprint of a profile body (djb2 over canonical JSON). */
export function fingerprintProfile(data: unknown): string {
  const s = JSON.stringify(sortKeysDeep(data));
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) >>> 0;
  }
  return `djb2-${hash.toString(16)}-len${s.length}`;
}

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = sortKeysDeep((v as PresetJson)[k]);
    return out;
  }
  return v;
}

// --- clone and patch --------------------------------------------------------

export interface ClonePatchResult {
  data: PresetJson;
  changedFields: ProfileFieldChange[];
  /** Patches deliberately not written (see cloneAndPatch), with reasons. */
  skippedFields: SkippedFieldNote[];
  preservedFieldCount: number;
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Format a number for a preset value: trim trailing zeros, keep precision. */
export function formatPresetNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`Non-finite value: ${n}`);
  return String(Number(n.toFixed(4)));
}

/** Human-friendly label for a preset key, e.g. "Enable pressure advance". */
function presetKeyLabel(key: string): string {
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Clone the base preset and patch only the calibrated values.
 *
 * Rules (see docs/SLICER_PROFILE_RESEARCH.md):
 * - Every field not owned by a patch is preserved byte-for-byte (deep clone).
 * - Identity fields are re-assigned: name, filament_settings_id; from = "User";
 *   filament_id is always fresh. Cloning a system preset sets inherits to that
 *   preset's name (how Bambu saves user presets) and fills version from the
 *   resolved inheritance chain; cloning a user preset preserves both.
 * - Per-extruder arrays keep their shape. A patch writes only the target
 *   extruder index unless applyToAllExtruders is set; other positions keep
 *   their original value (including "nil").
 * - When the base preset has FEWER value slots than the calibrated nozzle's
 *   index (the single-slot case included), it cannot address that nozzle at
 *   all: Orca-family `get_at(i)` falls back to slot 0 for any index past the
 *   end of the array, so whatever is written is what EVERY nozzle reads.
 *   Nothing calibrated is written and every patch is reported in
 *   `skippedFields` — see `baseCannotAddressNozzle` below.
 * - When a patched key is missing (delta preset), it is added as an array
 *   sized to the preset's extruder count, with "nil" — the no-filament-override
 *   sentinel — in untouched positions. Settings where "nil" is invalid
 *   (flow/temp/PA) may only replicate the patched value when there is exactly
 *   one slot, or when the user asked for every extruder: on a multi-nozzle
 *   preset with per-nozzle targeting there is no prior value to preserve and no
 *   legal neutral value, so the key is NOT WRITTEN AT ALL and the omission is
 *   reported in `skippedFields`. Replicating it there would silently hand one
 *   nozzle's calibration to a physically different nozzle.
 */
/**
 * A fresh Bambu-style custom filament id: `P` + 7 hex, unique per generation
 * (FNV-1a over the name plus time/random). Bambu-lineage slicers key filaments
 * by `filament_id`; giving the clone a new id prevents it from being hidden
 * behind a cloud-synced parent that shares the id.
 */
export function freshFilamentId(seed: string): string {
  let h = 2166136261 >>> 0;
  const s = `${seed}|${Date.now()}|${Math.random()}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return 'P' + h.toString(16).padStart(8, '0').slice(0, 7);
}

/**
 * The one slot name a legend-less SINGLE-slot Bambu preset can be given.
 *
 * A single-slot preset has exactly one value that every nozzle reads, so there
 * is no slot-to-hardware mapping to get wrong — the only question the legend
 * answers there is "what is this one slot called", and every Bambu machine's
 * first extruder variant is Direct Drive Standard. It exists because a user
 * preset without `filament_extruder_variant` is not shown by variant-aware
 * Bambu Studio at all (validation blocks one), and `include` — the key that
 * supplied it — does not resolve from user directories.
 *
 * It is deliberately ONE entry and must never be extended into a list that gets
 * stretched over a multi-slot preset. On a preset with two or more slots the
 * legend is what says which nozzle each slot belongs to, and inventing one is
 * exactly how a bowden auxiliary's calibration ends up labelled (and read) as a
 * direct-drive main-nozzle variant. Real X2D shape proving it: "Generic PLA High
 * Speed @BBL X2D 0.2 nozzle" ships TWO value slots, declares no legend and has
 * no `include`; a fabricated ['Direct Drive Standard','Direct Drive High Flow']
 * there is wrong twice over — that machine's slots span two feed paths. When no
 * legend can be resolved for a multi-slot preset, nothing is written and the
 * clone is left without the key, which validation blocks.
 */
export const BAMBU_SINGLE_SLOT_LEGEND = ['Direct Drive Standard'];

export function cloneAndPatch(args: {
  base: ParsedFilamentProfile;
  newName: string;
  patches: CalibratedFieldPatch[];
  targetExtruderIndex: number;
  applyToAllExtruders: boolean;
  /**
   * The PHYSICAL nozzle the project calibrated (`project.nozzleIndex`), which
   * is NOT the same thing as `targetExtruderIndex`: callers clamp the target to
   * the base preset's slot count (see `defaultTargetExtruder`), so a project
   * that calibrated nozzle 2 arrives here as target 0 on a single-slot base.
   * Without this the clamp is invisible and the aux nozzle's calibration is
   * written into the slot the MAIN nozzle reads. Defaults to
   * `targetExtruderIndex` for callers that do not track a physical nozzle.
   */
  calibratedNozzleIndex?: number;
  /**
   * How filament reaches the calibrated nozzle. When the base preset's slots
   * are per feed path (the X2D's Direct Drive / Bowden legend), this is what
   * proves the chosen slot belongs to the nozzle that was calibrated. Unknown
   * (undefined/null) is treated as "cannot prove it" and refuses the write on
   * such a preset rather than falling back to the slot index.
   */
  calibratedNozzleFeed?: ExtruderType | null;
  /** Hotend flow class on the calibrated nozzle. Defaults to standard. */
  calibratedHotendFlow?: HotendFlowClass;
  /** Printer-profile label for the calibrated nozzle, used in messages. */
  calibratedNozzleLabel?: string | null;
  /**
   * How many PHYSICAL nozzles the machine has, from the printer profile. A
   * legend that describes only hotend variants of one feed path cannot address
   * one of two nozzles — both read whichever slot matches their fitted hotend —
   * so a per-nozzle write on such a machine has to be refused. 0/undefined
   * means "the printer profile does not say", which asserts nothing.
   */
  physicalNozzleCount?: number;
}): ClonePatchResult {
  const { base, newName, patches, targetExtruderIndex, applyToAllExtruders } = args;
  const src = base.profile.rawProfile as PresetJson;
  const data = deepClone(src);
  const extruders = base.extruderCount;
  const idx = Math.min(targetExtruderIndex, extruders - 1);

  if (targetExtruderIndex >= extruders && extruders > 1) {
    throw new Error(`Target extruder ${targetExtruderIndex + 1} does not exist in this profile (${extruders} extruders).`);
  }

  const changed: ProfileFieldChange[] = [];

  // Identity re-assignment (recorded but not shown as calibration changes).
  data.name = newName;
  data.from = 'User';
  if ('filament_settings_id' in data || true) data.filament_settings_id = [newName];
  // Cloud/account identity of the source must never leak into the clone.
  delete data.setting_id;
  delete data.user_id;
  // Bambu-lineage slicers dedupe filament presets by `filament_id` when signed
  // in: a clone that keeps its parent's id is hidden behind the cloud-synced
  // parent, and a preset with NO id at all is not adopted by the account
  // loader either (verified in Bambu Studio 2.7.x — neither ever appears in
  // the filament list). System leaves don't even declare a literal
  // filament_id (it lives in their abstract "@base" parent), so the id must
  // be assigned unconditionally, mirroring Bambu's "duplicate filament"
  // behavior.
  data.filament_id = freshFilamentId(newName);
  // A user preset Bambu Studio creates from a system preset inherits that
  // concrete preset by NAME (e.g. "Generic ASA @BBL H2S 0.4 nozzle"), never
  // the abstract "@base" parent a system leaf's own `inherits` points to.
  // Cloning a user preset keeps its inherits (already a concrete system name).
  if (base.profile.sourceType === 'system' && base.profile.name) {
    data.inherits = base.profile.name;
  }
  // Bambu-created user presets always carry a `version` — the vendor library
  // version from system/{Vendor}.json (resolved by the scanner); no preset in
  // the library declares it. Fill it when the clone would otherwise lack one.
  if (typeof data.version !== 'string' && base.profile.profileVersion) {
    data.version = base.profile.profileVersion;
  }
  // Bambu Studio user presets never carry system-preset plumbing: `type`,
  // `instantiation`, and `include` appear in NO preset Bambu itself writes
  // into an account folder (verified across a real account's 70+ presets),
  // and `include` references template files that do not resolve from user
  // dirs. Everything they provided still flows through `inherits` → the
  // concrete system leaf. Working presets also all declare
  // `filament_extruder_variant` — the legend mapping each per-slot array
  // position to hardware; variant-aware Bambu Studio (2.7+) does not show a
  // user preset without it.
  //
  // The legend is the one thing `include` supplied that CANNOT be recovered
  // from `inherits`, because a user-directory preset does not resolve template
  // files at all. It is therefore materialized here from the resolved legend —
  // verbatim, never stretched. When no legend can be resolved for a preset too
  // wide for the direct-drive-only list, the key is left absent on purpose:
  // validation blocks a Bambu preset without it, and an invented legend that
  // mislabels a Bowden slot as direct drive is strictly worse than none.
  const legend = resolveSlotLegend(base);
  const usableLegend = legend && legend.matchesSlotCount ? legend : null;
  // A slot legend is only ever WRITTEN when it was READ from the preset (or its
  // include template), or when there is exactly one slot and therefore no
  // mapping to get wrong. Slot count is not evidence of anything: a two-slot
  // X2D preset with no legend is two feed paths, not two direct-drive hotends.
  const canNameEverySlot = !!usableLegend || extruders <= 1;
  if (base.profile.slicerId === 'bambu') {
    delete data.type;
    delete data.instantiation;
    delete data.include;
    if (!Array.isArray(data.filament_extruder_variant)) {
      if (usableLegend) {
        data.filament_extruder_variant = [...usableLegend.names];
      } else if (canNameEverySlot) {
        data.filament_extruder_variant = [...BAMBU_SINGLE_SLOT_LEGEND];
      }
    }
  }

  // Keys that may not hold "nil" (the slicer requires a concrete value).
  const NO_NIL = new Set(['nozzle_temperature', 'nozzle_temperature_initial_layer', 'filament_flow_ratio', 'filament_max_volumetric_speed', 'pressure_advance', 'filament_shrink']);

  /** True when the base preset declares this key as a usable per-extruder array. */
  const declaredArray = (v: unknown): v is string[] =>
    Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string');

  /**
   * What an untargeted slot gets when the base preset does not declare the key.
   * "nil" is the documented no-filament-override sentinel: the slot behaves
   * exactly as it did while the key was absent. `null` = no honest value exists
   * (the slicer rejects "nil" here), so the key must not be written at all.
   */
  const neutralFill = (key: string): string | null => (NO_NIL.has(key) ? null : 'nil');

  /** Slots this write targets; every other slot must keep its behaviour. */
  const targetsFor = (len: number): number[] =>
    applyToAllExtruders ? Array.from({ length: len }, (_, i) => i) : [idx];

  const untargetedSlots = (len: number): number[] => {
    const t = new Set(targetsFor(len));
    return Array.from({ length: len }, (_, i) => i).filter(i => !t.has(i));
  };

  // A VALUE SLOT is not a NOZZLE. They were the same number until the X2D's
  // variant-indexed presets arrived (aux = nozzle 2 = slot 3 of 4), and every
  // message below has to keep them apart or it reports hardware that does not
  // exist — "nozzle 4" on a two-nozzle machine. "Nozzle N" is reserved for
  // `calibratedNozzle`; anything derived from an array index says "value slot".
  const slotWords = (i: number): string => {
    const name = usableLegend?.names[i];
    return name ? `value slot ${i + 1} (“${name}”)` : `value slot ${i + 1}`;
  };
  const targetSlotWords = (): string => slotWords(idx);
  const untargetedSlotWords = (len: number): string => {
    const list = untargetedSlots(len).map(slotWords);
    if (list.length === 0) return 'no other value slot';
    if (list.length === 1) return list[0];
    return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  };
  const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);
  /**
   * "Apply to all value slots" is a legitimate escape only when every slot is
   * the same feed path. On a mixed-feed preset it is the thing that writes a
   * bowden calibration onto direct-drive slots, so it is never suggested there.
   */
  const applyAllSuggestion = usableLegend?.mixedFeed
    ? ' Do NOT use “apply to all value slots” here: this preset\'s slots span two different feed paths, so one calibration cannot be correct for all of them.'
    : ' You can also re-run with “apply to all value slots” if this value really holds for every slot.';

  /** Every slot is written, so no untargeted slot can be silently invented. */
  const writesEverySlot = applyToAllExtruders || extruders === 1;

  const skipped: SkippedFieldNote[] = [];

  // The nozzle the user actually calibrated, before any caller-side clamping.
  const calibratedNozzle = args.calibratedNozzleIndex ?? targetExtruderIndex;
  /**
   * The base preset has fewer value slots than the calibrated nozzle needs, so
   * it CANNOT hold a value addressed to that nozzle — the single-slot preset
   * targeting nozzle 2 is the common case. Orca-family `get_at(i)` falls back
   * to slot 0 for every index past the end of a per-extruder array, so anything
   * written into the slots that DO exist is what every nozzle on the machine
   * reads, including the ones this project never calibrated. On a Bambu X2D
   * that means a bowden auxiliary pressure advance (0.5–1.0) landing on the
   * direct-drive main nozzle, whose own band is 0–0.1, and a bowden retraction
   * distance landing on a direct-drive feed.
   *
   * There is no slot to target and no neutral value to put beside it, so
   * NOTHING calibrated is written; every patch and companion is reported in
   * `skippedFields` instead. Guessing a value here would be exactly the silent
   * cross-nozzle write the multi-slot rule below already refuses to make.
   */
  const baseCannotAddressNozzle = !applyToAllExtruders && calibratedNozzle > extruders - 1;
  const cannotAddressReason = (label: string, key: string, valueNote: string): string =>
    `${label} (${key}) was NOT written: this base preset carries only ${extruders} value slot(s), so it cannot hold a value for nozzle ${calibratedNozzle + 1} — the nozzle this project calibrated. Orca-family slicers read slot 1 for every nozzle a preset has no slot for, so ${valueNote} would have been applied to EVERY nozzle, including the main one. Pick a base preset made for this machine — one whose value slots include the one that nozzle reads — or set ${key} by hand in the slicer for nozzle ${calibratedNozzle + 1}.`;

  // --- does the chosen slot really belong to the calibrated nozzle? ---------
  // The slots of a Bambu preset are extruder VARIANTS, so slot 2 of an X2D
  // preset is "Direct Drive High Flow" — a MAIN-nozzle variant — even though
  // the auxiliary nozzle is physical nozzle 2. Nothing above can catch that:
  // the preset is wide enough, the index exists, the value simply lands on the
  // wrong hardware. The legend is the only authority, so it is checked by name.
  const nozzleFeed = args.calibratedNozzleFeed ?? null;
  const nozzleName = args.calibratedNozzleLabel ? ` (${args.calibratedNozzleLabel})` : '';
  const chosenVariant = usableLegend?.variants[idx] ?? null;
  const physicalNozzles = args.physicalNozzleCount ?? 0;
  let wrongSlotReason: ((label: string, key: string, valueNote: string) => string) | null = null;
  if (applyToAllExtruders && extruders > 1 && usableLegend) {
    // "Apply to every value slot" is an assertion the user is allowed to make
    // about hotend variants of ONE feed path ("this filament runs the same
    // numbers in Standard and High Flow"). It is not an assertion anybody can
    // make across feed paths: a bowden retraction distance on a direct-drive
    // slot is wrong as a matter of physics, not of preference, and the checkbox
    // that offers it says nothing about feed paths. So the flag does NOT open
    // this door — it is the one guard it must not be able to switch off.
    const foreign = usableLegend.variants
      .map((v, i) => ({ v, i }))
      .filter(({ v }) => v.feed !== null && (nozzleFeed ? v.feed !== nozzleFeed : usableLegend.mixedFeed));
    const foreignNames = foreign.map(({ v, i }) => `value slot ${i + 1} “${v.name}”`);
    const foreignList = foreignNames.length > 1
      ? `${foreignNames.slice(0, -1).join(', ')} and ${foreignNames[foreignNames.length - 1]}`
      : foreignNames[0];
    const foreignFeeds = [...new Set(foreign.map(({ v }) => feedWord(v.feed!)))].join(' and ');
    if (foreign.length && nozzleFeed) {
      wrongSlotReason = (label, key, valueNote) =>
        `${label} (${key}) was NOT written: “apply to all value slots” would put ${valueNote} into ${foreignList}, which belong to the ${foreignFeeds} feed path, but this project calibrated the ${feedWord(nozzleFeed)}-fed nozzle ${calibratedNozzle + 1}${nozzleName}. A ${feedWord(nozzleFeed)} calibration is not transferable to ${foreignFeeds} hardware — the retraction distance and pressure advance a bowden path needs are several times what a direct-drive path can survive. Untick “apply to all value slots” so Trim writes only the slot that belongs to this nozzle, or set ${key} by hand in the slicer.`;
    } else if (foreign.length) {
      wrongSlotReason = (label, key, valueNote) =>
        `${label} (${key}) was NOT written: this preset's value slots are per feed path (${usableLegend.names.join(', ')}), “apply to all value slots” would write ${valueNote} into every one of them, and Trim could not determine which feed path nozzle ${calibratedNozzle + 1}${nozzleName} uses — the project's printer profile does not describe that nozzle. Add the nozzle's feed type to the printer profile and re-generate, or set ${key} by hand in the slicer.`;
    }
  } else if (!applyToAllExtruders && extruders > 1 && usableLegend && chosenVariant) {
    const candidates = nozzleFeed
      ? usableLegend.variants.map((v, i) => ({ v, i })).filter(({ v }) => v.feed === nozzleFeed)
      : [];
    const suggestion = candidates.length
      ? `Write to ${candidates.map(({ v, i }) => `slot ${i + 1} “${v.name}”`).join(' or ')} instead`
      : `This preset has no slot for that feed path (its slots are ${usableLegend.names.join(', ')}) — pick a base preset made for this machine`;
    if (nozzleFeed && chosenVariant.feed && chosenVariant.feed !== nozzleFeed) {
      wrongSlotReason = (label, key, valueNote) =>
        `${label} (${key}) was NOT written: value slot ${idx + 1} of this preset is “${chosenVariant.name}”, which belongs to the ${feedWord(chosenVariant.feed!)} feed path, but this project calibrated the ${feedWord(nozzleFeed)}-fed nozzle ${calibratedNozzle + 1}${nozzleName}. Writing ${valueNote} there would put a ${feedWord(nozzleFeed)} calibration on ${feedWord(chosenVariant.feed!)} hardware. ${suggestion}, or set ${key} by hand in the slicer for that slot.`;
    } else if (nozzleFeed && !chosenVariant.feed) {
      wrongSlotReason = (label, key, valueNote) =>
        `${label} (${key}) was NOT written: Trim does not recognize value slot ${idx + 1} of this preset (“${chosenVariant.name}”), so it cannot prove that slot belongs to the ${feedWord(nozzleFeed)}-fed nozzle ${calibratedNozzle + 1}${nozzleName}. ${valueNote} was withheld rather than written to unidentified hardware. ${suggestion}, or set ${key} by hand in the slicer.`;
    } else if (!nozzleFeed && usableLegend.mixedFeed) {
      wrongSlotReason = (label, key, valueNote) =>
        `${label} (${key}) was NOT written: this preset's value slots are per feed path (${usableLegend.names.join(', ')}) and Trim could not determine which feed path nozzle ${calibratedNozzle + 1}${nozzleName} uses — the project's printer profile does not describe that nozzle. Slot order is not nozzle order on this machine, so writing ${valueNote} into slot ${idx + 1} “${chosenVariant.name}” could not be shown to be correct. Add the nozzle's feed type to the printer profile and re-generate, or set ${key} by hand in the slicer.`;
    } else if (!usableLegend.mixedFeed && physicalNozzles > 1) {
      // Every slot describes the SAME feed path, so the legend distinguishes
      // hotend variants — not nozzles. On a machine with two physical nozzles
      // (the Bambu Lab H2D: two direct-drive toolheads, presets carrying the
      // 2-slot direct-dual legend) both nozzles read whichever slot matches the
      // hotend they currently carry, so slot 1 "Direct Drive Standard" is what
      // BOTH read with standard hotends fitted. There is no slot that belongs
      // to one of them, so a per-nozzle write cannot be honoured at all.
      wrongSlotReason = (label, key, valueNote) =>
        `${label} (${key}) was NOT written: every value slot of this preset describes the same feed path (${usableLegend.names.join(', ')}), so its slots are hotend variants, not nozzles — but the printer profile declares ${physicalNozzles} physical nozzles. Both nozzles read whichever slot matches the hotend fitted to them, so slot ${idx + 1} “${chosenVariant.name}” is not exclusive to nozzle ${calibratedNozzle + 1}${nozzleName}: writing ${valueNote} there would hand it to the other nozzle as well. Set ${key} by hand in the slicer for the nozzle you calibrated, or tick “apply to all value slots” only if this value really holds for every nozzle on the machine.`;
    }
  }

  // A Bambu preset whose slots cannot all be named honestly must not be written
  // either: the clone loses `include`, so an unnamed slot legend would either be
  // absent (the slicer hides the preset) or invented (mislabelled hardware).
  let cannotNameSlotsReason: ((label: string, key: string, valueNote: string) => string) | null = null;
  if (base.profile.slicerId === 'bambu' && !canNameEverySlot && !Array.isArray(src.filament_extruder_variant)) {
    cannotNameSlotsReason = (label, key, valueNote) =>
      `${label} (${key}) was NOT written: this base preset carries ${extruders} value slots but Trim could not establish what each slot means — it declares no filament_extruder_variant legend, and it pulls none in from an “include” template Trim knows. Slot count is not evidence: on a Bambu Lab X2D a two-slot preset spans two FEED PATHS, so writing ${valueNote} into an unidentified slot could put a bowden calibration on a direct-drive nozzle this project never calibrated. Pick a base preset that declares its slot legend (Bambu's X2D 0.4 nozzle presets do), or set ${key} by hand in the slicer.`;
  }

  const withholdAll = baseCannotAddressNozzle
    ? cannotAddressReason
    : (cannotNameSlotsReason ?? wrongSlotReason);

  for (const patch of patches) {
    // Withhold everything before any slot maths: no honest write exists here.
    if (withholdAll) {
      const after = formatPresetNumber(patch.value) + (patch.valueSuffix ?? '');
      skipped.push({
        presetKey: patch.presetKey, label: patch.label,
        reason: withholdAll(patch.label, patch.presetKey,
          `${after}${patch.unit ? ` ${patch.unit}` : ''}`)
      });
      // Companions are this value's plumbing; withheld with it, and reported
      // with it, so the skipped list matches the file exactly.
      for (const comp of patch.companions ?? []) {
        skipped.push({
          presetKey: comp.presetKey, label: presetKeyLabel(comp.presetKey),
          reason: withholdAll(presetKeyLabel(comp.presetKey), comp.presetKey, `"${comp.value}"`) +
            ` It belongs to ${patch.label} (${patch.presetKey}), which was withheld for the same reason.`
        });
      }
      continue;
    }

    const key = patch.presetKey;
    const after = formatPresetNumber(patch.value) + (patch.valueSuffix ?? '');
    const existing = data[key];
    const absent = !declaredArray(existing);

    // The base preset does not declare this key, so the nozzles this project
    // did NOT calibrate have no value to preserve. Writing the calibrated value
    // into them would apply one nozzle's calibration to different hardware
    // (a bowden aux K on a direct-drive main nozzle, for example), so the key
    // is left out entirely unless a legal neutral value exists for those slots.
    if (absent && !writesEverySlot && neutralFill(key) === null) {
      const others = untargetedSlotWords(extruders);
      skipped.push({
        presetKey: key, label: patch.label,
        reason: `${patch.label} (${key}) was NOT written: the base preset does not set it, so ${others} ${plural(untargetedSlots(extruders).length, 'has', 'have')} no existing value to keep and this setting does not accept the "nil" (no override) sentinel. Writing ${after}${patch.unit ? ` ${patch.unit}` : ''} would have applied nozzle ${calibratedNozzle + 1}${nozzleName}'s calibration to ${others} as well. Pick a base preset that already sets ${key}, or set it by hand in the slicer for ${targetSlotWords()}.${applyAllSuggestion}`
      });
      // Companions are this value's plumbing (e.g. the flag that switches
      // pressure advance on). With the value itself withheld they must not be
      // written either — and each one has to be REPORTED, or the preview and
      // the install summary claim one field was left out when two were. The
      // guarantee this whole rule rests on is that the reported list matches
      // exactly what lands in the file.
      for (const comp of patch.companions ?? []) {
        skipped.push({
          presetKey: comp.presetKey, label: presetKeyLabel(comp.presetKey),
          reason: `${presetKeyLabel(comp.presetKey)} (${comp.presetKey}) was NOT written either: it belongs to ${patch.label} (${key}), which was withheld above. ${comp.presetKey} is left exactly as the base preset had it. Setting ${patch.label} by hand in the slicer for ${targetSlotWords()} covers both.`
        });
      }
      continue;
    }

    let arr: string[];
    if (declaredArray(existing)) {
      arr = [...existing];
      // Preserve array shape; pad only if the profile itself is wider.
      while (arr.length < extruders) arr.push(arr[arr.length - 1]);
    } else {
      arr = new Array(extruders).fill(neutralFill(key) ?? after) as string[];
    }

    const targets = targetsFor(arr.length);
    let recorded = false;
    for (const t of targets) {
      const before = Array.isArray(existing) && typeof (existing as unknown[])[t] === 'string'
        ? (existing as string[])[t]
        : null;
      if (before !== after) {
        changed.push({
          presetKey: key, label: patch.label, before, after, unit: patch.unit,
          extruderIndex: extruders > 1 ? t : undefined
        });
        recorded = true;
      }
      arr[t] = after;
    }
    // A key added from scratch writes every slot, not just the target: report
    // what lands in the untargeted ones too, or the preview would hide it.
    if (absent) {
      for (const i of untargetedSlots(arr.length)) {
        changed.push({
          presetKey: key, label: patch.label,
          before: null, after: arr[i], unit: patch.unit,
          extruderIndex: extruders > 1 ? i : undefined
        });
        recorded = true;
      }
    }
    // Padding alone still mutates the key even when the target value matched:
    // record it, or the diff would flag the widened array as unexpected drift.
    // Record it honestly: the first padded slot did not exist before (null)
    // and received a copy of the array's previous last value.
    if (!recorded && JSON.stringify(arr) !== JSON.stringify(existing)) {
      const firstPadded = Array.isArray(existing) ? existing.length : 0;
      changed.push({
        presetKey: key, label: `${patch.label} (array normalized to ${extruders} extruders)`,
        before: null, after: arr[firstPadded] ?? after, unit: patch.unit,
        extruderIndex: extruders > 1 ? firstPadded : undefined
      });
    }
    data[key] = arr;

    // Companions follow the same per-extruder targeting as the main patch:
    // only the calibrated extruder position(s) are written.
    for (const comp of patch.companions ?? []) {
      const compExisting = data[comp.presetKey];
      const compAbsent = !declaredArray(compExisting);
      // Same rule as the main patch: never invent a companion value for a
      // nozzle this project did not calibrate (e.g. enabling pressure advance
      // on the untargeted nozzle).
      if (compAbsent && !writesEverySlot && neutralFill(comp.presetKey) === null) {
        const others = untargetedSlotWords(extruders);
        skipped.push({
          presetKey: comp.presetKey, label: presetKeyLabel(comp.presetKey),
          reason: `${presetKeyLabel(comp.presetKey)} (${comp.presetKey}) was NOT written: the base preset does not set it, so ${others} ${plural(untargetedSlots(extruders).length, 'has', 'have')} no existing value to keep and this setting does not accept the "nil" (no override) sentinel. Set it by hand in the slicer for ${targetSlotWords()}.${applyAllSuggestion}`
        });
        continue;
      }
      let compArr: string[];
      if (declaredArray(compExisting)) {
        compArr = [...compExisting];
        // Preserve array shape; pad only if the profile itself is wider.
        while (compArr.length < extruders) compArr.push(compArr[compArr.length - 1]);
      } else {
        compArr = new Array(extruders).fill(neutralFill(comp.presetKey) ?? comp.value) as string[];
      }
      let compRecorded = false;
      for (const t of targetsFor(compArr.length)) {
        const compBefore = Array.isArray(compExisting) && typeof (compExisting as unknown[])[t] === 'string'
          ? (compExisting as string[])[t]
          : null;
        if (compBefore !== comp.value) {
          changed.push({
            presetKey: comp.presetKey, label: presetKeyLabel(comp.presetKey), before: compBefore, after: comp.value,
            extruderIndex: extruders > 1 ? t : undefined
          });
          compRecorded = true;
        }
        compArr[t] = comp.value;
      }
      // Same "report every slot" rule as the main patch path.
      if (compAbsent) {
        for (const i of untargetedSlots(compArr.length)) {
          changed.push({
            presetKey: comp.presetKey, label: presetKeyLabel(comp.presetKey),
            before: null, after: compArr[i], extruderIndex: extruders > 1 ? i : undefined
          });
          compRecorded = true;
        }
      }
      // Same padding rule as the main patch path (see above): before = null
      // for the padded slot, after = the value that actually filled it.
      if (!compRecorded && JSON.stringify(compArr) !== JSON.stringify(compExisting)) {
        const firstPadded = Array.isArray(compExisting) ? compExisting.length : 0;
        changed.push({
          presetKey: comp.presetKey,
          label: `${presetKeyLabel(comp.presetKey)} (array normalized to ${extruders} extruders)`,
          before: null, after: compArr[firstPadded] ?? comp.value,
          extruderIndex: extruders > 1 ? firstPadded : undefined
        });
      }
      data[comp.presetKey] = compArr;
    }
  }

  const skippedKeys = new Set(skipped.map(s => s.presetKey));
  const preservedFieldCount = Object.keys(src).filter(k =>
    !['name', 'from', 'filament_settings_id', 'setting_id', 'user_id'].includes(k) &&
    (skippedKeys.has(k) ||
      !patches.some(p => p.presetKey === k || (p.companions ?? []).some(c => c.presetKey === k)))
  ).length;

  return { data, changedFields: changed, skippedFields: skipped, preservedFieldCount };
}

// --- serialization ----------------------------------------------------------

/**
 * Serialize a preset the way the slicers write them: 4-space indent,
 * keys in stable sorted order (observed in real presets), trailing newline.
 */
export function serializePreset(data: PresetJson): string {
  return JSON.stringify(sortKeysDeep(data), null, 4) + '\n';
}

/** Build the .info sidecar for a newly created local preset. */
export function buildInfoSidecar(args: { baseId: string | null; nowUnixSeconds?: number }): string {
  const t = args.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
  return [
    'sync_info = create',
    'user_id = ',
    'setting_id = ',
    `base_id = ${args.baseId ?? ''}`,
    `updated_time = ${t}`,
    ''
  ].join('\n');
}

/**
 * Stamp the owning account into a .info sidecar. Presets Bambu Studio itself
 * writes into an account folder carry `user_id = <account>`; a preset with an
 * empty user_id in a signed-in account folder is not adopted into the account's
 * preset list. Called at install time, when the target location is known.
 */
export function withInfoUserId(infoText: string, userId: string): string {
  return infoText.replace(/^user_id\s*=.*$/m, `user_id = ${userId}`);
}

/** Extract a key from .info sidecar text. */
export function infoValue(infoText: string | null, key: string): string | null {
  if (!infoText) return null;
  const m = new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm').exec(infoText);
  return m ? m[1].trim() : null;
}

// --- naming -----------------------------------------------------------------

/** Characters invalid in Windows/macOS file names (preset name is the file stem). */
const INVALID_FILENAME_CHARS = /[<>:"\/\\|?*\u0000-\u001f]/g;

export function sanitizeProfileName(name: string): string {
  return name.replace(INVALID_FILENAME_CHARS, '').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim();
}

export function defaultProfileName(args: {
  manufacturer: string; material: string; color?: string;
  printerName?: string; nozzle?: number;
}): string {
  const core = ['Trim -', args.manufacturer, args.material, args.color].filter(Boolean).join(' ');
  const suffix = args.printerName ? ` @ ${args.printerName}${args.nozzle ? ` ${args.nozzle}` : ''}` : '';
  return sanitizeProfileName(core + suffix);
}
