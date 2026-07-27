import { h, clear, confirmDialog, toast, download } from './dom';
import { getProject, getPrinter, saveProject, addTimeline, completionPercent, currentStage } from '../storage/store';
import { CALIBRATIONS, getCalibration } from '../data/calibrations';
import { confidenceScore, confidenceLabel } from '../logic/confidence';
import { recommendationsForProject } from '../logic/recommendations';
import { exportProject } from '../export/backup';
import { copyFinalsToClipboard } from './report';
import { STEP_DEPENDENCY_WARNINGS, nozzleBadgeLabel, flexibleRetractionCaution } from '../logic/ranges';
import { getMaterial } from '../data/materials';
import { presetBackupCallout } from './presetBackupPrompt';
import type { CalibrationProject, CalibrationId } from '../types';

/**
 * Presentation-only memory of the panel we last drew. The needle-settle
 * animation is the app's one authored moment, so it fires when a value LANDS
 * (arriving from a finished test, or opening a different project) and stays
 * still for re-renders caused by reordering, skipping or switching mode.
 */
let lastPanelSignature = '';

export async function renderProject(root: HTMLElement, id: string): Promise<void> {
  const p = await getProject(id);
  if (!p) {
    root.append(h('div', { class: 'card' },
      h('span', { class: 'placard placard-unlit' }, 'No such project'),
      h('h1', {}, 'Project not found'),
      h('p', {}, 'It may have been deleted on this device.'),
      h('a', { class: 'btn btn-primary', href: '#/' }, 'Back to dashboard')));
    return;
  }
  const printer = await getPrinter(p.printerProfileId);
  const mat = getMaterial(p.filament.material);
  const pct = completionPercent(p);
  const stage = currentStage(p);
  const conf = confidenceScore(p);
  const recs = recommendationsForProject(p);
  const f = p.finals;

  // Something has actually been measured — otherwise every instrument stays
  // dark. A score of 0 is "not yet measured", never a reading of zero.
  const anyMeasured = conf.parts.some(part => part.earned > 0);

  const signature = [id, conf.score, f.nozzleTemp, f.flowRatio, f.pressureAdvance,
    f.retractionDistance, f.maxVolumetricSpeed, f.shrinkagePercent].join('|');
  const settle = signature !== lastPanelSignature;
  lastPanelSignature = signature;

  const rerender = async () => { clear(root); await renderProject(root, id); };

  const nozzleLabel = nozzleBadgeLabel(p, printer);

  // --- header ---
  root.append(
    h('p', {}, h('a', { href: '#/' }, '← All projects')),
    h('div', { class: 'score-wrap', style: 'align-items:flex-start;flex-wrap:wrap;gap:var(--s-5)' },
      h('div', { style: 'flex:1;min-width:16rem' },
        h('h1', { style: 'margin:.2rem 0' }, `${p.filament.manufacturer} ${mat.label} ${p.filament.color}`.trim()),
        h('p', { class: 'proj-vals', style: 'gap:var(--s-2);margin:var(--s-3) 0 0' },
          nozzleLabel
            ? h('span', {
                class: 'placard placard-lit',
                title: 'This project calibrates one specific nozzle'
              }, nozzleLabel)
            : null,
          p.filament.productLine ? h('span', { class: 'placard' }, p.filament.productLine) : null,
          h('span', { class: 'placard' }, `${p.filament.diameter} mm`),
          printer
            ? h('span', { class: 'placard' }, printer.name)
            : h('span', { class: 'badge badge-warn' }, 'Printer profile missing'),
          printer ? h('span', { class: 'placard' }, `${printer.nozzleDiameter} mm ${p.nozzleType}`) : null,
          h('span', { class: 'placard' }, `${p.slicer.slicer === 'orca' ? 'Orca Slicer' : 'Bambu Studio'} ${p.slicer.version}`),
          h('span', { class: 'placard' }, `Started ${p.calibrationDate}`)),
        h('p', { style: 'display:flex;align-items:center;gap:var(--s-3);flex-wrap:wrap;margin-top:var(--s-3)' },
          h('span', { class: `badge ${p.mode === 'coach' ? 'badge-accent' : 'badge-info'}` },
            p.mode === 'coach' ? '🧭 Coach mode' : '⚙ Expert mode'),
          h('button', {
            class: 'btn btn-ghost btn-sm', onClick: async () => {
              p.mode = p.mode === 'coach' ? 'expert' : 'coach';
              await saveProject(p); await rerender();
            }
          }, `Switch to ${p.mode === 'coach' ? 'Expert' : 'Coach'}`))
      ),
      h('div', { style: 'display:flex;align-items:center;gap:var(--s-4);flex-wrap:wrap' },
        gauge({ label: 'Confidence', value: anyMeasured ? conf.score : undefined, min: 0, max: 100, settle }),
        h('p', { class: 'field-help', style: 'max-width:20ch;margin:0' },
          anyMeasured ? confidenceLabel(conf.score) : 'Nothing measured yet — no test has been completed.'))
    ),
    h('div', { class: 'btn-row' },
      stage ? h('a', { class: 'btn btn-primary', href: `#/wizard/${p.id}/${stage}` }, `▶ Continue: ${getCalibration(stage).shortName}`) : null,
      h('a', { class: 'btn', href: `#/session/${p.id}`, title: 'Guided session — one screen per test, results carried forward' }, '🧭 Guided session'),
      hasCalibratedValues(p) ? h('a', { class: `btn ${stage ? '' : 'btn-primary'}`, href: `#/profile/${p.id}` }, '🧵 Create Slicer Profile') : null,
      h('a', { class: 'btn', href: `#/report/${p.id}` }, '📄 Report'),
      h('a', { class: 'btn', href: `#/card/${p.id}` }, '🪪 Calibration card'),
      h('button', { class: 'btn', onClick: () => copyFinalsToClipboard(p) }, '📋 Copy final settings'),
      h('button', { class: 'btn', onClick: async () => download(`perfectfit-${p.id.slice(0, 8)}.json`, await exportProject(p, printer)) }, '⭳ Export JSON')
    )
  );

  // --- pre-calibration slicer preset backup prompt ---
  if (stage) {
    const backupPrompt = presetBackupCallout(p, rerender);
    if (backupPrompt) root.append(backupPrompt);
  }

  // --- calibration complete: profile call-to-action ---
  if (!stage && hasCalibratedValues(p)) {
    root.append(h('div', { class: 'callout callout-ok' },
      h('p', { class: 'co-title' }, '🎉 Your filament calibration is complete.'),
      h('p', {}, 'Turn the results into a ready-to-use filament profile for your slicer — PerfectFit clones a base profile, applies only your calibrated values, and can install it for you (desktop app).'),
      h('div', { class: 'btn-row' },
        h('a', { class: 'btn btn-primary', href: `#/profile/${p.id}` }, '🧵 Create Slicer Profile'),
        h('a', { class: 'btn', href: `#/report/${p.id}` }, '📄 View Report'))
    ));
  }

  // --- the panel: six instruments, one per calibrated value ---
  root.append(h('div', { class: 'instrument' },
    h('h2', {}, nozzleLabel ? `Panel — ${nozzleLabel}` : 'Panel'),
    h('p', { class: 'field-help' },
      'A dark instrument has not been measured yet — it is not a reading of zero. Each completed test lights its own gauge.'),
    h('div', { class: 'six-pack' },
      gauge({ label: 'Nozzle temp', value: f.nozzleTemp, unit: '°C', min: 160, max: 320, settle }),
      gauge({ label: 'Flow ratio', value: f.flowRatio, min: 0.85, max: 1.15, settle }),
      gauge({ label: 'Pressure advance', value: f.pressureAdvance, min: 0, max: 1, settle }),
      gauge({ label: 'Retraction', value: f.retractionDistance, unit: 'mm', min: 0, max: 8, settle }),
      gauge({ label: 'Max vol. speed', value: f.maxVolumetricSpeed, unit: 'mm³/s', min: 0, max: 40, settle }),
      gauge({ label: 'Shrinkage', value: f.shrinkagePercent, unit: '%', min: 96, max: 104, settle }))
  ));

  // --- generated profiles ---
  if (p.generatedProfiles?.length) {
    const gpCard = h('div', { class: 'card' }, h('h2', {}, 'Generated slicer profiles'));
    for (const rec of p.generatedProfiles) {
      const last = rec.installHistory[rec.installHistory.length - 1];
      gpCard.append(h('div', { class: 'eval-item' },
        h('div', { class: 'eval-icon', 'aria-hidden': 'true' },
          h('span', { class: 'lamp lamp-ok' }),
          h('span', { style: 'display:block;margin-top:.3rem' }, '🧵')),
        h('div', { style: 'flex:1;min-width:0' },
          h('h4', {}, rec.generatedProfileName),
          h('p', { class: 'proj-vals', style: 'gap:var(--s-2);margin:var(--s-1) 0' },
            h('span', { class: 'placard' }, `${rec.changedFields.length} value(s) applied`),
            h('span', { class: 'placard' }, new Date(rec.generatedAt).toLocaleString())),
          h('p', { class: 'eval-meaning' }, `Based on “${rec.baseProfileName}”.`),
          last ? h('p', { class: 'field-help' },
            `Last action: ${last.mode}${last.success ? ' ✓' : ' ✖'} ${new Date(last.at).toLocaleString()}${last.backupId ? ` · backup ${last.backupId}` : ''}${last.verificationPassed ? ' · verified' : ''}`) : null),
        h('a', { class: 'btn btn-sm', href: `#/profile/${p.id}` }, 'Re-run Create Slicer Profile')
      ));
    }
    root.append(gpCard);
  }

  // --- smart recommendations ---
  if (recs.length) {
    root.append(h('div', { class: 'callout callout-warn' },
      h('p', { class: 'co-title' }, '⚠ Smart recommendations'),
      h('ul', { class: 'issues' },
        recs.slice(0, 4).map(r => h('li', { class: 'issue issue-warning' },
          h('span', { class: 'issue-icon', 'aria-hidden': 'true' }, '⚠'),
          h('span', {},
            h('span', { class: 'placard', style: 'margin-right:.45rem' }, getCalibration(r.targetStep).shortName),
            r.reason, ' ',
            h('a', { href: `#/wizard/${p.id}/${r.targetStep}` }, 'Re-run test →')))))
    ));
  }

  // --- steps ---
  const stepsCard = h('div', { class: 'card' },
    h('h2', {}, 'Calibration steps'),
    h('div', { class: 'substep-bar' },
      h('span', { class: 'label' }, 'Plan complete'),
      h('div', { class: 'bar' }, h('div', { style: `--fill:${pct / 100}` })),
      h('span', { class: 'label' }, `${pct}%`)),
    h('p', { class: 'field-help' },
      'The order matters: temperature affects flow, flow affects pressure advance, and all three affect retraction. Reordering or skipping is allowed, but the app will warn you about dependencies.')
  );

  p.stepOrder.forEach((sid, idx) => {
    const def = getCalibration(sid);
    const st = p.steps[sid];
    const status = st?.status ?? 'not-started';
    const badge =
      status === 'completed' ? h('span', { class: 'badge badge-ok' }, '✓ Calibrated') :
      status === 'in-progress' ? h('span', { class: 'badge badge-accent' }, '▶ In progress') :
      status === 'skipped' ? h('span', { class: 'badge badge-info' }, '⏭ Skipped') :
      h('span', { class: 'placard placard-unlit' }, 'Not measured');
    const lamp =
      status === 'completed' ? 'lamp lamp-ok' :
      status === 'in-progress' ? 'lamp' :
      'lamp lamp-unlit';

    const finalsText = finalsSummary(p, sid);

    stepsCard.append(h('div', { class: 'eval-item' },
      h('div', { class: 'eval-icon', 'aria-hidden': 'true' },
        h('span', { class: lamp }),
        h('span', { style: 'display:block;margin-top:.3rem' }, def.icon)),
      h('div', { style: 'flex:1;min-width:0' },
        h('h4', { style: 'display:flex;align-items:center;gap:var(--s-2);flex-wrap:wrap' },
          h('span', { class: 'placard' }, `Step ${idx + 1}`),
          h('span', {}, def.name),
          badge,
          st?.retestRecommended ? h('span', { class: 'badge badge-warn' }, '⟲ Retest suggested') : null),
        finalsText ? h('p', { class: 'eval-meaning' }, finalsText) : h('p', { class: 'eval-meaning' }, def.purpose.split('.')[0] + '.'),
        st?.history?.length ? h('p', { class: 'field-help' }, `${st.history.length + (st.current && st.status === 'completed' ? 1 : 0)} attempt(s) recorded`) : null
      ),
      h('div', { style: 'display:flex;flex-direction:column;gap:.3rem;align-items:flex-end' },
        h('a', { class: 'btn btn-sm btn-primary', href: `#/wizard/${p.id}/${sid}` },
          status === 'completed' ? 'Review / redo' : status === 'in-progress' ? 'Continue' : 'Start'),
        h('div', { style: 'display:flex;gap:.25rem' },
          idx > 0 ? h('button', { class: 'btn btn-ghost btn-sm', title: 'Move up', 'aria-label': `Move ${def.shortName} up`, onClick: () => moveStep(p, idx, -1, rerender) }, '↑') : null,
          idx < p.stepOrder.length - 1 ? h('button', { class: 'btn btn-ghost btn-sm', title: 'Move down', 'aria-label': `Move ${def.shortName} down`, onClick: () => moveStep(p, idx, +1, rerender) }, '↓') : null,
          status !== 'completed' && sid !== 'final-verification' ? h('button', {
            class: 'btn btn-ghost btn-sm', title: 'Skip this test', onClick: async () => {
              const warn = STEP_DEPENDENCY_WARNINGS[sid];
              const dependents = dependentsOf(sid, p);
              const ok = await confirmDialog({
                title: `Skip ${def.shortName}?`,
                body: (status === 'skipped') ? 'Un-skip this step?' :
                  `${warn ?? ''} ${dependents.length ? `Later steps that rely on it: ${dependents.join(', ')}.` : ''} You can un-skip anytime.`,
                confirmLabel: status === 'skipped' ? 'Un-skip' : 'Skip it'
              });
              if (!ok) return;
              st.status = status === 'skipped' ? 'not-started' : 'skipped';
              addTimeline(p, { stepId: sid, kind: 'skipped', summary: `${def.shortName} ${st.status === 'skipped' ? 'skipped' : 'restored'}` });
              await saveProject(p); await rerender();
            }
          }, status === 'skipped' ? '↩' : '⏭') : null
        )
      )
    ));
  });
  root.append(stepsCard);

  // --- confidence breakdown ---
  root.append(h('div', { class: 'card' },
    h('h2', {}, 'Confidence score'),
    confidenceBand(conf.score, anyMeasured),
    h('p', { class: 'field-help' }, 'The score reflects how complete and trustworthy this profile is: each finished test adds its weight, scaled by the confidence you reported; skipped tests add nothing; tests flagged for retest count less.'),
    h('div', { class: 'table-scroll' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Test'), h('th', {}, 'Contribution'), h('th', {}, 'Status'))),
      h('tbody', {}, conf.parts.map(part => h('tr', {},
        h('th', { scope: 'row' }, getCalibration(part.step).shortName),
        h('td', {}, `${Math.round(part.earned)} / ${part.possible}`),
        h('td', {},
          h('span', { class: `lamp ${part.earned > 0 ? 'lamp-ok' : 'lamp-unlit'}`, style: 'margin-right:.4rem' }),
          part.note))))
    ))
  ));

  // --- timeline: the logged sequence ---
  const tl = [...p.timeline].reverse();
  root.append(h('div', { class: 'card' },
    h('h2', {}, 'Calibration log'),
    tl.length > 50
      ? h('p', { class: 'field-help' }, `Showing the 50 most recent of ${tl.length} logged entries, newest first.`)
      : null,
    tl.length
      ? h('ul', { class: 'timeline' }, tl.slice(0, 50).map(e => h('li', {},
          h('div', { class: 'tl-time' }, new Date(e.at).toLocaleString()),
          h('div', { style: 'margin-top:.2rem' },
            h('span', { class: 'placard', style: 'margin-right:.45rem' },
              e.stepId === 'project' ? 'Project' : getCalibration(e.stepId as CalibrationId).shortName),
            e.summary),
          e.detail ? h('div', { class: 'field-help' }, e.detail) : null)))
      : h('p', { class: 'field-help' }, 'Every value you set will be logged here so you can see how the profile evolved.')
  ));
}

/** At least one calibrated final exists — the profile generator has something to apply. */
export function hasCalibratedValues(p: CalibrationProject): boolean {
  const f = p.finals;
  return [f.nozzleTemp, f.flowRatio, f.pressureAdvance, f.retractionDistance, f.maxVolumetricSpeed]
    .some(v => v !== undefined);
}

/** Steps in THIS project's plan that depend on `sid` (optional steps like ooze-control only count when the project carries them). */
function dependentsOf(sid: CalibrationId, p: CalibrationProject): string[] {
  return p.stepOrder
    .filter(id => CALIBRATIONS[id]?.dependencies.includes(sid))
    .map(id => getCalibration(id).shortName);
}

async function moveStep(p: CalibrationProject, idx: number, dir: -1 | 1, rerender: () => Promise<void>): Promise<void> {
  const target = idx + dir;
  const sid = p.stepOrder[idx];
  const other = p.stepOrder[target];
  const def = getCalibration(sid);
  // dependency warning when moving a step before one of its dependencies
  const wouldViolate = dir === -1
    ? def.dependencies.includes(other)
    : getCalibration(other).dependencies.includes(sid);
  if (wouldViolate) {
    const ok = await confirmDialog({
      title: 'Dependency warning',
      body: dir === -1
        ? `${def.shortName} normally runs AFTER ${getCalibration(other).shortName} (${STEP_DEPENDENCY_WARNINGS[sid] ?? 'results build on it'}). Reorder anyway?`
        : `${getCalibration(other).shortName} normally runs AFTER ${def.shortName}. Reorder anyway?`,
      confirmLabel: 'Reorder anyway'
    });
    if (!ok) return;
  }
  [p.stepOrder[idx], p.stepOrder[target]] = [p.stepOrder[target], p.stepOrder[idx]];
  await saveProject(p);
  await rerender();
}

function finalsSummary(p: CalibrationProject, sid: CalibrationId): string {
  const f = p.finals;
  switch (sid) {
    case 'temperature':
      return f.nozzleTemp !== undefined ? `Chosen: ${f.nozzleTemp} °C${f.firstLayerTemp ? ` (first layer ${f.firstLayerTemp} °C)` : ''}${f.highFlowTemp ? ` (high-flow ${f.highFlowTemp} °C)` : ''}` : '';
    case 'flow-pass1':
    case 'flow-pass2':
    case 'flow-verify':
      return f.flowRatio !== undefined ? `Flow ratio: ${f.flowRatio}` : '';
    case 'pressure-advance':
      return f.pressureAdvance !== undefined ? `PA: ${f.pressureAdvance}` : '';
    case 'retraction': {
      if (f.retractionDistance === undefined) return '';
      // Same one cap the tower planner, the compute step, the report and the
      // write path use — a flexible retraction this long must not be quoted
      // back to the user as a settled result.
      const caution = flexibleRetractionCaution(p.filament.material, f.retractionDistance);
      return `Retraction: ${f.retractionDistance} mm${f.retractionSpeed ? ` @ ${f.retractionSpeed} mm/s` : ''}${caution ? ` — ⚠ ${caution}` : ''}`;
    }
    case 'max-volumetric-speed':
      return f.maxVolumetricSpeed !== undefined ? `Max volumetric speed: ${f.maxVolumetricSpeed} mm³/s` : '';
    case 'shrinkage':
      return f.shrinkagePercent !== undefined ? `Shrinkage: ${f.shrinkagePercent}%` : '';
    default: return '';
  }
}

// --- instruments -----------------------------------------------------------

/**
 * One round gauge with its placard beneath. `min`/`max` are a DISPLAY scale
 * only — they place the needle on the dial and never touch stored values or
 * any calculation. An absent value draws an UNLIT face: no needle, no fake
 * zero, because dark means "not yet measured".
 */
function gauge(spec: {
  label: string;
  value?: number;
  unit?: string;
  min: number;
  max: number;
  settle: boolean;
}): HTMLElement {
  const lit = spec.value !== undefined && Number.isFinite(spec.value);
  const span = spec.max - spec.min || 1;
  const t = lit ? Math.min(1, Math.max(0, ((spec.value as number) - spec.min) / span)) : 0;
  const angle = -135 + t * 270;
  const reading = lit ? `${spec.value}${spec.unit ? ` ${spec.unit}` : ''}` : 'not measured yet';
  return h('div', {
    class: `gauge ${lit ? 'is-lit' : 'is-unlit'}${spec.settle ? '' : ' no-settle'}`,
    style: `--angle:${angle.toFixed(1)}deg`,
    role: 'img',
    'aria-label': `${spec.label}: ${reading}`
  },
    h('div', { class: 'gauge-face' },
      h('span', { class: 'gauge-ticks', 'aria-hidden': 'true' }),
      h('span', { class: 'gauge-needle', 'aria-hidden': 'true' }),
      h('span', { class: 'gauge-hub', 'aria-hidden': 'true' }),
      h('span', { class: 'gauge-readout', 'aria-hidden': 'true' },
        h('b', { class: 'gauge-value' }, lit ? String(spec.value) : '—'),
        spec.unit ? h('i', { class: 'gauge-unit' }, spec.unit) : null)),
    h('span', { class: 'gauge-placard' }, spec.label));
}

/**
 * The confidence reading against its band. A capability score is a scale, not
 * a percentage in a circle: 60 and above is the band you can build production
 * prints on, and the hairline drift shows how far the reading sits from the
 * middle of it long before anything would need to shout.
 */
function confidenceBand(score: number, measured: boolean): HTMLElement {
  const at = Math.min(100, Math.max(0, score));
  return h('div', {
    class: `band${measured ? '' : ' is-unlit'}`,
    style: `--lo:60%;--hi:100%;--at:${at}%;--mid:80%`
  },
    h('div', { class: 'band-track' },
      h('span', { class: 'band-span' }),
      h('span', { class: 'band-drift' }),
      h('span', { class: 'band-mark' })),
    h('div', { class: 'band-scale' }, h('span', {}, '0'), h('span', {}, '100')),
    h('p', { class: 'band-legend' }, measured
      ? `Reading ${score} of 100 — ${confidenceLabel(score)}. The marked band, 60 and above, is where a profile is complete enough to trust for real prints.`
      : 'Nothing measured yet, so there is no reading to place. The marked band, 60 and above, is where a profile is complete enough to trust for real prints.'));
}
