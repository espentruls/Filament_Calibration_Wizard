import { h, field, numberInput, issueList, clear, toast } from './dom';
import { listPrinters, createProject, saveProject, loadSettings } from '../storage/store';
import { MATERIALS, getMaterial } from '../data/materials';
import { CALIBRATIONS } from '../data/calibrations';
import { nozzleTopology, printerCanHeatChamber, suggestChamberTemp } from '../logic/ranges';
import {
  nozzleFilamentVerdict, readFilamentPresetFacts, resolveFilamentPresetFacts,
  splitPresetName, vendorAnnotatedSibling
} from '../logic/validation';
import type { FilamentPresetChainNode, FilamentPresetFacts, VendorCompatibilityAdvisory } from '../logic/validation';
import { withOptionalStep } from '../logic/stepPlan';
import { slicerVersionOptions } from '../data/slicers';
import { navigate } from '../app';
import * as bridge from '../slicerIntegration/bridge';
import { detectInstallations, scanProfiles } from '../slicerIntegration/scanner';
import { rankBaselineNames } from '../slicerIntegration/recommendations';
import type { DetectedFilamentProfile, IntegrationSlicerId } from '../slicerIntegration/types';
import type {
  CalibrationProject, CompatibilityOverrideRecord, CompatibilityVerdict,
  MaterialId, SlicerId, ExperienceMode
} from '../types';

/** Display scale for the material temperature band (presentation only). */
const TEMP_SCALE_MIN = 150;
const TEMP_SCALE_MAX = 350;

/**
 * Whether the compatibility callout has anything worth the space it takes.
 *
 * On a machine with a per-nozzle choice it always does — the whole question is
 * "which nozzle", and "we could not tell" is a real answer there. On a
 * single-nozzle machine it appears only when there is an actual warning, so a
 * one-nozzle printer is never shown dual-nozzle machinery just to be told
 * nothing is known.
 */
export function showsCompatibilityPanel(
  verdict: CompatibilityVerdict | null, perNozzle: boolean
): boolean {
  if (!verdict) return false;
  return perNozzle || verdict.needsAcknowledgement;
}

/**
 * The one thing standing between a warned combination and a new project: an
 * explicit tick. Not a block — the tick is always available and always enough,
 * and no other value on the form can make it unavailable. What it prevents is a
 * project being created with the warning never acknowledged, which would leave
 * every later report unable to say the warning was ever shown.
 */
export function compatibilityGateIssues(
  verdict: CompatibilityVerdict | null, acknowledged: boolean
): { level: 'error' | 'warning'; message: string }[] {
  if (!verdict?.needsAcknowledgement || acknowledged) return [];
  return [{
    level: 'error',
    message: 'This filament and this nozzle are flagged above. Tick "Calibrate this combination anyway" to go ahead — or change the nozzle, the material, or the starting profile.'
  }];
}

/**
 * The override as it is stored: the level, the headline and the evidence
 * exactly as the user saw them, not a summary written afterwards.
 */
export function compatibilityOverrideRecord(args: {
  verdict: CompatibilityVerdict | null;
  acknowledged: boolean;
  nozzleIndex: number;
  nozzleLabel?: string;
  material: MaterialId;
  presetName?: string | null;
}): CompatibilityOverrideRecord | null {
  const { verdict, acknowledged } = args;
  if (!verdict?.needsAcknowledgement || !acknowledged) return null;
  return {
    at: new Date().toISOString(),
    level: verdict.level,
    headline: verdict.headline,
    evidence: verdict.evidence.map(e => `${e.detail} (${e.source})`),
    nozzleIndex: args.nozzleIndex,
    nozzleLabel: args.nozzleLabel,
    material: args.material,
    presetName: args.presetName ?? undefined,
    inferred: verdict.inferred
  };
}

export async function renderNewProject(root: HTMLElement): Promise<void> {
  const printers = await listPrinters();
  const settings = loadSettings();

  if (!printers.length) {
    root.append(h('div', { class: 'card', style: 'text-align:center;padding:2rem' },
      h('span', { class: 'placard placard-unlit' }, 'No printer profile'),
      h('h1', { style: 'margin-top:var(--s-4)' }, 'Add a printer first'),
      h('p', { style: 'max-width:56ch;margin:var(--s-3) auto var(--s-5)' },
        'A calibration project needs a printer profile — its nozzle size, temperature limits, and extruder type shape every suggested range.'),
      h('a', { class: 'btn btn-primary', href: '#/printers' }, 'Create a printer profile')
    ));
    return;
  }

  const manufacturer = h('input', { type: 'text', placeholder: 'e.g. Polymaker, eSun, Bambu Lab' });
  const productLine = h('input', { type: 'text', placeholder: 'e.g. PolyLite, PLA+ Pro' });
  const materialSel = h('select', {}, MATERIALS.map(m => h('option', { value: m.id }, m.label)));
  const materialOther = h('input', { type: 'text', placeholder: 'Material name', style: 'display:none' });
  const color = h('input', { type: 'text', placeholder: 'e.g. Galaxy Black' });
  const diameter = h('select', {},
    h('option', { value: '1.75', selected: true }, '1.75 mm'),
    h('option', { value: '2.85' }, '2.85 mm'));
  const printerSel = h('select', {}, printers.map(p => h('option', { value: p.id }, `${p.name} (${p.nozzleDiameter} mm)`)));
  const nozzleType = h('select', {},
    h('option', { value: 'brass' }, 'Brass'),
    h('option', { value: 'hardened steel' }, 'Hardened steel'),
    h('option', { value: 'stainless steel' }, 'Stainless steel'),
    h('option', { value: 'plated/coated' }, 'Plated / coated'),
    h('option', { value: 'ruby/tungsten' }, 'Ruby / tungsten tip'),
    h('option', { value: 'other' }, 'Other / unknown'));
  const startingProfile = h('input', { type: 'text', placeholder: 'e.g. Generic PLA @ your printer', list: 'starting-profile-options' });
  const profileOptions = h('datalist', { id: 'starting-profile-options' });
  // Bambu Studio is the default slicer, not merely the second entry in the list.
  // It is the slicer PerfectFit writes filament presets into directly — per
  // extruder on a dual-nozzle machine — and the bowden-fed auxiliary nozzle that
  // gets no automatic flow-dynamics calibration from the printer is the case
  // this product exists for. Everything else stays one selection away; the list
  // itself is unchanged. The LAST Bambu entry wins, matching how
  // `getSlicerContent` resolves a slicer without a stated version.
  const slicerOptions = slicerVersionOptions();
  const defaultSlicer = slicerOptions.reduce(
    (best, o, i) => (o.slicer === 'bambu' ? i : best), -1);
  const slicerSel = h('select', {}, slicerOptions.map((o, i) =>
    h('option', {
      value: `${o.slicer}|${o.version}`,
      selected: i === (defaultSlicer === -1 ? 0 : defaultSlicer)
    }, o.label)));

  // Desktop: suggest the profiles actually present in the selected slicer,
  // RANKED for this project — brand (or Generic) presets matching the chosen
  // material and printer first, everything else after for advanced users.
  // The scan is cached per slicer; re-ranking on form changes is instant.
  let scannedFor: IntegrationSlicerId | null = null;
  let scannedProfiles: DetectedFilamentProfile[] = [];
  /** name → inheritance node, rebuilt only when a new scan lands. */
  let profileIndex: Map<string, FilamentPresetChainNode> | null = null;
  const indexProfiles = (): Map<string, FilamentPresetChainNode> => {
    if (profileIndex) return profileIndex;
    profileIndex = new Map();
    for (const p of scannedProfiles) {
      profileIndex.set(p.name.toLowerCase(), {
        name: p.name, raw: p.rawProfile, parentName: p.parentProfileName
      });
    }
    return profileIndex;
  };
  const rankProfileOptions = () => {
    clear(profileOptions);
    if (!scannedProfiles.length) return;
    // Score against what the form currently says, via a throwaway project.
    const pseudo: CalibrationProject = createProject({
      filament: {
        manufacturer: manufacturer.value.trim(),
        productLine: '',
        material: materialSel.value as MaterialId,
        materialOther: materialSel.value === 'OTHER' ? materialOther.value.trim() : undefined,
        color: '', diameter: 1.75, startingProfile: ''
      },
      printerProfileId: printerSel.value, nozzleType: '',
      slicer: { slicer: slicerSel.value.split('|')[0] as SlicerId, version: '' },
      notes: '', mode: 'coach'
    });
    const printer = printers.find(p => p.id === printerSel.value);
    rankBaselineNames(scannedProfiles, pseudo, printer)
      .forEach(n => profileOptions.append(h('option', { value: n })));
  };
  const refreshProfileOptions = async () => {
    if (!bridge.isDesktop()) return;
    try {
      const wizSlicer = slicerSel.value.split('|')[0] as IntegrationSlicerId;
      if (scannedFor !== wizSlicer) {
        const installs = await detectInstallations();
        const inst = installs.find(i => i.slicerId === wizSlicer);
        const loc = inst?.userDataLocations.find(l => l.active) ?? inst?.userDataLocations[0];
        if (!inst || !loc) { scannedFor = wizSlicer; scannedProfiles = []; return; }
        const scan = await scanProfiles(inst.slicerId, loc);
        scannedProfiles = scan.profiles;
        profileIndex = null;
        scannedFor = wizSlicer;
      }
      rankProfileOptions();
      refreshCompatibility();
    } catch { /* scan is best-effort; free text always works */ }
  };
  slicerSel.addEventListener('change', () => void refreshProfileOptions());
  [materialSel, printerSel].forEach(el => el.addEventListener('change', rankProfileOptions));
  let rankTimer: ReturnType<typeof setTimeout> | undefined;
  [manufacturer, materialOther].forEach(el => el.addEventListener('input', () => {
    clearTimeout(rankTimer);
    rankTimer = setTimeout(rankProfileOptions, 250);
  }));
  const notes = h('textarea', { placeholder: 'Anything worth remembering about this spool (age, storage, prior drying…)' });
  const dateInput = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });

  const modeCoach = h('input', { type: 'radio', name: 'mode', value: 'coach', checked: settings.defaultMode === 'coach' });
  const modeExpert = h('input', { type: 'radio', name: 'mode', value: 'expert', checked: settings.defaultMode === 'expert' });

  // --- nozzle selector (multi-nozzle printers, e.g. Bambu Lab X2D) ----------
  // Two nozzles are two separate instrument panels: the feed path, not the
  // machine, decides the pressure-advance and retraction envelopes. Picking one
  // here is picking which panel the whole project will calibrate.
  let nozzleChoice = 0;
  const nozzleHost = h('div', {});
  const refreshNozzles = () => {
    clear(nozzleHost);
    nozzleChoice = 0;
    const printer = printers.find(pp => pp.id === printerSel.value);
    // The nozzle count comes from the printer profile's PHYSICAL nozzle list and
    // from nowhere else. It is never derived from a filament preset's value-slot
    // count: a single-nozzle Bambu P2S presents three slots (Standard / High
    // Flow / E3D High Flow hotend variants of one nozzle), and an X2D presents
    // four or six depending on the installed bundle. A single-nozzle machine
    // sees none of this machinery.
    const topo = nozzleTopology(printer);
    if (!topo.perNozzle) {
      // "Several extruders, no nozzle list" is not a second nozzle — it is a
      // profile that has not said enough to calibrate one nozzle at a time.
      if (topo.kind === 'unknown' && topo.note) {
        nozzleHost.append(h('div', { class: 'callout' },
          h('p', { class: 'co-title' }, 'Nozzles not described on this printer profile'),
          h('p', {}, topo.note)));
      }
      return;
    }
    const nozzles = topo.nozzles;
    const group = h('div', { class: 'grid grid-2' }, nozzles.map((n, i) => {
      const radio = h('input', {
        type: 'radio', name: 'nozzle-choice', value: String(i), checked: i === 0,
        onChange: () => { nozzleChoice = i; refreshOoze(); refreshCompatibility(); }
      });
      const caps = [
        n.maxSpeed ? `≤ ${n.maxSpeed} mm/s` : null,
        n.maxAccel ? `≤ ${n.maxAccel} mm/s²` : null
      ].filter((c): c is string => Boolean(c));
      return h('label', { class: 'radio-card' }, radio,
        h('span', { class: 'placard' }, i === 0 ? `Panel ${i + 1} · Main` : `Panel ${i + 1} · Auxiliary`),
        h('span', { class: 'rc-title', style: 'margin-top:var(--s-2)' }, n.label,
          i === 0 ? h('span', { class: 'rc-badge' }, 'default') : null),
        h('span', { class: 'rule-ticks', style: 'display:block;margin:var(--s-2) 0' }),
        h('span', { class: 'proj-vals', style: 'gap:var(--s-2)' },
          h('span', { class: 'placard' }, n.feed === 'bowden' ? 'Bowden / remote feed' : 'Direct drive'),
          caps.map(c => h('span', { class: 'placard' }, c))),
        h('p', { class: 'rc-desc' },
          n.feed === 'bowden'
            // Not "no flexible filaments": that is a flat prohibition, and this
            // app warns rather than prohibits. What the filament is allowed to
            // do on this nozzle is answered below, from the preset data.
            ? 'Wider K (0–1) and retraction (2–6 mm) ranges, and the ooze-control step is pre-selected below. Compatibility for the filament you chose is checked against your slicer\'s own presets underneath.'
            : 'Standard test ranges — the extruder motor sits on the toolhead, so the pressure response is short and predictable.'));
    }));
    nozzleHost.append(h('fieldset', {},
      h('legend', {}, 'Nozzle under calibration *'),
      h('p', { class: 'field-help', style: 'margin-top:0' },
        'Which nozzle does this project calibrate? Each physical nozzle needs its own calibration — the feed path changes pressure advance and retraction completely.'),
      group,
      topo.note ? h('p', { class: 'field-help', style: 'color:var(--warn)' }, `⚠ ${topo.note}`) : null));
  };

  // --- filament / nozzle compatibility --------------------------------------
  // Read out of the installed presets, not out of a list carried in this app: a
  // list goes stale the moment the vendor ships a new bundle, and it cannot
  // explain itself. Every level short of "clear" is a warning the user can
  // override — they own the printer — and an override is recorded on the
  // project so nothing written later reads as an endorsement.
  let compatVerdict: CompatibilityVerdict | null = null;
  let compatPresetName: string | null = null;
  let compatAcknowledged = false;
  const compatHost = h('div', {});

  /** Resolved facts for whatever preset the "starting profile" field names. */
  const compatFacts = (extruderIndex: number): {
    facts?: FilamentPresetFacts; advisory: VendorCompatibilityAdvisory | null;
  } => {
    const wanted = startingProfile.value.trim().toLowerCase();
    if (!wanted || !scannedProfiles.length) return { advisory: null };
    const index = indexProfiles();
    const start = index.get(wanted);
    if (!start) return { advisory: null };
    // A user's preset is nearly always a delta: its compatibility keys live in
    // the parent it inherits from, so the chain is walked before anything is read.
    const facts = resolveFilamentPresetFacts(start, n => index.get(n.toLowerCase()));
    if (facts.annotated) return { facts, advisory: null };
    // Unannotated preset: look for the vendor's own preset for the same
    // material label on the same printer. Pre-filtered by name so only a
    // handful of candidates are ever parsed.
    const mine = splitPresetName(facts.scopedName ?? facts.name ?? '');
    if (!mine) return { facts, advisory: null };
    const candidates = scannedProfiles
      .filter(p => {
        const s = splitPresetName(p.name);
        return !!s && s.scope === mine.scope
          && s.label.toLowerCase() === mine.label.toLowerCase()
          && s.vendor.toLowerCase() !== mine.vendor.toLowerCase();
      })
      .map(p => ({ name: p.name, facts: readFilamentPresetFacts(p.rawProfile, p.name) }));
    return {
      facts,
      advisory: vendorAnnotatedSibling({ name: facts.name ?? start.name, facts }, candidates, extruderIndex)
    };
  };

  const refreshCompatibility = (): void => {
    clear(compatHost);
    compatVerdict = null;
    compatPresetName = null;
    compatAcknowledged = false;
    const printer = printers.find(pp => pp.id === printerSel.value);
    const topo = nozzleTopology(printer);
    // On a machine whose nozzles are not described, there is no "second nozzle"
    // to reason about — say nothing rather than reason about a guess.
    if (topo.kind === 'unknown') return;
    const index = topo.perNozzle ? nozzleChoice : 0;
    const nozzle = topo.nozzles[index];
    const material = getMaterial(materialSel.value);
    const { facts, advisory } = compatFacts(index);
    const v = nozzleFilamentVerdict({
      extruderIndex: index,
      nozzleLabel: nozzle?.label,
      feed: nozzle?.feed ?? printer?.extruderType,
      material,
      filament: facts,
      vendorAdvisory: advisory
    });
    compatVerdict = v;
    compatPresetName = facts?.name ?? null;
    if (!showsCompatibilityPanel(v, topo.perNozzle)) return;

    const tone = v.level === 'blocked' || v.level === 'critical' ? ' callout-bad'
      : v.level === 'caution' ? ' callout-warn' : '';
    const title = {
      blocked: '⛔ Marked unusable on this nozzle',
      critical: '⚠ Marked highly not recommended',
      caution: '⚠ Marked not recommended',
      clear: 'Listed as available on this nozzle',
      unknown: 'Compatibility unknown'
    }[v.level];

    const ackBox = h('input', {
      type: 'checkbox',
      onChange: () => { compatAcknowledged = ackBox.checked; }
    });
    compatHost.append(h('div', { class: `callout${tone}` },
      h('p', { class: 'co-title' }, title),
      h('p', {}, v.headline),
      v.evidence.length
        ? h('ul', { class: 'issues' }, v.evidence.map(e => h('li', {
            class: `issue ${e.inferred ? 'issue-warning' : ''}`
          },
          h('span', { class: e.inferred ? 'placard' : 'placard placard-lit' }, e.inferred ? 'Deduced' : 'Read'),
          h('span', {}, ` ${e.detail} `,
            h('span', { class: 'readout-label' }, `(${e.source})`)))))
        : null,
      v.level === 'unknown'
        ? h('p', { class: 'field-help' },
            'Pick the exact preset you calibrate from in "Starting filament profile" and this reads whatever your slicer has on disk. Until then there is nothing to read — which is not the same as nothing being wrong.')
        : null,
      v.needsAcknowledgement
        ? h('div', { class: 'check-item', style: 'margin-top:var(--s-3)' }, ackBox,
            h('div', {},
              h('strong', {}, 'Calibrate this combination anyway'),
              h('p', { class: 'field-help', style: 'margin:.2rem 0 0' },
                'You own the printer, so this is your call — nothing here stops you. Ticking it records the warning on the project, so the report and the later steps keep saying which combination these values came from.')))
        : null
    ));
  };
  // --- optional steps -------------------------------------------------------
  // The ooze-control checklist is NOT in DEFAULT_ORDER and must never be: it
  // would rewrite the plan of every project already saved and drop every one of
  // their confidence scores. It is opt-in per project instead — pre-ticked for a
  // bowden-fed auxiliary nozzle, which is exactly the rule that used to be the
  // only way to get it, and now reachable on any machine, because drool during
  // an ordinary single-material print is not a dual-nozzle problem.
  let oozeChoice = false;
  let oozeTouched = false;
  const oozeHost = h('div', {});
  const refreshOoze = (): void => {
    clear(oozeHost);
    const printer = printers.find(pp => pp.id === printerSel.value);
    const nozzles = printer?.nozzles ?? [];
    const auto = nozzles.length >= 2 && nozzles[nozzleChoice]?.feed === 'bowden';
    if (!oozeTouched) oozeChoice = auto;
    const def = CALIBRATIONS['ooze-control'];
    const box = h('input', {
      type: 'checkbox', checked: oozeChoice,
      onChange: () => { oozeChoice = box.checked; oozeTouched = true; }
    });
    oozeHost.append(h('fieldset', {},
      h('legend', {}, 'Optional step'),
      h('div', { class: 'check-item' }, box,
        h('div', {},
          h('strong', {}, `${def.icon} ${def.name}`),
          h('p', { class: 'field-help', style: 'margin:.2rem 0 0' },
            auto
              ? 'Added by default for a bowden-fed auxiliary nozzle. It is a checklist and one verification print, not a number to find.'
              : 'A checklist and one verification print for drips, blobs and smears. It is written around dual-nozzle toolchanges, so some of its checks will not apply on a single-nozzle machine — the drying and retraction ones do. Untick it and the plan is unchanged.'))),
      h('p', { class: 'field-help', style: 'margin-top:var(--s-2)' },
        'Optional steps can be reordered or skipped later, and they only count toward this project\'s progress.')));
  };

  printerSel.addEventListener('change', () => { refreshNozzles(); refreshOoze(); refreshCompatibility(); });
  materialSel.addEventListener('change', refreshCompatibility);
  let compatTimer: ReturnType<typeof setTimeout> | undefined;
  startingProfile.addEventListener('input', () => {
    clearTimeout(compatTimer);
    compatTimer = setTimeout(refreshCompatibility, 250);
  });
  refreshNozzles();
  refreshOoze();
  refreshCompatibility();
  void refreshProfileOptions();

  const materialInfo = h('div', {});
  const refreshMaterialInfo = () => {
    clear(materialInfo);
    const m = getMaterial(materialSel.value);
    materialOther.style.display = materialSel.value === 'OTHER' ? '' : 'none';
    const printer = printers.find(p => p.id === printerSel.value);
    const warnings = [...m.warnings];
    if (printer && m.nozzleTemp.min > printer.maxNozzleTemp) {
      warnings.unshift(`This material typically needs ${m.nozzleTemp.min}–${m.nozzleTemp.max} °C, but "${printer.name}" is limited to ${printer.maxNozzleTemp} °C. It likely cannot print this material safely.`);
    }
    if (printer && m.bedTemp.min > printer.maxBedTemp) {
      warnings.push(`Typical bed temps (${m.bedTemp.min}–${m.bedTemp.max} °C) exceed this printer's bed limit (${printer.maxBedTemp} °C).`);
    }
    // Chamber-aware guidance uses the printer database's heatedChamber field
    // when it's known. Absent/undefined means "not specified" — stay silent.
    if (printer && m.enclosureRecommended && printer.heatedChamber === false) {
      warnings.push(`${m.label} warps without a warm, enclosed build space, and "${printer.name}" has no heated chamber. An enclosure (even passive) helps; expect warping otherwise.`);
    }
    // The chamber is guidance, never a step and never a written value — but the
    // one instruction that damages hardware if generalised, so it is per
    // material and it is stated here where the material is chosen.
    const chamber = suggestChamberTemp(m.id, printer);
    const canHeat = printerCanHeatChamber(printer);
    const chamberWorthSaying = chamber.advice !== 'ambient' || canHeat;
    if (chamber.advice === 'ambient' && canHeat) {
      warnings.push(chamber.warnings.join(' '));
    }
    const chamberPlacard = !chamberWorthSaying
      ? null
      : chamber.advice === 'ambient'
        ? 'Chamber off'
        : chamber.suggestedC !== undefined
          ? `Chamber ${chamber.suggestedC} °C`
          : null;
    materialInfo.append(
      h('div', { class: 'panel' },
        h('p', { style: 'margin:.2rem 0' }, h('strong', {}, m.label), ` — ${m.description}`),
        tempBand(m.label, m.nozzleTemp.min, m.nozzleTemp.max),
        h('p', { class: 'proj-vals', style: 'gap:var(--s-2);margin:var(--s-3) 0 0' },
          h('span', { class: 'placard' }, `Bed ${m.bedTemp.min}–${m.bedTemp.max} °C`),
          chamberPlacard ? h('span', { class: 'placard' }, chamberPlacard) : null,
          m.hygroscopic ? h('span', { class: 'placard' }, 'Moisture-sensitive') : null,
          m.enclosureRecommended ? h('span', { class: 'placard' }, 'Enclosure recommended') : null,
          m.flexible ? h('span', { class: 'placard' }, 'Flexible') : null),
        chamberWorthSaying
          ? h('p', { class: 'field-help', style: 'margin-top:var(--s-2)' }, chamber.headline)
          : null,
        h('p', { class: 'field-help' }, 'These are suggested starting points, not guarantees — spool labels and datasheets win. Every range stays editable later.'),
        warnings.length ? h('ul', { class: 'issues' }, warnings.map(w =>
          h('li', { class: 'issue issue-warning' }, h('span', { class: 'issue-icon' }, '⚠'), w))) : null
      )
    );
  };
  materialSel.addEventListener('change', refreshMaterialInfo);
  printerSel.addEventListener('change', refreshMaterialInfo);
  refreshMaterialInfo();

  const issuesHost = h('div', {});

  root.append(
    h('h1', {}, 'New calibration project'),
    h('p', { class: 'field-help' },
      'Three panels of setup, then the instruments go dark until you measure them. Nothing here is locked in — every range stays editable once the project exists.'),
    h('div', { class: 'card' },
      h('h2', {}, 'Filament'),
      h('div', { class: 'field-row' },
        field('Manufacturer *', manufacturer),
        field('Product / line', productLine),
        field('Color', color)
      ),
      h('div', { class: 'field-row' },
        field('Material type *', materialSel),
        field('Other material name', materialOther),
        field('Diameter', diameter)
      ),
      materialInfo
    ),
    h('div', { class: 'card' },
      h('h2', {}, 'Printer & slicer'),
      h('div', { class: 'field-row' },
        field('Printer profile *', printerSel),
        field('Nozzle type / material', nozzleType, 'Abrasive filaments (CF/GF) need hardened nozzles.')
      ),
      nozzleHost,
      compatHost,
      oozeHost,
      h('div', { class: 'field-row' },
        field('Slicer & version *', slicerSel, 'Instructions are version-aware; pick what you actually run.'),
        field('Starting filament profile', startingProfile, 'The preset you\'ll be modifying as you calibrate — usually a "Generic <material>" profile. Each test will remind you to save values into THIS preset. (Desktop app: suggestions come from the profiles detected in your slicer.)'),
        field('Calibration date', dateInput)
      ),
      profileOptions
    ),
    h('div', { class: 'card' },
      h('h2', {}, 'Guidance level'),
      h('div', { class: 'grid grid-2' },
        h('label', { class: 'radio-card' }, modeCoach,
          h('span', { class: 'rc-title' }, '🧭 Coach Mode', h('span', { class: 'rc-badge' }, 'recommended')),
          h('p', { class: 'rc-desc' }, 'Plain-language explanations, good/bad examples, confidence checks, and adaptive troubleshooting. Pick this unless you\'ve calibrated filaments before.')),
        h('label', { class: 'radio-card' }, modeExpert,
          h('span', { class: 'rc-title' }, '⚙ Expert Mode'),
          h('p', { class: 'rc-desc' }, 'Straight to ranges, formulas, and profile destinations with minimal hand-holding. You can switch modes anytime.'))
      ),
      field('Notes', notes),
      issuesHost,
      h('div', { class: 'btn-row' },
        h('a', { class: 'btn', href: '#/' }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary', onClick: async () => {
            const issues: { level: 'error' | 'warning'; message: string }[] = [];
            if (!manufacturer.value.trim()) issues.push({ level: 'error', message: 'Manufacturer is required (write "Unknown" if the spool is unbranded).' });
            if (materialSel.value === 'OTHER' && !materialOther.value.trim()) issues.push({ level: 'error', message: 'Name the material when choosing "Other".' });
            issues.push(...compatibilityGateIssues(compatVerdict, compatAcknowledged));
            clear(issuesHost);
            if (issues.length) { const l = issueList(issues); if (l) issuesHost.append(l); return; }

            const [slicer, version] = slicerSel.value.split('|');
            const project = createProject({
              filament: {
                manufacturer: manufacturer.value.trim(),
                productLine: productLine.value.trim(),
                material: materialSel.value as MaterialId,
                materialOther: materialSel.value === 'OTHER' ? materialOther.value.trim() : undefined,
                color: color.value.trim(),
                diameter: Number(diameter.value),
                startingProfile: startingProfile.value.trim()
              },
              printerProfileId: printerSel.value,
              nozzleType: nozzleType.value,
              slicer: { slicer: slicer as SlicerId, version },
              notes: notes.value,
              mode: (modeExpert.checked ? 'expert' : 'coach') as ExperienceMode
            });
            project.calibrationDate = dateInput.value || project.calibrationDate;

            // Multi-nozzle printers: record which nozzle this project calibrates.
            // `perNozzle` (physical nozzles, from the printer profile) is the
            // only thing that may decide this — never a preset's slot count.
            const printer = printers.find(pp => pp.id === printerSel.value);
            const topo = nozzleTopology(printer);
            if (topo.perNozzle) project.nozzleIndex = nozzleChoice;
            // The override is the user's decision, so it is stored as theirs:
            // the level, the headline and the evidence exactly as shown.
            const overrideIndex = topo.perNozzle ? nozzleChoice : 0;
            const override = compatibilityOverrideRecord({
              verdict: compatVerdict,
              acknowledged: compatAcknowledged,
              nozzleIndex: overrideIndex,
              nozzleLabel: topo.nozzles[overrideIndex]?.label,
              material: materialSel.value as MaterialId,
              presetName: compatPresetName
            });
            if (override) project.compatibilityOverride = override;
            // The ooze-control step is opt-in and stays out of DEFAULT_ORDER, so
            // no existing project's plan or confidence score is touched by its
            // existence. Pre-ticked for a bowden aux nozzle, which reproduces
            // the old automatic behaviour exactly.
            if (oozeChoice) project.stepOrder = withOptionalStep(project.stepOrder, 'ooze-control');

            await saveProject(project);
            toast('Project created — let\'s calibrate.', 'success');
            navigate(`#/project/${project.id}`);
          }
        }, 'Create project →')
      )
    )
  );
}

/**
 * The material's typical nozzle-temperature envelope, drawn as a suggested band
 * on a fixed scale. It is deliberately UNLIT: no tower has been run yet, so
 * there is no measured mark to place — only the band the tower will aim into.
 */
function tempBand(materialLabel: string, min: number, max: number): HTMLElement {
  const span = TEMP_SCALE_MAX - TEMP_SCALE_MIN;
  const at = (v: number) => Math.min(100, Math.max(0, ((v - TEMP_SCALE_MIN) / span) * 100));
  const lo = at(min), hi = at(max), mid = (lo + hi) / 2;
  return h('div', {
    class: 'band is-unlit',
    style: `--lo:${lo.toFixed(1)}%;--hi:${hi.toFixed(1)}%;--at:${mid.toFixed(1)}%;--mid:${mid.toFixed(1)}%`
  },
    h('div', { class: 'band-track' },
      h('span', { class: 'band-span' }),
      h('span', { class: 'band-drift' }),
      h('span', { class: 'band-mark' })),
    h('div', { class: 'band-scale' },
      h('span', {}, `${TEMP_SCALE_MIN} °C`),
      h('span', {}, `${TEMP_SCALE_MAX} °C`)),
    h('p', { class: 'band-legend' },
      `Typical nozzle temperature for ${materialLabel} is ${min}–${max} °C. Nothing is measured yet — the temperature tower places the mark inside this band.`));
}
