import { h } from './dom';
import { getProject, getPrinter } from '../storage/store';
import { getMaterial } from '../data/materials';
import { confidenceScore } from '../logic/confidence';
import { nozzleBadgeLabel } from '../logic/ranges';
import { gaugeEl, projectGauges } from './dashboard';
import QRCode from 'qrcode';

/**
 * Printable one-page calibration card with a QR code.
 *
 * This is real printed output — it gets carried to the machine — so every part
 * of it is drawn as line work that survives a monochrome printer: dials with
 * tick scales, hairline rules, and boxed placards. The print stylesheet inverts
 * the panel to ink on white; nothing here depends on colour to be readable.
 *
 * The QR encodes the app's URL plus the project id (opens this saved
 * calibration when scanned on the device hosting the app). Because the app is
 * local-first, the QR resolves wherever this app is served — for a fully
 * portable option the card also lists every value in plain text.
 */
/** Denser table rows — the sheet has to hold the whole calibration. */
const CELL = 'padding:.3rem .65rem';

export async function renderCard(root: HTMLElement, id: string): Promise<void> {
  const p = await getProject(id);
  if (!p) { root.append(h('p', {}, 'Project not found.')); return; }
  const printer = await getPrinter(p.printerProfileId);
  const mat = getMaterial(p.filament.material);
  const conf = confidenceScore(p);
  const f = p.finals;
  const nozzleLabel = nozzleBadgeLabel(p, printer);

  const url = `${location.origin}${location.pathname}#/project/${p.id}`;
  const canvas = h('canvas', { width: 160, height: 160, 'aria-label': 'QR code linking to this calibration' });
  try {
    await QRCode.toCanvas(canvas, url, { width: 160, margin: 1 });
  } catch { /* QR is a nice-to-have; the text carries the data */ }

  const vals: [string, string][] = [];
  if (f.firstLayerTemp !== undefined) vals.push(['First layer', `${f.firstLayerTemp} °C`]);
  if (f.nozzleTemp !== undefined) vals.push(['Nozzle temp', `${f.nozzleTemp} °C`]);
  if (f.highFlowTemp !== undefined) vals.push(['High-flow temp', `${f.highFlowTemp} °C`]);
  if (f.flowRatio !== undefined) vals.push(['Flow ratio', String(f.flowRatio)]);
  if (f.pressureAdvance !== undefined) vals.push(['Pressure advance', String(f.pressureAdvance)]);
  if (f.retractionDistance !== undefined) vals.push(['Retraction', `${f.retractionDistance} mm${f.retractionSpeed ? ` @ ${f.retractionSpeed} mm/s` : ''}`]);
  if (f.maxVolumetricSpeed !== undefined) vals.push(['Max vol. speed', `${f.maxVolumetricSpeed} mm³/s`]);
  if (f.shrinkagePercent !== undefined) vals.push(['Shrinkage (XY)', `${f.shrinkagePercent}%`]);

  root.append(
    h('div', { class: 'no-print btn-row', style: 'margin-bottom:1rem' },
      h('a', { class: 'btn', href: `#/project/${p.id}` }, '← Back'),
      h('button', { class: 'btn btn-primary', onClick: () => window.print() }, 'Print card')),

    // No top margin: on paper it would collapse out to the body and push the
    // sheet past a single page (body keeps a 100vh minimum). The screen gets
    // its breathing room from the button row above instead.
    h('div', { class: 'card', style: 'max-width:640px;margin:0 auto' },
      // --- nameplate ------------------------------------------------------
      h('div', { style: 'display:flex;gap:1rem;align-items:flex-start' },
        h('div', { style: 'flex:1;min-width:0' },
          h('span', { class: 'placard' }, 'Calibration card'),
          h('h1', { style: 'margin:.4rem 0 .15rem;font-size:1.3rem' }, `${p.filament.manufacturer} ${mat.label}`),
          h('p', { class: 'proj-sub' },
            [p.filament.productLine, p.filament.color, `${p.filament.diameter} mm`].filter(Boolean).join(' · ')),
          h('p', { class: 'proj-sub' },
            `${printer?.name ?? 'printer'} · ${printer?.nozzleDiameter ?? '?'} mm ${p.nozzleType} · ${printer?.extruderType === 'bowden' ? 'Bowden' : 'direct drive'}`),
          h('div', { style: 'display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.5rem' },
            h('span', { class: 'placard placard-lit' }, `Confidence ${conf.score} / 100`),
            h('span', { class: 'placard' }, `Calibrated ${p.calibrationDate}`),
            nozzleLabel ? h('span', { class: 'placard' }, nozzleLabel) : null)),
        h('div', { style: 'text-align:center;flex:none' },
          canvas,
          h('span', { class: 'placard-sub', style: 'max-width:160px' }, 'Scan to open'))),

      // --- the six-pack, printed as drawn dials ---------------------------
      // Tightened so the dials, the value table and the notes all land on one
      // sheet — this card is carried to the machine, not read on a screen.
      h('div', { class: 'six-pack', style: 'margin:.35rem 0;padding:.55rem 0' },
        projectGauges(p, printer).map(g => gaugeEl(g, { size: 'sm', settle: false, dial: '5.4rem' }))),

      // --- the same values in plain text, for typing into the slicer ------
      h('table', { class: 'data', style: 'margin-top:.2rem' },
        h('thead', {}, h('tr', {},
          h('th', { style: `width:200px;${CELL}` }, 'Parameter'),
          h('th', { style: CELL }, 'Value'))),
        h('tbody', {}, vals.length
          ? vals.map(([k, v]) => h('tr', {},
            h('th', { style: `width:200px;${CELL}` }, k),
            h('td', { style: CELL }, h('span', { class: 'value-chip' }, v))))
          : [h('tr', {}, h('td', { colspan: '2', style: CELL }, 'No calibrated values yet — finish some tests first.'))])),

      p.notes ? h('div', { class: 'panel', style: 'margin:.35rem 0' },
        h('span', { class: 'readout-label' }, 'Notes'),
        h('p', { class: 'proj-sub', style: 'margin:.25rem 0 0' }, p.notes)) : null,

      h('hr', { class: 'rule-ticks', style: 'margin:.4rem 0' }),
      h('p', { class: 'field-help', style: 'margin:0' },
        `Slicer: ${p.slicer.slicer === 'orca' ? 'Orca Slicer' : 'Bambu Studio'} ${p.slicer.version} · PerfectFit calibration card`)
    )
  );
}
