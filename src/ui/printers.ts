import { h, clear, field, numberInput, issueList, confirmDialog, toast } from './dom';
import { listPrinters, savePrinter, deletePrinter, listProjects, uid } from '../storage/store';
import { validateNumber } from '../logic/validation';
import type { PrinterProfile, ExtruderType, NozzleProfile } from '../types';

export async function renderPrinters(root: HTMLElement): Promise<void> {
  const printers = await listPrinters();

  root.append(
    h('div', { style: 'display:flex;align-items:center;gap:1rem;flex-wrap:wrap' },
      h('h1', { style: 'margin:0;flex:1' }, 'Printer profiles'),
      h('button', { class: 'btn btn-primary', onClick: () => openEditor(root, null) }, '＋ Add printer')
    ),
    h('p', { class: 'field-help' },
      'Calibration projects reference a printer profile. Its limits (max temps, max flow) are used to warn you before any suggested setting could exceed what the machine can safely do.')
  );

  if (!printers.length) {
    root.append(h('div', { class: 'card', style: 'text-align:center;padding:2rem' },
      h('p', { style: 'font-size:2rem;margin:.2rem' }, '🖨️'),
      h('p', {}, 'No printers yet. Add the printer you\'ll calibrate on — nozzle size, temperature limits, and extruder type drive the suggested test ranges.'),
      h('button', { class: 'btn btn-primary', onClick: () => openEditor(root, null) }, 'Add your first printer')
    ));
    return;
  }

  root.append(h('div', { class: 'grid grid-cards' }, printers.map(p =>
    h('div', { class: 'card' },
      h('h3', { style: 'margin:0' }, p.name),
      h('p', { class: 'proj-sub' }, `${p.manufacturer} · ${p.nozzleDiameter} mm nozzle · ${p.extruderType === 'direct' ? 'Direct drive' : 'Bowden'}`),
      h('p', { class: 'proj-sub' },
        `Max nozzle ${p.maxNozzleTemp} °C · max bed ${p.maxBedTemp} °C` +
        (p.maxVolumetricFlow ? ` · max flow ${p.maxVolumetricFlow} mm³/s` : ' · max flow unknown')),
      p.nozzles?.length
        ? h('p', { class: 'proj-sub' }, '🔩 ' + p.nozzles.map(n =>
            `${n.label}${n.maxSpeed ? ` (≤${n.maxSpeed} mm/s)` : ''}`).join(' · '))
        : null,
      p.notes ? h('p', { class: 'field-help' }, p.notes) : null,
      h('div', { class: 'btn-row' },
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
    )
  )));
}

function openEditor(root: HTMLElement, existing: PrinterProfile | null): void {
  const p: PrinterProfile = existing ? { ...existing, retractionRange: { ...existing.retractionRange } } : {
    id: uid(), name: '', manufacturer: '', nozzleDiameter: 0.4,
    maxNozzleTemp: 260, maxBedTemp: 100, maxVolumetricFlow: undefined,
    extruderType: 'direct', retractionRange: { start: 0, end: 2 },
    notes: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
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
  const issuesHost = h('div', {});

  // --- nozzle list (multi-nozzle printers, e.g. Bambu Lab X2D) ---------------
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
      const maxSpeed = numberInput({
        value: n.maxSpeed ?? '', step: 10, min: 1, placeholder: 'no cap',
        onInput: () => { n.maxSpeed = maxSpeed.value === '' ? undefined : Number(maxSpeed.value); }
      });
      const maxAccel = numberInput({
        value: n.maxAccel ?? '', step: 100, min: 1, placeholder: 'no cap',
        onInput: () => { n.maxAccel = maxAccel.value === '' ? undefined : Number(maxAccel.value); }
      });
      nozzleHost.append(h('div', { class: 'field-row', style: 'align-items:end' },
        field(`Nozzle ${i + 1} label`, label),
        field('Feed', feed, i === 0 ? 'Feed path drives PA and retraction suggestions.' : undefined),
        field('Max speed (mm/s)', maxSpeed),
        field('Max accel (mm/s²)', maxAccel),
        h('button', {
          class: 'btn btn-sm btn-danger', type: 'button', style: 'margin-bottom:.9rem',
          'aria-label': `Remove nozzle ${i + 1}`,
          onClick: () => { nozzleState.splice(i, 1); renderNozzleRows(); }
        }, '🗑')
      ));
    });
    if (!nozzleState.length) {
      nozzleHost.append(h('p', { class: 'field-help' },
        'No nozzle list = a normal single-nozzle printer (the extruder type above applies). Add nozzles only for machines with two physical nozzles, like the Bambu Lab X2D.'));
    }
  };
  renderNozzleRows();

  const applyX2dTemplate = (): void => {
    if (!name.value.trim()) name.value = 'Bambu Lab X2D';
    manufacturer.value = 'Bambu Lab';
    maxNozzleTemp.value = '300'; // official X2D spec sheet: 300 °C max nozzle temp (bambulab.com/en-us/x2d/specs)
    extruder.value = 'direct'; // the main (left) nozzle is direct drive on the toolhead
    retrStart.value = '0';
    retrEnd.value = '2'; // main/direct path; the bowden aux gets its own 2–6 mm suggestion
    nozzleState.length = 0;
    nozzleState.push(
      { label: 'Main (direct drive)', feed: 'direct' },
      {
        label: 'Auxiliary (bowden)', feed: 'bowden', maxSpeed: 200, maxAccel: 1000,
        notes: 'Remote stepper at the rear panel feeding via PTFE tube. Supports-oriented; no flexible filaments; nozzle size must match the main; ~4 mm Z loss while it prints.'
      });
    renderNozzleRows();
    toast('Bambu Lab X2D template applied — review and save.', 'info');
  };

  const overlay = h('div', { class: 'modal-overlay' },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', style: 'max-width:720px;max-height:90vh;overflow:auto' },
      h('h3', {}, existing ? `Edit ${existing.name}` : 'New printer profile'),
      h('div', { class: 'btn-row', style: 'margin:.2rem 0 .6rem' },
        h('button', { class: 'btn btn-sm', type: 'button', onClick: applyX2dTemplate }, '⚡ Quick-fill: Bambu Lab X2D'),
        h('span', { class: 'field-help' }, 'Fills name, 300 °C limit, and both nozzles (direct-drive main + 200 mm/s / 1000 mm/s² bowden aux).')),
      field('Profile name *', name),
      h('div', { class: 'field-row' },
        field('Manufacturer', manufacturer),
        field('Nozzle diameter (mm)', nozzle, 'The nozzle you will calibrate with. Different nozzle sizes need separate calibrations.')
      ),
      h('div', { class: 'field-row' },
        field('Max nozzle temp (°C)', maxNozzleTemp, 'From the printer/hotend spec. The app blocks suggestions above this.'),
        field('Max bed temp (°C)', maxBedTemp),
        field('Max volumetric flow (mm³/s)', maxFlow, 'If the maker publishes one (e.g. ~32 for a P1S stock hotend). Used to cap max-flow recommendations.')
      ),
      h('div', { class: 'field-row' },
        field('Extruder type', extruder, 'Direct drive = motor on the print head. Bowden = motor on the frame with a PTFE tube.'),
        field('Retraction range start (mm)', retrStart),
        field('Retraction range end (mm)', retrEnd)
      ),
      h('div', { style: 'border-top:1px solid var(--surface-2);margin-top:.6rem;padding-top:.6rem' },
        h('h4', { style: 'margin:0 0 .2rem' }, 'Nozzles (dual-nozzle printers)'),
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
              notes: notes.value
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
  name.focus();
}
