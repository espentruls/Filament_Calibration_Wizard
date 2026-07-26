import { h, toast } from './dom';
import { getProject, getPrinter, completionPercent } from '../storage/store';
import { getCalibration } from '../data/calibrations';
import { getMaterial } from '../data/materials';
import { getSlicerContent } from '../data/slicers';
import { confidenceScore, confidenceLabel } from '../logic/confidence';
import type { CalibrationProject, CalibrationId } from '../types';

/** Copy the final calibrated values to the clipboard as readable text. */
export async function copyFinalsToClipboard(p: CalibrationProject): Promise<void> {
  const mat = getMaterial(p.filament.material);
  const f = p.finals;
  const lines = [
    `${p.filament.manufacturer} ${mat.label} ${p.filament.color} — calibrated ${p.calibrationDate}`,
    f.firstLayerTemp !== undefined ? `First-layer temperature: ${f.firstLayerTemp} °C` : null,
    f.nozzleTemp !== undefined ? `Nozzle temperature: ${f.nozzleTemp} °C` : null,
    f.highFlowTemp !== undefined ? `High-flow temperature: ${f.highFlowTemp} °C` : null,
    f.flowRatio !== undefined ? `Flow ratio: ${f.flowRatio}` : null,
    f.pressureAdvance !== undefined ? `Pressure advance: ${f.pressureAdvance}` : null,
    f.retractionDistance !== undefined ? `Retraction length: ${f.retractionDistance} mm` : null,
    f.retractionSpeed !== undefined ? `Retraction speed: ${f.retractionSpeed} mm/s` : null,
    f.maxVolumetricSpeed !== undefined ? `Max volumetric speed: ${f.maxVolumetricSpeed} mm³/s` : null,
    f.shrinkagePercent !== undefined ? `Shrinkage (XY): ${f.shrinkagePercent}%` : null
  ].filter(Boolean);
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    toast('Final settings copied to clipboard.', 'success');
  } catch {
    toast('Clipboard unavailable — use the report page instead.', 'error');
  }
}

/** Printable full calibration report. */
export async function renderReport(root: HTMLElement, id: string): Promise<void> {
  const p = await getProject(id);
  if (!p) { root.append(h('p', {}, 'Project not found.')); return; }
  const printer = await getPrinter(p.printerProfileId);
  const mat = getMaterial(p.filament.material);
  const slicer = getSlicerContent(p.slicer.slicer, p.slicer.version);
  const conf = confidenceScore(p);
  const f = p.finals;

  // The instrument constellation: every value this project can land, ranked in
  // rows. A value that has not been measured stays UNLIT — it is never a zero.
  const instruments: [string, number | undefined, string?][] = [
    ['First layer', f.firstLayerTemp, '°C'],
    ['Nozzle temp', f.nozzleTemp, '°C'],
    ...(f.highFlowTemp !== undefined ? [['High-flow temp', f.highFlowTemp, '°C'] as [string, number, string]] : []),
    ['Flow ratio', f.flowRatio],
    ['Pressure advance', f.pressureAdvance],
    ['Retraction', f.retractionDistance, 'mm'],
    ['Retract speed', f.retractionSpeed, 'mm/s'],
    ['Max vol. speed', f.maxVolumetricSpeed, 'mm³/s'],
    ['Shrinkage XY', f.shrinkagePercent, '%']
  ];

  root.append(
    h('div', { class: 'no-print btn-row' },
      h('a', { class: 'btn', href: `#/project/${p.id}` }, '← Back'),
      h('button', { class: 'btn btn-primary', onClick: () => window.print() }, '🖨 Print / save as PDF')),

    // Masthead: engraved placard, then the spool this record belongs to.
    h('p', { style: 'margin:0' }, h('span', { class: 'placard' }, 'Calibration record')),
    h('h1', {}, `${p.filament.manufacturer} ${mat.label} ${p.filament.color}`),
    h('p', { class: 'field-help', style: 'margin-top:0' },
      [
        printer ? `${printer.name} · ${printer.nozzleDiameter} mm ${p.nozzleType}` : 'printer profile deleted',
        `${slicer.slicerLabel} ${p.slicer.version}`,
        `calibrated ${p.calibrationDate}`
      ].join(' · ')),
    h('hr', { class: 'rule-ticks' }),

    h('div', { class: 'card' },
      h('h2', {}, 'Final values'),
      h('p', { class: 'field-help' },
        'These are the numbers to enter in the slicer. A dark instrument is a value you have not measured yet — it is not a zero.'),
      h('div', { class: 'readout-grid' },
        instruments.map(([label, value, unit]) => instrumentCell(label, value, unit))),
      h('div', { class: 'table-scroll' }, h('table', { class: 'data' }, h('tbody', {},
        p.finals.firstLayerTemp !== undefined ? row('First-layer temperature', `${p.finals.firstLayerTemp} °C`) : null,
        p.finals.nozzleTemp !== undefined ? row('Nozzle temperature', `${p.finals.nozzleTemp} °C`) : null,
        p.finals.highFlowTemp !== undefined ? row('High-flow temperature', `${p.finals.highFlowTemp} °C`) : null,
        p.finals.flowRatio !== undefined ? row('Flow ratio', String(p.finals.flowRatio)) : null,
        p.finals.pressureAdvance !== undefined ? row('Pressure advance', String(p.finals.pressureAdvance)) : null,
        p.finals.retractionDistance !== undefined ? row('Retraction length', `${p.finals.retractionDistance} mm`) : null,
        p.finals.retractionSpeed !== undefined ? row('Retraction speed', `${p.finals.retractionSpeed} mm/s`) : null,
        p.finals.maxVolumetricSpeed !== undefined ? row('Max volumetric speed', `${p.finals.maxVolumetricSpeed} mm³/s`) : null,
        p.finals.shrinkagePercent !== undefined ? row('Shrinkage (XY)', `${p.finals.shrinkagePercent}%`) : null
      )))
    ),

    h('div', { class: 'card' },
      h('h2', {}, 'Overview'),
      h('div', { class: 'table-scroll' }, h('table', { class: 'data' }, h('tbody', {},
        row('Filament', `${p.filament.manufacturer} ${p.filament.productLine} — ${mat.label}${p.filament.materialOther ? ` (${p.filament.materialOther})` : ''}, ${p.filament.color}, ${p.filament.diameter} mm`),
        row('Printer', printer ? `${printer.name} (${printer.manufacturer}) — ${printer.nozzleDiameter} mm ${p.nozzleType} nozzle, ${printer.extruderType === 'direct' ? 'direct drive' : 'Bowden'}` : '(printer profile deleted)'),
        row('Printer limits', printer ? `nozzle ≤ ${printer.maxNozzleTemp} °C · bed ≤ ${printer.maxBedTemp} °C · flow ${printer.maxVolumetricFlow ? `≤ ${printer.maxVolumetricFlow} mm³/s` : 'unrated'}` : '—'),
        row('Slicer', `${slicer.slicerLabel} ${p.slicer.version} (instructions verified ${slicer.verifiedOn})`),
        row('Starting profile', p.filament.startingProfile || '—'),
        row('Calibration date', p.calibrationDate),
        row('Completion', `${completionPercent(p)}%`),
        row('Confidence score', `${conf.score}/100 — ${confidenceLabel(conf.score)}`),
        p.notes ? row('Notes', p.notes) : null
      )))
    )
  );

  // Per-test detail
  for (const sid of p.stepOrder) {
    const st = p.steps[sid];
    const def = getCalibration(sid);
    if (!st || (!st.current && !st.history.length)) continue;
    const a = st.current;
    root.append(h('div', { class: 'card' },
      h('h2', {}, `${def.icon} ${def.name}`),
      h('div', { style: 'display:flex;flex-wrap:wrap;gap:.4rem;margin:0 0 .6rem' },
        statusChip(st.status),
        st.retestRecommended ? h('span', { class: 'badge badge-warn' }, 'retest recommended') : null,
        a?.confidence ? h('span', { class: 'badge badge-info' }, `confidence: ${a.confidence}`) : null),
      a ? h('div', { class: 'table-scroll' }, h('table', { class: 'data' }, h('tbody', {},
        a.method ? row('Method', a.method) : null,
        row('Test settings', kv(a.settings)),
        row('Result entry', kv(a.result)),
        row('Computed', kv(a.computed)),
        a.notes ? row('Notes', a.notes) : null,
        row('Completed', a.completedAt ? new Date(a.completedAt).toLocaleString() : '—')
      ))) : null,
      st.history.length ? h('p', { class: 'field-help' }, `${st.history.length} earlier attempt(s) preserved in history.`) : null
    ));
  }

  // Timeline
  root.append(h('div', { class: 'card' },
    h('h2', {}, 'Timeline'),
    h('ul', { class: 'timeline' }, [...p.timeline].reverse().map(e => h('li', {},
      h('div', { class: 'tl-time' }, new Date(e.at).toLocaleString()),
      h('div', {}, h('strong', {}, e.stepId === 'project' ? 'Project' : getCalibration(e.stepId as CalibrationId).shortName), ` — ${e.summary}`))))
  ));
}

/**
 * One instrument in the ranked constellation: a tabular readout with a bordered
 * placard BENEATH it. Product rule #1 — an unmeasured value renders unlit with
 * an em-dash, never a fabricated zero.
 */
function instrumentCell(label: string, value: number | undefined, unit?: string): HTMLElement {
  const lit = value !== undefined;
  return h('div', {
    class: 'panel',
    style: 'margin:0;width:100%;display:flex;flex-direction:column;align-items:center;gap:.55rem;text-align:center'
  },
    h('span', { class: lit ? 'readout' : 'readout is-unlit' },
      h('b', { class: 'readout-value' }, lit ? String(value) : '—'),
      unit ? h('i', { class: 'readout-unit' }, unit) : null),
    h('span', {
      class: lit ? 'placard' : 'placard placard-unlit',
      style: 'white-space:normal'
    }, label),
    lit ? null : h('span', { class: 'sr-only' }, 'Not measured yet')
  );
}

/** Status annunciator: a lamp inside a placard chip. */
function statusChip(s: string): HTMLElement {
  const spec = s === 'completed'
    ? { badge: 'badge badge-ok', lamp: 'lamp lamp-ok', text: 'completed' }
    : s === 'skipped'
      ? { badge: 'badge badge-info', lamp: 'lamp lamp-unlit', text: 'skipped' }
      : s === 'in-progress'
        ? { badge: 'badge', lamp: 'lamp', text: 'in progress' }
        : { badge: 'badge badge-info', lamp: 'lamp lamp-unlit', text: 'not started' };
  return h('span', { class: spec.badge },
    h('span', { class: spec.lamp, 'aria-hidden': 'true' }), spec.text);
}

function row(k: string, v: string): HTMLElement {
  return h('tr', {}, h('th', { style: 'width:220px' }, k), h('td', {}, v));
}
function kv(o: Record<string, unknown>): string {
  return Object.entries(o)
    .filter(([, v]) => v !== '' && v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    .join(' · ') || '—';
}
