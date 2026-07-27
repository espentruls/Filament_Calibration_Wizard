import { h, clear, field, numberInput, issueList, confirmDialog, toast } from './dom';
import { listPrinters, savePrinter, deletePrinter, listProjects, uid } from '../storage/store';
import { validateNumber } from '../logic/validation';
import {
  groupedPrinterSpecs, getPrinterSpec, specLabel, profileValuesFromSpec, PRINTER_DB_COUNT,
  isSpecRefreshAvailable, specChangesForProfile, refreshProfileFromDatabase
} from '../data/printerDatabase';
import type { PrinterProfile, ExtruderType, NozzleProfile, PrinterSpecification } from '../types';

// --- machine-limit provenance ----------------------------------------------
// The shipped database does not publish a max nozzle temperature for most of
// its records (the corrupted rows were replaced with null rather than guesses),
// and the same is true of max bed temperature. The editor still has to put SOME
// number in those required fields, so it uses the conservative values below —
// which are NOT specifications and must never be presented as database data.
// Every downstream clamp trusts PrinterProfile.maxNozzleTemp, so a fabricated
// limit wearing a database badge is worse than an obviously absent one.

/** Conservative stand-in when nothing publishes a nozzle limit. Not a spec. */
export const FALLBACK_MAX_NOZZLE_TEMP = 260;
/** Conservative stand-in when nothing publishes a bed limit. Not a spec. */
export const FALLBACK_MAX_BED_TEMP = 100;

export interface LimitProvenance {
  key: 'maxNozzleTemp' | 'maxBedTemp' | 'maxVolumetricFlow';
  label: string;
  unit: string;
  /** True when this database record genuinely carries the limit. */
  fromDatabase: boolean;
  /** What the form falls back to when it does not (undefined = left empty). */
  fallback?: number;
}

const LIMIT_FIELDS: { key: LimitProvenance['key']; label: string; unit: string; fallback?: number }[] = [
  { key: 'maxNozzleTemp', label: 'Max nozzle temp', unit: '°C', fallback: FALLBACK_MAX_NOZZLE_TEMP },
  { key: 'maxBedTemp', label: 'Max bed temp', unit: '°C', fallback: FALLBACK_MAX_BED_TEMP },
  { key: 'maxVolumetricFlow', label: 'Max volumetric flow', unit: 'mm³/s' }
];

/** Which machine limits a database record actually publishes. */
export function limitProvenance(spec: PrinterSpecification | null | undefined): LimitProvenance[] {
  const values = spec ? profileValuesFromSpec(spec) : {};
  return LIMIT_FIELDS.map(f => ({ ...f, fromDatabase: spec ? f.key in values : false }));
}

/**
 * Sentence naming the limits this record does NOT publish, and what the form
 * put there instead. Null when the record carries every limit that has a
 * fallback (max volumetric flow is simply left empty, which reads as unknown).
 */
export function unpublishedLimitsNote(spec: PrinterSpecification | null | undefined): string | null {
  const missing = limitProvenance(spec).filter(l => !l.fromDatabase && l.fallback !== undefined);
  if (!missing.length) return null;
  const parts = missing.map(l => `${l.label} (${l.fallback} ${l.unit})`).join(' and ');
  return `This database record does not publish ${missing.length === 1 ? 'one limit' : 'these limits'}: ${parts}. `
    + 'Those figures are PerfectFit\'s conservative fallback — NOT FROM THE DATABASE and not a specification for this machine. '
    + 'Check the value against your own hotend/bed rating and correct it: PTFE-lined hotends are often rated 240–250 °C, and every temperature suggestion in the app is capped by whatever is in this field.';
}

/** Text for the "filled from database" badge — never claims limits it lacks. */
export function specFillBadgeText(spec: PrinterSpecification): string {
  const missing = limitProvenance(spec).filter(l => !l.fromDatabase && l.fallback !== undefined);
  const base = `✓ Filled from database: ${specLabel(spec)}. Review and change any value for modified or custom hardware.`;
  if (!missing.length) return base;
  return `${base} Note: ${missing.map(l => l.label).join(' and ')} ${missing.length === 1 ? 'is' : 'are'} NOT PUBLISHED for this record — see the warning below the field.`;
}

export async function renderPrinters(root: HTMLElement): Promise<void> {
  const printers = await listPrinters();

  root.append(
    h('div', { style: 'display:flex;align-items:center;gap:var(--s-4);flex-wrap:wrap' },
      h('h1', { style: 'margin:0;flex:1' }, 'Printer profiles'),
      h('button', { class: 'btn btn-primary', onClick: () => openEditor(root, null) }, '＋ Add printer')
    ),
    h('p', { class: 'field-help' },
      `Calibration projects reference a printer profile. Its limits (max temps, max flow) are used to warn you before any suggested setting could exceed what the machine can safely do. Pick from ${PRINTER_DB_COUNT.toLocaleString()} known printers to fill the specs in automatically, or enter your own.`),
    h('hr', { class: 'rule-ticks' })
  );

  if (!printers.length) {
    root.append(h('div', { class: 'card', style: 'text-align:center;padding:2rem' },
      h('span', { class: 'placard placard-unlit' }, 'No printers on file'),
      h('p', { style: 'max-width:58ch;margin:var(--s-4) auto var(--s-5)' },
        'No printers yet. Add the printer you\'ll calibrate on — nozzle size, temperature limits, and extruder type drive the suggested test ranges.'),
      h('button', { class: 'btn btn-primary', onClick: () => openEditor(root, null) }, 'Add your first printer')
    ));
    return;
  }

  root.append(h('div', { class: 'grid grid-cards' }, printers.map(p => {
    // Which of this card's limits the linked database record actually carries.
    // A profile can be database-linked and still hold fallback numbers.
    const backed = new Set(
      limitProvenance(p.databasePrinterId ? getPrinterSpec(p.databasePrinterId) : null)
        .filter(l => l.fromDatabase).map(l => l.key));
    const unbackedLimits = p.databasePrinterId
      ? limitProvenance(getPrinterSpec(p.databasePrinterId)).filter(l => !l.fromDatabase && l.fallback !== undefined)
      : [];
    return h('div', { class: 'card' },
      h('h3', {}, p.name),
      h('p', { class: 'proj-vals', style: 'gap:var(--s-2)' },
        p.manufacturer ? h('span', { class: 'placard' }, p.manufacturer) : null,
        h('span', { class: 'placard' }, `${p.nozzleDiameter} mm nozzle`),
        // A machine-level feed type is a lie on a multi-nozzle machine: the X2D
        // is direct on nozzle 1 and bowden on nozzle 2, so a single "DIRECT
        // DRIVE" placard would sit directly above a "BOWDEN FEED" nozzle panel
        // contradicting it. When there is more than one nozzle, the per-nozzle
        // panels below are the only statement about feed.
        (p.nozzles?.length ?? 0) > 1
          ? null
          : h('span', { class: 'placard' }, p.extruderType === 'direct' ? 'Direct drive' : 'Bowden'),
        p.databasePrinterId
          ? h('span', { class: `badge ${unbackedLimits.length ? 'badge-info' : 'badge-ok'}` },
              unbackedLimits.length ? '✓ Database specs (some limits unpublished)' : '✓ Database specs')
          : h('span', { class: 'badge badge-info' }, '✎ Manually configured')),
      h('div', { class: 'panel', style: 'padding:0 var(--s-3)' },
        h('table', { class: 'data' }, h('tbody', {},
          specRow('Max nozzle', p.maxNozzleTemp, '°C', !!p.databasePrinterId && !backed.has('maxNozzleTemp')),
          specRow('Max bed', p.maxBedTemp, '°C', !!p.databasePrinterId && !backed.has('maxBedTemp')),
          specRow('Max flow', p.maxVolumetricFlow, 'mm³/s')))),
      unbackedLimits.length
        ? h('p', { class: 'field-help', style: 'color:var(--warn)' },
            `⚠ ${unbackedLimits.map(l => l.label).join(' and ')} ${unbackedLimits.length === 1 ? 'is' : 'are'} not published in the database for this printer — the value shown is PerfectFit's conservative fallback, not a spec. Edit the profile and set your hardware's own rating.`)
        : null,
      p.nozzles?.length ? nozzlePanels(p.nozzles) : null,
      p.notes ? h('p', { class: 'field-help' }, p.notes) : null,
      refreshCallout(root, p),
      h('div', { class: 'proj-actions' },
        h('button', { class: 'btn btn-sm', onClick: () => openEditor(root, p) }, '✎ Edit'),
        h('button', {
          class: 'btn btn-sm btn-danger', onClick: async () => {
            const projects = await listProjects();
            const used = projects.filter(pr => pr.printerProfileId === p.id).length;
            const ok = await confirmDialog({
              title: 'Delete printer profile?',
              body: used
                ? `"${p.name}" is referenced by ${used} project(s). Deleting it won't delete those projects, but they'll lose their printer limits and range suggestions.`
                : `Remove "${p.name}" from this device?`,
              confirmLabel: 'Delete', danger: true
            });
            if (!ok) return;
            await deletePrinter(p.id);
            clear(root); await renderPrinters(root);
          }
        }, '🗑 Delete')
      )
    );
  })));
}

// --- equipment placards ------------------------------------------------------

/**
 * One machine limit as a labelled readout. An unpublished limit reads UNLIT —
 * the app genuinely does not know it, and a dash says so where a zero would lie.
 * `unbacked` marks a value the database never supplied, so a database-linked
 * card cannot pass a fallback off as a published specification.
 */
function specRow(label: string, value: number | undefined, unit: string, unbacked = false): HTMLElement {
  const known = value !== undefined && Number.isFinite(value);
  return h('tr', {},
    h('th', { scope: 'row' },
      h('span', { class: 'readout-label' }, label),
      unbacked ? h('span', { class: 'readout-label', style: 'color:var(--warn)' }, ' · fallback, not from database') : null),
    h('td', { style: 'text-align:right' },
      h('span', { class: `readout${known ? '' : ' is-unlit'}` },
        h('b', { class: 'readout-value', style: 'font-size:1.05rem' }, known ? String(value) : '—'),
        h('i', { class: 'readout-unit' }, unit))));
}

/** Two nozzles are two panels: each physical path gets its own placard. */
function nozzlePanels(nozzles: NozzleProfile[]): HTMLElement {
  return h('div', { class: 'grid grid-2', style: 'margin-top:var(--s-3)' }, nozzles.map((n, i) =>
    h('div', { class: 'panel', style: 'margin:0' },
      h('span', { class: 'placard' }, i === 0 ? `Nozzle ${i + 1} · Main` : `Nozzle ${i + 1} · Auxiliary`),
      h('p', { class: 'proj-title', style: 'font-size:.88rem;margin:var(--s-2) 0 0' }, n.label),
      h('p', { class: 'proj-vals', style: 'gap:var(--s-2);margin:var(--s-2) 0 0' },
        h('span', { class: 'badge badge-info' }, n.feed === 'bowden' ? 'Bowden feed' : 'Direct drive'),
        n.maxSpeed ? h('span', { class: 'badge badge-info' }, `≤ ${n.maxSpeed} mm/s`) : null,
        n.maxAccel ? h('span', { class: 'badge badge-info' }, `≤ ${n.maxAccel} mm/s²`) : null))));
}

// --- searchable printer combobox -------------------------------------------

/**
 * Minimal dependency-free searchable combobox: a text input plus a grouped,
 * scrollable results panel. Manufacturers are grouped and alphabetical; models
 * are alphabetical within each. Supports type-to-filter and keyboard nav
 * (Arrow keys, Enter, Escape). Calls onSelect with the chosen spec.
 */
function printerCombobox(onSelect: (spec: PrinterSpecification) => void): { root: HTMLElement; input: HTMLInputElement } {
  const input = h('input', {
    type: 'text', role: 'combobox', 'aria-expanded': 'false', 'aria-autocomplete': 'list',
    autocomplete: 'off', placeholder: 'Search by brand or model — e.g. "X1", "Ender 3", "Qidi"'
  });
  const panel = h('div', { class: 'combo-panel', role: 'listbox', style: 'display:none' });
  const wrap = h('div', { class: 'combo', style: 'position:relative' }, input, panel);

  let items: HTMLElement[] = [];
  let active = -1;

  const close = () => { panel.style.display = 'none'; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const setActive = (i: number) => {
    items.forEach(el => el.classList.remove('combo-active'));
    active = Math.max(-1, Math.min(i, items.length - 1));
    if (active >= 0) { items[active].classList.add('combo-active'); items[active].scrollIntoView({ block: 'nearest' }); }
  };

  const render = () => {
    clear(panel);
    items = [];
    const groups = groupedPrinterSpecs(input.value);
    if (!groups.length) {
      panel.append(h('div', { class: 'combo-empty' }, 'No matching printer. Use “My printer is not listed” below.'));
    }
    let shown = 0;
    for (const g of groups) {
      if (shown > 400) break; // keep the DOM light for very broad queries
      panel.append(h('div', { class: 'combo-group' }, g.manufacturer));
      for (const spec of g.printers) {
        const model = spec.model.toLowerCase().startsWith(g.manufacturer.toLowerCase() + ' ')
          ? spec.model.slice(g.manufacturer.length + 1) : spec.model;
        const opt = h('div', { class: 'combo-item', role: 'option', tabindex: '-1' }, model);
        opt.addEventListener('mousedown', e => { e.preventDefault(); onSelect(spec); input.value = specLabel(spec); close(); });
        panel.append(opt);
        items.push(opt);
        shown++;
      }
    }
    panel.style.display = 'block';
    input.setAttribute('aria-expanded', 'true');
    setActive(items.length ? 0 : -1);
  };

  input.addEventListener('focus', render);
  input.addEventListener('input', render);
  input.addEventListener('keydown', e => {
    const k = (e as KeyboardEvent).key;
    if (k === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (k === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (k === 'Enter') {
      if (active >= 0 && items[active]) { e.preventDefault(); (items[active] as HTMLElement).dispatchEvent(new MouseEvent('mousedown')); }
    } else if (k === 'Escape') { close(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));

  return { root: wrap, input };
}

// --- refreshing specs after a database correction ---------------------------

/**
 * Offer to re-apply database specs when the shipped database has been revised
 * since this profile was filled. Shows the exact before/after per field and
 * only writes on confirmation — the app doesn't know which values a user
 * hand-tuned for modified hardware, so it must not overwrite silently.
 *
 * Refreshing keeps the profile id, so projects referencing this printer stay
 * linked. (Deleting and re-adding would mint a new id and orphan them.)
 */
function refreshCallout(root: HTMLElement, p: PrinterProfile): HTMLElement | null {
  if (!isSpecRefreshAvailable(p)) return null;
  // The database moved on, but this particular printer's values may be
  // unaffected — say nothing unless something actually differs. Recomputed per
  // render rather than written back, so rendering stays side-effect free.
  const changes = specChangesForProfile(p);
  if (!changes.length) return null;
  return h('div', { class: 'callout callout-warn' },
    h('p', { class: 'co-title' }, '↻ Updated specs available for this printer'),
    h('p', {}, `The printer database has been corrected since these specs were saved. ${changes.length} value${changes.length === 1 ? '' : 's'} differ${changes.length === 1 ? 's' : ''} from the current data.`),
    h('button', {
      class: 'btn btn-sm btn-primary', onClick: async () => {
        const ok = await confirmDialog({
          title: `Refresh specs for ${p.name}?`,
          body: 'These values will be replaced with the current database data. Your printer name, notes, retraction range, and nozzle list are kept, and projects using this printer stay linked.\n\n'
            + changes.map(c => `• ${c.label}: ${c.from} → ${c.to}`).join('\n')
            + '\n\nAnything you changed by hand for modified hardware will be overwritten — cancel and edit the fields directly if you\'d rather keep your own values.',
          confirmLabel: 'Refresh specs'
        });
        if (!ok) return;
        await savePrinter(refreshProfileFromDatabase(p));
        toast(`Specs refreshed for ${p.name}.`, 'success');
        clear(root); await renderPrinters(root);
      }
    }, 'Review and refresh')
  );
}

// --- editor ----------------------------------------------------------------

function openEditor(root: HTMLElement, existing: PrinterProfile | null): void {
  // Working copy holding all values, including extended specs not shown as
  // top-level inputs but persisted and used by the calibration workflow.
  const p: PrinterProfile = existing
    ? {
      ...existing,
      retractionRange: { ...existing.retractionRange },
      buildVolume: existing.buildVolume ? { ...existing.buildVolume } : undefined,
      nozzles: existing.nozzles?.map(n => ({ ...n }))
    }
    : {
      id: uid(), name: '', manufacturer: '', nozzleDiameter: 0.4,
      // Conservative fallbacks, not specifications — flagged as such in the
      // editor (see limitNotes below) so no clamp inherits a false provenance.
      maxNozzleTemp: FALLBACK_MAX_NOZZLE_TEMP, maxBedTemp: FALLBACK_MAX_BED_TEMP,
      maxVolumetricFlow: undefined,
      extruderType: 'direct', retractionRange: { start: 0, end: 2 },
      notes: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      isManual: true
    };

  const name = h('input', { type: 'text', value: p.name, placeholder: 'e.g. Bambu Lab P1S, Ender 3 v2' });
  const manufacturer = h('input', { type: 'text', value: p.manufacturer, placeholder: 'e.g. Bambu Lab' });
  const nozzle = numberInput({ value: p.nozzleDiameter, step: 0.05, min: 0.1, max: 2 });
  const maxNozzleTemp = numberInput({ value: p.maxNozzleTemp, step: 5, min: 150, max: 500 });
  const maxBedTemp = numberInput({ value: p.maxBedTemp, step: 5, min: 0, max: 200 });
  const maxFlow = numberInput({ value: p.maxVolumetricFlow ?? '', step: 0.5, min: 1, max: 100, placeholder: 'leave empty if unknown' });
  const extruder = h('select', {},
    h('option', { value: 'direct', selected: p.extruderType === 'direct' }, 'Direct drive'),
    h('option', { value: 'bowden', selected: p.extruderType === 'bowden' }, 'Bowden'));
  const retrStart = numberInput({ value: p.retractionRange.start, step: 0.1, min: 0, max: 10 });
  const retrEnd = numberInput({ value: p.retractionRange.end, step: 0.1, min: 0, max: 15 });
  const notes = h('textarea', { placeholder: 'Hotend mods, firmware, anything future-you should know' }, p.notes);

  // --- advanced (extended machine specs) -----------------------------------
  const maxChamber = numberInput({ value: p.maxChamberTemp ?? '', step: 5, min: 0, max: 120, placeholder: 'not specified' });
  const heatedChamber = h('select', {},
    h('option', { value: '', selected: p.heatedChamber === undefined }, 'Not specified'),
    h('option', { value: 'yes', selected: p.heatedChamber === true }, 'Yes — actively heated'),
    h('option', { value: 'no', selected: p.heatedChamber === false }, 'No'));
  const supportedNozzles = h('input', { type: 'text', value: (p.supportedNozzleDiameters ?? []).join(', '), placeholder: 'e.g. 0.2, 0.4, 0.6, 0.8' });
  const bvx = numberInput({ value: p.buildVolume?.x ?? '', step: 1, min: 0, placeholder: 'X' });
  const bvy = numberInput({ value: p.buildVolume?.y ?? '', step: 1, min: 0, placeholder: 'Y' });
  const bvz = numberInput({ value: p.buildVolume?.z ?? '', step: 1, min: 0, placeholder: 'Z' });
  const maxSpeed = numberInput({ value: p.maxPrintSpeed ?? '', step: 10, min: 0, placeholder: 'not specified' });
  const maxAccel = numberInput({ value: p.maxAcceleration ?? '', step: 100, min: 0, placeholder: 'not specified' });
  const firmware = h('input', { type: 'text', value: p.firmware ?? '', placeholder: 'e.g. Klipper, Marlin' });
  const extruderCount = numberInput({ value: p.extruderCount ?? '', step: 1, min: 1, max: 8, placeholder: '1' });
  const mmu = h('input', { type: 'text', value: p.multiMaterialCompatibility ?? '', placeholder: 'e.g. AMS, MMU3 — leave blank if none' });

  const issuesHost = h('div', {});
  const dbBadge = h('p', { class: 'field-help', style: 'display:none;color:var(--radio-green)' });

  // Per-field provenance warnings. The database publishes no nozzle limit for
  // most of its records and no bed limit for nearly as many; the form still has
  // to show a number, so it shows a conservative fallback AND says so. Without
  // this the green "filled from database" line would vouch for a figure the
  // database never contained — and every clamp downstream trusts that figure.
  const limitNotes: Record<'maxNozzleTemp' | 'maxBedTemp', HTMLElement> = {
    maxNozzleTemp: h('p', { class: 'field-help', style: 'display:none;color:var(--warn)' }),
    maxBedTemp: h('p', { class: 'field-help', style: 'display:none;color:var(--warn)' })
  };
  const limitInputs: Record<'maxNozzleTemp' | 'maxBedTemp', HTMLInputElement> = {
    maxNozzleTemp, maxBedTemp
  };
  const setLimitNote = (key: 'maxNozzleTemp' | 'maxBedTemp', unbacked: boolean): void => {
    const el = limitNotes[key];
    const f = LIMIT_FIELDS.find(l => l.key === key)!;
    // Only warn while the field still literally holds the invented fallback:
    // once it holds the user's own figure the warning would misdescribe it.
    if (!unbacked || Number(limitInputs[key].value) !== f.fallback) {
      el.style.display = 'none'; el.textContent = ''; return;
    }
    el.textContent = `⚠ Not from the database — ${f.fallback} ${f.unit} is PerfectFit's conservative fallback for this field, not a published spec for this printer. `
      + 'Every temperature the app suggests is capped by this number, so check it against your hardware\'s own rating and correct it.';
    el.style.display = '';
  };
  const applyLimitNotes = (spec: PrinterSpecification | null): void => {
    for (const l of limitProvenance(spec)) {
      if (l.key === 'maxVolumetricFlow') continue; // left empty when unknown, which already reads as unknown
      setLimitNote(l.key, !l.fromDatabase);
    }
  };
  const setBadge = (spec: PrinterSpecification | null) => {
    if (spec) { dbBadge.textContent = specFillBadgeText(spec); dbBadge.style.display = ''; }
    else { dbBadge.style.display = 'none'; }
    applyLimitNotes(spec);
  };
  if (existing?.databasePrinterId) setBadge(getPrinterSpec(existing.databasePrinterId) ?? null);
  // A brand-new profile opens on the same invented 260/100 defaults, with no
  // database record behind them at all.
  else if (!existing) applyLimitNotes(null);

  // Typing a limit by hand replaces the fallback with the user's own figure —
  // the provenance warning has done its job and would only be noise afterwards.
  maxNozzleTemp.addEventListener('input', () => setLimitNote('maxNozzleTemp', false));
  maxBedTemp.addEventListener('input', () => setLimitNote('maxBedTemp', false));

  // Track edits so we can warn before a new selection discards them.
  let dirtySinceSelect = false;
  const markDirty = () => { dirtySinceSelect = true; };
  for (const el of [name, manufacturer, nozzle, maxNozzleTemp, maxBedTemp, maxFlow, extruder, retrStart, retrEnd, notes,
    maxChamber, heatedChamber, supportedNozzles, bvx, bvy, bvz, maxSpeed, maxAccel, firmware, extruderCount, mmu]) {
    el.addEventListener('input', markDirty);
    el.addEventListener('change', markDirty);
  }

  // --- nozzle list (multi-nozzle printers, e.g. Bambu Lab X2D) ---------------
  // The printer database records how many extruders a machine has, but not the
  // feed path of each physical nozzle — which is what the PA, retraction and
  // ooze-control suggestions key off. So this list stays hand-edited even on
  // profiles filled from the database. Each row is one instrument panel's
  // configuration, so each gets its own bordered fieldset.
  const nozzleState: NozzleProfile[] = (p.nozzles ?? []).map(n => ({ ...n }));
  const nozzleHost = h('div', {});
  const renderNozzleRows = (): void => {
    clear(nozzleHost);
    nozzleState.forEach((n, i) => {
      const label = h('input', {
        type: 'text', value: n.label, placeholder: i === 0 ? 'e.g. Main (direct drive)' : 'e.g. Auxiliary (bowden)',
        onInput: () => { n.label = label.value; }
      });
      const feed = h('select', { onChange: () => { n.feed = feed.value as ExtruderType; } },
        h('option', { value: 'direct', selected: n.feed === 'direct' }, 'Direct drive'),
        h('option', { value: 'bowden', selected: n.feed === 'bowden' }, 'Bowden / remote'));
      const nozzleSpeed = numberInput({
        value: n.maxSpeed ?? '', step: 10, min: 1, placeholder: 'no cap',
        onInput: () => { n.maxSpeed = nozzleSpeed.value === '' ? undefined : Number(nozzleSpeed.value); }
      });
      const nozzleAccel = numberInput({
        value: n.maxAccel ?? '', step: 100, min: 1, placeholder: 'no cap',
        onInput: () => { n.maxAccel = nozzleAccel.value === '' ? undefined : Number(nozzleAccel.value); }
      });
      nozzleHost.append(h('fieldset', { style: 'margin:var(--s-3) 0' },
        h('legend', {}, i === 0 ? `Nozzle ${i + 1} · Main` : `Nozzle ${i + 1} · Auxiliary`),
        h('div', { class: 'field-row', style: 'align-items:end' },
          field('Nozzle label', label),
          field('Feed', feed, i === 0 ? 'Feed path drives PA and retraction suggestions.' : undefined),
          field('Max speed (mm/s)', nozzleSpeed),
          field('Max accel (mm/s²)', nozzleAccel),
          h('button', {
            class: 'btn btn-sm btn-danger', type: 'button', style: 'margin-bottom:.9rem',
            'aria-label': `Remove nozzle ${i + 1}`,
            onClick: () => { nozzleState.splice(i, 1); renderNozzleRows(); }
          }, '🗑')
        )
      ));
    });
    if (!nozzleState.length) {
      nozzleHost.append(h('p', { class: 'field-help' },
        'No nozzle list = a normal single-nozzle printer (the extruder type above applies). Add nozzles only for machines with two physical nozzles, like the Bambu Lab X2D.'));
    }
  };
  renderNozzleRows();

  const applySpec = (spec: PrinterSpecification) => {
    const v = profileValuesFromSpec(spec);
    // Persist everything on the working copy (incl. fields with no visible input).
    Object.assign(p, v);
    p.databasePrinterId = spec.id;
    p.isManual = false;
    // Reflect into visible inputs (blank DB fields don't clobber existing values).
    if (!name.value.trim()) name.value = specLabel(spec).replace(' · ', ' ');
    if (v.manufacturer) manufacturer.value = v.manufacturer;
    if (v.nozzleDiameter !== undefined) nozzle.value = String(v.nozzleDiameter);
    if (v.maxNozzleTemp !== undefined) maxNozzleTemp.value = String(v.maxNozzleTemp);
    if (v.maxBedTemp !== undefined) maxBedTemp.value = String(v.maxBedTemp);
    if (v.maxVolumetricFlow !== undefined) maxFlow.value = String(v.maxVolumetricFlow);
    if (v.extruderType) extruder.value = v.extruderType;
    maxChamber.value = v.maxChamberTemp !== undefined ? String(v.maxChamberTemp) : '';
    heatedChamber.value = v.heatedChamber === true ? 'yes' : v.heatedChamber === false ? 'no' : '';
    supportedNozzles.value = (v.supportedNozzleDiameters ?? []).join(', ');
    bvx.value = v.buildVolume?.x !== undefined ? String(v.buildVolume.x) : '';
    bvy.value = v.buildVolume?.y !== undefined ? String(v.buildVolume.y) : '';
    bvz.value = v.buildVolume?.z !== undefined ? String(v.buildVolume.z) : '';
    maxSpeed.value = v.maxPrintSpeed !== undefined ? String(v.maxPrintSpeed) : '';
    maxAccel.value = v.maxAcceleration !== undefined ? String(v.maxAcceleration) : '';
    firmware.value = v.firmware ?? '';
    extruderCount.value = v.extruderCount !== undefined ? String(v.extruderCount) : '';
    mmu.value = v.multiMaterialCompatibility ?? '';
    // The nozzle rows are deliberately left as they are — the database carries
    // no per-nozzle feed data, so a selection can only ever add specs, never
    // replace a nozzle list the user configured.
    setBadge(spec);
    dirtySinceSelect = false;
  };

  const combo = printerCombobox(async (spec) => {
    if (dirtySinceSelect) {
      const ok = await confirmDialog({
        title: 'Replace edited values?',
        body: `You've edited some fields. Filling from “${specLabel(spec)}” will overwrite them with the database values. Continue?`,
        confirmLabel: 'Replace'
      });
      if (!ok) return;
    }
    applySpec(spec);
  });

  const manualBtn = h('button', {
    class: 'btn btn-sm', type: 'button', onClick: () => {
      p.databasePrinterId = null; p.isManual = true;
      combo.input.value = '';
      setBadge(null);
      toast('Manual entry — enter your printer\'s specs by hand.', 'info');
      name.focus();
    }
  }, 'My printer is not listed — enter manually');

  /**
   * One-click Bambu Lab X2D profile. The dual-nozzle detail the calibration
   * workflow needs — a direct-drive main plus a bowden-fed auxiliary with its
   * own speed/accel ceiling — isn't in the printer database, so this writes a
   * hand-made profile: extruderCount 2 (so the multi-filament callout fires),
   * isManual true and no database linkage (so the spec-refresh callout doesn't
   * offer to overwrite values no database record backs).
   */
  const applyX2dTemplate = (): void => {
    if (!name.value.trim()) name.value = 'Bambu Lab X2D';
    manufacturer.value = 'Bambu Lab';
    maxNozzleTemp.value = '300'; // official X2D spec sheet: 300 °C max nozzle temp (bambulab.com/en-us/x2d/specs)
    setLimitNote('maxNozzleTemp', false); // a cited spec, not a fallback
    extruder.value = 'direct'; // the main (left) nozzle is direct drive on the toolhead
    retrStart.value = '0';
    retrEnd.value = '2'; // main/direct path; the bowden aux gets its own 2–6 mm suggestion
    extruderCount.value = '2'; // two physical nozzles
    nozzleState.length = 0;
    nozzleState.push(
      { label: 'Main (direct drive)', feed: 'direct' },
      {
        label: 'Auxiliary (bowden)', feed: 'bowden', maxSpeed: 200, maxAccel: 1000,
        notes: 'Remote stepper at the rear panel feeding via PTFE tube. Supports-oriented; no flexible filaments; nozzle size must match the main; ~4 mm Z loss while it prints.'
      });
    renderNozzleRows();
    p.extruderCount = 2;
    p.databasePrinterId = null;
    p.isManual = true;
    combo.input.value = '';
    setBadge(null);
    // Picking a database printer afterwards should ask before discarding this.
    dirtySinceSelect = true;
    toast('Bambu Lab X2D template applied — review and save.', 'info');
  };

  const advanced = h('details', { class: 'advanced' },
    h('summary', {}, 'Advanced machine specs (chamber, build volume, firmware…)'),
    h('p', { class: 'field-help' }, 'Optional. Filled from the database when available and used for extra safety checks. Blank means “not specified”.'),
    h('div', { class: 'field-row' },
      field('Max chamber temp (°C)', maxChamber, 'Highest controlled chamber temperature, if the printer heats its chamber.'),
      field('Heated chamber', heatedChamber),
      field('Supported nozzle sizes (mm)', supportedNozzles, 'Comma-separated. Used to sanity-check the selected nozzle diameter.')),
    h('div', { class: 'field-row' },
      field('Build volume X (mm)', bvx),
      field('Build volume Y (mm)', bvy),
      field('Build volume Z (mm)', bvz)),
    h('div', { class: 'field-row' },
      field('Max print speed (mm/s)', maxSpeed),
      field('Max acceleration (mm/s²)', maxAccel),
      field('Number of extruders', extruderCount)),
    h('div', { class: 'field-row' },
      field('Firmware', firmware),
      field('Multi-material (AMS/MMU)', mmu))
  );

  const overlay = h('div', { class: 'modal-overlay' },
    // Wider than the app's other modals: the nozzle rows are five columns.
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', style: 'max-width:720px;max-height:90vh;overflow:auto' },
      h('h3', {}, existing ? `Edit ${existing.name}` : 'New printer profile'),
      field('Find your printer', combo.root, `Choose from ${PRINTER_DB_COUNT.toLocaleString()} known printers to auto-fill specs, then adjust anything for your setup.`),
      h('div', { style: 'margin:-.5rem 0 var(--s-3)' }, manualBtn),
      h('div', { class: 'panel' },
        h('span', { class: 'placard' }, 'Template'),
        h('div', { class: 'btn-row', style: 'margin-top:var(--s-2)' },
          h('button', { class: 'btn btn-sm', type: 'button', onClick: applyX2dTemplate }, '⚡ Quick-fill: Bambu Lab X2D')),
        h('p', { class: 'field-help', style: 'margin:var(--s-2) 0 0' },
          'Fills name, 300 °C limit, 2 extruders, and both nozzles (direct-drive main + 200 mm/s / 1000 mm/s² bowden aux).')),
      dbBadge,
      h('hr', { class: 'rule-ticks' }),
      field('Profile name *', name),
      h('div', { class: 'field-row' },
        field('Manufacturer', manufacturer),
        field('Nozzle diameter (mm)', nozzle, 'The nozzle you will calibrate with. Different nozzle sizes need separate calibrations.')
      ),
      h('div', { class: 'field-row' },
        h('div', {},
          field('Max nozzle temp (°C)', maxNozzleTemp, 'From the printer/hotend spec. The app blocks suggestions above this.'),
          limitNotes.maxNozzleTemp),
        h('div', {},
          field('Max bed temp (°C)', maxBedTemp),
          limitNotes.maxBedTemp),
        field('Max volumetric flow (mm³/s)', maxFlow, 'If the maker publishes one (e.g. ~32 for a P1S stock hotend). Used to cap max-flow recommendations.')
      ),
      h('div', { class: 'field-row' },
        field('Extruder type', extruder, 'Direct drive = motor on the print head. Bowden = motor on the frame with a PTFE tube.'),
        field('Retraction range start (mm)', retrStart),
        field('Retraction range end (mm)', retrEnd)
      ),
      h('div', { style: 'border-top:1px solid var(--hairline);margin-top:var(--s-5);padding-top:var(--s-4)' },
        h('h4', { style: 'margin:0 0 var(--s-1)' }, 'Nozzles (dual-nozzle printers)'),
        h('p', { class: 'field-help' },
          'For machines with two physical nozzles (e.g. Bambu Lab X2D). Each calibration project then picks which nozzle it calibrates, and suggestions adapt to that nozzle\'s feed path.'),
        nozzleHost,
        h('div', { class: 'btn-row' },
          h('button', {
            class: 'btn btn-sm', type: 'button', onClick: () => {
              nozzleState.push({ label: '', feed: nozzleState.length ? 'bowden' : 'direct' });
              renderNozzleRows();
            }
          }, '＋ Add nozzle'))
      ),
      advanced,
      field('Notes', notes),
      issuesHost,
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', onClick: () => overlay.remove() }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary', onClick: async () => {
            const issues = [
              ...(name.value.trim() ? [] : [{ level: 'error' as const, message: 'Profile name is required.' }]),
              ...validateNumber(nozzle.value, { label: 'Nozzle diameter', min: 0.1, max: 2 }),
              ...validateNumber(maxNozzleTemp.value, { label: 'Max nozzle temp', min: 150, max: 500 }),
              ...validateNumber(maxBedTemp.value, { label: 'Max bed temp', min: 0, max: 200 }),
              ...(maxFlow.value === '' ? [] : validateNumber(maxFlow.value, { label: 'Max volumetric flow', min: 1, max: 100 })),
              ...validateNumber(retrStart.value, { label: 'Retraction start', min: 0, max: 10 }),
              ...validateNumber(retrEnd.value, { label: 'Retraction end', min: 0, max: 15 })
            ];
            if (Number(retrEnd.value) <= Number(retrStart.value)) {
              issues.push({ level: 'error', message: 'Retraction range end must be greater than start.' });
            }
            if (nozzleState.some(n => !n.label.trim())) {
              issues.push({ level: 'error', message: 'Every nozzle row needs a label (or remove the empty row).' });
            }
            // Soft warning: selected nozzle not in the printer's supported set.
            const supported = parseNozzleCsv(supportedNozzles.value);
            if (supported.length && !supported.includes(Number(nozzle.value))) {
              issues.push({ level: 'warning', message: `Nozzle ${nozzle.value} mm isn't in this printer's supported sizes (${supported.join(', ')} mm). Save anyway if you've fitted a different nozzle.` });
            }
            clear(issuesHost);
            if (issues.some(i => i.level === 'error')) {
              const list = issueList(issues); if (list) issuesHost.append(list);
              return;
            }
            const saved: PrinterProfile = {
              ...p,
              name: name.value.trim(),
              manufacturer: manufacturer.value.trim(),
              nozzleDiameter: Number(nozzle.value),
              maxNozzleTemp: Number(maxNozzleTemp.value),
              maxBedTemp: Number(maxBedTemp.value),
              maxVolumetricFlow: maxFlow.value === '' ? undefined : Number(maxFlow.value),
              extruderType: extruder.value as ExtruderType,
              retractionRange: { start: Number(retrStart.value), end: Number(retrEnd.value) },
              nozzles: nozzleState.length
                ? nozzleState.map(n => ({ ...n, label: n.label.trim() }))
                : undefined,
              notes: notes.value,
              // Extended specs — undefined (not 0/NaN) when left blank.
              maxChamberTemp: numOrUndef(maxChamber.value),
              heatedChamber: heatedChamber.value === '' ? undefined : heatedChamber.value === 'yes',
              supportedNozzleDiameters: supported.length ? supported : undefined,
              buildVolume: buildVolumeOrUndef(bvx.value, bvy.value, bvz.value),
              maxPrintSpeed: numOrUndef(maxSpeed.value),
              maxAcceleration: numOrUndef(maxAccel.value),
              firmware: firmware.value.trim() || undefined,
              extruderCount: numOrUndef(extruderCount.value),
              multiMaterialCompatibility: mmu.value.trim() || undefined,
              isManual: !p.databasePrinterId
            };
            await savePrinter(saved);
            overlay.remove();
            toast('Printer profile saved.', 'success');
            clear(root); await renderPrinters(root);
          }
        }, 'Save printer')
      )
    )
  );
  document.body.append(overlay);
  (existing ? name : combo.input).focus();
}

// --- small helpers ---------------------------------------------------------

function parseNozzleCsv(s: string): number[] {
  const nums = s.split(/[,;/]/).map(x => parseFloat(x.trim())).filter(x => Number.isFinite(x));
  return [...new Set(nums)].sort((a, b) => a - b);
}

function numOrUndef(v: string): number | undefined {
  if (v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function buildVolumeOrUndef(x: string, y: string, z: string): PrinterProfile['buildVolume'] {
  const bx = numOrUndef(x), by = numOrUndef(y), bz = numOrUndef(z);
  if (bx === undefined && by === undefined && bz === undefined) return undefined;
  return { x: bx, y: by, z: bz };
}
