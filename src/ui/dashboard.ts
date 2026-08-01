import { h, clear, confirmDialog, toast, download } from './dom';
import {
  listProjects, listPrinters, deleteProject, saveProject, uid,
  completionPercent, currentStage
} from '../storage/store';
import { getCalibration } from '../data/calibrations';
import { confidenceScore } from '../logic/confidence';
import { nozzleBadgeLabel } from '../logic/ranges';
import { exportProject } from '../export/backup';
import { importFilePicker } from './importExport';
import { hasCalibratedValues } from './projectView';
import { maybeFirstRunBackupCard } from './presetBackupPrompt';
import type { CalibrationProject, CalibrationId, ExtruderType, PrinterProfile } from '../types';
import { getMaterial } from '../data/materials';

// ---------------------------------------------------------------------------
// Gauges — the instrument primitive shared by the dashboard and the printable
// calibration card. Product rule #1: a value that has not been measured shows
// an UNLIT dial (no needle, no fake zero). Dark means "not yet measured".
// ---------------------------------------------------------------------------

export interface GaugeReading {
  /** Placard engraved beneath the dial (the stylesheet sets it in caps). */
  placard: string;
  /** Sentence-case name used to build the accessible label. */
  name: string;
  /** Measured value, or undefined when this step has produced nothing yet. */
  value: number | undefined;
  unit?: string;
  /** Scale ends the needle sweeps between (-135° .. +135°). */
  min: number;
  max: number;
  /** Decimal places the dial rounds to before printing the readout. */
  digits: number;
  /**
   * Suggested range for this reading, in the same units as `value`. Drawn as an
   * arc on the dial FACE so a measured value is read against the band it was
   * expected to land in — deviation is visible long before anything alarms.
   * Omitted whenever the data carries no suggested range; the dial then renders
   * exactly as it did before.
   */
  band?: { lo: number; hi: number };
}

function fmtValue(v: number, digits: number): string {
  return String(Number(v.toFixed(digits)));
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * One round instrument with its placard label beneath it (never inside).
 * `dial` overrides the stylesheet's --gauge-size for dense layouts (the printed
 * card has to hold a whole six-pack and a value table on one sheet).
 */
export function gaugeEl(
  r: GaugeReading,
  opts: { size?: 'sm' | 'lg'; settle?: boolean; dial?: string } = {}
): HTMLElement {
  const lit = r.value !== undefined && Number.isFinite(r.value);
  const span = r.max - r.min || 1;
  const frac = lit ? clamp01(((r.value as number) - r.min) / span) : 0;
  const angle = -135 + frac * 270;
  const shown = lit ? fmtValue(r.value as number, r.digits) : '—';
  const cls = [
    'gauge',
    opts.size ? `gauge-${opts.size}` : '',
    lit ? 'is-lit' : 'is-unlit',
    opts.settle === false ? 'no-settle' : ''
  ].filter(Boolean).join(' ');

  // The suggested-range arc. Contract: --band-lo / --band-hi, each a 0..1
  // fraction of the dial's 270° sweep, set inline on .gauge. Both are omitted
  // together when there is no range to show — a band that covers (almost) the
  // whole face tells the reader nothing, so that case is dropped too.
  let bandStyle = '';
  let bandLabel = '';
  if (r.band) {
    const rawLo = Math.min(r.band.lo, r.band.hi);
    const rawHi = Math.max(r.band.lo, r.band.hi);
    const lo = clamp01((rawLo - r.min) / span);
    const hi = clamp01((rawHi - r.min) / span);
    if (hi - lo > 0.02 && hi - lo < 0.98) {
      bandStyle = `;--band-lo:${lo.toFixed(4)};--band-hi:${hi.toFixed(4)}`;
      bandLabel = `, suggested ${fmtValue(rawLo, r.digits)} to ${fmtValue(rawHi, r.digits)}${r.unit ? ` ${r.unit}` : ''}`;
    }
  }

  return h('div', {
    class: cls,
    style: `--angle:${angle.toFixed(1)}deg${bandStyle}${opts.dial ? `;--gauge-size:${opts.dial}` : ''}`,
    role: 'img',
    'aria-label': lit
      ? `${r.name}: ${shown}${r.unit ? ` ${r.unit}` : ''}${bandLabel}`
      : `${r.name}: not yet measured${bandLabel}`
  },
    h('div', { class: 'gauge-face' },
      h('span', { class: 'gauge-ticks', 'aria-hidden': 'true' }),
      lit ? h('span', { class: 'gauge-needle', 'aria-hidden': 'true' }) : null,
      h('span', { class: 'gauge-hub', 'aria-hidden': 'true' }),
      h('span', { class: 'gauge-readout' },
        h('b', { class: 'gauge-value' }, shown),
        r.unit ? h('i', { class: 'gauge-unit' }, r.unit) : null)),
    h('span', { class: 'gauge-placard' }, r.placard)
  );
}

/** Which feed path this project's nozzle uses — sets the PA/retraction scales. */
function feedOf(p: CalibrationProject, printer?: PrinterProfile): ExtruderType {
  return printer?.nozzles?.[p.nozzleIndex ?? 0]?.feed ?? printer?.extruderType ?? 'direct';
}

/**
 * The fixed six-pack for a calibration project, always in the same rank order
 * so the panel is a constellation you learn once: temperature, flow, pressure
 * advance, retraction, max flow, shrinkage.
 */
export function projectGauges(p: CalibrationProject, printer?: PrinterProfile): GaugeReading[] {
  const f = p.finals;
  const mat = getMaterial(p.filament.material);
  const feed = feedOf(p, printer);
  const retEnd = printer?.retractionRange?.end;
  const retStart = printer?.retractionRange?.start;

  // Suggested-range arcs are drawn ONLY from ranges this data already carries.
  // A dial with no honest range gets no band rather than an invented one.
  // Retraction is the delicate case: the range saved on a printer profile
  // describes the MAIN feed path (a bowden-fed auxiliary nozzle is calibrated
  // against its own numbers), and flexibles are held under a lower safe cap —
  // so neither case gets the printer's arc.
  const declaredFeed = printer?.nozzles?.[p.nozzleIndex ?? 0]?.feed;
  const retBand = retStart !== undefined && retEnd !== undefined && retEnd > 0
    && declaredFeed !== 'bowden' && !mat.flexible
    ? { lo: retStart, hi: retEnd }
    : undefined;

  return [
    { placard: 'Nozzle temp', name: 'Nozzle temperature', value: f.nozzleTemp, unit: '°C',
      min: mat.nozzleTemp.min - 20, max: mat.nozzleTemp.max + 20, digits: 0,
      band: { lo: mat.nozzleTemp.min, hi: mat.nozzleTemp.max } },
    // Flow ratio and shrinkage have no suggested band in the data — no arc.
    { placard: 'Flow ratio', name: 'Flow ratio', value: f.flowRatio,
      min: 0.85, max: 1.15, digits: 3 },
    // PA's suggested range IS the full dial (the scale is built from it), so an
    // arc across the whole face would say nothing.
    { placard: 'Press advance', name: 'Pressure advance', value: f.pressureAdvance,
      min: 0, max: feed === 'bowden' ? 1 : 0.15, digits: 3 },
    { placard: 'Retraction', name: 'Retraction distance', value: f.retractionDistance, unit: 'mm',
      min: 0, max: retEnd ? Math.max(retEnd * 1.3, 1) : (feed === 'bowden' ? 8 : 2), digits: 2,
      band: retBand },
    { placard: 'Max flow', name: 'Maximum volumetric speed', value: f.maxVolumetricSpeed, unit: 'mm³/s',
      min: 0, max: Math.max(mat.mvsRange.end, printer?.maxVolumetricFlow ?? 0, f.maxVolumetricSpeed ?? 0, 10), digits: 1,
      band: { lo: mat.mvsRange.start, hi: mat.mvsRange.end } },
    { placard: 'Shrinkage', name: 'XY shrinkage', value: f.shrinkagePercent, unit: '%',
      min: 97, max: 103, digits: 2 }
  ];
}

/**
 * The whole six-pack with nothing measured. This is the honest picture of a
 * fresh install: six instruments, all dark — not three, and never a row of
 * zeroes.
 */
const EMPTY_SIX_PACK: GaugeReading[] = [
  { placard: 'Nozzle temp', name: 'Nozzle temperature', value: undefined, unit: '°C', min: 0, max: 1, digits: 0 },
  { placard: 'Flow ratio', name: 'Flow ratio', value: undefined, min: 0, max: 1, digits: 3 },
  { placard: 'Press advance', name: 'Pressure advance', value: undefined, min: 0, max: 1, digits: 3 },
  { placard: 'Retraction', name: 'Retraction distance', value: undefined, unit: 'mm', min: 0, max: 1, digits: 2 },
  { placard: 'Max flow', name: 'Maximum volumetric speed', value: undefined, unit: 'mm³/s', min: 0, max: 1, digits: 1 },
  { placard: 'Shrinkage', name: 'XY shrinkage', value: undefined, unit: '%', min: 0, max: 1, digits: 2 }
];

/** Steps whose result is already shown on a dial — the rest get placards. */
const GAUGED_STEPS: CalibrationId[] = [
  'temperature', 'flow-pass1', 'flow-pass2', 'flow-verify',
  'pressure-advance', 'retraction', 'max-volumetric-speed', 'shrinkage'
];

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function renderDashboard(root: HTMLElement): Promise<void> {
  const [projects, printers] = await Promise.all([listProjects(), listPrinters()]);
  const printerMap = new Map(printers.map(p => [p.id, p]));

  const active = projects.filter(p => !p.archived);
  const archived = projects.filter(p => p.archived);

  // Which physical nozzles anywhere in the fleet have produced values. A nozzle
  // missing from this set is a panel sitting dark (product rule #4).
  const litNozzles = new Set<string>();
  for (const q of projects) {
    if (!q.archived && hasCalibratedValues(q)) litNozzles.add(`${q.printerProfileId}:${q.nozzleIndex ?? 0}`);
  }

  // One nameplate line: title, counts and controls together, so the panel opens
  // with its instruments instead of pushing them under the fold. The storage
  // disclosure moved to the footer placard at the end of this view.
  root.append(
    h('div', { style: 'display:flex;align-items:center;gap:.5rem 1rem;flex-wrap:wrap;margin-bottom:var(--s-4)' },
      h('h1', { style: 'margin:0;flex:0 0 auto' }, 'Calibration projects'),
      h('div', { style: 'display:flex;gap:.4rem;flex-wrap:wrap;align-items:center;flex:1 1 auto' },
        active.length || archived.length
          ? [h('span', { class: 'placard' }, `${active.length} active`),
             h('span', { class: litNozzles.size ? 'placard placard-lit' : 'placard placard-unlit' },
               `${litNozzles.size} nozzle${litNozzles.size === 1 ? '' : 's'} calibrated`),
             archived.length ? h('span', { class: 'placard placard-unlit' }, `${archived.length} archived`) : null]
          : null),
      h('div', { class: 'btn-row', style: 'margin:0;flex:0 0 auto' },
        h('button', { class: 'btn', onClick: () => importFilePicker(() => renderDashboardInto(root)) }, 'Import'),
        h('a', { class: 'btn btn-primary', href: '#/new' }, '＋ New project')
      )
    )
  );

  const firstRunCard = await maybeFirstRunBackupCard();
  if (firstRunCard) root.append(firstRunCard);

  if (active.length === 0) {
    root.append(
      h('div', { class: 'card', style: 'text-align:center' },
        h('h2', { style: 'margin:.2rem 0 0' }, projects.length ? 'No active projects' : 'Welcome to Trim'),
        // An empty panel is the honest picture: nothing measured, nothing lit.
        h('div', { class: 'six-pack', 'aria-hidden': 'true' },
          EMPTY_SIX_PACK.map(g => gaugeEl(g, { settle: false }))),
        h('p', { class: 'field-help', style: 'margin-left:auto;margin-right:auto' },
          'A calibration project walks one spool of filament through temperature, flow, pressure advance, retraction, and max flow tests — and ends with a verified slicer profile. Until a test lands a value, its instrument stays dark.'),
        h('div', { class: 'btn-row', style: 'justify-content:center' },
          printers.length === 0
            ? [h('a', { class: 'btn', href: '#/printers' }, '1 · Add your printer'),
               h('a', { class: 'btn btn-primary', href: '#/new' }, '2 · Start calibrating')]
            : [h('a', { class: 'btn btn-primary', href: '#/new' }, 'Start your first calibration')])
      )
    );
  } else {
    root.append(h('div', { class: 'grid' },
      active.map(p => projectCluster(p, printerMap, litNozzles, root))));
  }

  if (archived.length) {
    root.append(
      h('h2', {}, `Archived (${archived.length})`),
      h('div', { class: 'grid grid-cards' },
        archived.map(p => projectCluster(p, printerMap, litNozzles, root, true)))
    );
  }

  // Footer placard — the storage disclosure, one line, out of the way of the
  // instruments. The link is kept whole so the phrase never breaks mid-action.
  root.append(
    h('div', {
      style: 'display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap;'
        + 'margin-top:var(--s-6);padding-top:var(--s-3);border-top:1px solid var(--hairline)'
    },
      h('span', { class: 'placard' }, 'Storage'),
      h('p', { class: 'field-help', style: 'margin:0;flex:1 1 20rem;max-width:none' },
        'Everything is stored on this device only — no account, no cloud, no telemetry. ',
        h('a', { href: '#/settings', style: 'white-space:nowrap' }, 'Back up your data'), ' regularly.')
    )
  );
}

async function renderDashboardInto(root: HTMLElement): Promise<void> {
  clear(root);
  await renderDashboard(root);
}

/**
 * One project rendered as an instrument cluster: a six-pack of dials for the
 * values it has landed, the nozzle panels it belongs to, and its remaining
 * sequence. Archived projects render compact, with no dials.
 */
function projectCluster(
  p: CalibrationProject,
  printers: Map<string, PrinterProfile>,
  litNozzles: Set<string>,
  root: HTMLElement,
  isArchived = false
): HTMLElement {
  const printer = printers.get(p.printerProfileId);
  const pct = completionPercent(p);
  const stage = currentStage(p);
  const score = confidenceScore(p).score;
  const mat = getMaterial(p.filament.material);
  const total = p.stepOrder.length;
  const done = p.stepOrder.filter(id => p.steps[id]?.status === 'completed').length;

  const f = p.finals;
  const vals: HTMLElement[] = [];
  if (f.nozzleTemp !== undefined) vals.push(h('span', { class: 'badge badge-info' }, `Temp ${f.nozzleTemp} °C`));
  if (f.flowRatio !== undefined) vals.push(h('span', { class: 'badge badge-info' }, `Flow ${f.flowRatio}`));
  if (f.pressureAdvance !== undefined) vals.push(h('span', { class: 'badge badge-info' }, `PA ${f.pressureAdvance}`));
  if (f.retractionDistance !== undefined) vals.push(h('span', { class: 'badge badge-info' }, `Retr ${f.retractionDistance} mm`));
  if (f.maxVolumetricSpeed !== undefined) vals.push(h('span', { class: 'badge badge-info' }, `Flow max ${f.maxVolumetricSpeed} mm³/s`));
  if (f.shrinkagePercent !== undefined) vals.push(h('span', { class: 'badge badge-info' }, `Shrink ${f.shrinkagePercent}%`));

  const auxSteps = p.stepOrder.filter(id => !GAUGED_STEPS.includes(id));

  return h('div', { class: 'card proj-card' },
    // --- nameplate -----------------------------------------------------
    h('div', { style: 'display:flex;justify-content:space-between;gap:.75rem;align-items:baseline;flex-wrap:wrap' },
      h('h3', { class: 'proj-title', style: 'flex:1 1 12rem' }, `${p.filament.manufacturer || 'Unknown'} ${mat.label}`),
      // A summary of the dials, not a measurement — it is labelled and it sits
      // quieter than the instruments it summarises.
      h('span', {
        class: score > 0 ? 'readout' : 'readout is-unlit',
        style: 'gap:.4em;flex:0 0 auto',
        title: 'Calibration confidence score'
      },
        h('span', { class: 'readout-label' }, 'Confidence'),
        h('b', { class: 'readout-value', style: 'font-size:var(--fs-body);font-weight:600' }, String(score)))
    ),
    h('p', { class: 'proj-sub' },
      [p.filament.productLine, p.filament.color, printer ? `${printer.name} (${printer.nozzleDiameter} mm)` : 'no printer', p.nozzleType].filter(Boolean).join(' · ')),

    // --- the six-pack: every panel opens with its instruments ------------
    isArchived ? null : h('div', { class: 'six-pack' },
      projectGauges(p, printer).map(g => gaugeEl(g))),
    isArchived && vals.length ? h('div', { class: 'proj-vals' }, vals) : null,

    // --- nozzle panels: two nozzles means two panels --------------------
    nozzlePanels(p, printer, litNozzles),

    // --- steps that produce no dial -------------------------------------
    !isArchived && auxSteps.length
      ? h('div', { style: 'display:flex;align-items:center;gap:.6rem;flex-wrap:wrap' },
        h('span', { class: 'readout-label' }, 'Checks'),
        h('ul', { class: 'progress-steps', style: 'margin:0' },
          auxSteps.map(id => {
            const st = p.steps[id]?.status;
            const cls = st === 'completed' ? 'is-done'
              : st === 'skipped' ? 'is-skipped'
                : id === stage ? 'is-current' : '';
            return h('li', { class: `progress-step ${cls}`.trim() }, getCalibration(id).shortName);
          })))
      : null,

    // --- sequence tape --------------------------------------------------
    h('div', { style: 'display:flex;align-items:center;gap:.6rem;flex-wrap:wrap' },
      h('span', { class: 'readout-label' }, 'Steps'),
      h('div', {
        class: 'proj-progress', style: 'flex:1 1 8rem',
        role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Completion'
      }, h('div', { style: `--fill:${pct / 100}` })),
      h('span', { class: 'readout-label' }, `${done} / ${total}`),
      stage
        ? h('span', { class: 'placard' }, `Next · ${getCalibration(stage).shortName}`)
        : h('span', { class: 'placard placard-lit' }, 'All steps done'),
      h('span', { class: 'readout-label' }, `Updated ${new Date(p.updatedAt).toLocaleDateString()}`)
    ),

    // --- actions --------------------------------------------------------
    h('div', { class: 'proj-actions' },
      stage
        ? h('a', { class: 'btn btn-primary btn-sm', href: `#/wizard/${p.id}/${stage}` }, '▶ Continue')
        : h('a', { class: 'btn btn-primary btn-sm', href: `#/project/${p.id}` }, '✔ View results'),
      h('a', { class: 'btn btn-sm', href: `#/session/${p.id}`, title: 'Guided session — one screen per test, results carried forward' }, 'Guided session'),
      hasCalibratedValues(p) ? h('a', { class: 'btn btn-sm', href: `#/profile/${p.id}`, title: 'Create Slicer Profile' }, 'Slicer profile') : null,
      h('a', { class: 'btn btn-sm', href: `#/project/${p.id}` }, 'Open'),
      h('button', {
        class: 'btn btn-sm', title: 'Duplicate project', 'aria-label': 'Duplicate project', onClick: async () => {
          const copy: CalibrationProject = JSON.parse(JSON.stringify(p));
          copy.id = uid();
          copy.filament.productLine = `${copy.filament.productLine} (copy)`.trim();
          copy.archived = false;
          await saveProject(copy);
          toast('Project duplicated.', 'success');
          await renderDashboardInto(root);
        }
      }, '⧉ Duplicate'),
      h('button', {
        class: 'btn btn-sm', title: 'Export project as JSON', 'aria-label': 'Export project as JSON', onClick: async () => {
          const printerP = printers.get(p.printerProfileId);
          download(exportFileName(p), await exportProject(p, printerP));
        }
      }, '⭳ Export'),
      h('button', {
        class: 'btn btn-sm', title: p.archived ? 'Unarchive' : 'Archive', onClick: async () => {
          p.archived = !p.archived;
          await saveProject(p);
          await renderDashboardInto(root);
        }
      }, p.archived ? 'Unarchive' : 'Archive'),
      h('button', {
        class: 'btn btn-sm btn-danger', title: 'Delete project', 'aria-label': 'Delete project', onClick: async () => {
          const ok = await confirmDialog({
            title: 'Delete this project?',
            body: `"${p.filament.manufacturer} ${p.filament.material} ${p.filament.color}" and its photos will be permanently removed from this device. Consider exporting it first.`,
            confirmLabel: 'Delete permanently', danger: true
          });
          if (!ok) return;
          await deleteProject(p.id);
          toast('Project deleted.', 'info');
          await renderDashboardInto(root);
        }
      }, '✕ Delete')
    )
  );
}

/**
 * The nozzle placards for this project's machine. On a multi-nozzle printer
 * every physical nozzle gets a panel, so an auxiliary path that nothing has
 * calibrated yet sits visibly dark next to the one that is lit.
 *
 * Ranking, in order: THIS project's nozzle outranks a merely-calibrated one.
 * The target carries an index triangle and a luminous plate edge; a nozzle some
 * OTHER project calibrated reads quietly, so the eye is never pulled to the
 * nozzle the reader is not working on.
 */
function nozzlePanels(
  p: CalibrationProject,
  printer: PrinterProfile | undefined,
  litNozzles: Set<string>
): HTMLElement | null {
  const nozzles = printer?.nozzles ?? [];

  if (nozzles.length > 1) {
    return h('div', { class: 'panel' },
      h('span', { class: 'readout-label' }, `Nozzle panels · ${printer?.name ?? 'printer'}`),
      h('div', { style: 'display:flex;gap:1.25rem;flex-wrap:wrap;margin-top:.45rem' },
        nozzles.map((nz, i) => {
          const lit = litNozzles.has(`${p.printerProfileId}:${i}`);
          const mine = (p.nozzleIndex ?? 0) === i;
          const feedLabel = nz.feed === 'bowden' ? 'Bowden' : 'Direct drive';

          // The target plate: white edge, white type. The lamp still tells the
          // truth about measurement — a target nozzle with nothing measured
          // keeps its hollow, unlit lamp.
          const plateStyle = mine
            ? 'border-color:var(--luminous);color:var(--luminous);background:var(--lum-wash)'
            : lit
              ? 'color:var(--luminous-dim);border-color:var(--hairline)'
              : '';
          const lampCls = mine && lit ? 'lamp lamp-ok'
            : lit ? 'lamp'
              : 'lamp lamp-unlit';

          const ownership = mine ? 'This project'
            : lit ? 'Another project'
              : 'No project yet';

          return h('div', { style: 'min-width:9rem' },
            // index triangle — the marker that says "this one", nothing else.
            // Kept in the flow (hidden, not removed) so both plates stay aligned.
            h('span', {
              'aria-hidden': 'true',
              style: 'display:block;font-size:var(--fs-legend-sm);line-height:1;margin-bottom:.2rem;color:var(--luminous)'
                + (mine ? '' : ';visibility:hidden')
            }, '▲'),
            h('span', {
              class: !mine && !lit ? 'placard placard-unlit' : 'placard',
              style: plateStyle,
              title: mine
                ? `This project calibrates ${nz.label}.`
                : lit
                  ? `${nz.label} has values from a different project.`
                  : `Nothing has been measured for ${nz.label} yet — this panel is dark.`
            },
              h('span', { class: lampCls, 'aria-hidden': 'true' }),
              ' ',
              mine ? h('span', { class: 'sr-only' }, 'Target nozzle for this project: ') : null,
              nz.label),
            h('span', {
              class: 'placard-sub',
              style: mine ? 'color:var(--luminous)' : ''
            }, ownership),
            h('span', { class: 'placard-sub', style: 'margin-top:.15em' },
              `${feedLabel} · ${lit ? 'calibrated' : 'not yet measured'}`));
        }))
    );
  }

  const label = nozzleBadgeLabel(p, printer);
  if (!label) return null;
  return h('div', {},
    h('span', { class: 'placard', title: 'This project calibrates one specific nozzle' }, label));
}

function exportFileName(p: CalibrationProject): string {
  const base = `${p.filament.manufacturer}-${p.filament.material}-${p.filament.color}`.replace(/[^a-z0-9-]+/gi, '_');
  return `trim-${base || 'project'}.json`;
}
