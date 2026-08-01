// ---------------------------------------------------------------------------
// Slicer profile wizard: Choose slicer → Scan → Select base profile →
// Configure → Preview & validate → Export / Install → Success.
//
// Desktop-only actions (detection, scanning, direct install) degrade cleanly
// to manual file selection + download in the browser build.
// ---------------------------------------------------------------------------

import { h, clear, field, toast, confirmDialog, download } from './dom';
import { getProject, getPrinter, saveProject, addTimeline, uid } from '../storage/store';
import type { CalibrationProject, ExtruderType, PrinterProfile } from '../types';
import type {
  DetectedFilamentProfile, GeneratedFilamentProfile, GeneratedProfileRecord,
  HotendFlowClass, IntegrationSlicerId, ParsedFilamentProfile, ProfileInstallResult,
  ProfileValidationResult, ScoredProfile, SlicerInstallation, UserDataLocation
} from '../slicerIntegration/types';
import * as bridge from '../slicerIntegration/bridge';
import { detectInstallations, scanProfiles, currentPlatform } from '../slicerIntegration/scanner';
import { getAdapter } from '../slicerIntegration/adapters';
import { recommendProfiles } from '../slicerIntegration/recommendations';
import { buildPatchesFromProject, generateProfile } from '../slicerIntegration/generator';
import { formatChange, summarizeDiff, fullJsonDiff } from '../slicerIntegration/diff';
import { validateGeneratedProfile, unacknowledgedWarnings } from '../slicerIntegration/validation';
import { exportProfile, installProfile } from '../slicerIntegration/installer';
import {
  defaultProfileName, resolveSlotLegend, resolveTargetSlot, type SlotLegend
} from '../slicerIntegration/orcaFamily';
import { slicerDisplayName, integrationIdsForProjectSlicer, findVerifiedVersion } from '../slicerIntegration/registry';
import { loadExperimentalFeatures } from '../slicerIntegration/featureFlags';
import { buildDiagnosticReport } from '../slicerIntegration/diagnostics';
import { errorTemplate } from '../slicerIntegration/errors';

type Stage = 'slicer' | 'profiles' | 'configure' | 'preview' | 'result';

interface WizState {
  stage: Stage;
  installations: SlicerInstallation[] | null;
  installation: SlicerInstallation | null;
  location: UserDataLocation | null;
  scan: { profiles: DetectedFilamentProfile[]; parsed: Map<string, ParsedFilamentProfile>; parseFailures: { fileName: string; error: string }[] } | null;
  advanced: boolean;
  filterText: string;
  filterSource: string;
  filterCompatibleOnly: boolean;
  selectedBase: ParsedFilamentProfile | null;
  manualSlicerId: IntegrationSlicerId;
  newName: string;
  targetExtruder: number;
  /** True once the user picked a slot by hand, so re-renders stop overriding it. */
  slotChosenByUser: boolean;
  applyAll: boolean;
  /** Bambu Studio only: bake pressure advance into start g-code (M900). */
  bakePaGcode: boolean;
  enabledPatchKeys: Set<string> | null;
  generated: GeneratedFilamentProfile | null;
  validation: ProfileValidationResult | null;
  acknowledged: Set<string>;
  installResult: ProfileInstallResult | null;
  exportedTo: string | null;
  /** ISO time this state was created or last saved the project — detects recalibration after a successful install. */
  syncedAt: string;
}

const states = new Map<string, WizState>();

function freshState(): WizState {
  return {
    stage: 'slicer', installations: null, installation: null, location: null,
    scan: null, advanced: false, filterText: '', filterSource: 'all',
    filterCompatibleOnly: true, selectedBase: null, manualSlicerId: 'orca',
    newName: '', targetExtruder: 0, slotChosenByUser: false,
    applyAll: false, bakePaGcode: false, enabledPatchKeys: null,
    generated: null, validation: null, acknowledged: new Set(),
    installResult: null, exportedTo: null,
    syncedAt: new Date().toISOString()
  };
}

function stateFor(project: CalibrationProject): WizState {
  let s = states.get(project.id);
  // A finished wizard (successful install) is stale once the project changed
  // after the wizard last touched it — e.g. after recalibrating — start fresh.
  if (s && s.stage === 'result' && s.installResult?.success && (project.updatedAt ?? '') > s.syncedAt) {
    s = undefined;
  }
  if (!s) {
    s = freshState();
    states.set(project.id, s);
  }
  return s;
}

export async function renderProfileWizard(root: HTMLElement, projectId: string): Promise<void> {
  const project = await getProject(projectId);
  if (!project) {
    root.append(h('div', { class: 'card' }, h('h1', {}, 'Project not found'),
      h('a', { class: 'btn btn-primary', href: '#/' }, 'Back to dashboard')));
    return;
  }
  const printer = await getPrinter(project.printerProfileId);
  const st = stateFor(project);
  const flags = loadExperimentalFeatures();

  if (!flags.slicerProfileGeneration) {
    root.append(h('div', { class: 'card' },
      h('h1', {}, 'Slicer profile generation is disabled'),
      h('p', {}, 'Enable “Experimental: slicer profile generation” in Settings to use this feature.'),
      h('a', { class: 'btn btn-primary', href: `#/project/${projectId}` }, 'Back to project')));
    return;
  }

  const rerender = () => { clear(root); void renderProfileWizard(root, projectId); };

  root.append(
    h('p', { class: 'no-print', style: 'margin:0' }, h('a', { href: `#/project/${projectId}` }, '← Back to project')),
    h('p', { style: 'margin:.6rem 0 0' }, h('span', { class: 'placard' }, 'Profile build')),
    h('h1', { style: 'margin:.2rem 0' }, 'Create slicer profile'),
    h('p', { class: 'field-help' },
      h('span', { class: 'badge badge-warn' }, 'Experimental installer'), ' ',
      'PerfectFit will back up the affected slicer files before installation. Profile formats can change between slicer versions, so support is verified per version. Export always works.'),
    stageNav(st)
  );

  switch (st.stage) {
    case 'slicer': await renderSlicerStage(root, st, project, rerender); break;
    case 'profiles': await renderProfilesStage(root, st, project, printer, rerender); break;
    case 'configure': renderConfigureStage(root, st, project, printer, rerender); break;
    case 'preview': renderPreviewStage(root, st, project, printer, rerender); break;
    case 'result': renderResultStage(root, st, project, rerender); break;
  }
}

function stageNav(st: WizState): HTMLElement {
  const stages: { id: Stage; label: string }[] = [
    { id: 'slicer', label: '1. Slicer' },
    { id: 'profiles', label: '2. Base profile' },
    { id: 'configure', label: '3. Configure' },
    { id: 'preview', label: '4. Preview & validate' },
    { id: 'result', label: '5. Install / export' }
  ];
  const at = stages.findIndex(s => s.id === st.stage);
  return h('ol', { class: 'progress-steps' }, stages.map((s, i) => {
    const state = i < at ? 'is-done' : i === at ? 'is-current' : '';
    const lamp = i < at ? 'lamp lamp-ok' : i === at ? 'lamp' : 'lamp lamp-unlit';
    return h('li', {
      class: `progress-step ${state}`.trim(),
      'aria-current': i === at ? 'step' : null
    },
      h('span', {
        class: lamp, 'aria-hidden': 'true',
        style: i === at ? 'background:var(--on-green);box-shadow:none' : null
      }),
      s.label);
  }));
}

// --- stage 1: slicer --------------------------------------------------------

async function renderSlicerStage(
  root: HTMLElement, st: WizState, project: CalibrationProject, rerender: () => void
): Promise<void> {
  const card = h('div', { class: 'card' }, h('h2', {}, 'Choose the target slicer'));
  root.append(card);

  if (!bridge.isDesktop()) {
    card.append(
      h('div', { class: 'callout' },
        h('p', { class: 'co-title' }, 'Browser mode'),
        h('p', {}, 'Automatic slicer detection and installation require the PerfectFit desktop app. In the browser you can still load an exported profile below, apply your calibration to it, and download the result for manual import.'))
    );
    card.append(manualSelectionBlock(st, project, rerender));
    return;
  }

  if (st.installations === null) {
    card.append(h('p', { class: 'field-help', role: 'status' }, 'Scanning for installed slicers…'));
    try {
      st.installations = await detectInstallations();
    } catch (e) {
      st.installations = [];
      card.append(h('p', { class: 'field-help' }, `Detection failed: ${String(e)}`));
    }
    rerender();
    return;
  }

  const preferred = integrationIdsForProjectSlicer(project.slicer.slicer);
  const sorted = [...st.installations].sort((a, b) =>
    Number(preferred.includes(b.slicerId)) - Number(preferred.includes(a.slicerId)));

  if (sorted.length === 0) {
    card.append(h('p', {}, 'No supported slicers were detected on this computer.'),
      h('p', { class: 'field-help' }, 'Supported: Orca Slicer, Bambu Studio, Snapmaker Orca, ElegooSlicer, Flash Studio Desktop (Orca-Flashforge). You can still use a profile file directly below.'));
  }

  // The real platform, resolved once. It used to be hard-coded to 'windows'
  // here, which made `findVerifiedVersion` match our Windows-only registry
  // entries on macOS and Linux too — so the "not yet verified for automatic
  // installation, you can still export for manual import" paragraph was
  // SUPPRESSED on exactly the platforms where direct install is unverified,
  // while the capability line right below it (computed from the real platform)
  // still said "not yet verified". We ship macOS and Linux builds, so that
  // contradiction was reaching real users and taking the export fallback
  // guidance with it.
  const platform = await currentPlatform();

  for (const inst of sorted) {
    const verified = findVerifiedVersion(inst.slicerId, inst.version, platform);
    const canInstall = inst.capabilities.canInstallDirectly;
    const locations = inst.userDataLocations;
    const selected = st.installation?.id === inst.id;

    const locationRows = locations.map(loc => h('label', { class: 'check-item' },
      h('input', {
        type: 'radio', name: `loc-${inst.id}`,
        checked: selected && st.location?.id === loc.id,
        onChange: () => { st.installation = inst; st.location = loc; st.scan = null; rerender(); }
      }),
      h('div', {},
        h('strong', {}, loc.accountId === 'default' ? 'Local presets' : `Account ${loc.accountId}`),
        loc.active ? h('span', { class: 'badge badge-ok', style: 'margin-left:.35rem' }, 'active in slicer') : null,
        loc.cloudLinked ? h('span', { class: 'badge badge-warn', style: 'margin-left:.35rem' }, 'cloud-linked') : null,
        h('p', { class: 'field-help', style: 'margin:.2rem 0 0' }, `${loc.filamentProfileCount} filament preset(s) — ${loc.path}`))
    ));

    card.append(h('div', {
      class: 'eval-item',
      style: selected
        ? 'background:var(--green-wash);border:var(--hair) solid var(--green-line);border-radius:var(--radius-sm);padding:var(--s-3)'
        : ''
    },
      h('div', { class: 'eval-icon' },
        h('span', { class: selected ? 'lamp lamp-ok' : 'lamp lamp-unlit', 'aria-hidden': 'true' }),
        h('span', { class: 'sr-only' }, selected ? 'Selected: ' : 'Not selected: ')),
      h('div', { style: 'flex:1' },
        h('h4', {}, inst.displayName, ' ',
          h('span', { class: 'badge badge-info' }, inst.version ?? 'version unknown'),
          preferred.includes(inst.slicerId) ? h('span', { class: 'badge badge-accent', style: 'margin-left:.3rem' }, 'matches this project') : null),
        h('p', { class: 'eval-meaning' },
          `Scan: ${inst.capabilities.canScanProfiles ? 'yes' : 'no'} · Generate: yes · Export: yes · Direct install: ${canInstall ? 'verified' : 'not yet verified'}`),
        !verified?.directInstallVerified ? h('p', { class: 'field-help' },
          'This version has not yet been verified for automatic installation. You can still scan profiles, generate, and export for manual import.') : null,
        locations.length > 1 ? h('p', { class: 'field-help' }, 'Multiple preset locations found — pick the one your slicer actually uses (marked “active”).') : null,
        h('div', {}, locationRows)
      ),
      h('div', {},
        h('button', {
          class: 'btn btn-sm btn-primary', onClick: () => {
            st.installation = inst;
            st.location = st.location && locations.some(l => l.id === st.location!.id)
              ? st.location
              : (locations.find(l => l.active) ?? locations[0] ?? null);
            st.scan = null;
            if (!st.location) { toast('This slicer has no user preset folder yet. Open the slicer once, then retry.', 'error'); return; }
            st.stage = 'profiles';
            rerender();
          }
        }, selected ? 'Continue →' : 'Select'))
    ));
  }

  card.append(manualSelectionBlock(st, project, rerender));

  // Diagnostics
  const diagBtn = h('button', {
    class: 'btn btn-ghost btn-sm', onClick: async () => {
      const platform = await currentPlatform();
      const report = buildDiagnosticReport({ appVersion: '1.1.0-experimental', platform, installations: st.installations ?? [] });
      try {
        await navigator.clipboard.writeText(report);
        toast('Diagnostic report copied to clipboard.', 'success');
      } catch {
        download('perfectfit-diagnostics.txt', report, 'text/plain');
      }
    }
  }, 'Copy diagnostic report');
  const diagSave = h('button', {
    class: 'btn btn-ghost btn-sm', onClick: async () => {
      const platform = await currentPlatform();
      download('perfectfit-diagnostics.txt', buildDiagnosticReport({ appVersion: '1.1.0-experimental', platform, installations: st.installations ?? [] }), 'text/plain');
    }
  }, 'Save diagnostic report');
  root.append(
    h('hr', { class: 'rule-ticks' }),
    h('p', { style: 'margin:0' }, h('span', { class: 'placard' }, 'Troubleshooting')),
    h('div', { class: 'btn-row', style: 'margin-top:.6rem' }, diagBtn, diagSave));
}

function manualSelectionBlock(st: WizState, project: CalibrationProject, rerender: () => void): HTMLElement {
  const fileInput = h('input', { type: 'file', accept: '.json,application/json' }) as HTMLInputElement;
  const slicerSelect = h('select', {},
    (['orca', 'bambu', 'snapmaker-orca', 'elegoo', 'flash-studio'] as IntegrationSlicerId[]).map(id =>
      h('option', { value: id, selected: st.manualSlicerId === id }, slicerDisplayName(id)))) as HTMLSelectElement;

  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.json')) { toast('Please choose a .json filament preset file.', 'error'); return; }
    const text = await f.text();
    st.manualSlicerId = slicerSelect.value as IntegrationSlicerId;
    try {
      const parsed = getAdapter(st.manualSlicerId).parseProfile({ kind: 'manual-file', fileName: f.name, json: text });
      if (!parsed) { toast('That file is not a recognizable filament preset.', 'error'); return; }
      if (!parsed.schemaRecognized) {
        const ok = await confirmDialog({
          title: 'Format not recognized',
          body: 'This file does not look like an Orca-family filament preset. Using it as a base may produce a profile the slicer rejects. Continue anyway?',
          confirmLabel: 'Use it anyway', danger: true
        });
        if (!ok) return;
      }
      st.installation = null; st.location = null; st.scan = null;
      st.selectedBase = parsed;
      // The slot is resolved in the configure stage, where the printer profile
      // (and therefore the calibrated nozzle's feed path) is in scope.
      st.targetExtruder = 0; st.slotChosenByUser = false;
      st.newName = ''; // configure stage fills in the default (with printer suffix)
      st.stage = 'configure';
      rerender();
    } catch (e) {
      toast(`Could not parse that file: ${String(e)}`, 'error');
    }
  });

  return h('div', {},
    h('hr', { class: 'rule-ticks' }),
    h('h3', { style: 'margin:0 0 .3rem' }, 'Use a profile file from another location'),
    h('p', { class: 'field-help' },
      'For experienced users: pick an exported filament preset (.json) to use as the base profile. The original file is never modified. Without a detected slicer, the result is export-only.'),
    h('div', { class: 'field-row' },
      field('Profile file', fileInput),
      field('Which slicer is it from?', slicerSelect))
  );
}

// --- stage 2: base profile selection ---------------------------------------

async function renderProfilesStage(
  root: HTMLElement, st: WizState, project: CalibrationProject,
  printer: PrinterProfile | undefined, rerender: () => void
): Promise<void> {
  if (!st.installation || !st.location) { st.stage = 'slicer'; rerender(); return; }
  const card = h('div', { class: 'card' },
    h('h2', {}, `Select a base profile — ${st.installation.displayName}`),
    h('p', { class: 'field-help' },
      'PerfectFit clones the base profile and changes only the values you calibrated. Everything else (cooling, speeds, unknown future settings) is preserved. The base profile itself is never modified.'));
  root.append(card);

  if (!st.scan) {
    card.append(h('p', { class: 'field-help', role: 'status' }, 'Scanning filament presets…'));
    try {
      st.scan = await scanProfiles(st.installation.slicerId, st.location);
    } catch (e) {
      card.append(h('div', { class: 'callout callout-warn' },
        h('p', { class: 'co-title' }, 'Scan failed'),
        h('p', {}, String(e)),
        h('button', { class: 'btn', onClick: () => { st.scan = null; rerender(); } }, 'Try again')));
      return;
    }
    rerender();
    return;
  }

  const rec = recommendProfiles(st.scan.profiles, project, printer);

  // Scan summary — makes "no stock presets arrived from the native scan"
  // visible instead of silently falling back (see issue with H2S baselines).
  {
    const bySource = new Map<string, number>();
    for (const p of st.scan.profiles) bySource.set(p.sourceType, (bySource.get(p.sourceType) ?? 0) + 1);
    const parts = ['system', 'user', 'cloud', 'project'].filter(k => bySource.has(k))
      .map(k => `${bySource.get(k)} ${k === 'system' ? 'stock' : k === 'project' ? 'cached' : k}`);
    card.append(h('p', { class: 'field-help' },
      `Scanned ${st.scan.profiles.length} preset(s): ${parts.join(' · ') || 'none'}${st.scan.parseFailures.length ? ` · ${st.scan.parseFailures.length} unparsable` : ''}.`));
    if (!bySource.has('system')) {
      card.append(h('ul', { class: 'issues' },
        h('li', { class: 'issue issue-warning' },
          h('span', { class: 'issue-icon', 'aria-hidden': 'true' }, '⚠'),
          h('span', { class: 'sr-only' }, 'Warning: '),
          'No stock (system) presets were found in this scan — suggestions below fall back to user presets.')));
    }
  }

  const choose = (p: DetectedFilamentProfile) => {
    st.selectedBase = st.scan!.parsed.get(p.id) ?? null;
    if (!st.selectedBase) { toast('Internal error: profile not parsed.', 'error'); return; }
    st.newName = defaultName(project, printer);
    // The slot is resolved from the preset's own variant legend in the
    // configure stage — never from the nozzle index (see resolveTargetSlot).
    st.targetExtruder = 0; st.slotChosenByUser = false;
    st.applyAll = false; st.bakePaGcode = false; st.enabledPatchKeys = null;
    st.stage = 'configure';
    rerender();
  };

  if (!st.advanced) {
    card.append(h('p', { class: 'field-help' },
      'Suggested baselines are stock (system) profiles for your material, compatible with the selected printer. PerfectFit clones a clean stock profile and applies only your calibrated values.'));
    if (rec.usedFallback) {
      card.append(h('div', { class: 'callout callout-warn' },
        h('p', { class: 'co-title' }, 'No stock profile matched — showing closest compatible profiles'),
        h('p', {}, `No system/stock ${project.filament.material} profile for this printer was found in the scan${bridge.isDesktop() ? '' : ' (stock profiles need the desktop app)'}. The suggestions below are the closest compatible profiles instead; review them, or use Advanced to pick any profile.`)));
    }
    if (rec.best) {
      card.append(recommendedCard(rec.best, true, choose));
      for (const alt of rec.alternatives) card.append(recommendedCard(alt, false, choose));
    } else {
      card.append(h('div', { class: 'callout callout-warn' },
        h('p', { class: 'co-title' }, 'No compatible profile found'),
        h('p', {}, `None of the ${st.scan.profiles.length} scanned presets are a stock ${project.filament.material} profile compatible with this printer. Switch to advanced selection to pick any profile, or add a generic ${project.filament.material} profile for this printer in your slicer first.`)));
    }
    card.append(h('div', { class: 'btn-row' },
      h('button', { class: 'btn btn-ghost', onClick: () => { st.advanced = true; rerender(); } }, '⚙ Advanced: show all profiles'),
      h('button', { class: 'btn btn-ghost', onClick: () => { st.stage = 'slicer'; rerender(); } }, '← Back')));
    return;
  }

  // Advanced mode: full filterable table.
  const search = h('input', { type: 'search', value: st.filterText, placeholder: 'Search name, vendor, material…' }) as HTMLInputElement;
  search.addEventListener('input', () => { st.filterText = search.value; renderTable(); });
  const sourceSel = h('select', {},
    ['all', 'user', 'cloud', 'system', 'project'].map(v =>
      h('option', { value: v, selected: st.filterSource === v }, v === 'all' ? 'All sources' : v))) as HTMLSelectElement;
  sourceSel.addEventListener('change', () => { st.filterSource = sourceSel.value; renderTable(); });
  const compatOnly = h('input', { type: 'checkbox', checked: st.filterCompatibleOnly }) as HTMLInputElement;
  compatOnly.addEventListener('change', () => { st.filterCompatibleOnly = compatOnly.checked; renderTable(); });

  card.append(h('div', { class: 'field-row' },
    field('Search', search), field('Source', sourceSel),
    h('label', { class: 'check-item', style: 'align-self:end' }, compatOnly, h('span', {}, 'Compatible only'))));

  const tableHost = h('div', { class: 'table-scroll' });
  card.append(tableHost);

  const renderTable = () => {
    clear(tableHost);
    const q = st.filterText.trim().toLowerCase();
    let rows = rec.all;
    if (st.filterCompatibleOnly) rows = rows.filter(r => r.compatibility.compatible);
    if (st.filterSource !== 'all') rows = rows.filter(r => r.profile.sourceType === st.filterSource);
    if (q) rows = rows.filter(r =>
      r.profile.name.toLowerCase().includes(q) ||
      (r.profile.vendor ?? '').toLowerCase().includes(q) ||
      (r.profile.materialType ?? '').toLowerCase().includes(q));
    tableHost.append(h('table', { class: 'data' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Profile'), h('th', {}, 'Material'), h('th', {}, 'Vendor'),
        h('th', {}, 'Source'), h('th', {}, 'Nozzle'), h('th', {}, 'Score'), h('th', {}, ''))),
      h('tbody', {}, rows.slice(0, 400).map(r => h('tr', {},
        h('td', {},
          r.profile.name,
          r.compatibility.errors.length ? h('span', { class: 'badge badge-warn', style: 'margin-left:.3rem' }, 'incompatible') : null,
          r.profile.warnings.length ? h('span', { title: r.profile.warnings.join('\n'), style: 'cursor:help;margin-left:.35rem' },
            h('span', { class: 'lamp lamp-caution', 'aria-hidden': 'true' }),
            h('span', { class: 'sr-only' }, `Warning: ${r.profile.warnings.join(' ')}`)) : null),
        h('td', {}, r.profile.materialType ?? '—'),
        h('td', {}, r.profile.vendor ?? '—'),
        h('td', {}, r.profile.sourceType),
        h('td', {}, r.profile.compatibleNozzleDiameters.join('/') || '—'),
        h('td', {}, String(r.score)),
        h('td', {}, h('button', {
          class: 'btn btn-sm', onClick: async () => {
            if (r.compatibility.errors.length) {
              const ok = await confirmDialog({
                title: 'Incompatible base profile',
                body: `${r.compatibility.errors.join(' ')} The source profile is never modified, but the generated profile may behave badly. Continue anyway?`,
                confirmLabel: 'Use it anyway', danger: true
              });
              if (!ok) return;
            }
            choose(r.profile);
          }
        }, 'Use as base'))
      )))));
    if (rows.length === 0) tableHost.append(h('p', { class: 'field-help' }, 'No profiles match the current filters.'));
  };
  renderTable();

  if (st.scan.parseFailures.length) {
    card.append(h('p', { class: 'field-help' }, `${st.scan.parseFailures.length} file(s) could not be parsed and are not listed.`));
  }
  card.append(h('div', { class: 'btn-row' },
    h('button', { class: 'btn btn-ghost', onClick: () => { st.advanced = false; rerender(); } }, '← Recommended view'),
    h('button', { class: 'btn btn-ghost', onClick: () => { st.stage = 'slicer'; rerender(); } }, '← Back to slicer')));
}

function recommendedCard(s: ScoredProfile, best: boolean, choose: (p: DetectedFilamentProfile) => void): HTMLElement {
  return h('div', {
    class: 'eval-item',
    style: best
      ? 'background:var(--green-wash);border:var(--hair) solid var(--green-line);border-radius:var(--radius-sm);padding:var(--s-3)'
      : ''
  },
    h('div', { class: 'eval-icon' },
      h('span', { class: best ? 'lamp lamp-ok' : 'lamp lamp-unlit', 'aria-hidden': 'true' })),
    h('div', { style: 'flex:1' },
      h('h4', {}, best ? 'Recommended: ' : 'Alternative: ', s.profile.name,
        h('span', { class: 'badge badge-info', style: 'margin-left:.3rem' }, s.profile.sourceType)),
      h('p', { class: 'eval-meaning' }, best ? 'Why this is recommended:' : 'Why this is a reasonable choice:'),
      h('ul', { style: 'margin:.2rem 0 .3rem;padding-left:1.2rem' },
        s.reasons.filter(r => r.matched && r.points > 0).slice(0, 6).map(r => h('li', {}, `✓ ${r.label}`))),
      s.compatibility.warnings.length
        ? h('ul', { class: 'issues' }, h('li', { class: 'issue issue-warning' },
            h('span', { class: 'issue-icon', 'aria-hidden': 'true' }, '⚠'),
            h('span', { class: 'sr-only' }, 'Warning: '),
            s.compatibility.warnings.join(' · ')))
        : null),
    h('div', {}, h('button', { class: `btn btn-sm ${best ? 'btn-primary' : ''}`, onClick: () => choose(s.profile) }, best ? 'Continue →' : 'Choose'))
  );
}

// --- stage 3: configure -----------------------------------------------------

/**
 * The physical nozzle this project calibrated, as hardware rather than as a
 * number. `feed` is what proves a preset slot belongs to this nozzle; when the
 * printer profile cannot say, it stays null and the write path refuses rather
 * than reading a variant array by nozzle index.
 */
interface CalibratedNozzle {
  index: number;
  feed: ExtruderType | null;
  label: string | null;
  hotendFlow: HotendFlowClass;
}

function calibratedNozzleOf(
  project: CalibrationProject, printer: PrinterProfile | undefined
): CalibratedNozzle {
  const index = project.nozzleIndex ?? 0;
  const listed = printer?.nozzles?.[index];
  // A legacy single-nozzle printer profile carries no `nozzles` array; its one
  // feed path is the profile's own extruderType. Any other index has no source.
  const fallback = !printer?.nozzles?.length && index === 0 ? printer?.extruderType ?? null : null;
  return {
    index,
    feed: listed?.feed ?? fallback,
    label: listed?.label ?? null,
    // PerfectFit does not yet record which hotend variant a nozzle has, and
    // Bambu ships different values for Standard vs High Flow. Standard is the
    // shipped default; the slot picker below names the variant it selected so
    // a high-flow owner can move it.
    hotendFlow: 'standard'
  };
}

/**
 * What this preset's value slots MEAN, in the user's words.
 *
 * This paragraph is the app's own explanation of the model, and getting it
 * wrong is what produced this bug class four times over. It used to read "on
 * dual-nozzle printers each slot is a tool" — which on a Bambu Lab X2D is
 * exactly backwards. There, four slots span two feed paths, and the auxiliary
 * is physical nozzle 2 while its values live in slot 3. A user who believed the
 * old sentence would "correct" PerfectFit's pre-selection from slot 3 to slot 2
 * and be pointing at a MAIN-nozzle variant.
 *
 * So the wording is derived from the resolved legend rather than asserted, and
 * it is a pure function so it can be read back in a test.
 */
export function slotMeaningParagraph(legend: SlotLegend | null, slots: number): string {
  if (legend?.mixedFeed) {
    return `This profile carries ${slots} value slots, and they are EXTRUDER VARIANTS spanning two different feed paths (${legend.names.join(', ')}) — not nozzle numbers. On this machine slot order is not nozzle order: the bowden auxiliary is physical nozzle 2, but its values live in the Bowden slots, which come after both Direct Drive ones. PerfectFit picks the slot by NAME from that legend, never by nozzle index. Slots you do not pick keep their existing values.`;
  }
  if (legend) {
    return `This profile carries ${slots} value slots, named by the preset itself: ${legend.names.join(', ')}. They are extruder VARIANTS — a feed path plus a hotend class — so pick the one describing the hardware you calibrated with, which is not necessarily the one matching your nozzle's number. Slots you do not pick keep their existing values.`;
  }
  return `This profile carries ${slots} value slots but does not say what they mean. A slot is an extruder VARIANT (feed path plus hotend class), which is not necessarily a nozzle number — pick the one matching the hardware you calibrated with. Slots you do not pick keep their existing values.`;
}

/** One entry of the slot dropdown. Named from the legend whenever there is one. */
export function slotOptionLabel(legend: SlotLegend | null, i: number): string {
  return legend?.names[i] ? `Slot ${i + 1} — ${legend.names[i]}` : `Value slot ${i + 1}`;
}

/**
 * Whether "apply to all value slots" may be offered at all.
 *
 * It is a legitimate assertion about hotend variants of ONE feed path ("this
 * filament runs the same numbers in Standard and High Flow"). It is not one
 * anybody can make across feed paths, and it is not an answer to "which
 * hardware does this value belong to" — yet it used to be the only enabled
 * control on the refusal screen, sitting beside the blocking error under a
 * label that mentions tools and hotends and never mentions feed paths. Ticking
 * it cleared the refusal and switched off every cross-nozzle guard in the write
 * path at once.
 *
 * Returned as a reason rather than a boolean so the screen can say why.
 */
export function applyToAllAvailability(
  legend: SlotLegend | null, slotResolved: boolean
): { available: boolean; reason?: string } {
  if (legend?.mixedFeed) {
    return {
      available: false,
      reason: 'Applying to all value slots is not available on this preset: its slots span two different feed paths, and a calibration measured on one of them is not transferable to the other. A bowden retraction distance on a direct-drive path drags soft plastic into the cold zone; PerfectFit refuses that write however it is asked for.'
    };
  }
  if (!slotResolved) {
    return {
      available: false,
      reason: 'Applying to all value slots is not available while PerfectFit cannot tell which slot belongs to this nozzle — writing to more slots does not answer which hardware the value belongs to.'
    };
  }
  return { available: true };
}

function defaultName(project: CalibrationProject, printer: PrinterProfile | undefined): string {
  const mat = project.filament.material === 'OTHER' ? (project.filament.materialOther ?? 'Custom') : project.filament.material;
  return defaultProfileName({
    manufacturer: project.filament.manufacturer, material: mat, color: project.filament.color,
    printerName: printer?.name, nozzle: printer?.nozzleDiameter
  });
}

function renderConfigureStage(
  root: HTMLElement, st: WizState, project: CalibrationProject,
  printer: PrinterProfile | undefined, rerender: () => void
): void {
  const base = st.selectedBase;
  if (!base) { st.stage = 'profiles'; rerender(); return; }
  const allPatches = buildPatchesFromProject(project);
  if (st.enabledPatchKeys === null) st.enabledPatchKeys = new Set(allPatches.map(p => p.presetKey));
  if (!st.newName) st.newName = defaultName(project, printer);

  const card = h('div', { class: 'card' },
    h('h2', {}, 'Configure the new profile'),
    h('p', { class: 'field-help' }, `Base: ${base.profile.name} (${base.profile.sourceType}${base.profile.parentProfileName ? `, inherits “${base.profile.parentProfileName}”` : ''})`));
  root.append(card);

  const nameInput = h('input', { type: 'text', value: st.newName }) as HTMLInputElement;
  nameInput.addEventListener('input', () => { st.newName = nameInput.value; });
  card.append(field('Profile name', nameInput, 'This becomes the preset name in the slicer and its file name. Only characters invalid for file names are removed.'));

  const dupNames = (st.scan?.profiles ?? []).filter(p => p.sourceType === 'user' || p.sourceType === 'cloud').map(p => p.name);

  if (allPatches.length === 0) {
    card.append(h('div', { class: 'callout callout-warn' },
      h('p', { class: 'co-title' }, 'No calibrated values yet'),
      h('p', {}, 'No completed calibration steps produced values to apply. Finish at least one calibration step first — PerfectFit never patches defaults or guesses.')));
  } else {
    card.append(h('h3', {}, 'Calibrated values to apply'),
      h('p', { class: 'field-help' }, 'Only values from completed calibration steps are listed. Untick anything you don\'t want in the generated profile.'));
    for (const p of allPatches) {
      const cb = h('input', { type: 'checkbox', checked: st.enabledPatchKeys.has(p.presetKey) }) as HTMLInputElement;
      cb.addEventListener('change', () => {
        if (cb.checked) st.enabledPatchKeys!.add(p.presetKey); else st.enabledPatchKeys!.delete(p.presetKey);
      });
      card.append(h('label', { class: 'check-item' }, cb,
        h('div', {},
          h('strong', {}, p.label),
          h('p', { class: 'coach-note' },
            h('span', { class: 'value-chip' }, `${p.value}${p.unit ? ` ${p.unit}` : ''}`)))));
    }
  }

  // Which value slot the calibration belongs in. A preset's slots are extruder
  // VARIANTS ("Direct Drive Standard", "Bowden High Flow", …), not nozzle
  // numbers, so this is resolved from the preset's own legend by name.
  const nozzle = calibratedNozzleOf(project, printer);
  const legend = resolveSlotLegend(base);
  const physicalNozzleCount = printer?.nozzles?.length ?? 0;
  const slotPick = resolveTargetSlot({
    base, nozzleIndex: nozzle.index, nozzleFeed: nozzle.feed,
    hotendFlow: nozzle.hotendFlow, nozzleLabel: nozzle.label,
    physicalNozzleCount
  });
  if (!st.slotChosenByUser) {
    st.targetExtruder = slotPick.kind === 'unresolved' ? 0 : slotPick.slot;
  }
  const usableLegend = legend && legend.matchesSlotCount ? legend : null;
  /**
   * Ticking "apply to all value slots" must NOT clear this. It used to, which
   * made one checkbox beside the blocking error the way to write a bowden
   * calibration onto the direct-drive main nozzle — every cross-nozzle guard in
   * the write path was gated on the same flag. The refusal is about which
   * hardware a value belongs to; writing it to MORE slots cannot answer that.
   */
  const slotUnresolved = slotPick.kind === 'unresolved';

  if (base.extruderCount > 1) {
    // The legend is the authority on what each slot means; it may live in the
    // preset itself or in a Bambu `include` template. Without one, the slots
    // are unlabelled and the user has to say which hardware they calibrated.
    const slotLabel = (i: number) => slotOptionLabel(usableLegend, i);
    // Nothing is pre-selected when the mapping could not be determined: a slot
    // shown as chosen would be a claim PerfectFit cannot make.
    const toolSel = h('select', {}, [
      ...(slotUnresolved
        ? [h('option', { value: '', selected: true, disabled: true }, 'Not determined — see the note below')]
        : []),
      ...Array.from({ length: base.extruderCount }, (_, i) =>
        h('option', { value: String(i), selected: !slotUnresolved && st.targetExtruder === i }, slotLabel(i)))
    ]) as HTMLSelectElement;
    toolSel.addEventListener('change', () => {
      st.targetExtruder = Number(toolSel.value); st.slotChosenByUser = true;
    });
    const applyAll = applyToAllAvailability(usableLegend, !slotUnresolved);
    const allDisabled = !applyAll.available;
    if (allDisabled) st.applyAll = false;
    const allCb = h('input', {
      type: 'checkbox', checked: st.applyAll, disabled: allDisabled ? true : undefined
    }) as HTMLInputElement;
    allCb.addEventListener('change', () => { st.applyAll = allCb.checked; rerender(); });
    // Picking a slot cannot rescue an unresolved mapping: the write path refuses
    // for the same reason the wizard could not resolve it, so offering the
    // control would be offering a button that does nothing.
    toolSel.disabled = st.applyAll || slotUnresolved;

    // What the wizard actually decided, named as hardware. "Slot 3" is not
    // checkable by a human; "Bowden Standard — the auxiliary nozzle" is.
    const nozzleWords = nozzle.label ?? `nozzle ${nozzle.index + 1}`;
    const preselection = slotPick.kind === 'variant'
      ? h('p', { class: 'field-help' },
          `Pre-selected slot ${slotPick.slot + 1}, ${slotPick.variantName} — the variant this preset uses for ${nozzleWords}, the nozzle this project calibrated. `,
          slotPick.candidates.length > 1
            ? `This preset also carries ${slotPick.candidates.filter(i => i !== slotPick.slot).map(i => `“${slotPick.legend.names[i]}”`).join(' and ')} for the same feed path — they are different HOTENDS on it, and PerfectFit assumes a STANDARD one. Change it here if yours is high flow.`
            : 'Confirm it matches your hardware.')
      : slotPick.kind === 'positional' && project.nozzleIndex !== undefined
        ? h('p', { class: 'field-help' },
            `This preset does not say what its value slots mean, so PerfectFit could not match one to ${nozzleWords}. Slot ${st.targetExtruder + 1} is pre-selected by position only — confirm it is the hardware you calibrated before generating.`)
        : null;

    card.append(h('h3', {}, 'Per-variant values'),
      h('p', { class: 'field-help' }, slotMeaningParagraph(usableLegend, base.extruderCount)),
      ...(preselection ? [preselection] : []),
      h('div', { class: 'field-row' },
        field('Apply calibration to', toolSel),
        h('label', { class: 'check-item', style: 'align-self:end' }, allCb,
          h('span', {}, 'Apply to ALL value slots (only if the calibrated values hold for every variant this preset carries)'))),
      ...(applyAll.reason ? [h('p', { class: 'field-help' }, applyAll.reason)] : []));
  }

  // No slot could be matched to the calibrated nozzle. Say so plainly and stop:
  // a value written to a slot we cannot identify is a value on hardware this
  // project never calibrated.
  if (slotUnresolved && slotPick.kind === 'unresolved') {
    card.append(h('div', { class: 'callout callout-bad' },
      h('p', { class: 'co-title' }, 'PerfectFit cannot tell which value slot belongs to this nozzle'),
      h('p', {}, slotPick.reason),
      h('p', {}, slotPick.code === 'FEED_UNKNOWN'
        ? 'Open the printer profile for this project and set the feed type (direct drive or bowden) for each nozzle, then come back.'
        : slotPick.code === 'SLOT_SHARED_BY_NOZZLES'
          ? 'This is a property of the preset format, not a mistake you made: a filament preset stores one value per extruder VARIANT, and on this machine both nozzles use the same variants. Set the calibrated values by hand in the slicer for the nozzle you calibrated.'
          : 'Go back and pick a base preset made for this printer, or set these values by hand in the slicer for the nozzle you calibrated.')));
  }

  // A base preset narrower than the machine cannot address the nozzle this
  // project calibrated: Orca-family slicers fall back to slot 1 for every
  // higher index, so one nozzle's calibration would drive all of them. The
  // slot selector above is hidden in exactly this case (it needs >1 slot), so
  // say it here — validateGeneratedProfile blocks it in the next stage anyway,
  // but the user should not have to press Generate to find out.
  {
    const baseSlots = base.extruderCount;
    const calibratedNozzle = project.nozzleIndex ?? 0;
    const physicalNozzles = printer?.nozzles?.length ?? 0;
    if (baseSlots <= calibratedNozzle) {
      const nozzleLabel = printer?.nozzles?.[calibratedNozzle]?.label;
      card.append(h('div', { class: 'callout callout-bad' },
        h('p', { class: 'co-title' }, `This base preset cannot hold a value for nozzle ${calibratedNozzle + 1}`),
        h('p', {}, `It carries only ${baseSlots} value slot(s), but this project calibrated nozzle ${calibratedNozzle + 1}${nozzleLabel ? ` (${nozzleLabel})` : ''}. Orca-family slicers apply a single-slot value to EVERY nozzle, so installing it would give every nozzle — including the main one — nozzle ${calibratedNozzle + 1}'s calibration. Go back and pick a base preset for this machine that carries ${calibratedNozzle + 1} value slots.`)));
    } else if (physicalNozzles > baseSlots) {
      card.append(h('div', { class: 'callout callout-warn' },
        h('p', { class: 'co-title' }, 'This base preset is narrower than the printer'),
        h('p', {}, `It carries ${baseSlots} value slot(s) but the printer profile declares ${physicalNozzles} physical nozzles. The slicer will apply slot 1's values to every nozzle, including ones this project did not calibrate.`)));
    }
  }

  // Bambu Studio ignores the native pressure_advance field for Bambu machines,
  // so offer to bake the calibrated K into the filament start g-code as M900.
  // Orca-family targets honor the native field and never see this option.
  if (base.profile.slicerId === 'bambu' && allPatches.some(p => p.presetKey === 'pressure_advance')) {
    const bakeCb = h('input', { type: 'checkbox', checked: st.bakePaGcode }) as HTMLInputElement;
    bakeCb.addEventListener('change', () => { st.bakePaGcode = bakeCb.checked; });
    card.append(
      h('h3', {}, 'Bambu Studio: pressure advance delivery'),
      h('div', { class: 'panel' },
        h('label', { class: 'check-item' }, bakeCb,
          h('div', {},
            h('strong', {}, 'Bake pressure advance into start G-code (M900)'),
            h('p', { class: 'coach-note' },
              'Bambu Studio ignores the profile’s pressure-advance field for Bambu machines — the printer’s on-machine Flow Dynamics owns it. Tick this to write your calibrated value as “M900 K… L1000 M10” into the filament start G-code so it actually reaches the printer.')))),
      h('div', { class: 'callout callout-warn' },
        h('p', { class: 'co-title' }, 'Turn Flow Dynamics off at print time'),
        h('p', {},
          'For the baked value to take effect you must turn Flow Dynamics off at print time: click ',
          h('strong', {}, 'Print Plate'), ', then in the ', h('strong', {}, 'Send print job'),
          ' dialog set ', h('strong', {}, 'Flow Dynamics Calibration'), ' to ',
          h('strong', {}, 'Off'), ' (options are Auto / On / Off). Left On or Auto, the machine may override the baked value.')));
  }

  card.append(h('div', { class: 'btn-row' },
    h('button', {
      class: 'btn btn-primary',
      disabled: slotUnresolved ? true : undefined,
      onClick: () => {
        const name = st.newName.trim();
        if (!name) { toast('Enter a profile name.', 'error'); return; }
        if (slotUnresolved) {
          toast('PerfectFit cannot tell which value slot belongs to the nozzle this project calibrated — see the note above.', 'error');
          return;
        }
        const patches = allPatches.filter(p => st.enabledPatchKeys!.has(p.presetKey));
        try {
          st.generated = generateProfile({
            slicerId: base.profile.slicerId, baseProfile: base.profile, newName: name,
            patches, targetExtruderIndex: st.targetExtruder,
            applyToAllExtruders: st.applyAll,
            calibratedNozzleFeed: nozzle.feed,
            calibratedHotendFlow: nozzle.hotendFlow,
            calibratedNozzleLabel: nozzle.label,
            physicalNozzleCount,
            bakePressureAdvanceGcode: st.bakePaGcode, project
          }, base);
        } catch (e) {
          toast(String(e), 'error'); return;
        }
        st.validation = validateGeneratedProfile(st.generated, {
          project, printer, baseProfile: base.profile, existingProfileNames: dupNames
        });
        st.acknowledged = new Set();
        st.stage = 'preview';
        rerender();
      }
    }, 'Generate & preview →'),
    h('button', { class: 'btn btn-ghost', onClick: () => { st.stage = st.installation ? 'profiles' : 'slicer'; rerender(); } }, '← Back')));
}

// --- stage 4: preview & validate -------------------------------------------

function renderPreviewStage(
  root: HTMLElement, st: WizState, project: CalibrationProject,
  printer: PrinterProfile | undefined, rerender: () => void
): void {
  const gen = st.generated; const base = st.selectedBase; const val = st.validation;
  if (!gen || !base || !val) { st.stage = 'configure'; rerender(); return; }

  const diff = summarizeDiff(base.profile.rawProfile as Record<string, unknown>, gen);

  const card = h('div', { class: 'card' },
    h('h2', {}, 'Preview changes'),
    h('div', { class: 'panel' },
      h('p', { style: 'margin:0' }, h('span', { class: 'placard' }, 'Base'), ' ', base.profile.name),
      h('p', { style: 'margin:.4rem 0 0' }, h('span', { class: 'placard placard-lit' }, 'New'), ' ', gen.name)),
    printer ? h('p', { class: 'field-help' }, `Target printer: ${printer.name} · ${printer.nozzleDiameter} mm nozzle`) : null,
    st.installation ? h('p', { class: 'field-help' }, `Target slicer: ${st.installation.displayName} ${st.installation.version ?? ''} · destination: ${st.location?.path ?? '—'}`) : h('p', { class: 'field-help' }, 'No slicer selected — export only.'));
  root.append(card);

  card.append(h('h3', {}, 'Changes'));
  if (diff.calibrated.length === 0) {
    card.append(h('p', { class: 'field-help' }, 'No calibrated changes — the profile is a renamed copy of the base.'));
  } else {
    card.append(h('ul', { style: 'margin:.2rem 0;padding-left:1.2rem' },
      diff.calibrated.map(c => h('li', {}, formatChange(c)))));
  }
  card.append(h('p', { class: 'field-help' },
    `${diff.preservedFieldCount} field(s) preserved from the base profile. Identity fields updated: ${diff.identity.map(i => i.key).join(', ') || 'none'}.`));

  // Aux/bowden nozzle on a Bambu preset: surface the two dual-nozzle gotchas.
  // The #10404 reassurance may only be shown when the generated preset REALLY
  // carries an explicit (non-nil) retraction at the bowden index — the patch is
  // only emitted when the retraction step completed, and the user can deselect
  // it in the configure stage. Otherwise this must be a warning, not a promise.
  //
  // The nozzle is the PROJECT's, never printer.nozzles[targetExtruder]: the
  // target is a value-slot index (an extruder variant), and on a 4-slot X2D
  // preset it runs past the end of a 2-entry nozzles array — which used to make
  // both callouts vanish exactly when the bowden slot was finally targeted.
  const targetNozzle = calibratedNozzleOf(project, printer);
  if (gen.slicerId === 'bambu' && base.extruderCount > 1 && targetNozzle.feed === 'bowden') {
    const retrRaw = (gen.data as Record<string, unknown>).filament_retraction_length;
    const retrAt = Array.isArray(retrRaw) ? retrRaw[st.targetExtruder] : undefined;
    const retrExplicit = typeof retrAt === 'string' && retrAt.trim() !== '' && retrAt.trim().toLowerCase() !== 'nil';
    const retrChangedHere = gen.changedFields.some(c =>
      c.presetKey === 'filament_retraction_length' && (c.extruderIndex === undefined || c.extruderIndex === st.targetExtruder));
    const kPatched = gen.changedFields.some(c =>
      c.presetKey === 'pressure_advance' && (c.extruderIndex === undefined || c.extruderIndex === st.targetExtruder));
    const bugIntro = 'Bambu Studio bug #10404: a preset whose bowden retraction override is left unset ("nil") silently falls back to the 0.8 mm MAIN default on the auxiliary nozzle. ';

    // Two separate annunciators: the retraction override is only a caution when
    // it is genuinely missing, while the printer-side K note is always a caution.
    card.append(h('div', { class: retrExplicit ? 'callout callout-ok' : 'callout callout-warn' },
      h('p', { class: 'co-title' }, 'Auxiliary (bowden) nozzle — retraction override'),
      retrExplicit
        ? h('p', {}, bugIntro +
            `This generated preset carries an explicit ${retrAt} mm retraction at the bowden index, so that fallback cannot happen — verify the "Bowden Extruder" override stays ticked if you edit the preset later.` +
            (retrChangedHere ? '' : ' Note: that value is inherited from the base preset, not changed by this project.'))
        : h('p', {}, bugIntro +
            'This preset does NOT set the bowden retraction override (the retraction step was not completed, or its patch was deselected in the previous stage), so that fallback CAN still happen — complete the retraction calibration, or set the "Bowden Extruder" retraction override explicitly in Bambu Studio.')));

    card.append(h('div', { class: 'callout callout-warn' },
      h('p', { class: 'co-title' }, 'Pressure advance (K) lives on the printer'),
      h('p', {}, 'Pressure advance (K) on Bambu printers lives ON the printer, keyed to filament + nozzle. ' +
        (kPatched
          ? 'The preset\'s K field is patched for completeness, but manual K only applies when the pre-print calibration gear is set to "Off".'
          : 'This preset leaves the K field unchanged (the pressure-advance step was not completed, or its patch was deselected) — calibrate K for this nozzle in Bambu Studio; manual K only applies when the pre-print calibration gear is set to "Off".'))));
  }

  // full JSON diff (advanced)
  const details = h('details', { class: 'advanced' },
    h('summary', {}, 'Full JSON diff (advanced)'),
    h('div', { class: 'table-scroll' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Field'), h('th', {}, 'Before'), h('th', {}, 'After'))),
      h('tbody', {}, fullJsonDiff(base.profile.rawProfile as Record<string, unknown>, gen.data).map(e =>
        h('tr', {}, h('td', {}, e.key), h('td', {}, e.before ?? '—'), h('td', {}, e.after ?? '—')))))));
  card.append(details);

  // validation
  const vCard = h('div', { class: 'card' }, h('h2', {}, 'Validation'));
  root.append(vCard);
  if (val.errors.length === 0 && val.warnings.length === 0) {
    vCard.append(h('div', { class: 'callout callout-ok' },
      h('p', { class: 'co-title' }, 'All checks passed'),
      h('p', {}, 'Nothing in the generated profile conflicts with this printer, this slicer version, or your calibrated values.')));
  }
  if (val.errors.length) {
    vCard.append(h('p', { class: 'field-help' }, `${val.errors.length} error(s) — installation and export are blocked until fixed:`),
      h('ul', { class: 'issues' }, val.errors.map(e => h('li', { class: 'issue issue-error' },
        h('span', { class: 'issue-icon', 'aria-hidden': 'true' }, '✖'),
        h('span', { class: 'sr-only' }, 'Error: '),
        e.message))));
  }
  if (val.warnings.length) {
    const plain = val.warnings.filter(w => !w.requiresAcknowledgement);
    const acks = val.warnings.filter(w => w.requiresAcknowledgement);
    vCard.append(h('p', { class: 'field-help' }, `${val.warnings.length} warning(s) — read each one before continuing.`));
    if (plain.length) {
      vCard.append(h('ul', { class: 'issues' }, plain.map(w => h('li', { class: 'issue issue-warning' },
        h('span', { class: 'issue-icon', 'aria-hidden': 'true' }, '⚠'),
        h('span', { class: 'sr-only' }, 'Warning: '),
        w.message))));
    }
    if (acks.length) {
      const fs = h('fieldset', {}, h('legend', {}, 'Acknowledge to continue'));
      for (const w of acks) {
        const cb = h('input', { type: 'checkbox', checked: st.acknowledged.has(w.code) }) as HTMLInputElement;
        cb.addEventListener('change', () => { if (cb.checked) st.acknowledged.add(w.code); else st.acknowledged.delete(w.code); });
        fs.append(h('label', { class: 'check-item' }, cb, h('div', {}, h('strong', {}, 'I understand: '), w.message)));
      }
      vCard.append(fs);
    }
  }

  const pendingAcks = unacknowledgedWarnings(val, [...st.acknowledged]);
  root.append(h('div', { class: 'btn-row' },
    h('button', {
      class: 'btn btn-primary',
      onClick: () => {
        if (!val.valid) { toast('Fix the validation errors first.', 'error'); return; }
        if (unacknowledgedWarnings(val, [...st.acknowledged]).length) { toast('Acknowledge the warnings above first.', 'error'); return; }
        st.stage = 'result'; st.installResult = null; st.exportedTo = null;
        rerender();
      },
      disabled: !val.valid || pendingAcks.length > 0 ? true : undefined
    }, 'Continue →'),
    h('button', { class: 'btn btn-ghost', onClick: () => { st.stage = 'configure'; rerender(); } }, '← Back')));
}

// --- stage 5: install / export ---------------------------------------------

async function persistRecord(
  project: CalibrationProject, st: WizState,
  mode: 'export' | 'install' | 'saved', destination: string | null,
  backupId: string | null, verificationPassed: boolean | null, success: boolean
): Promise<void> {
  const gen = st.generated!;
  project.generatedProfiles = project.generatedProfiles ?? [];
  let rec = project.generatedProfiles.find(r => r.generatedProfileName === gen.name && r.generatedAt === gen.generatedAt);
  if (!rec) {
    rec = {
      id: uid(), projectId: project.id, slicerId: gen.slicerId,
      slicerVersion: st.installation?.version ?? null,
      installationId: st.installation?.id ?? null,
      baseProfileName: gen.baseProfileName,
      baseProfileFingerprint: gen.baseProfileFingerprint,
      generatedProfileName: gen.name, generatedAt: gen.generatedAt,
      generatedProfileData: gen.data, generatedInfoText: gen.infoText,
      changedFields: gen.changedFields, validation: st.validation,
      installHistory: []
    } satisfies GeneratedProfileRecord;
    project.generatedProfiles.push(rec);
  }
  rec.installHistory.push({
    at: new Date().toISOString(), mode, slicerId: gen.slicerId,
    slicerVersion: st.installation?.version ?? null,
    destination, backupId, verificationPassed, success
  });
  addTimeline(project, {
    stepId: 'project', kind: 'note',
    summary: mode === 'install'
      ? `Slicer profile “${gen.name}” ${success ? 'installed into' : 'failed to install into'} ${slicerDisplayName(gen.slicerId)}`
      : mode === 'export'
        ? `Slicer profile “${gen.name}” exported`
        : `Slicer profile “${gen.name}” saved in project`
  });
  await saveProject(project);
  st.syncedAt = project.updatedAt; // our own save must not mark this state stale
}

function renderResultStage(
  root: HTMLElement, st: WizState, project: CalibrationProject, rerender: () => void
): void {
  const gen = st.generated;
  if (!gen) { st.stage = 'configure'; rerender(); return; }
  const flags = loadExperimentalFeatures();
  const canInstall = !!st.installation?.capabilities.canInstallDirectly && !!st.location && flags.automaticProfileInstallation;
  const res = st.installResult;

  if (res?.success) {
    const applied = gen.changedFields.map(c => `✓ ${formatChange(c)}`);
    root.append(h('div', { class: 'card' },
      h('h2', {}, 'Profile installed successfully'),
      h('p', {}, h('strong', {}, gen.name), ` — installed into ${st.installation!.displayName}.`),
      h('p', { class: 'field-help' }, `Based on: ${gen.baseProfileName}`),
      h('h3', {}, 'Applied'),
      h('ul', { style: 'margin:.2rem 0;padding-left:1.2rem' }, applied.map(a => h('li', {}, a))),
      h('p', {}, `A backup was created before installation${res.backupId ? ` (id ${res.backupId})` : ''}. The installed file was re-read and verified.`),
      res.warnings.length
        ? h('ul', { class: 'issues' }, res.warnings.map(w => h('li', { class: 'issue issue-warning' },
            h('span', { class: 'issue-icon', 'aria-hidden': 'true' }, '⚠'),
            h('span', { class: 'sr-only' }, 'Warning: '),
            w)))
        : null,
      h('p', {}, h('strong', {}, `Restart ${st.installation!.displayName} to load the new profile.`)),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-primary', onClick: () => bridge.openSlicer(gen.slicerId).catch(e => toast(String(e), 'error')) }, `▶ Launch ${st.installation!.displayName}`),
        h('button', { class: 'btn', onClick: () => bridge.openProfileDirectory(st.location!.path + '\\filament').catch(() => bridge.openProfileDirectory(st.location!.path)).catch(e => toast(String(e), 'error')) }, '📂 Open profile folder'),
        // Backup ids repeat across slicers, so the slicer this install targeted
        // is part of the address.
        res.backupId ? h('button', { class: 'btn', onClick: () => bridge.openBackupDirectory(gen.slicerId, res.backupId!).catch(e => toast(String(e), 'error')) }, '🗄 View backup') : null,
        h('a', { class: 'btn', href: `#/report/${project.id}` }, '📄 View calibration report'),
        h('button', { class: 'btn btn-ghost', onClick: () => { states.delete(project.id); rerender(); } }, '↺ Create another profile'))
    ));
    return;
  }

  const card = h('div', { class: 'card' }, h('h2', {}, 'Install or export'));
  root.append(card);

  if (res && res.error) {
    const t = errorTemplate(res.error.code);
    card.append(h('div', { class: 'callout callout-bad' },
      h('p', { class: 'co-title' }, t.title),
      h('p', {}, t.whatHappened, ' ', t.anythingChanged),
      h('ul', { style: 'margin:.2rem 0;padding-left:1.2rem' }, t.nextSteps.map(s2 => h('li', {}, s2))),
      res.error.detail ? h('details', { class: 'advanced' }, h('summary', {}, 'Technical details'), h('p', { class: 'field-help' }, res.error.detail)) : null,
      res.backupId ? h('p', { class: 'field-help' }, `Backup id: ${res.backupId} (Settings → Slicer profile backups)`) : null));
  }

  // Export
  card.append(h('h3', {}, '1. Export profile file'),
    h('p', { class: 'field-help' }, bridge.isDesktop()
      ? 'Save the generated preset anywhere, then import it in the slicer (Filament settings → import, or drag & drop into the slicer window).'
      : 'Download the generated preset, then import it in the slicer (Filament settings → import, or drag & drop into the slicer window).'),
    h('div', { class: 'btn-row' },
      h('button', {
        class: 'btn btn-primary', onClick: async () => {
          try {
            const dest = await exportProfile(gen);
            if (dest === null) return; // cancelled
            st.exportedTo = dest;
            await persistRecord(project, st, 'export', dest, null, null, true);
            toast(dest === 'download' ? 'Profile downloaded.' : `Saved to ${dest}`, 'success');
            rerender();
          } catch (e) { toast(String(e), 'error'); }
        }
      }, '⭳ Export profile'),
      st.exportedTo
        ? h('span', { class: 'badge badge-ok' }, h('span', { class: 'lamp lamp-ok', 'aria-hidden': 'true' }), 'exported')
        : null));

  // Install
  card.append(h('h3', {}, '2. Install automatically'));
  if (!bridge.isDesktop()) {
    card.append(h('p', { class: 'field-help' }, 'Automatic installation requires the PerfectFit desktop app.'));
  } else if (!st.installation || !st.location) {
    card.append(h('p', { class: 'field-help' }, 'No slicer/location selected (manual file mode) — use export instead.'));
  } else if (!canInstall) {
    card.append(h('p', { class: 'field-help' },
      `Automatic installation is disabled for ${st.installation.displayName} ${st.installation.version ?? ''}: this version has not been verified for direct install yet. Use export — it is just as good, minus one manual import step.`));
  } else {
    card.append(
      h('p', { class: 'field-help' },
        `Destination: ${st.location.path}\\filament\\${gen.fileStem}.json — a timestamped backup is created first, the file is written to a temp file, verified, atomically moved, and re-verified. ${st.installation.displayName} must be closed.`),
      h('div', { class: 'btn-row' },
        h('button', {
          class: 'btn btn-primary', onClick: () => void doInstall(false)
        }, '⚙ Install into slicer')));
  }

  // Save in PerfectFit
  card.append(h('h3', {}, '3. Save inside PerfectFit'),
    h('p', { class: 'field-help' }, 'Keep the generated profile in this calibration project to export or install later.'),
    h('div', { class: 'btn-row' },
      h('button', {
        class: 'btn', onClick: async () => {
          await persistRecord(project, st, 'saved', null, null, null, true);
          toast('Profile saved in the project.', 'success');
        }
      }, '💾 Save in project')));

  card.append(h('div', { class: 'btn-row', style: 'margin-top:.6rem' },
    h('button', { class: 'btn btn-ghost', onClick: () => { st.stage = 'preview'; rerender(); } }, '← Back to preview')));

  async function doInstall(allowReplace: boolean): Promise<void> {
    if (!st.installation || !st.location || !gen) return;
    // Live process check with explicit user flow.
    try {
      const running = await bridge.detectRunningSlicerProcess(gen.slicerId);
      if (running) {
        const again = await confirmDialog({
          title: `${st.installation.displayName} is currently open`,
          body: `Close ${st.installation.displayName} before installing this profile so it does not overwrite or ignore the new preset. Click “Check again” after closing it.`,
          confirmLabel: 'Check again'
        });
        if (again) return void doInstall(allowReplace);
        return;
      }
    } catch { /* native check unavailable → the install command re-checks anyway */ }

    const result = await installProfile({
      profile: gen, location: st.location, projectId: project.id, allowReplace
    });

    if (result.error?.code === 'DUPLICATE_PROFILE' && !allowReplace) {
      const replace = await confirmDialog({
        title: 'A profile with this name already exists',
        body: `“${gen.name}” already exists in ${st.installation.displayName}. Replace it? A backup of the existing preset is created first. (Cancel to go back and pick a different name.)`,
        confirmLabel: 'Replace (with backup)', danger: true
      });
      if (replace) return void doInstall(true);
      st.stage = 'configure'; rerender(); return;
    }

    st.installResult = result;
    await persistRecord(project, st, 'install',
      result.installedFiles[0] ?? null, result.backupId, result.verificationPassed, result.success);
    rerender();
  }
}
