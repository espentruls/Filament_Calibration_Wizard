import { h, clear, field, numberInput, toast, confirmDialog, download } from './dom';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../storage/store';
import { exportAll, importBackup } from '../export/backup';
import { applyTheme } from '../app';
import { idb } from '../storage/db';
import { loadExperimentalFeatures, saveExperimentalFeatures } from '../slicerIntegration/featureFlags';
import * as bridge from '../slicerIntegration/bridge';
import { backupDetectedPresetLibraries, totalFileCount } from '../slicerIntegration/libraryBackup';
import { slicerDisplayName } from '../slicerIntegration/registry';
import type { IntegrationSlicerId } from '../slicerIntegration/types';

/**
 * Render a backup timestamp in the local time of the machine running the app.
 * The backend records `created_at` as a UTC ISO-8601 string (…Z); parsing it
 * and formatting with the browser locale converts it to the user's zone, so
 * the displayed time matches the PC clock instead of showing UTC.
 */
function formatBackupTime(createdAt: string): string {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return createdAt; // fall back to raw string
  return d.toLocaleString();
}

/**
 * Turn the "max-flow safety margin (%)" box into the stored `mvsSafetyMargin`
 * factor (headroom 15 % → 0.85).
 *
 * Read defensively, because this number scales the maximum volumetric flow the
 * app recommends. `min`/`max` on an <input type="number"> do NOT clamp what a
 * user types — they only mark the field invalid — so the raw box could hand
 * back "500" (stored as -4, a negative flow limit) or "" (silently meaning
 * "0 % headroom", removing the safety margin). Anything outside the 0–50 %
 * the field offers is clamped, and anything unreadable falls back to the
 * default instead of being invented. This is the same range `importBackup`
 * enforces on a backup file: the app must not be able to persist a value its
 * own import path would throw out.
 */
export function safetyMarginFromHeadroomPercent(raw: string): number {
  if (!raw.trim()) return DEFAULT_SETTINGS.mvsSafetyMargin;
  const pct = Number(raw);
  if (!Number.isFinite(pct)) return DEFAULT_SETTINGS.mvsSafetyMargin;
  const clamped = Math.min(50, Math.max(0, pct));
  return Number((1 - clamped / 100).toFixed(4));
}

export function renderSettings(root: HTMLElement): void {
  const s = loadSettings();

  const theme = h('select', {},
    h('option', { value: 'auto', selected: s.theme === 'auto' }, 'Follow system'),
    h('option', { value: 'light', selected: s.theme === 'light' }, 'Light — day panel'),
    h('option', { value: 'dark', selected: s.theme === 'dark' }, 'Dark — night panel'));
  const largeText = h('input', { type: 'checkbox', checked: s.largeText });
  const mode = h('select', {},
    h('option', { value: 'coach', selected: s.defaultMode === 'coach' }, 'Coach (guided)'),
    h('option', { value: 'expert', selected: s.defaultMode === 'expert' }, 'Expert (condensed)'));
  const margin = numberInput({ value: Math.round((1 - s.mvsSafetyMargin) * 100), min: 0, max: 50, step: 5 });

  const save = () => {
    const next = {
      theme: theme.value as typeof s.theme,
      largeText: largeText.checked,
      defaultMode: mode.value as typeof s.defaultMode,
      mvsSafetyMargin: safetyMarginFromHeadroomPercent(margin.value)
    };
    saveSettings(next);
    applyTheme();
    toast('Settings saved.', 'success');
  };
  [theme, mode].forEach(el => el.addEventListener('change', save));
  largeText.addEventListener('change', save);
  margin.addEventListener('change', save);

  root.append(
    h('p', { style: 'margin:0' }, h('span', { class: 'placard' }, 'Panel setup')),
    h('h1', {}, 'Settings'),
    h('div', { class: 'card' },
      h('h2', {}, 'Appearance & guidance'),
      h('div', { class: 'field-row' },
        field('Theme', theme),
        field('Default guidance level for new projects', mode),
        field('Default max-flow safety margin (%)', margin, 'Headroom kept below measured max flow. 15% is a sensible conservative default; raise it for critical parts.')
      ),
      h('div', { class: 'check-item' }, largeText,
        h('div', {}, h('strong', {}, 'Larger text'), h('p', { class: 'coach-note' }, 'Increases the base font size across the app.')))
    ),
    h('div', { class: 'card' },
      h('h2', {}, 'App data backup (projects & printers)'),
      h('p', { class: 'field-help' }, 'Exports/restores PerfectFit\'s OWN data: calibration projects, printer profiles, and settings, as a JSON file you keep. Everything lives in this browser\'s local storage — clearing site data deletes it, so export regularly. (Looking for your slicer preset backups? They\'re in the "Slicer profile backups" card below.)'),
      h('div', { class: 'btn-row' },
        h('button', {
          class: 'btn btn-primary', onClick: async () => {
            download(`perfectfit-backup-${new Date().toISOString().slice(0, 10)}.json`, await exportAll(false));
          }
        }, '⭳ Export all data (no photos)'),
        h('button', {
          class: 'btn', onClick: async () => {
            download(`perfectfit-backup-full-${new Date().toISOString().slice(0, 10)}.json`, await exportAll(true));
          }
        }, '⭳ Export all data + photos'),
        h('button', { class: 'btn', onClick: () => restoreBackupPicker(() => { clear(root); renderSettings(root); }) }, '📥 Restore from backup')
      )
    ),
    experimentalCard(),
    slicerBackupsCard(),
    h('div', { class: 'card' },
      h('h2', {}, 'Privacy'),
      h('ul', {},
        h('li', {}, 'No account. No cloud. No analytics, ads, trackers, or telemetry.'),
        h('li', {}, 'Nothing you enter — including photos — ever leaves this device.'),
        h('li', {}, 'External model links open third-party websites; nothing is sent to them from your data.'),
        h('li', {}, 'The optional offline (PWA) cache stores only the app\'s own files.'))
    ),
    dangerZoneCard()
  );
}

/**
 * Restore flow for the app's own backup file.
 *
 * Unlike the generic import picker this one offers to REPLACE printer profiles
 * whose ids already exist — a backup is otherwise powerless to repair a
 * damaged profile, because a colliding id is left untouched. The choice is put
 * to the user before anything is written, so the import still happens in one
 * pass and nothing is duplicated whichever way they answer.
 */
function restoreBackupPicker(onDone: () => void): void {
  const input = h('input', {
    type: 'file', accept: 'application/json,.json',
    class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true'
  });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    try {
      const res = await importBackup(await file.text(), {
        onPrinterCollision: printers => confirmDialog({
          title: `Replace ${printers.length} printer profile(s) you already have?`,
          body: `This backup carries printer profile(s) that already exist on this device:\n\n${printers.map(p => `• ${p.name}`).join('\n')}\n\n`
            + 'Replace them with the versions in the backup — do this to repair a profile that has been damaged — or cancel to keep the profiles you have. '
            + 'Your calibration projects are imported either way.',
          confirmLabel: 'Replace with the backup'
        })
      });
      toast(res.message, res.ok ? 'success' : 'error');
      if (res.ok) onDone();
    } catch (err) {
      toast(`Import failed: ${String(err)}`, 'error');
    }
  });
  document.body.append(input);
  input.click();
}

/**
 * Every localStorage key this app writes is namespaced with this prefix:
 * `perfectfit.settings`, `perfectfit.autosave`, `perfectfit.experimentalFeatures`
 * and `perfectfit.presetBackupFirstRunPrompt`.
 */
const APP_STORAGE_PREFIX = 'perfectfit.';

/**
 * Remove this app's own localStorage keys — and nothing else.
 *
 * `localStorage.clear()` empties the whole ORIGIN. The browser build can be
 * served next to anything else on the same host, so clearing the origin would
 * destroy data that isn't ours to delete. Walking the keys keeps the erase
 * confined to PerfectFit. Returns how many keys were removed.
 */
export function clearAppLocalStorage(): number {
  const ours: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(APP_STORAGE_PREFIX)) ours.push(k);
  }
  for (const k of ours) localStorage.removeItem(k);
  return ours.length;
}

/** Every IndexedDB store this app owns (see src/storage/db.ts). */
const APP_IDB_STORES = ['projects', 'printers', 'photos'] as const;

/**
 * Delete every trace of this app's own data from this device.
 *
 * IndexedDB has no cross-store clear, so this is one transaction per store.
 * Each is attempted even when an earlier one failed: the user asked for
 * EVERYTHING to go, and stopping at the first failure left them with almost
 * all of it plus an error that did not say what survived. Anything that could
 * not be erased is named in the thrown error, which the Danger zone shows.
 */
export async function eraseAllLocalData(): Promise<void> {
  const failures: string[] = [];
  for (const store of APP_IDB_STORES) {
    try { await idb.clear(store); } catch (err) { failures.push(`${store} (${String(err)})`); }
  }
  try { clearAppLocalStorage(); } catch (err) { failures.push(`settings (${String(err)})`); }
  if (failures.length) {
    throw new Error(
      `Everything else was erased, but this could NOT be deleted and is still on this device: ${failures.join('; ')}.`);
  }
}

/**
 * The erase control is a guarded switch, not a bare red button: the cover has
 * to be lifted (arm) before the switch can be thrown, and the two existing
 * confirmations still follow.
 */
function dangerZoneCard(): HTMLElement {
  const arm = h('input', { type: 'checkbox' }) as HTMLInputElement;

  const eraseBtn = h('button', {
    class: 'btn btn-danger', disabled: true, 'aria-disabled': 'true', onClick: async () => {
      const ok = await confirmDialog({
        title: 'Erase ALL data?',
        body: 'Deletes every project, printer profile, photo, and setting from this device. This cannot be undone. Export a backup first.',
        confirmLabel: 'Erase everything', danger: true
      });
      if (!ok) return;
      const really = await confirmDialog({
        title: 'Really erase everything?',
        body: 'Last chance — there is no cloud copy to recover from.',
        confirmLabel: 'Yes, erase', danger: true
      });
      if (!really) return;
      try {
        await eraseAllLocalData();
      } catch (err) {
        // Storage can refuse the clear. Say exactly what survived rather than
        // reloading into what looks like a wiped app while data is still there.
        toast(`Erase incomplete. ${String(err)}`, 'error');
        return;
      }
      toast('All local data erased.', 'info');
      location.hash = '#/'; location.reload();
    }
  }, '🗑 Erase all local data') as HTMLButtonElement;

  arm.addEventListener('change', () => {
    eraseBtn.disabled = !arm.checked;
    eraseBtn.setAttribute('aria-disabled', String(!arm.checked));
  });

  return h('div', { class: 'card' },
    h('h2', {}, 'Danger zone'),
    h('div', { class: 'callout callout-bad' },
      h('p', { class: 'co-title' }, 'Erase all local data'),
      h('p', {}, 'This deletes every calibration project, printer profile, photo, and setting stored in this browser. There is no cloud copy and no undo — export a backup before you throw this switch.'),
      h('div', { class: 'panel' },
        h('label', { class: 'check-item' }, arm,
          h('div', {},
            h('strong', {}, 'Arm the erase control'),
            h('p', { class: 'coach-note' }, 'Unlocks the switch below. Two confirmations still follow before anything is deleted.')))),
      h('div', { class: 'btn-row' }, eraseBtn))
  );
}

function experimentalCard(): HTMLElement {
  const f = loadExperimentalFeatures();
  const mk = (key: keyof typeof f, label: string, help: string) => {
    const cb = h('input', { type: 'checkbox', checked: f[key] }) as HTMLInputElement;
    cb.addEventListener('change', () => {
      const next = loadExperimentalFeatures();
      next[key] = cb.checked;
      saveExperimentalFeatures(next);
      toast('Experimental settings saved.', 'success');
    });
    return h('label', { class: 'check-item' }, cb,
      h('div', {}, h('strong', {}, label), h('p', { class: 'coach-note' }, help)));
  };
  return h('div', { class: 'card' },
    h('h2', {}, 'Experimental features'),
    h('div', { class: 'callout callout-warn' },
      h('p', { class: 'co-title' }, 'Unfinished instrumentation'),
      h('p', {}, 'The slicer profile installer is experimental. PerfectFit backs up affected slicer files before any installation, and unverified slicer versions stay export-only.')),
    mk('slicerProfileGeneration', 'Slicer profile generation', 'Create filament profiles from completed calibrations (clone a base profile, patch calibrated values).'),
    mk('automaticProfileInstallation', 'Automatic profile installation', 'Allow direct installation into verified slicer versions (desktop app only). Export always remains available.'),
    mk('advancedProfileSelection', 'Advanced profile selection', 'Show every detected profile with filters, raw JSON, and override options.'),
    mk('unsupportedVersionOverride', 'Unverified version override (not recommended)', 'Allow direct installation into slicer versions that have not been verified. Export is the safer choice.')
  );
}

/**
 * Show what a failed restore had already changed — permanently, until the user
 * dismisses it or leaves the page.
 *
 * A restore that stops part-way leaves the preset library half old and half
 * new, and the backend's report of exactly which files were already reverted is
 * the only way to finish the job by hand. That report runs to dozens of lines;
 * a 3.5-second toast collapsed it into an unreadable block and then threw it
 * away. Install failures already get a panel that stays on screen — this
 * matches it.
 */
export function reportRestoreFailure(host: HTMLElement, detail: string): HTMLElement {
  const running = detail.includes('SLICER_RUNNING');
  const panel = h('div', { class: 'callout callout-bad' },
    h('p', { class: 'co-title' }, running ? 'The slicer is still open' : 'Restore stopped part-way'),
    h('p', {}, running
      ? 'Nothing was changed. The slicer holds its preset files open and rewrites them when it exits, so a restore has to wait until it is closed. Close it, then press Restore again.'
      : 'Some files were already put back and some were not. Close the slicer and run this restore again — it is safe to repeat and will finish the remaining files.'),
    h('details', { class: 'advanced' },
      h('summary', {}, 'Exactly what was changed'),
      h('pre', { style: 'white-space:pre-wrap;max-height:16rem;overflow:auto;user-select:text' }, detail)),
    h('div', { class: 'btn-row' },
      h('button', {
        class: 'btn btn-sm',
        onClick: () => { void navigator.clipboard?.writeText(detail); }
      }, 'Copy list'),
      h('button', { class: 'btn btn-sm btn-ghost', onClick: () => panel.remove() }, 'Dismiss')));
  host.prepend(panel);
  return panel;
}

/**
 * Restore one slicer preset backup, addressed by the (slicer, id) pair.
 *
 * A restore rewrites the exact files an open slicer holds — and Orca and Bambu
 * Studio write their whole user preset library back out when they exit, so a
 * restore performed underneath a live slicer is silently undone minutes later.
 * The install path has always refused to run in that state; this holds the same
 * line, with the same "Check again" loop, so the user is stopped BEFORE
 * anything is written rather than left reading an error afterwards.
 *
 * The check is advisory — the slicer can still be launched between it and the
 * write — so the backend refuses again, and that refusal lands on the panel
 * below rather than in a toast that expires.
 */
export async function restoreSlicerBackup(host: HTMLElement, b: bridge.RawBackupSummary): Promise<void> {
  const name = slicerDisplayName(b.slicer_id as IntegrationSlicerId);
  const ok = await confirmDialog({
    title: 'Restore this backup?',
    body: `Restores the ${name} files covered by “${b.installed_profile_name}” exactly as they were when this backup was made (${b.file_count} file(s)). Files this backup recorded as not-yet-existing will be removed. Close ${name} first — PerfectFit will refuse to restore while it is open.`,
    confirmLabel: 'Restore'
  });
  if (!ok) return;

  for (;;) {
    let running = false;
    try {
      running = await bridge.detectRunningSlicerProcess(b.slicer_id as IntegrationSlicerId);
    } catch {
      // Native check unavailable (older build, unknown slicer id) — the
      // restore command re-checks before it writes anything.
    }
    if (!running) break;
    const again = await confirmDialog({
      title: `${name} is currently open`,
      body: `Close ${name} before restoring these presets. It holds the preset files open and writes its own copy back out when it exits, which would undo the restore without telling you. Click “Check again” after closing it.`,
      confirmLabel: 'Check again'
    });
    if (!again) return;
  }

  try {
    const r = await bridge.restoreProfileBackup(b.slicer_id, b.backup_id);
    toast(`Restored ${r.restored_files.length} file(s), removed ${r.deleted_files.length}.`, 'success');
  } catch (e) {
    reportRestoreFailure(host, String(e));
  }
}

export function slicerBackupsCard(): HTMLElement {
  const card = h('div', { class: 'card' },
    h('h2', {}, 'Slicer profile backups'),
    h('p', { class: 'field-help' }, 'Backups of your SLICER\'s preset files (Orca/Bambu filament, printer, and process profiles) — separate from the app data backup above. Before installing a profile, PerfectFit backs up the affected slicer files with checksums; you can also snapshot your entire user preset library at any time. Restore puts the original files back exactly as they were.'));
  if (!bridge.isDesktop()) {
    card.append(h('p', { class: 'field-help' }, 'Available in the PerfectFit desktop app.'));
    return card;
  }
  const host = h('div', {});
  // The half-restored report lives OUTSIDE the region `refresh()` clears. It is
  // the only record of which presets were already reverted, and rebuilding the
  // table — which deleting or making any other backup does — would otherwise
  // wipe it without the user ever dismissing it.
  const reportHost = h('div', {});
  const backupNowBtn = h('button', {
    class: 'btn', onClick: async () => {
      backupNowBtn.disabled = true;
      backupNowBtn.textContent = 'Backing up…';
      try {
        const o = await backupDetectedPresetLibraries('manual');
        if (o.backups.length) toast(`Backed up ${totalFileCount(o)} preset file(s) across ${o.backups.length} location(s).`, 'success');
        else toast(`No presets were backed up. ${o.notes.join(' ') || 'No supported slicer was detected.'}`, 'error');
        await refresh();
      } catch (e) {
        toast(`Backup failed: ${String(e)}`, 'error');
      } finally {
        backupNowBtn.disabled = false;
        backupNowBtn.textContent = '🗄 Back up all slicer presets now';
      }
    }
  }, '🗄 Back up all slicer presets now') as HTMLButtonElement;
  card.append(h('div', { class: 'btn-row' }, backupNowBtn), reportHost, host);
  const refresh = async () => {
    clear(host);
    let backups;
    try {
      backups = await bridge.listProfileBackups();
    } catch (e) {
      host.append(h('p', { class: 'field-help' }, `Could not list backups: ${String(e)}`));
      return;
    }
    if (!backups.length) {
      host.append(h('p', { class: 'field-help' }, 'No backups yet. One is created automatically on every profile installation.'));
      return;
    }
    host.append(h('div', { class: 'table-scroll' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Created'), h('th', {}, 'Slicer'), h('th', {}, 'Profile'), h('th', {}, 'Files'), h('th', {}, ''))),
      h('tbody', {}, backups.map(b => h('tr', {},
        h('td', {}, formatBackupTime(b.created_at)),
        h('td', {}, b.slicer_id),
        h('td', {}, b.installed_profile_name),
        h('td', {}, String(b.file_count)),
        h('td', {}, h('div', { class: 'btn-row', style: 'margin-top:0' },
          h('button', {
            // A backup id is unique only inside one slicer's folder, so every
            // one of these addresses the (slicer, id) PAIR — resolving by id
            // alone opened, restored, or deleted whichever slicer read_dir
            // happened to list first.
            class: 'btn btn-sm', onClick: () => bridge.openBackupDirectory(b.slicer_id, b.backup_id).catch(e => toast(String(e), 'error'))
          }, '📂 Open'),
          h('button', {
            class: 'btn btn-sm', onClick: () => void restoreSlicerBackup(reportHost, b)
          }, '⟲ Restore'),
          h('button', {
            class: 'btn btn-sm btn-danger', title: 'Delete this backup', 'aria-label': `Delete the backup made ${formatBackupTime(b.created_at)}`,
            onClick: async () => {
              const ok = await confirmDialog({
                title: 'Delete this backup?',
                body: 'The backed-up slicer files will no longer be restorable from PerfectFit.',
                confirmLabel: 'Delete backup', danger: true
              });
              if (!ok) return;
              try { await bridge.deleteProfileBackup(b.slicer_id, b.backup_id); await refresh(); }
              catch (e) { toast(String(e), 'error'); }
            }
          }, '🗑')
        ))
      ))))));
  };
  void refresh();
  return card;
}
