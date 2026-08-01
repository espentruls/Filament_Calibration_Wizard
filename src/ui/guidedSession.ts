// ---------------------------------------------------------------------------
// Guided session — the screen.
//
// A NEW mode that runs ALONGSIDE the classic step-by-step wizard (`#/wizard/…`),
// which is untouched and still reachable from every step here. This screen is an
// instrument panel at work: it says which nozzle is being calibrated, shows the
// session's cluster as its own progress indicator, and puts one step's work in
// front of the user — what to set in the slicer, then the existing per-step form
// from `testForms.ts`, with every pre-filled number carrying its provenance.
//
// All session reasoning comes from `src/session` (pure, DOM-free, works with the
// experimental `automatedCalibration` flag off, which is its default). All slicer
// facts come from `src/data/slicers.ts` by way of the session's action plan —
// nothing on this screen invents a menu path, and a gap in the shipped data is
// printed as a gap.
//
// Nothing here changes calibration math, validation, or the classic wizard.
// ---------------------------------------------------------------------------

import { h, clear, frag, field, numberInput, issueList, toast, confirmDialog } from './dom';
import {
  getProject, getPrinter, listProjects, saveProject, addTimeline, uid,
  saveDraft, loadDraft, clearDraft, savePhoto, deletePhoto
} from '../storage/store';
import { getCalibration } from '../data/calibrations';
import { getMaterial } from '../data/materials';
import { applyRetestFlags } from '../logic/recommendations';
import { nozzleBadgeLabel } from '../logic/ranges';
import { validateAgainstPrinter } from '../logic/validation';
import type { NormalizedProfileKey } from '../automatedCalibration';

/**
 * Overridable values that a printer profile puts a hard limit on, mapped to the
 * limit `validateAgainstPrinter` checks. Every temperature that reaches a hotend
 * is here; a key absent from this map has no machine limit to check against.
 */
const PRINTER_LIMIT_KEYS: Partial<Record<NormalizedProfileKey, 'nozzleTemp' | 'bedTemp' | 'mvs'>> = {
  nozzleTemp: 'nozzleTemp',
  firstLayerTemp: 'nozzleTemp',
  highFlowTemp: 'nozzleTemp',
  bedTemp: 'bedTemp',
  maxVolumetricSpeed: 'mvs'
};
import { CONTROLLERS, type ComputeOutput, type TestCtx } from './testForms';
import { gaugeEl, projectGauges, type GaugeReading } from './dashboard';
import { hasCalibratedValues } from './projectView';
import { restoreProject } from './wizard';
import { copyFinalsToClipboard } from './report';
import { setLeaveGuard } from '../app';
import {
  CANONICAL_KEYS,
  clearSessionOverride,
  resolveGuidedSession,
  sessionPartialProfile,
  sessionStepView,
  sessionValues,
  setSessionOverride,
  startGuidedSession,
  syncSessionValues,
  type GuidedSession,
  type ResolvedValue,
  type SessionAction,
  type SessionActionPlan,
  type SessionNozzle,
  type SessionStep,
  type StepWorkingValues,
  type ValueProvenance
} from '../session';
import type {
  CalibrationAttempt, CalibrationId, CalibrationProject, ConfidenceLevel,
  FinalValues, PrinterProfile, StoredPhoto
} from '../types';

// ---------------------------------------------------------------------------
// Per-step working draft (auto-saved, separate from the classic wizard's draft)
// ---------------------------------------------------------------------------

type StepPhase = 'setup' | 'measure' | 'save';

interface StepDraft {
  phase: StepPhase;
  method: string;
  prereqs: string[];
  settings: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
}

/**
 * Draft key. Deliberately NOT the wizard's `projectId:stepId` — the two modes
 * keep independent drafts so opening one can never corrupt the other's.
 */
function draftKeyFor(projectId: string, nozzleIndex: number, stepId: CalibrationId): string {
  return `session:${projectId}:${nozzleIndex}:${stepId}`;
}

function defaultMethod(project: CalibrationProject, stepId: CalibrationId): string {
  const def = getCalibration(stepId);
  return (
    def.methods.find(m => m.recommended && m.slicers.includes(project.slicer.slicer))?.id
    ?? def.methods.find(m => m.slicers.includes(project.slicer.slicer))?.id
    ?? def.methods[0].id
  );
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/** Where a pre-filled number came from, as an engraved plate. */
const PROVENANCE_PLATE: Record<ValueProvenance, { label: string; cls: string }> = {
  calibrated: { label: 'Calibrated', cls: 'placard placard-lit' },
  'user-override': { label: 'You set this', cls: 'placard' },
  carried: { label: 'From the profile', cls: 'placard' },
  'printer-default': { label: 'Printer profile', cls: 'placard' },
  // A material starting point is a placeholder, not a measurement — it reads
  // unlit for the same reason a dial with nothing measured stays dark.
  'material-default': { label: 'Starting point', cls: 'placard placard-unlit' },
  unset: { label: 'Not measured', cls: 'placard placard-unlit' }
};

/** Short status word for a step, in the session's own vocabulary. */
function phaseWord(step: SessionStep): string {
  switch (step.phase) {
    case 'complete': return 'Calibrated';
    case 'stale': return 'Recheck';
    case 'in-progress': return 'In progress';
    case 'ready': return 'Ready';
    case 'blocked': return 'Waiting';
    case 'skipped': return 'Skipped';
  }
}

/** camelCase / snake_case setting key → a short engraved placard label. */
function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** A measured value as a readout, or an unlit one when nothing is known. */
function readoutFor(v: ResolvedValue): HTMLElement {
  if (v.value === undefined) {
    return h('span', { class: 'readout is-unlit' },
      h('b', { class: 'readout-value' }, '—'));
  }
  return h('span', { class: 'readout' },
    h('b', { class: 'readout-value' }, v.value.toFixed(v.precision)),
    v.unit ? h('i', { class: 'readout-unit' }, v.unit) : null);
}

function provenancePlate(v: ResolvedValue): HTMLElement {
  const plate = PROVENANCE_PLATE[v.provenance];
  return h('span', { class: plate.cls, title: v.explanation }, plate.label);
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

/**
 * Keep `--gs-pin-top` equal to the sticky app-header's height, so the condensed
 * plan strip pins EXACTLY beneath it — in either theme and at any width the
 * header wraps to. Read from the header itself rather than hard-coded, and kept
 * live by one ResizeObserver on that persistent element (set up once, never per
 * render — the header outlives every route).
 */
let headerHeightSync: ResizeObserver | null = null;
function syncPinTop(): void {
  const header = document.querySelector('.app-header');
  if (!header) return;
  const set = (): void => document.documentElement.style.setProperty(
    '--gs-pin-top', `${Math.round(header.getBoundingClientRect().height)}px`);
  set();
  if (!headerHeightSync && 'ResizeObserver' in window) {
    headerHeightSync = new ResizeObserver(set);
    headerHeightSync.observe(header);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function renderGuidedSession(
  root: HTMLElement,
  projectId: string,
  stepId?: CalibrationId
): Promise<void> {
  const loaded = await getProject(projectId);
  if (!loaded) {
    root.append(h('div', { class: 'card' },
      h('span', { class: 'placard placard-unlit' }, 'No such project'),
      h('h1', {}, 'Project not found'),
      h('p', {}, 'It may have been deleted on this device.'),
      h('a', { class: 'btn btn-primary', href: '#/' }, 'Back to dashboard')));
    return;
  }

  const project: CalibrationProject = loaded;
  const printer = await getPrinter(project.printerProfileId);
  const allProjects = await listProjects();

  // Attach the persisted half of the session (working profile + provenance) and
  // bring it up to date with whatever the classic wizard has already recorded.
  // Both operations are idempotent; only a real change costs a write.
  const started = resolveGuidedSession({ project, printer }).started;
  const sync = startGuidedSession(project, { printer });
  if (!started || sync.changedKeys.length || sync.staleJobIds.length) {
    // A refused write here costs only the session bookkeeping, so the screen
    // still opens — but say so, rather than letting the rejection escape the
    // route handler and leave a blank page with nothing in the UI.
    try {
      await saveProject(project);
    } catch (err) {
      toast(`Could not save this session's setup to this device (${String(err)}). You can keep working, but changes may not persist.`, 'error');
    }
  }

  let focusId: CalibrationId | null = stepId ?? null;
  const view = h('div', {});
  root.append(view);

  // The condensed plan strip pins beneath the app header; keep the offset it
  // uses honest, and hold the one observer that toggles its condensed state so a
  // redraw re-wires the new sentinel instead of leaking the old one.
  syncPinTop();
  let stripObserver: IntersectionObserver | null = null;

  /** Move the guided screen to another step without leaving the route. */
  function select(next: CalibrationId): void {
    focusId = next;
    draw();
    window.scrollTo(0, 0);
  }

  async function persistAndRedraw(): Promise<void> {
    // The value on screen changed already; if the write is refused the user has
    // to be told, or they carry on believing an override was stored.
    try {
      await saveProject(project);
    } catch (err) {
      toast(`Could not save that change to this device — it is not stored. ${String(err)}`, 'error');
    }
    draw();
  }

  function draw(): void {
    const session = resolveGuidedSession({ project, printer });
    const resolved = focusId && session.plan.some(s => s.id === focusId)
      ? focusId
      : (session.focusStepId ?? session.plan[0]?.id ?? null);
    focusId = resolved;

    // Keep the URL honest without firing a hashchange — in-screen step changes
    // must not trip the app's leave guard the way a real navigation would.
    const want = resolved ? `#/session/${project.id}/${resolved}` : `#/session/${project.id}`;
    if (location.hash !== want) history.replaceState(null, '', want);

    clear(view);
    view.append(
      sessionHeader(session, allProjects),
      progressStrip(session, printer, resolved, select),
      clusterCard(session, printer, resolved, select),
      installCard(session),
      resolved
        ? stepCard(session, resolved)
        : h('div', { class: 'card' },
          h('h2', {}, 'No steps in this plan'),
          h('p', {}, 'This project has no calibration steps yet. Add them from the project page.'),
          h('a', { class: 'btn btn-primary', href: `#/project/${project.id}` }, 'Open the project'))
    );

    // Toggle the strip's condensed state from ONE IntersectionObserver on the
    // 1px sentinel that sits just below the full route — no scroll listener, no
    // per-frame measurement. The fold it watches for is the header's lower edge,
    // not the top of the viewport, so the bar pins the instant the full route
    // clears the header. Re-wired each draw against the freshly built sentinel.
    stripObserver?.disconnect();
    const sentinel = view.querySelector('.gs-plan-sentinel');
    const pin = view.querySelector<HTMLElement>('.gs-pin');
    if (sentinel && pin && 'IntersectionObserver' in window) {
      const pinTop = parseInt(
        getComputedStyle(document.documentElement).getPropertyValue('--gs-pin-top'), 10) || 64;
      stripObserver = new IntersectionObserver(
        entries => pin.classList.toggle('is-condensed', !entries[0].isIntersecting),
        { rootMargin: `${-pinTop}px 0px 0px 0px`, threshold: 0 });
      stripObserver.observe(sentinel);
    }
  }

  // --- the current step ----------------------------------------------------

  function stepCard(session: GuidedSession, id: CalibrationId): HTMLElement {
    const stepView = sessionStepView(session, id);
    if (!stepView) {
      return h('div', { class: 'card' }, h('p', {}, 'That step is not part of this plan.'));
    }
    const { step, values, actions } = stepView;
    const def = getCalibration(id);
    const draftKey = draftKeyFor(project.id, session.nozzle.index, id);
    const stored = loadDraft<StepDraft>(draftKey);
    const draft: StepDraft = stored ?? {
      phase: 'setup',
      method: defaultMethod(project, id),
      prereqs: [],
      settings: null,
      result: null
    };
    if (!def.methods.some(m => m.id === draft.method)) draft.method = defaultMethod(project, id);
    const persist = (): void => saveDraft(draftKey, draft);

    // Guard a real departure once entries exist. In-screen step changes use
    // replaceState and never reach this.
    const syncGuard = (): void => setLeaveGuard(draft.phase === 'setup' ? null : async () => {
      persist();
      return confirmDialog({
        title: 'Leave this test?',
        body: 'Your entries are auto-saved as a draft and will be restored when you come back. Leave now?',
        confirmLabel: 'Leave'
      });
    });
    syncGuard();

    const card = h('div', { class: 'instrument gs-step-card' });
    const workArea = h('div', {});

    card.append(
      h('h2', { style: 'display:flex;align-items:center;gap:var(--s-3);flex-wrap:wrap' },
        h('span', {}, `${def.icon} ${def.name}`),
        h('span', { class: 'placard' }, `Step ${step.position} of ${session.plan.length}`),
        h('span', { class: step.phase === 'complete' ? 'placard placard-lit' : 'placard placard-unlit' },
          phaseWord(step)),
        step.optional ? h('span', { class: 'placard' }, 'Optional step') : null),
      h('p', { class: 'field-help' }, def.purpose)
    );

    if (step.staleness.stale) {
      card.append(h('div', { class: 'callout callout-warn' },
        h('p', { class: 'co-title' }, 'This result may no longer hold'),
        h('ul', {}, step.staleness.reasons.map(r => h('li', {}, r.detail)))));
    }

    if (step.blockedBy.length) {
      card.append(h('div', { class: 'callout callout-warn' },
        h('p', { class: 'co-title' }, 'Waiting on earlier work'),
        h('ul', { class: 'issues' }, step.blockedBy.map(b => h('li', { class: 'issue issue-warning' },
          h('span', { class: 'issue-icon', 'aria-hidden': 'true' }, '⚠'),
          h('span', {}, b.reason, ' ',
            b.stepId
              ? h('a', {
                href: `#/session/${project.id}/${b.stepId}`,
                onClick: (e: Event) => { e.preventDefault(); select(b.stepId as CalibrationId); }
              }, `Go to ${getCalibration(b.stepId).shortName} →`)
              : null)))),
        h('p', { class: 'field-help' }, 'You can still run this test — the warning is here so a result you cannot trust never looks like one you can. Setting a missing value by hand below also clears the way.')));
    }

    // --- 1. what to change in the slicer ------------------------------------
    card.append(h('h3', {}, 'Set these in your slicer'), slicerSection(actions, session.nozzle));

    // --- 2. what this test inherits, with provenance ------------------------
    card.append(h('h3', {}, 'Carried into this test'), inheritedSection(values, () => persistAndRedraw()));

    // --- 3. print and measure ------------------------------------------------
    card.append(h('h3', {}, 'Then print and measure'), workArea);

    const material = getMaterial(project.filament.material);
    const ctx: TestCtx = {
      project, printer, material,
      method: draft.method,
      coach: project.mode === 'coach'
    };
    const controller = CONTROLLERS[id];

    function renderWork(): void {
      ctx.method = draft.method;
      syncGuard();
      clear(workArea);
      switch (draft.phase) {
        case 'setup': renderSetup(); break;
        case 'measure': renderMeasure(); break;
        case 'save': renderSave(); break;
      }
    }

    function methodPicker(): HTMLElement {
      const picker = h('select', {
        onChange: () => {
          draft.method = picker.value;
          persist();
          renderWork();
        }
      }, def.methods.map(m => h('option', {
        value: m.id,
        selected: m.id === draft.method
      }, `${m.label}${m.slicers.includes(project.slicer.slicer) ? '' : ` — not in ${session.slicerLabel}`}`)));
      return field('Test method', picker,
        def.methods.find(m => m.id === draft.method)?.description);
    }

    function renderSetup(): void {
      const checks = new Set(draft.prereqs);
      const bundle = controller.settingsForm(ctx, draft.settings);
      const issuesHost = h('div', {});

      workArea.append(frag(
        def.prerequisites.length
          ? h('div', { class: 'panel' },
            h('span', { class: 'placard' }, 'Preflight'),
            def.prerequisites.map(pr => {
              const cb = h('input', {
                type: 'checkbox', checked: checks.has(pr.id),
                onChange: () => {
                  cb.checked ? checks.add(pr.id) : checks.delete(pr.id);
                  draft.prereqs = [...checks];
                  persist();
                }
              });
              return h('div', { class: 'check-item' }, cb,
                h('div', {}, h('strong', {}, pr.label),
                  ctx.coach && pr.coachNote ? h('p', { class: 'coach-note' }, pr.coachNote) : null));
            }))
          : null,
        def.methods.length > 1 ? methodPicker() : null,
        bundle.el,
        issuesHost,
        h('div', { class: 'btn-row' },
          h('button', {
            class: 'btn btn-primary',
            onClick: async () => {
              const { data, issues } = bundle.collect();
              clear(issuesHost);
              const l = issueList(issues); if (l) issuesHost.append(l);
              if (issues.some(i => i.level === 'error')) return;
              draft.prereqs = [...checks];
              draft.settings = data as Record<string, unknown>;
              draft.phase = 'measure';
              persist();
              renderWork();
            }
          }, 'Settings are set — print it'),
          h('a', { class: 'btn btn-ghost btn-sm', href: `#/wizard/${project.id}/${id}` },
            'Open the step-by-step wizard'))
      ));
    }

    function renderMeasure(): void {
      const settings = draft.settings ?? {};
      const bundle = controller.resultForm(ctx, settings, draft.result);
      const issuesHost = h('div', {});

      workArea.append(frag(
        settingsSummary(settings, () => { draft.phase = 'setup'; persist(); renderWork(); }),
        def.evaluationGuide.length
          ? h('details', { class: 'why', open: ctx.coach ? true : null },
            h('summary', {}, 'How to judge this print'),
            h('div', { class: 'why-body' }, def.evaluationGuide.map(ev => h('div', { class: 'eval-item' },
              h('div', { class: 'eval-icon', 'aria-hidden': 'true' },
                h('span', {
                  class: ev.severity === 'good' ? 'lamp lamp-ok'
                    : ev.severity === 'bad' ? 'lamp lamp-alert'
                      : 'lamp lamp-caution'
                })),
              h('div', {},
                h('h4', {}, ev.title),
                h('p', {}, h('strong', {}, 'Look: '), ev.look),
                h('p', { class: 'eval-meaning' }, h('strong', {}, 'Means: '), ev.meaning))))))
          : null,
        bundle.el,
        issuesHost,
        h('div', { class: 'btn-row' },
          h('button', {
            class: 'btn btn-primary',
            onClick: async () => {
              const { data, issues } = bundle.collect();
              clear(issuesHost);
              const l = issueList(issues); if (l) issuesHost.append(l);
              if (issues.some(i => i.level === 'error')) return;
              if (issues.some(i => i.level === 'warning')) {
                const ok = await confirmDialog({
                  title: 'Heads-up',
                  body: issues.filter(i => i.level === 'warning').map(i => i.message).join(' '),
                  confirmLabel: 'Continue'
                });
                if (!ok) return;
              }
              draft.result = data as Record<string, unknown>;
              draft.phase = 'save';
              persist();
              renderWork();
            }
          }, 'Calculate the result'),
          h('button', {
            class: 'btn',
            onClick: () => { draft.phase = 'setup'; persist(); renderWork(); }
          }, '← Back to settings'))
      ));
    }

    function renderSave(): void {
      const out = controller.compute(ctx, draft.settings ?? {}, draft.result ?? {});
      let confidence: ConfidenceLevel = 'medium';
      const notes = h('textarea', { placeholder: 'Observations worth remembering (optional)' });
      const retest = h('input', { type: 'checkbox' });
      const photoInput = h('input', { type: 'file', accept: 'image/*', multiple: true });
      const photoList = h('div', { class: 'sample-grid' });
      // `id` is stamped by commitStep on the first attempt so a retry after a
      // failed save overwrites the same photo record instead of duplicating it.
      const pendingPhotos: { id?: string; name: string; type: string; blob: Blob }[] = [];
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

      workArea.append(frag(
        out.calcs.length
          ? frag(out.calcs.map((c, i) => h('div', { class: 'instrument', style: 'margin:var(--s-4) 0 0' },
            h('div', { style: 'display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--s-2)' },
              h('span', { class: 'placard placard-lit' }, 'Result'),
              out.calcs.length > 1 ? h('span', { class: 'placard' }, `Calculation ${i + 1} of ${out.calcs.length}`) : null),
            h('div', { class: 'readout', style: 'margin-top:var(--s-4)' },
              h('b', { class: 'readout-value' }, String(c.rounded)),
              c.unit ? h('i', { class: 'readout-unit' }, c.unit) : null),
            h('div', { class: 'rule-ticks', 'aria-hidden': 'true' }),
            h('div', { class: 'calc-box' },
              h('span', { class: 'placard-sub' }, 'Formula'),
              h('div', { class: 'formula' }, c.formulaText),
              h('span', { class: 'placard-sub' }, 'Substitution'),
              h('div', {}, c.substituted),
              h('span', { class: 'placard-sub' }, 'Result'),
              h('div', { class: 'result' }, `= ${c.rounded}${c.unit ? ' ' + c.unit : ''}`),
              h('p', { class: 'field-help', style: 'margin:var(--s-2) 0 0' },
                `Rounded to ${c.precision} decimal${c.precision === 1 ? '' : 's'} from ${Number.isFinite(c.raw) ? String(Number(c.raw.toPrecision(10))) : '—'}.`)))))
          : out.computed['verdict']
            ? h('div', { class: 'instrument', style: 'margin:var(--s-4) 0 0' },
              h('span', { class: 'placard placard-lit' }, 'Verdict'),
              h('p', { style: 'margin:var(--s-4) 0 0;font-size:var(--fs-headline)' }, String(out.computed['verdict'])))
            : null,
        out.warnings.length ? issueList(out.warnings.map(w => ({ level: 'warning' as const, message: w }))) : null,
        out.enterInSlicer.length
          ? h('div', { class: 'panel' },
            h('span', { class: 'placard placard-lit' }, 'Values to enter'),
            valuesTable(out.enterInSlicer),
            h('p', { class: 'field-help' },
              'Enter these in the preset this project is calibrating, saving it as a user preset — never over a stock one.'))
          : null,
        field('How confident are you in this result?', confGroup),
        h('div', { class: 'check-item' }, retest,
          h('div', {}, h('strong', {}, 'I\'d like to retest this later'),
            h('p', { class: 'coach-note' }, 'Marks the step as done but flags it for a future re-run.'))),
        field('Notes', notes),
        field('Photos of the test print (stored on this device only)', photoInput,
          'Optional. Photos never leave your device.'),
        photoList,
        h('div', { class: 'btn-row' },
          h('button', {
            class: 'btn btn-primary',
            onClick: async () => {
              // Nothing after this may run when the save was refused: the step
              // did NOT complete, so the screen must not advance and the leave
              // guard must stay armed over the user's unsaved entries.
              const saved = await commitStep({
                project, printer, stepId: id, draft, out,
                confidence, retest: retest.checked, notes: notes.value,
                photos: pendingPhotos, draftKey, label: def.shortName
              });
              if (!saved) return;
              setLeaveGuard(null);
              const next = resolveGuidedSession({ project, printer });
              focusId = next.nextActionableStepId ?? next.focusStepId ?? id;
              draw();
              window.scrollTo(0, 0);
            }
          }, 'Save this result'),
          h('button', {
            class: 'btn',
            onClick: () => { draft.phase = 'measure'; persist(); renderWork(); }
          }, '← Back to measurements'))
      ));
    }

    renderWork();

    // --- navigation ---------------------------------------------------------
    const index = session.plan.findIndex(s => s.id === id);
    const prev = index > 0 ? session.plan[index - 1] : null;
    const next = index >= 0 && index < session.plan.length - 1 ? session.plan[index + 1] : null;
    const actionable = session.nextActionableStepId && session.nextActionableStepId !== id
      ? session.plan.find(s => s.id === session.nextActionableStepId) ?? null
      : null;

    card.append(
      h('div', { class: 'rule-ticks', 'aria-hidden': 'true' }),
      h('div', { class: 'btn-row' },
        prev ? h('button', {
          class: 'btn btn-sm', onClick: () => select(prev.id)
        }, `← ${prev.shortName}`) : null,
        next ? h('button', {
          class: 'btn btn-sm', onClick: () => select(next.id)
        }, `${next.shortName} →`) : null,
        actionable ? h('button', {
          class: 'btn btn-sm btn-primary', onClick: () => select(actionable.id)
        }, `Next actionable · ${actionable.shortName}`) : null,
        h('a', { class: 'btn btn-sm btn-ghost', href: `#/project/${project.id}` }, 'Project overview'))
    );

    return card;
  }

  // --- inherited values, with provenance and manual overrides ---------------

  function inheritedSection(values: StepWorkingValues, onChange: () => Promise<void>): HTMLElement {
    if (!values.inherited.length) {
      return h('p', { class: 'field-help' },
        'This test needs no results from earlier steps — it is where its own values come from.');
    }

    const rows = values.inherited.map(v => h('tr', {},
      h('th', { scope: 'row' },
        v.label,
        v.required
          ? null
          : h('span', { class: 'placard-sub' }, 'Advisory')),
      h('td', {}, readoutFor(v)),
      h('td', {},
        provenancePlate(v),
        h('p', { class: 'field-help', style: 'margin:var(--s-1) 0 0' }, v.explanation))));

    const overrides = values.inherited.map(v => {
      const input = numberInput({
        step: 'any',
        value: v.value !== undefined ? String(Number(v.value.toFixed(v.precision))) : '',
        'aria-label': `${v.label} value to set by hand`
      });
      const row = h('div', { class: 'field-row', style: 'align-items:flex-end' },
        field(`${v.label}${v.unit ? ` (${v.unit})` : ''}`, input),
        h('div', { class: 'btn-row', style: 'margin:0' },
          h('button', {
            class: 'btn btn-sm',
            onClick: async () => {
              const n = Number(input.value);
              if (!Number.isFinite(n)) { toast('Enter a number first.', 'error'); return; }
              // A hand-typed override is shown back to the user as "set this in
              // your slicer", so it has to meet the same machine limits the test
              // forms enforce. Without this, a typo can hand someone a hotend
              // temperature their printer is not rated for.
              const limitKind = PRINTER_LIMIT_KEYS[v.key];
              if (limitKind) {
                const blocking = validateAgainstPrinter(limitKind, n, printer)
                  .filter((i) => i.level === 'error');
                if (blocking.length) { toast(blocking[0].message, 'error'); return; }
              }
              setSessionOverride(project, { key: v.key, value: n });
              await onChange();
              toast(`${v.label} set by hand.`, 'success');
            }
          }, 'Set'),
          v.provenance === 'user-override'
            ? h('button', {
              class: 'btn btn-sm btn-ghost',
              onClick: async () => {
                clearSessionOverride(project, { key: v.key });
                await onChange();
                toast(`${v.label} back to the measured value.`, 'info');
              }
            }, 'Use measured')
            : null));
      return row;
    });

    return h('div', {},
      h('div', { class: 'table-scroll' },
        h('table', { class: 'data' },
          h('thead', {}, h('tr', {},
            h('th', {}, 'Setting'), h('th', {}, 'Reading'), h('th', {}, 'Where it came from'))),
          h('tbody', {}, rows))),
      values.missing.length
        ? h('p', { class: 'field-help' },
          'A reading shown as a starting point has not been measured — it is a placeholder, and a test run on one is worth less than it looks.')
        : null,
      h('details', { class: 'why' },
        h('summary', {}, 'Set a value by hand'),
        h('div', { class: 'why-body' },
          h('p', { class: 'field-help' },
            'Use this when you already know a value — from the spool, from another session, or because you set it deliberately. A value you set here supersedes an older measurement; a fresh calibration afterwards supersedes it in turn.'),
          overrides)));
  }

  // --- install the preset ---------------------------------------------------

  /**
   * The preset-install affordance — the thing that removes the actual typing:
   * the app generates a filament preset from the measured values, per extruder
   * on a dual-nozzle machine, and installs it. That is worth having after the
   * first completed test, not only at the end, so this sits directly under the
   * cluster and is present on every step rather than waiting below the whole
   * step form.
   *
   * There is no second install path: the button opens the existing profile
   * wizard. The values table folds away so the step's own work stays the next
   * thing on screen.
   */
  function installCard(session: GuidedSession): HTMLElement {
    const report = sessionPartialProfile(session);
    // The profile wizard generates from the project's own `finals`, so it can
    // only install for the nozzle the project itself records.
    const canInstall = report.installable && hasCalibratedValues(project);
    const count = report.values.length;

    const card = h('div', { class: 'card' },
      h('span', { class: canInstall ? 'placard placard-lit' : 'placard placard-unlit' },
        canInstall
          ? `${count} measured value${count === 1 ? '' : 's'} ready`
          : 'Nothing to install yet'),
      h('h2', { style: 'margin-top:var(--s-3)' }, 'Install what is calibrated so far'),
      h('p', {}, report.summary),
      h('p', { class: 'field-help' },
        'A partial profile is a real deliverable: temperature and flow locked into a preset are worth having before pressure advance is even started.'),
      h('div', { class: 'btn-row' },
        canInstall
          ? h('a', { class: 'btn btn-primary', href: `#/profile/${project.id}` },
            'Open the profile wizard')
          : null,
        h('button', { class: 'btn btn-sm', onClick: () => copyFinalsToClipboard(project) },
          'Copy final settings'),
        h('a', { class: 'btn btn-sm btn-ghost', href: `#/report/${project.id}` }, 'Report'),
        h('a', { class: 'btn btn-sm btn-ghost', href: `#/card/${project.id}` }, 'Calibration card')));

    if (!report.installable) {
      card.append(h('p', { class: 'field-help' },
        'Nothing has been measured on this nozzle yet, so there is nothing to install. The first completed test changes that.'));
    } else if (!canInstall) {
      // Measurements exist for the nozzle being VIEWED, but they live in this
      // session's working profile rather than in the project's own record, which
      // is what the profile wizard reads. Say so instead of offering a button
      // that would write an empty preset.
      card.append(h('p', { class: 'field-help' },
        `These readings belong to ${session.nozzle.label}, and the profile wizard installs the values this project itself recorded — so there is nothing for it to write from here yet.`));
    }

    if (count) {
      card.append(h('details', { class: 'why' },
        h('summary', {}, 'See what would be written'),
        h('div', { class: 'why-body' },
          h('div', { class: 'table-scroll' },
            h('table', { class: 'data' },
              h('tbody', {}, report.values.map(v => h('tr', {},
                h('th', { scope: 'row' }, v.label),
                h('td', {}, readoutFor(v)),
                h('td', {}, provenancePlate(v))))))),
          h('p', { class: 'field-help', style: 'margin:var(--s-3) 0 0' },
            'Only measured values are written — nothing carried or assumed.'))));
    }

    return card;
  }

  draw();
}

// ---------------------------------------------------------------------------
// Header — filament, printer, and WHICH NOZZLE
// ---------------------------------------------------------------------------

function sessionHeader(session: GuidedSession, allProjects: CalibrationProject[]): HTMLElement {
  const p = session.project;
  const mat = getMaterial(p.filament.material);
  const done = session.completedStepIds.length;

  return h('div', {},
    h('p', {}, h('a', { href: `#/project/${p.id}` }, '← Project overview')),
    h('div', { style: 'display:flex;align-items:flex-start;gap:var(--s-4);flex-wrap:wrap' },
      h('div', { style: 'flex:1 1 20rem;min-width:0' },
        h('h1', { style: 'margin:.2rem 0' },
          `${p.filament.manufacturer} ${mat.label} ${p.filament.color}`.trim()),
        h('p', { class: 'proj-vals', style: 'gap:var(--s-2);margin:var(--s-3) 0 0' },
          h('span', { class: 'placard placard-lit' }, 'Guided session'),
          h('span', { class: 'placard' }, session.printer?.name ?? 'No printer profile'),
          session.printer ? h('span', { class: 'placard' }, `${session.printer.nozzleDiameter} mm ${p.nozzleType}`) : null,
          h('span', { class: 'placard' }, `${session.slicerLabel} ${session.slicerVersion}`),
          h('span', { class: 'placard' }, p.mode === 'coach' ? 'Coach mode' : 'Expert mode'))),
      h('div', { style: 'display:flex;flex-direction:column;align-items:flex-end;gap:var(--s-2)' },
        h('span', { class: done > 0 ? 'readout' : 'readout is-unlit', style: 'gap:.4em' },
          h('span', { class: 'readout-label' }, 'Steps'),
          h('b', { class: 'readout-value' }, `${done} / ${session.plan.length}`)),
        h('span', { class: 'readout-label' }, `${session.progressPercent}% of the plan`))),
    nozzlePanels(session, allProjects),
    session.warnings.length
      ? h('div', { class: 'callout' },
        h('p', { class: 'co-title' }, 'About this session'),
        h('ul', {}, session.warnings.map(w => h('li', {}, w))))
      : null
  );
}

/**
 * The nozzle plates for this machine, in the dashboard's own treatment: on a
 * multi-nozzle printer EVERY physical nozzle gets a panel, so "I am tuning the
 * auxiliary nozzle" is never ambiguous and an uncalibrated path sits visibly
 * dark next to the one being worked on (product rule #4).
 *
 * Ranking here differs from the dashboard's by exactly one thing: the plate that
 * outranks everything is the nozzle THIS SESSION is calibrating right now.
 */
function nozzlePanels(session: GuidedSession, allProjects: CalibrationProject[]): HTMLElement | null {
  const printer = session.printer;
  const p = session.project;
  const nozzles = printer?.nozzles ?? [];

  if (nozzles.length <= 1) {
    const label = nozzleBadgeLabel(p, printer);
    if (!label) return null;
    return h('p', { style: 'margin-top:var(--s-3)' },
      h('span', { class: 'placard placard-lit', title: 'This session calibrates one specific nozzle' }, label));
  }

  // Which physical nozzles anywhere in the fleet have produced values, and which
  // other project owns them — so a dark plate can offer its own session.
  const owners = new Map<number, CalibrationProject>();
  const lit = new Set<number>();
  for (const q of allProjects) {
    if (q.archived || q.printerProfileId !== p.printerProfileId) continue;
    const idx = q.nozzleIndex ?? 0;
    if (hasCalibratedValues(q)) lit.add(idx);
    if (q.id !== p.id && !owners.has(idx)) owners.set(idx, q);
  }

  return h('div', { class: 'panel' },
    h('span', { class: 'readout-label' }, `Nozzle panels · ${printer?.name ?? 'printer'}`),
    h('div', { style: 'display:flex;gap:1.25rem;flex-wrap:wrap;margin-top:.45rem' },
      nozzles.map((nz, i) => {
        const target = session.nozzle.index === i;
        const calibrated = lit.has(i);
        const other = owners.get(i);
        const feedLabel = nz.feed === 'bowden' ? 'Bowden' : 'Direct drive';

        const plateStyle = target
          ? 'border-color:var(--luminous);color:var(--luminous);background:var(--lum-wash)'
          : calibrated
            ? 'color:var(--luminous-dim);border-color:var(--hairline)'
            : '';
        const lampCls = target && calibrated ? 'lamp lamp-ok'
          : calibrated ? 'lamp'
            : 'lamp lamp-unlit';
        const ownership = target ? 'Calibrating now'
          : calibrated ? 'Another project'
            : 'No project yet';

        return h('div', { style: 'min-width:9rem' },
          // index triangle — the marker that says "this one", nothing else.
          h('span', {
            'aria-hidden': 'true',
            style: 'display:block;font-size:var(--fs-legend-sm);line-height:1;margin-bottom:.2rem;color:var(--luminous)'
              + (target ? '' : ';visibility:hidden')
          }, '▲'),
          h('span', {
            class: !target && !calibrated ? 'placard placard-unlit' : 'placard',
            style: plateStyle,
            title: target
              ? `This session calibrates ${nz.label}.`
              : calibrated
                ? `${nz.label} has values from a different project.`
                : `Nothing has been measured for ${nz.label} yet — this panel is dark.`
          },
            h('span', { class: lampCls, 'aria-hidden': 'true' }),
            ' ',
            target ? h('span', { class: 'sr-only' }, 'Nozzle this session calibrates: ') : null,
            nz.label),
          h('span', { class: 'placard-sub', style: target ? 'color:var(--luminous)' : '' }, ownership),
          h('span', { class: 'placard-sub', style: 'margin-top:.15em' },
            `${feedLabel} · ${calibrated ? 'calibrated' : 'not yet measured'}`),
          !target && other
            ? h('a', {
              class: 'placard-sub',
              style: 'margin-top:.25em',
              href: `#/session/${other.id}`
            }, 'Open its session →')
            : null);
      })));
}

// ---------------------------------------------------------------------------
// The progress strip — the plan drawn as a route
//
// Two views of the SAME plan, built from one pass over `session.plan`:
//  • a full route card in the page flow — every step named, measured steps lit
//    and carrying the value they logged, the open step raised in a lit bay,
//    pending steps dark;
//  • a condensed bar that pins under the app header once the full card scrolls
//    away — the same waypoints as marks, the open step named on the left with
//    its number and status, and how many steps remain.
//
// NO TIME OR ETA is shown anywhere. The app records no print-duration data, so
// the only honest "how much is left" is a step count. Measured values come from
// the same `clusterReadings` the six-pack reads, so the strip and the cluster
// always agree about whose nozzle they describe and what it measures.
// ---------------------------------------------------------------------------

/** A completed step's logged value, formatted exactly as its dial rounds it. */
function fmtReading(reading: GaugeReading): { value: string; unit?: string } {
  const v = reading.value;
  if (v === undefined || !Number.isFinite(v)) return { value: '—' };
  return { value: String(Number(v.toFixed(reading.digits))), unit: reading.unit };
}

function progressStrip(
  session: GuidedSession,
  printer: PrinterProfile | undefined,
  focusId: CalibrationId | null,
  select: (id: CalibrationId) => void
): DocumentFragment {
  const plan = session.plan;
  const total = plan.length;
  const byKey = clusterReadings(session, printer);
  const current = plan.find(s => s.id === focusId) ?? null;

  // The honest substitute for the mockup's ETA: steps still ahead. Consistent
  // with "Step N of M" — N + (steps left) === M.
  const stepsLeft = current
    ? Math.max(0, total - current.position)
    : Math.max(0, total - session.completedStepIds.length);
  const leftLabel = stepsLeft === 0 ? 'Last step'
    : stepsLeft === 1 ? '1 step left'
      : `${stepsLeft} steps left`;

  const legs: HTMLElement[] = [];
  const marks: HTMLElement[] = [];

  for (const step of plan) {
    const complete = step.status === 'completed';
    const isCurrent = step.id === focusId;
    // Only a completed step shows a value, and only via the cluster's readings —
    // an unmeasured step is an em dash, never a fabricated zero (product rule).
    const key = complete ? step.produces.find(k => byKey.has(k)) : undefined;
    const reading = key ? byKey.get(key) : undefined;
    const measured = complete && reading ? fmtReading(reading) : { value: '—' as string };
    // Optional pending steps read "Optional"; everything else uses the session's
    // own status vocabulary.
    const status = complete || !step.optional ? phaseWord(step) : 'Optional';

    const stateCls = complete ? 'is-done' : isCurrent ? 'is-current' : 'is-pending';
    const legCls = ['gs-leg', stateCls, step.optional ? 'is-optional' : '']
      .filter(Boolean).join(' ');
    const a11y = `Step ${step.position} of ${total}, ${step.name}, ${status.toLowerCase()}`
      + (measured.value !== '—' ? `, ${measured.value}${measured.unit ? ' ' + measured.unit : ''}` : '')
      + (step.optional ? ', optional' : '');

    const valEl = h('span', { class: 'gs-val' },
      measured.value, measured.unit ? h('i', {}, measured.unit) : null);
    const statusEl = h('span', { class: 'gs-status' }, status);

    legs.push(h('button', {
      type: 'button', class: legCls, 'aria-label': a11y,
      'aria-current': isCurrent ? 'step' : null,
      onClick: () => select(step.id)
    },
      h('span', { class: 'gs-cursor', 'aria-hidden': 'true' }, '▲'),
      h('span', { class: 'gs-name' }, step.shortName),
      h('span', { class: 'gs-mark', 'aria-hidden': 'true' }),
      isCurrent ? h('span', { class: 'gs-bay' }, valEl, statusEl) : [valEl, statusEl]));

    marks.push(h('button', {
      type: 'button',
      class: ['gs-pin-mark', stateCls, step.optional ? 'is-optional' : '']
        .filter(Boolean).join(' '),
      'aria-label': a11y,
      'aria-current': isCurrent ? 'step' : null,
      onClick: () => select(step.id)
    }));
  }

  // `position` is 1-based, so `plan[position]` is the step AFTER the open one.
  const nextStep = current ? plan[current.position] ?? null : null;
  const footCaption = nextStep
    ? frag('Next after this is ', h('strong', {}, nextStep.shortName), '.')
    : current ? 'This is the last step in the plan.'
      : 'Every step in this plan is done.';

  const fullCard = h('div', { class: 'instrument gs-plan', style: 'margin-top:var(--s-5)' },
    h('div', { class: 'gs-plan-head' },
      h('span', { class: 'placard' }, 'Calibration plan'),
      h('span', { class: 'readout-label' }, 'Lit = measured · dark = not yet run')),
    h('nav', { class: 'gs-route', 'aria-label': 'Calibration plan' }, legs),
    h('div', { class: 'rule-ticks', 'aria-hidden': 'true' }),
    h('div', { class: 'gs-foot' },
      h('p', { class: 'field-help', style: 'margin:0' }, footCaption),
      h('span', { class: 'readout-label', style: 'white-space:nowrap' }, leftLabel)));

  const pin = h('div', { class: 'gs-pin' },
    h('div', { class: 'gs-slim' },
      h('div', { class: 'gs-slim-inner' },
        current
          ? h('p', { class: 'gs-now' },
            h('span', { class: 'gs-now-idx' }, `Step ${current.position} of ${total}`),
            h('span', { class: 'gs-now-name' }, current.shortName),
            h('span', { class: 'gs-now-state' }, phaseWord(current)))
          : h('span', { class: 'gs-now-idx' }, `${total} steps`),
        h('span', { class: 'gs-pin-sep', 'aria-hidden': 'true' }),
        h('nav', { class: 'gs-pin-route', 'aria-label': 'Calibration plan' }, marks),
        h('span', { class: 'header-spacer' }),
        h('span', { class: 'gs-slim-right' }, leftLabel))));

  return frag(pin, fullCard, h('div', { class: 'gs-plan-sentinel', 'aria-hidden': 'true' }));
}

// ---------------------------------------------------------------------------
// The cluster — one instrument per step. The progress strip above is the plan's
// primary route; the cluster is the per-step dial face you work against.
// ---------------------------------------------------------------------------

/**
 * The cluster's dials, keyed by the setting each one carries.
 *
 * Scales and suggested-range arcs still come from the dashboard's committed
 * six-pack, so a dial means the same thing on both screens. The READINGS do
 * not: `projectGauges` reads `project.finals`, which is the project's own
 * nozzle and nothing else, so a session viewing the OTHER nozzle would have
 * printed one nozzle's numbers under a heading naming the other. They come
 * from `sessionValues` instead — the same per-nozzle resolution the step
 * tiles, the carried-value table and the install card all read, so the whole
 * screen agrees about whose nozzle it is describing.
 *
 * Which dial carries which setting is ASKED of `projectGauges` rather than
 * assumed from its order: a throwaway call with one distinct sentinel per key
 * says so directly, so reordering the dashboard's six-pack can never silently
 * mislabel this cluster. A dial that cannot be identified simply does not
 * appear, and its step falls back to the annunciator plate.
 */
function clusterReadings(
  session: GuidedSession,
  printer: PrinterProfile | undefined
): Map<string, GaugeReading> {
  const finals: FinalValues = {};
  for (const v of sessionValues(session)) {
    if (v.value !== undefined) finals[v.key] = v.value;
  }

  const probe: FinalValues = {};
  CANONICAL_KEYS.forEach((k, i) => { probe[k] = i + 1; });
  const keyAt = projectGauges({ ...session.project, finals: probe }, printer)
    .map(r => (typeof r.value === 'number' ? CANONICAL_KEYS[r.value - 1] : undefined));

  const byKey = new Map<string, GaugeReading>();
  projectGauges({ ...session.project, finals }, printer).forEach((reading, i) => {
    const key = keyAt[i];
    if (key) byKey.set(key, reading);
  });
  return byKey;
}

function clusterCard(
  session: GuidedSession,
  printer: PrinterProfile | undefined,
  focusId: CalibrationId | null,
  select: (id: CalibrationId) => void
): HTMLElement {
  const byKey = clusterReadings(session, printer);

  return h('div', { class: 'instrument' },
    h('h2', {}, `Session cluster — ${session.nozzle.label}`),
    h('p', { class: 'field-help' },
      'One instrument per test in this plan. A dark instrument has not been measured yet — it is not a reading of zero. The marked instrument is the test you are on; select any other to work on it.'),
    h('div', {
      class: 'six-pack six-pack-4',
      style: '--gauge-size:6.25rem',
      role: 'group',
      'aria-label': 'Calibration steps in this session'
    },
      session.plan.map(step => stepTile(session, step, byKey, focusId, select)))
  );
}

/** One step as an instrument: a dial where the step lands a value, an
 *  annunciator plate where it is a checklist. */
function stepTile(
  session: GuidedSession,
  step: SessionStep,
  byKey: Map<string, GaugeReading>,
  focusId: CalibrationId | null,
  select: (id: CalibrationId) => void
): HTMLElement {
  const focused = step.id === focusId;
  const complete = step.status === 'completed';
  const key = step.produces.find(k => byKey.has(k));
  const reading = key ? byKey.get(key) : undefined;

  const status = phaseWord(step);
  const why = step.blockedBy.length
    ? step.blockedBy.map(b => b.reason).join(' ')
    : step.staleness.stale
      ? step.staleness.reasons.map(r => r.detail).join(' ')
      : '';

  const instrument = reading
    ? gaugeEl(
      // Rule #1 lives here: the dial is lit ONLY when this step has run. The
      // reading it then shows is the value that setting stands at now.
      { ...reading, placard: step.shortName, value: complete ? reading.value : undefined },
      { size: 'sm', settle: false })
    : h('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:var(--s-3)' },
      h('div', {
        class: 'bezel',
        'aria-hidden': 'true',
        style: 'width:var(--gauge-size);height:var(--gauge-size);display:flex;flex-direction:column;'
          + 'align-items:center;justify-content:center;gap:.4rem;'
          + `background-color:var(--${complete ? 'instrument-face' : 'panel-deep'})`
      },
        h('span', { class: complete ? 'lamp lamp-ok' : 'lamp lamp-unlit' }),
        h('span', { style: 'font-size:var(--fs-readout)' }, step.icon)),
      h('span', { class: complete ? 'placard placard-lit' : 'placard placard-unlit' }, step.shortName));

  const label = `Step ${step.position}, ${step.name} — ${status.toLowerCase()}.`
    + (why ? ` ${why}` : '')
    + (focused ? ' Currently open.' : '');

  return h('a', {
    href: `#/session/${session.projectId}/${step.id}`,
    'aria-current': focused ? 'step' : null,
    'aria-label': label,
    title: why || step.name,
    style: 'display:flex;flex-direction:column;align-items:center;gap:var(--s-2);'
      + 'text-decoration:none;color:inherit;min-width:0',
    onClick: (e: Event) => { e.preventDefault(); select(step.id); }
  },
    // The index triangle, the same marker the nozzle plates use for "this one".
    h('span', {
      'aria-hidden': 'true',
      style: 'font-size:var(--fs-legend-sm);line-height:1;color:var(--luminous)'
        + (focused ? '' : ';visibility:hidden')
    }, '▲'),
    instrument,
    h('span', {
      class: 'placard-sub',
      'aria-hidden': 'true',
      style: 'margin-top:0;text-align:center' + (focused ? ';color:var(--luminous)' : '')
    }, focused ? `In focus · ${status}` : status),
    step.retestRecommended && complete
      ? h('span', { class: 'badge badge-warn', style: 'margin-top:.2rem' }, 'Retest')
      : null
  );
}

// ---------------------------------------------------------------------------
// "Set these in your slicer"
// ---------------------------------------------------------------------------

function slicerSection(plan: SessionActionPlan, nozzle: SessionNozzle): HTMLElement {
  const host = h('div', {});

  host.append(
    h('p', { class: 'proj-vals', style: 'gap:var(--s-2)' },
      h('span', { class: 'placard' }, `${plan.slicerLabel} ${plan.slicerVersion}`),
      nozzle.multiNozzle ? h('span', { class: 'placard placard-lit' }, nozzle.label) : null,
      h('span', { class: 'placard' }, nozzle.feed === 'bowden' ? 'Bowden fed' : 'Direct drive')),
    plan.menuPath
      ? h('p', {}, h('span', { class: 'placard' }, 'Where'), ' ', plan.menuPath)
      : h('p', {}, h('span', { class: 'placard' }, 'Calibration menu'), ' ', plan.calibrationMenuPath)
  );

  if (!plan.available) {
    host.append(h('div', { class: 'callout callout-warn' },
      h('p', { class: 'co-title' }, `No built-in test in ${plan.slicerLabel}`),
      h('p', {}, 'Follow the steps below — they come from the shipped instructions for this slicer and version.')));
  }

  if (plan.actions.length) {
    host.append(h('div', { class: 'panel' }, plan.actions.map(actionItem)));
  } else {
    host.append(h('p', { class: 'field-help' },
      'The shipped instructions carry no actions for this test in this slicer.'));
  }

  // A gap is where the shipped data has no answer. It is printed as plain text
  // because the alternative — inventing a menu path — is forbidden.
  if (plan.gaps.length) {
    host.append(h('div', { class: 'panel' },
      h('span', { class: 'placard placard-unlit' }, 'Not covered by the shipped instructions'),
      plan.gaps.map(g => h('p', { class: 'field-help' }, g))));
  }

  host.append(h('p', { class: 'field-help' },
    `Content verified against official docs on ${plan.verifiedOn}. `,
    h('a', { href: plan.docsUrl, target: '_blank', rel: 'noopener' }, 'Official documentation ↗')));

  return host;
}

/** One precise instruction. Severity is a lamp, never a decorative border. */
function actionItem(a: SessionAction): HTMLElement {
  const lampCls = a.severity === 'alert' ? 'lamp lamp-alert'
    : a.severity === 'caution' ? 'lamp lamp-caution'
      : 'lamp';

  return h('div', { class: 'eval-item', title: a.source },
    h('div', { class: 'eval-icon', 'aria-hidden': 'true' },
      h('span', { class: lampCls }),
      h('span', {
        style: 'display:block;margin-top:.3rem;font-family:var(--font-numeric);'
          + 'font-size:var(--fs-legend);color:var(--luminous-dim)'
      }, String(a.order + 1).padStart(2, '0'))),
    h('div', { style: 'flex:1;min-width:0' },
      h('h4', { style: 'display:flex;align-items:center;gap:var(--s-2);flex-wrap:wrap' },
        h('span', { class: 'sr-only' },
          a.severity === 'alert' ? 'Alert: ' : a.severity === 'caution' ? 'Caution: ' : ''),
        h('span', {}, a.title),
        a.severity === 'alert' ? h('span', { class: 'badge badge-bad' }, 'Known trap') : null,
        a.kind === 'disable' ? h('span', { class: 'badge badge-warn' }, 'Turn off first') : null,
        // A machine setting rather than a preset one — set on the printer, and
        // not something this session measures or installs anywhere.
        a.kind === 'environment' ? h('span', { class: 'badge' }, 'On the machine') : null,
        a.kind === 'carry-forward' ? h('span', { class: 'badge badge-ok' }, 'Carried forward') : null),
      a.path ? h('p', {}, h('span', { class: 'placard' }, 'Where'), ' ', a.path) : null,
      a.field ? h('p', {}, h('span', { class: 'placard' }, 'Field'), ' ', h('strong', {}, a.field)) : null,
      a.nozzleColumn
        ? h('p', {}, h('span', { class: 'placard' }, 'Column'), ' ',
          h('span', { class: 'value-chip' }, a.nozzleColumn))
        : null,
      a.value !== undefined
        ? h('p', {}, h('span', { class: 'placard' }, 'Value'), ' ',
          h('span', { class: 'value-chip' }, a.value))
        : null,
      h('p', { class: 'eval-meaning' }, a.detail)));
}

// ---------------------------------------------------------------------------
// Settings summary
// ---------------------------------------------------------------------------

function settingsSummary(settings: Record<string, unknown>, onEdit: () => void): HTMLElement {
  const entries = Object.entries(settings).filter(([, v]) =>
    v !== undefined && v !== null && v !== '' && typeof v !== 'object');
  return h('div', { class: 'panel' },
    h('div', { style: 'display:flex;align-items:center;gap:var(--s-3);flex-wrap:wrap' },
      h('span', { class: 'placard' }, 'Printed with'),
      h('button', { class: 'btn btn-ghost btn-sm', onClick: onEdit }, 'Change settings')),
    entries.length
      ? h('div', { style: 'display:flex;flex-wrap:wrap;gap:var(--s-2);margin-top:var(--s-2)' },
        entries.map(([k, v]) => h('span', { class: 'placard' }, `${humanizeKey(k)} · ${String(v)}`)))
      : h('p', { class: 'field-help' }, 'This test has no settings to record.'));
}

// ---------------------------------------------------------------------------
// Saving a result
//
// Writes exactly what the classic wizard writes (attempt, history, finals,
// timeline, retest flags), then keeps the session's per-nozzle working profile
// and its provenance in step. The wizard itself is untouched.
// ---------------------------------------------------------------------------

export async function commitStep(args: {
  project: CalibrationProject;
  printer?: PrinterProfile;
  stepId: CalibrationId;
  draft: StepDraft;
  out: ComputeOutput;
  confidence: ConfidenceLevel;
  retest: boolean;
  notes: string;
  /** `id` is stamped on the first attempt so a retry overwrites, not duplicates. */
  photos: { id?: string; name: string; type: string; blob: Blob }[];
  draftKey: string;
  /** Step name used in the confirmation/failure message shown to the user. */
  label: string;
}): Promise<boolean> {
  const { project, stepId, draft, out } = args;

  // Everything below mutates `project` in place, and the same object stays on
  // screen. A save can still be refused at commit time (quota, eviction), and
  // the storage layer reports that by rejecting. If it does, put the project
  // back exactly as it was: the retry the user is invited to make then records
  // the result ONCE instead of stacking a second timeline entry and pushing a
  // phantom attempt into history. Same contract as the classic wizard's
  // completeStep().
  const snapshot = JSON.parse(JSON.stringify(project)) as CalibrationProject;
  const savedPhotoIds: string[] = [];

  try {
    const st = project.steps[stepId] ?? (project.steps[stepId] = { status: 'not-started', current: null, history: [] });

    // Preserve the prior result in history rather than overwriting.
    if (st.current) st.history.unshift(st.current);

    const now = new Date().toISOString();
    const attempt: CalibrationAttempt = {
      id: uid(),
      startedAt: now,
      completedAt: now,
      method: draft.method,
      settings: (draft.settings ?? {}) as CalibrationAttempt['settings'],
      result: (draft.result ?? {}) as CalibrationAttempt['result'],
      computed: out.computed,
      prerequisitesConfirmed: draft.prereqs,
      notes: args.notes,
      photoIds: [],
      confidence: args.confidence
    };

    for (const ph of args.photos) {
      // The id is stamped onto the pending photo the first time round, so a
      // retry overwrites the same record instead of storing the picture twice.
      ph.id = ph.id ?? uid();
      const photo: StoredPhoto = {
        id: ph.id, projectId: project.id, stepId, attemptId: attempt.id,
        createdAt: now, name: ph.name, type: ph.type, blob: ph.blob, analysis: null
      };
      await savePhoto(photo);
      savedPhotoIds.push(photo.id);
      attempt.photoIds.push(photo.id);
    }

    st.current = attempt;
    st.status = 'completed';
    st.confidence = args.confidence;
    st.retestRecommended = args.retest;
    st.completedAt = attempt.completedAt;

    Object.assign(project.finals, out.finalsPatch);

    const summary = out.enterInSlicer.map(e => `${e.label} = ${e.value}`).join(', ')
      || String(out.computed['verdict'] ?? 'completed');
    addTimeline(project, {
      stepId, kind: 'completed',
      summary,
      detail: args.retest ? 'User flagged for retest.' : undefined
    });

    applyRetestFlags(project);
    // Push the new finals into this nozzle's working profile, with provenance,
    // so the next step inherits a measurement rather than a guess.
    syncSessionValues(project, { printer: args.printer });
    await saveProject(project);
  } catch (err) {
    restoreProject(project, snapshot);
    // Best effort: drop the photos this attempt wrote so the database looks
    // exactly as it did before. Failing to clean them up must not mask the
    // real error, and the ids are stable so a retry overwrites them anyway.
    for (const id of savedPhotoIds) {
      try { await deletePhoto(id); } catch { /* nothing more we can do */ }
    }
    toast(`Could not save ${args.label} — nothing was recorded. ${String(err)} Your entries are still here; press “Save this result” to try again.`, 'error');
    return false;
  }

  clearDraft(args.draftKey);
  toast(`${args.label} saved.`, 'success');
  return true;
}
