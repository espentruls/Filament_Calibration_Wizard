import { h, clear, frag, field, issueList, toast, confirmDialog } from './dom';
import {
  getProject, getPrinter, saveProject, addTimeline, uid,
  saveDraft, loadDraft, clearDraft, savePhoto, deletePhoto
} from '../storage/store';
import { getCalibration } from '../data/calibrations';
import { getSlicerContent } from '../data/slicers';
import { getMaterial } from '../data/materials';
import { MODEL_MANIFEST } from '../data/models';
import { CONTROLLERS, type TestCtx, type ComputeOutput } from './testForms';
import { applyRetestFlags } from '../logic/recommendations';
import { navigate, setLeaveGuard } from '../app';
import type { CalcResult } from '../logic/formulas';
import type {
  CalibrationId, CalibrationProject, CalibrationAttempt, ConfidenceLevel, PrinterProfile, StoredPhoto
} from '../types';

type StageId = 'purpose' | 'prereq' | 'method' | 'range' | 'slicer' | 'evaluate' | 'result' | 'calc' | 'done';

interface WizardState {
  stage: StageId;
  method: string;
  prereqs: string[];
  settings: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
}

export async function renderWizard(root: HTMLElement, projectId: string, stepId: CalibrationId): Promise<void> {
  const loaded = await getProject(projectId);
  const def = getCalibration(stepId);
  if (!loaded || !def) {
    root.append(h('div', { class: 'card' }, h('h1', {}, 'Not found'), h('a', { class: 'btn', href: '#/' }, 'Back')));
    return;
  }
  const project: CalibrationProject = loaded;
  const printer = await getPrinter(project.printerProfileId);
  const material = getMaterial(project.filament.material);
  const coach = project.mode === 'coach';
  const slicer = getSlicerContent(project.slicer.slicer, project.slicer.version);
  const instructions = slicer.perTest[stepId];

  const draftKey = `${projectId}:${stepId}`;
  const stored = loadDraft<WizardState>(draftKey);
  const state: WizardState = stored ?? {
    stage: 'purpose',
    method: def.methods.find(m => m.recommended && m.slicers.includes(project.slicer.slicer))?.id
      ?? def.methods.find(m => m.slicers.includes(project.slicer.slicer))?.id
      ?? def.methods[0].id,
    prereqs: [],
    settings: null,
    result: null
  };

  const stages: StageId[] = coach
    ? ['purpose', 'prereq', 'method', 'range', 'slicer', 'evaluate', 'result', 'calc', 'done']
    : ['prereq', 'method', 'range', 'slicer', 'result', 'calc', 'done'];
  if (!stages.includes(state.stage)) state.stage = stages[0];

  const persist = () => saveDraft(draftKey, state);

  // Warn before leaving mid-entry (past the informational stages).
  setLeaveGuard(async () => {
    const idx = stages.indexOf(state.stage);
    if (idx <= stages.indexOf('range') || state.stage === 'done') return true;
    persist(); // drafts survive regardless
    return confirmDialog({
      title: 'Leave this test?',
      body: 'Your entries are auto-saved as a draft and will be restored when you come back. Leave now?',
      confirmLabel: 'Leave'
    });
  });

  const ctx: TestCtx = { project, printer, material, method: state.method, coach };
  const controller = CONTROLLERS[stepId];

  const container = h('div', {});
  root.append(frag(
    h('p', {}, h('a', { href: `#/project/${project.id}` }, '← Project overview')),
    h('h1', {}, `${def.icon} ${def.name}`),
    coach ? null : h('p', { class: 'field-help' },
      h('span', { class: 'placard' }, 'Expert mode'),
      ' Condensed steps. Switch modes from the project page.'),
    container
  ));

  const stageLabels: Record<StageId, string> = {
    purpose: 'Why', prereq: 'Before you begin', method: 'Test method', range: 'Settings & range',
    slicer: 'Slicer steps', evaluate: 'Inspect the print', result: 'Enter results', calc: 'Calculation', done: 'Save & finish'
  };

  /** Short engraved names for the cross-check sweep placards. */
  const stagePlacards: Record<StageId, string> = {
    purpose: 'Why', prereq: 'Preflight', method: 'Method', range: 'Range',
    slicer: 'Slicer', evaluate: 'Inspect', result: 'Results', calc: 'Calc', done: 'Save'
  };

  function renderStage(): void {
    ctx.method = state.method;
    clear(container);
    const idx = stages.indexOf(state.stage);
    const pct = Math.round((idx / (stages.length - 1)) * 100);

    // The cross-check sweep: every stage of this test as a ranked placard.
    // Done reads lit, the current one reads active, the rest sit unlit.
    container.append(
      h('ol', { class: 'progress-steps', 'aria-label': 'Cross-check sweep for this test' },
        stages.map((s, i) => h('li', {
          class: `progress-step${i < idx ? ' is-done' : i === idx ? ' is-current' : ''}`,
          'aria-current': i === idx ? 'step' : null
        },
          h('span', { class: 'sr-only' },
            i < idx ? 'Done: ' : i === idx ? 'Current step: ' : 'Not reached: '),
          h('b', {}, String(i + 1).padStart(2, '0')),
          stagePlacards[s]))),
      h('div', { class: 'substep-bar' },
        h('span', { class: 'label' }, stageLabels[state.stage]),
        h('div', {
          class: 'bar', role: 'progressbar',
          'aria-label': 'Progress through this test',
          'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct)
        }, h('div', { style: `--fill:${pct / 100}` })),
        h('span', {
          class: 'placard placard-lit',
          'aria-label': `Step ${idx + 1} of ${stages.length}`
        }, `${idx + 1} / ${stages.length}`)
      )
    );

    const card = h('div', { class: 'card' });
    container.append(card);

    const nav = (opts: { nextLabel?: string; onNext?: () => boolean | Promise<boolean>; noBack?: boolean; noNext?: boolean } = {}) => {
      const row = h('div', { class: 'btn-row' });
      if (!opts.noBack && idx > 0) {
        row.append(h('button', {
          class: 'btn', onClick: () => { state.stage = stages[idx - 1]; persist(); renderStage(); }
        }, '← Back'));
      }
      if (!opts.noNext) {
        row.append(h('button', {
          class: 'btn btn-primary', onClick: async () => {
            const ok = opts.onNext ? await opts.onNext() : true;
            if (!ok) return;
            state.stage = stages[idx + 1];
            persist();
            renderStage();
            window.scrollTo(0, 0);
          }
        }, opts.nextLabel ?? 'Next →'));
      }
      return row;
    };

    switch (state.stage) {
      // ---------------------------------------------------------------- purpose
      case 'purpose': {
        card.append(frag(
          h('h2', { style: 'margin-top:0' }, 'What this calibrates'),
          h('p', {}, def.purpose),
          h('div', { class: 'callout' },
            h('p', { class: 'co-title' }, 'Why now?'),
            h('p', {}, def.whyThisOrder)),
          h('details', { class: 'why' },
            h('summary', {}, 'Why am I doing this? (the full story)'),
            h('div', { class: 'why-body' }, h('p', {}, def.whyExpanded))),
          def.versionNotes.length ? h('details', { class: 'why' },
            h('summary', {}, `Version notes (${slicer.slicerLabel} ${slicer.version})`),
            h('div', { class: 'why-body' }, h('ul', {}, def.versionNotes.map(n => h('li', {}, n))))) : null,
          nav()
        ));
        break;
      }

      // ---------------------------------------------------------------- prereq
      case 'prereq': {
        const checks = new Set(state.prereqs);
        card.append(frag(
          h('h2', { style: 'margin-top:0' }, 'Before you begin'),
          coach ? h('p', { class: 'field-help' }, 'These aren\'t bureaucracy — each unchecked box is a common way this test produces garbage results.') : null,
          h('fieldset', {},
            h('legend', {}, 'Preflight checks'),
            def.prerequisites.map(pr => {
              const cb = h('input', {
                type: 'checkbox', checked: checks.has(pr.id),
                onChange: () => { cb.checked ? checks.add(pr.id) : checks.delete(pr.id); }
              });
              return h('div', { class: 'check-item' }, cb,
                h('div', {}, h('strong', {}, pr.label),
                  coach && pr.coachNote ? h('p', { class: 'coach-note' }, pr.coachNote) : null));
            })),
          nav({
            onNext: async () => {
              state.prereqs = [...checks];
              if (checks.size < def.prerequisites.length) {
                return confirmDialog({
                  title: 'Some prerequisites unchecked',
                  body: 'You can continue, but unmet prerequisites are the top cause of misleading calibration results. Continue anyway?',
                  confirmLabel: 'Continue anyway'
                });
              }
              return true;
            }
          })
        ));
        break;
      }

      // ---------------------------------------------------------------- method
      case 'method': {
        const applicable = def.methods.filter(m => m.slicers.includes(project.slicer.slicer));
        const others = def.methods.filter(m => !m.slicers.includes(project.slicer.slicer));
        card.append(h('h2', { style: 'margin-top:0' }, 'Select the test method'));
        if (!applicable.length) {
          card.append(h('div', { class: 'callout callout-warn' },
            h('p', { class: 'co-title' }, `${slicer.slicerLabel} has no built-in test for this`),
            h('p', {}, 'See the slicer steps page for alternatives (external model or running this one test in Orca Slicer).')));
        }
        const groupName = `method-${stepId}`;
        [...applicable, ...others].forEach(m => {
          const radio = h('input', {
            type: 'radio', name: groupName, value: m.id,
            checked: state.method === m.id,
            onChange: () => { state.method = m.id; persist(); }
          });
          card.append(h('label', { class: 'radio-card', style: 'margin:.4rem 0;position:relative' }, radio,
            h('span', { class: 'rc-title' }, m.label,
              m.recommended ? h('span', { class: 'rc-badge' }, 'recommended') : null,
              !m.slicers.includes(project.slicer.slicer) ? h('span', { class: 'badge badge-warn', style: 'margin-left:.4rem' }, `not in ${slicer.slicerLabel}`) : null),
            h('p', { class: 'rc-desc' }, m.description)));
        });
        // External model info where relevant
        const relevantModels = MODEL_MANIFEST.filter(mm =>
          (stepId === 'final-verification' && mm.test === 'Final verification') ||
          (stepId === 'retraction' && mm.test.startsWith('Retraction')) ||
          (stepId === 'shrinkage' && mm.test.startsWith('Shrinkage')) ||
          (stepId === 'max-volumetric-speed' && mm.test.startsWith('Max flow')));
        if (relevantModels.length) {
          card.append(h('details', { class: 'why' },
            h('summary', {}, 'External test models (optional)'),
            h('div', { class: 'why-body' }, relevantModels.map(mm =>
              h('p', {}, h('strong', {}, mm.test), ` — ${mm.recommendedUse} `,
                h('a', { href: mm.sourceUrl, target: '_blank', rel: 'noopener' }, 'Download (opens third-party site)'),
                h('span', { class: 'field-help' }, ` · ${mm.attribution} · License: ${mm.license} · ${mm.fileType}`))))));
        }
        card.append(nav());
        break;
      }

      // ---------------------------------------------------------------- range
      case 'range': {
        card.append(h('h2', { style: 'margin-top:0' }, 'Choose settings and range'));
        const bundle = controller.settingsForm(ctx, state.settings);
        const issuesHost = h('div', {});
        card.append(bundle.el, issuesHost, nav({
          onNext: () => {
            const { data, issues } = bundle.collect();
            clear(issuesHost);
            const l = issueList(issues); if (l) issuesHost.append(l);
            if (issues.some(i => i.level === 'error')) return false;
            state.settings = data as Record<string, unknown>;
            return true;
          }
        }));
        break;
      }

      // ---------------------------------------------------------------- slicer
      case 'slicer': {
        card.append(h('h2', { style: 'margin-top:0' }, `Slicer instructions — ${slicer.slicerLabel} ${slicer.version}`));
        if (project.filament.startingProfile) {
          card.append(h('p', {},
            h('span', { class: 'placard' }, 'Profile you\'re calibrating'), ' ',
            h('span', { class: 'value-chip' }, project.filament.startingProfile),
            h('span', { class: 'field-help', style: 'margin-left:.4rem' }, 'Make sure THIS filament preset is the one selected in the slicer before running the test.')));
        }
        if (!instructions || !instructions.available) {
          card.append(frag(
            h('div', { class: 'callout callout-warn' },
              h('p', { class: 'co-title' }, 'No built-in test in this slicer'),
              instructions ? h('ol', {}, instructions.steps.map(s => h('li', {}, s))) : h('p', {}, 'Use an external model from the previous step.'))
          ));
        } else {
          card.append(frag(
            h('p', {}, h('span', { class: 'placard' }, 'Where'), ' ', `${instructions.menuPath}`),
            instructions.builtIn ? h('p', {}, h('span', { class: 'badge badge-ok' }, '✓ Generated in-slicer — nothing to download')) : null,
            multiFilamentCallout(printer, instructions.builtIn),
            instructions.disableFirst?.length ? h('div', { class: 'callout callout-warn' },
              h('p', { class: 'co-title' }, 'Temporarily disable first'),
              h('ul', {}, instructions.disableFirst.map(d => h('li', {}, d)))) : null,
            h('div', { class: 'panel' },
              h('span', { class: 'placard placard-lit' }, 'Procedure'),
              h('ol', {}, instructions.steps.map(s => h('li', { style: 'margin:.4rem 0' }, s)))),
            instructions.gotchas?.length ? h('details', { class: 'why', open: coach ? true : null },
              h('summary', {}, 'Gotchas'),
              h('div', { class: 'why-body' }, h('ul', {}, instructions.gotchas.map(g => h('li', {}, g))))) : null,
            h('p', { class: 'field-help' }, `Content verified against official docs on ${slicer.verifiedOn}. `,
              h('a', { href: slicer.docsUrl, target: '_blank', rel: 'noopener' }, 'Official documentation ↗'))
          ));
        }
        card.append(nav({ nextLabel: coach ? 'I\'ve printed the test →' : 'Next →' }));
        break;
      }

      // ---------------------------------------------------------------- evaluate
      case 'evaluate': {
        card.append(frag(
          h('h2', { style: 'margin-top:0' }, 'Inspect the print'),
          h('p', { class: 'field-help' }, 'Good light matters more than good eyes: one bright lamp at a shallow (raking) angle reveals texture that overhead light hides.'),
          def.evaluationGuide.map(ev => h('div', { class: 'eval-item' },
            h('div', { class: 'eval-icon', 'aria-hidden': 'true' },
              h('span', {
                class: ev.severity === 'good' ? 'lamp lamp-ok'
                  : ev.severity === 'bad' ? 'lamp lamp-alert'
                    : 'lamp lamp-caution'
              })),
            h('div', {},
              h('h4', {}, ev.title, ' ',
                h('span', { class: `badge ${ev.severity === 'good' ? 'badge-ok' : ev.severity === 'bad' ? 'badge-bad' : 'badge-warn'}` },
                  ev.severity === 'good' ? '✓ what you want' : ev.severity === 'bad' ? '✖ disqualifier' : '⚠ judgment call')),
              h('p', {}, h('strong', {}, 'Look: '), ev.look),
              h('p', { class: 'eval-meaning' }, h('strong', {}, 'Means: '), ev.meaning)))),
          nav()
        ));
        break;
      }

      // ---------------------------------------------------------------- result
      case 'result': {
        card.append(h('h2', { style: 'margin-top:0' }, 'Enter your results'));
        const bundle = controller.resultForm(ctx, state.settings ?? {}, state.result);
        const issuesHost = h('div', {});
        card.append(bundle.el, issuesHost, nav({
          nextLabel: 'Calculate →',
          onNext: async () => {
            const { data, issues } = bundle.collect();
            clear(issuesHost);
            const l = issueList(issues); if (l) issuesHost.append(l);
            if (issues.some(i => i.level === 'error')) return false;
            if (issues.some(i => i.level === 'warning')) {
              const ok = await confirmDialog({
                title: 'Heads-up',
                body: issues.filter(i => i.level === 'warning').map(i => i.message).join(' '),
                confirmLabel: 'Continue'
              });
              if (!ok) return false;
            }
            state.result = data as Record<string, unknown>;
            return true;
          }
        }));
        break;
      }

      // ---------------------------------------------------------------- calc
      case 'calc': {
        const out = controller.compute(ctx, state.settings ?? {}, state.result ?? {});
        card.append(
          h('h2', { style: 'margin-top:0' }, 'Calculation — no black boxes'),
          h('p', { class: 'field-help' }, 'Every input, the formula it feeds, the substitution and the rounding are laid out below. Check them against your own reading of the print — nothing here is hidden.')
        );
        if (out.calcs.length) {
          out.calcs.forEach((c, i) => card.append(calcInstrument(c, i, out.calcs.length)));
        } else {
          const v = out.computed['verdict'];
          if (v) card.append(h('div', { class: 'instrument', style: 'margin:1.5rem 0 0' },
            h('span', { class: 'placard placard-lit' }, 'Verdict'),
            h('p', { style: 'margin:1rem 0 0;font-size:1.05rem' }, String(v))));
        }
        if (out.warnings.length) {
          card.append(h('h3', {}, 'Notes and cautions'));
          const l = issueList(out.warnings.map(w => ({ level: 'warning' as const, message: w })));
          if (l) card.append(l);
        }
        if (out.enterInSlicer.length) {
          const dest = instructions?.saveTo;
          card.append(frag(
            h('h3', {}, 'Save it in the slicer'),
            project.filament.startingProfile && dest?.scope === 'filament' ? h('p', {},
              h('span', { class: 'placard' }, 'Profile to modify'), ' ',
              h('span', { class: 'value-chip' }, project.filament.startingProfile),
              h('span', { class: 'field-help', style: 'margin-left:.4rem' }, '— the filament preset this project is calibrating. Enter the value there (saving it as a user preset), not in whichever preset happens to be selected.')) : null,
            dest ? h('p', {}, h('span', { class: 'placard' }, 'Where'), ' ', `${dest.path} → `, h('strong', {}, dest.field)) : null,
            dest ? h('p', {}, h('span', { class: `badge ${dest.scope === 'filament' ? 'badge-accent' : dest.scope === 'printer' ? 'badge-warn' : 'badge-info'}` },
              dest.scope === 'filament' ? 'Filament profile setting' :
              dest.scope === 'printer' ? 'Printer profile setting (not filament!)' :
              dest.scope === 'process' ? 'Process profile setting' :
              dest.scope === 'per-object' ? 'Per-object setting' : 'Calibration-only — nothing to save')) : null,
            h('div', { class: 'panel' },
              h('span', { class: 'placard placard-lit' }, 'Values to enter'),
              valuesTable(out.enterInSlicer)),
            dest?.note ? h('div', { class: 'callout' }, h('p', {}, dest.note)) : null,
            h('div', { class: 'callout callout-warn' },
              h('p', { class: 'co-title' }, 'Don\'t overwrite stock presets'),
              h('p', {}, 'Save as a NEW user preset — suggested name: ',
                h('span', { class: 'value-chip' }, presetName(project, printer))))
          ));
        }
        card.append(nav({ nextLabel: 'I\'ve saved it — finish →' }));
        break;
      }

      // ---------------------------------------------------------------- done
      case 'done': {
        const out = controller.compute(ctx, state.settings ?? {}, state.result ?? {});
        let confidence: ConfidenceLevel = 'medium';
        const notes = h('textarea', { placeholder: 'Observations worth remembering (optional)' });
        const retest = h('input', { type: 'checkbox' });
        const photoInput = h('input', { type: 'file', accept: 'image/*', multiple: true });
        const photoList = h('div', { class: 'sample-grid' });
        const pendingPhotos: { name: string; type: string; blob: Blob }[] = [];
        photoInput.addEventListener('change', () => {
          for (const f of photoInput.files ?? []) {
            pendingPhotos.push({ name: f.name, type: f.type, blob: f });
            photoList.append(h('span', { class: 'badge badge-info' }, f.name));
          }
          photoInput.value = '';
        });

        const confGroup = h('div', { class: 'sample-grid', role: 'radiogroup', 'aria-label': 'Confidence' },
          (['low', 'medium', 'high'] as ConfidenceLevel[]).map(c => {
            const b = h('button', {
              type: 'button', class: 'sample-chip', 'aria-pressed': String(c === confidence),
              onClick: () => {
                confidence = c;
                confGroup.querySelectorAll('.sample-chip').forEach(x => x.setAttribute('aria-pressed', 'false'));
                b.setAttribute('aria-pressed', 'true');
              }
            }, c === 'low' ? 'Low — I guessed' : c === 'medium' ? 'Medium — fairly sure' : 'High — clear winner');
            return b;
          }));

        card.append(frag(
          h('h2', { style: 'margin-top:0' }, 'Save this result'),
          out.enterInSlicer.length ? h('div', { class: 'panel' },
            h('span', { class: 'placard placard-lit' }, 'Values recorded'),
            valuesTable(out.enterInSlicer)) : null,
          field('How confident are you in this result?', confGroup, coach ? 'Honest answers make the profile\'s confidence score meaningful — and tell the app when to suggest retests.' : undefined),
          h('div', { class: 'check-item' }, retest,
            h('div', {}, h('strong', {}, 'I\'d like to retest this later'),
              h('p', { class: 'coach-note' }, 'Marks the step as done but flags it for a future re-run.'))),
          field('Notes', notes),
          field('Photos of the test print (stored on this device only)', photoInput, 'Optional. Photos never leave your device; they\'re kept for your own reference (and future offline analysis features).'),
          photoList,
          h('div', { class: 'btn-row' },
            h('button', { class: 'btn', onClick: () => { state.stage = stages[idx - 1]; persist(); renderStage(); } }, '← Back'),
            h('button', {
              class: 'btn btn-primary', onClick: async (e: Event) => {
                const btn = e.currentTarget as HTMLButtonElement;
                btn.disabled = true;
                btn.textContent = 'Saving…';
                let saved = false;
                try {
                  saved = await completeStep({
                    project, stepId, state, out, confidence,
                    retest: retest.checked, notes: notes.value, pendingPhotos, draftKey,
                    label: def.shortName
                  });
                } finally {
                  btn.disabled = false;
                  btn.textContent = '✓ Save & continue';
                }
                // A failed save keeps the user on this screen with the leave
                // guard still armed: the measurement is NOT recorded, and
                // pressing the button again retries it.
                if (!saved) return;
                setLeaveGuard(null);
                const next = project.stepOrder[project.stepOrder.indexOf(stepId) + 1];
                navigate(next ? `#/wizard/${project.id}/${next}` : `#/project/${project.id}`);
              }
            }, '✓ Save & continue')
          )
        ));
        // history + reset
        const st = project.steps[stepId];
        if (st?.history?.length || st?.current) {
          card.append(h('details', { class: 'why' },
            h('summary', {}, `Previous attempts (${(st.history?.length ?? 0) + (st.current ? 1 : 0)})`),
            h('div', { class: 'why-body' },
              st.current ? h('p', {}, `Current: ${new Date(st.current.startedAt).toLocaleString()} — ${JSON.stringify(st.current.computed)}`) : null,
              (st.history ?? []).map(a => h('p', { class: 'field-help' }, `${new Date(a.startedAt).toLocaleString()} — ${JSON.stringify(a.computed)}`)))));
        }
        card.append(h('div', { class: 'btn-row' },
          h('button', {
            class: 'btn btn-ghost btn-sm', onClick: async () => {
              const ok = await confirmDialog({
                title: 'Reset this test?',
                body: 'Clears the draft entries for this test. Completed results and history are kept.',
                confirmLabel: 'Reset draft'
              });
              if (!ok) return;
              clearDraft(draftKey);
              setLeaveGuard(null);
              location.reload();
            }
          }, '⟲ Reset this test\'s draft')));
        break;
      }
    }
  }

  renderStage();
}

/**
 * Multi-filament warning for the built-in calibration tests.
 *
 * Verified in Orca's Plater.cpp: every calib_* function reads
 * `params.extruder_id`, which is initialised to 0 and never set by any of the
 * calibration dialogs — none of them expose an extruder picker. So the
 * generated plate is always assigned to filament slot 1, regardless of which
 * filament is "current". Reported by Guntram (Snapmaker U1, 4 tools) on the
 * community Discord after having to reassign every object by hand.
 *
 * This applies to ANY multi-filament setup, not just toolchangers: an AMS or
 * MMU machine has one extruder but several filament slots, and the slicer
 * still assigns the plate to slot 1. So the gate covers both — an X1 Carbon
 * with an AMS hits exactly the same problem as a 4-tool U1.
 */
function multiFilamentCallout(printer: PrinterProfile | undefined, builtIn: boolean): HTMLElement | null {
  if (!builtIn || !printer) return null;
  const tools = printer.extruderCount ?? 1;
  const mmu = printer.multiMaterialCompatibility?.trim();
  if (tools < 2 && !mmu) return null;

  const what = tools > 1
    ? `${tools} extruders`
    : `${mmu} — multiple filament slots on one extruder`;
  return h('div', { class: 'callout callout-warn' },
    h('p', { class: 'co-title' }, `Multi-filament setup (${what}) — check the filament assignment`),
    h('p', {}, 'The built-in calibration tests always place the generated plate on filament slot 1, and the calibration dialogs have no extruder or slot picker — so there is no way to mark a different filament as "the one being tested".'),
    h('p', {}, 'Either load the filament you are calibrating into slot 1 before running the test, or after the plate is generated, select all objects and switch them to the slot holding it. Check the temperature shown on the plate matches the filament you meant to test — if it does not, the test is using the wrong slot.'));
}

/** camelCase / snake_case calculation key → a short engraved placard label. */
function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The calculation instrument — this app's core promise made visible.
 *
 * The landed value reads as an instrument readout; every input, the formula,
 * the substitution and the rounding sit legibly beneath it. Nothing is folded
 * away behind a disclosure: "no black boxes" is the product, not a slogan.
 */
function calcInstrument(c: CalcResult, index: number, total: number): HTMLElement {
  const inputs = Object.entries(c.inputs);
  const decimals = `${c.precision} decimal${c.precision === 1 ? '' : 's'}`;
  const rawText = Number.isFinite(c.raw) ? String(Number(c.raw.toPrecision(10))) : '—';

  return h('div', { class: 'instrument', style: 'margin:1.5rem 0 0' },
    h('div', { style: 'display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.45rem' },
      h('span', { class: 'placard placard-lit' }, 'Result'),
      total > 1 ? h('span', { class: 'placard' }, `Step ${index + 1} of ${total}`) : null),

    h('div', { class: 'readout', style: 'margin-top:1rem' },
      h('b', { class: 'readout-value' }, String(c.rounded)),
      c.unit ? h('i', { class: 'readout-unit' }, c.unit) : null),

    h('div', { class: 'rule-ticks', 'aria-hidden': 'true' }),

    inputs.length ? frag(
      h('span', { class: 'placard-sub' }, 'Inputs'),
      h('div', { style: 'display:flex;flex-wrap:wrap;gap:.45rem;margin:.4rem 0 1rem' },
        inputs.map(([k, v]) => h('span', { class: 'placard' }, `${humanizeKey(k)} · ${v}`)))
    ) : null,

    h('div', { class: 'calc-box' },
      h('span', { class: 'placard-sub' }, 'Formula'),
      h('div', { class: 'formula' }, c.formulaText),
      h('span', { class: 'placard-sub' }, 'Substitution'),
      h('div', {}, c.substituted),
      h('span', { class: 'placard-sub' }, 'Result'),
      h('div', { class: 'result' }, `= ${c.rounded}${c.unit ? ' ' + c.unit : ''}`),
      h('p', { class: 'field-help', style: 'margin:.4rem 0 0' },
        `Rounded to ${decimals} from ${rawText}.`))
  );
}

/** The "enter this in your slicer" values, as a ruled instrument table. */
function valuesTable(entries: { label: string; value: string }[]): HTMLElement {
  return h('div', { class: 'table-scroll' },
    h('table', { class: 'data' },
      h('tbody', {}, entries.map(e =>
        h('tr', {},
          h('th', { scope: 'row' }, e.label),
          h('td', {}, h('span', { class: 'value-chip' }, e.value)))))));
}

function presetName(p: CalibrationProject, printer?: PrinterProfile): string {
  const mat = p.filament.material === 'OTHER' ? (p.filament.materialOther ?? 'Custom') : p.filament.material;
  return [
    p.filament.manufacturer, mat, p.filament.color, '-',
    printer?.name ?? 'printer', '-', `${printer?.nozzleDiameter ?? '?'}mm`
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

export async function completeStep(args: {
  project: CalibrationProject;
  stepId: CalibrationId;
  state: WizardState;
  out: ComputeOutput;
  confidence: ConfidenceLevel;
  retest: boolean;
  notes: string;
  pendingPhotos: { id?: string; name: string; type: string; blob: Blob }[];
  draftKey: string;
  /** Step name used in the confirmation/failure message shown to the user. */
  label: string;
}): Promise<boolean> {
  const { project, stepId, state, out, confidence, retest, notes, pendingPhotos, draftKey, label } = args;

  // Everything below mutates `project` in place, and the same object stays on
  // screen. If the save fails we put it back exactly as it was, so the retry
  // the user is invited to make records the result ONCE instead of stacking a
  // second timeline entry and pushing a phantom attempt into history.
  const snapshot = JSON.parse(JSON.stringify(project)) as CalibrationProject;
  const savedPhotoIds: string[] = [];

  try {
    const st = project.steps[stepId] ?? (project.steps[stepId] = { status: 'not-started', current: null, history: [] });

    // Preserve the prior result in history rather than overwriting.
    if (st.current) st.history.unshift(st.current);

    const attempt: CalibrationAttempt = {
      id: uid(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      method: state.method,
      settings: (state.settings ?? {}) as CalibrationAttempt['settings'],
      result: (state.result ?? {}) as CalibrationAttempt['result'],
      computed: out.computed,
      prerequisitesConfirmed: state.prereqs,
      notes,
      photoIds: [],
      confidence
    };

    for (const ph of pendingPhotos) {
      // The id is stamped onto the pending photo the first time round, so a
      // retry overwrites the same record instead of storing the picture twice.
      ph.id = ph.id ?? uid();
      const photo: StoredPhoto = {
        id: ph.id, projectId: project.id, stepId, attemptId: attempt.id,
        createdAt: new Date().toISOString(), name: ph.name, type: ph.type, blob: ph.blob, analysis: null
      };
      await savePhoto(photo);
      savedPhotoIds.push(photo.id);
      attempt.photoIds.push(photo.id);
    }

    st.current = attempt;
    st.status = 'completed';
    st.confidence = confidence;
    st.retestRecommended = retest;
    st.completedAt = attempt.completedAt;

    Object.assign(project.finals, out.finalsPatch);

    const valueSummary = out.enterInSlicer.map(e => `${e.label} = ${e.value}`).join(', ')
      || String(out.computed['verdict'] ?? 'completed');
    addTimeline(project, {
      stepId, kind: 'completed',
      summary: valueSummary,
      detail: retest ? 'User flagged for retest.' : undefined
    });

    applyRetestFlags(project);
    await saveProject(project);
  } catch (err) {
    restoreProject(project, snapshot);
    // Best effort: drop the photos this attempt wrote so the database looks
    // exactly as it did before. Failing to clean them up must not mask the
    // real error, and the ids are stable so a retry overwrites them anyway.
    for (const id of savedPhotoIds) {
      try { await deletePhoto(id); } catch { /* nothing more we can do */ }
    }
    toast(`Could not save ${label} — nothing was recorded. ${String(err)} Your entries are still here; press “Save & continue” to try again.`, 'error');
    return false;
  }

  clearDraft(draftKey);
  toast(`${label} saved.`, 'success');
  return true;
}

/**
 * Reset `target` to `snapshot` while keeping the same object identity.
 *
 * Exported because the guided session commits results through the same
 * mutate-then-save shape and needs the identical roll-back — one implementation,
 * so the two screens cannot drift into different failure behaviour.
 */
export function restoreProject(target: CalibrationProject, snapshot: CalibrationProject): void {
  for (const key of Object.keys(target)) delete (target as unknown as Record<string, unknown>)[key];
  Object.assign(target, snapshot);
}
