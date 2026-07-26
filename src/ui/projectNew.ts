import { h, field, numberInput, issueList, clear, toast } from './dom';
import { listPrinters, createProject, saveProject, loadSettings } from '../storage/store';
import { MATERIALS, getMaterial } from '../data/materials';
import { slicerVersionOptions } from '../data/slicers';
import { navigate } from '../app';
import type { MaterialId, SlicerId, ExperienceMode } from '../types';

export async function renderNewProject(root: HTMLElement): Promise<void> {
  const printers = await listPrinters();
  const settings = loadSettings();

  if (!printers.length) {
    root.append(h('div', { class: 'card', style: 'text-align:center;padding:2rem' },
      h('h1', {}, 'Add a printer first'),
      h('p', {}, 'A calibration project needs a printer profile — its nozzle size, temperature limits, and extruder type shape every suggested range.'),
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
  const startingProfile = h('input', { type: 'text', placeholder: 'e.g. Generic PLA @ your printer' });
  const slicerSel = h('select', {}, slicerVersionOptions().map(o =>
    h('option', { value: `${o.slicer}|${o.version}` }, o.label)));
  const notes = h('textarea', { placeholder: 'Anything worth remembering about this spool (age, storage, prior drying…)' });
  const dateInput = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });

  const modeCoach = h('input', { type: 'radio', name: 'mode', value: 'coach', checked: settings.defaultMode === 'coach' });
  const modeExpert = h('input', { type: 'radio', name: 'mode', value: 'expert', checked: settings.defaultMode === 'expert' });

  // --- nozzle selector (multi-nozzle printers, e.g. Bambu Lab X2D) ----------
  let nozzleChoice = 0;
  const nozzleHost = h('div', {});
  const refreshNozzles = () => {
    clear(nozzleHost);
    nozzleChoice = 0;
    const printer = printers.find(pp => pp.id === printerSel.value);
    const nozzles = printer?.nozzles ?? [];
    if (nozzles.length < 2) return;
    const group = h('div', { class: 'grid grid-2' }, nozzles.map((n, i) => {
      const radio = h('input', {
        type: 'radio', name: 'nozzle-choice', value: String(i), checked: i === 0,
        onChange: () => { nozzleChoice = i; }
      });
      const caps = [
        n.maxSpeed ? `≤ ${n.maxSpeed} mm/s` : null,
        n.maxAccel ? `≤ ${n.maxAccel} mm/s²` : null
      ].filter(Boolean).join(' · ');
      return h('label', { class: 'radio-card' }, radio,
        h('span', { class: 'rc-title' }, n.label,
          i === 0 ? h('span', { class: 'rc-badge' }, 'default') : null),
        h('p', { class: 'rc-desc' },
          n.feed === 'bowden'
            ? `Bowden/remote feed${caps ? ` (${caps})` : ''} — wider K (0–1) and retraction (2–6 mm) ranges, no flexible filaments, and a dual-nozzle ooze-control step is added to the plan.`
            : `Direct drive${caps ? ` (${caps})` : ''} — standard test ranges.`));
    }));
    nozzleHost.append(field('Which nozzle does this project calibrate? *', group,
      'Each physical nozzle needs its own calibration — the feed path changes pressure advance and retraction completely.'));
  };
  printerSel.addEventListener('change', refreshNozzles);
  refreshNozzles();

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
    materialInfo.append(
      h('div', { class: 'panel' },
        h('p', { style: 'margin:.2rem 0' }, h('strong', {}, m.label), ` — ${m.description}`),
        h('p', { class: 'field-help' },
          `Typical nozzle ${m.nozzleTemp.min}–${m.nozzleTemp.max} °C · bed ${m.bedTemp.min}–${m.bedTemp.max} °C` +
          (m.hygroscopic ? ' · moisture-sensitive (dry first)' : '') +
          (m.enclosureRecommended ? ' · enclosure recommended' : '') +
          (m.flexible ? ' · flexible' : '')),
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
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Filament'),
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
      h('h2', { style: 'margin-top:0' }, 'Printer & slicer'),
      h('div', { class: 'field-row' },
        field('Printer profile *', printerSel),
        field('Nozzle type / material', nozzleType, 'Abrasive filaments (CF/GF) need hardened nozzles.')
      ),
      nozzleHost,
      h('div', { class: 'field-row' },
        field('Slicer & version *', slicerSel, 'Instructions are version-aware; pick what you actually run.'),
        field('Starting filament profile', startingProfile, 'The slicer preset you\'ll clone from — usually a "Generic <material>" profile.'),
        field('Calibration date', dateInput)
      )
    ),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Guidance level'),
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
            // Only aux/bowden-nozzle projects get the ooze-control step —
            // single-nozzle and main-nozzle plans stay exactly as before.
            const printer = printers.find(pp => pp.id === printerSel.value);
            if ((printer?.nozzles?.length ?? 0) >= 2) {
              project.nozzleIndex = nozzleChoice;
              if (printer!.nozzles![nozzleChoice]?.feed === 'bowden') {
                const fv = project.stepOrder.indexOf('final-verification');
                project.stepOrder.splice(fv === -1 ? project.stepOrder.length : fv, 0, 'ooze-control');
              }
            }

            await saveProject(project);
            toast('Project created — let\'s calibrate.', 'success');
            navigate(`#/project/${project.id}`);
          }
        }, 'Create project →')
      )
    )
  );
}
