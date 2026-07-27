import type { AppSettings, BackupFile, CalibrationProject, PrinterProfile, StoredPhoto } from '../types';
import {
  DEFAULT_SETTINGS, SCHEMA_VERSION, ensureProjectSteps, listPrinters, listProjects,
  loadSettings, saveSettings, uid
} from '../storage/store';
import { idb, putAllAtomic } from '../storage/db';
// Imported from the module rather than the automatedCalibration barrel on
// purpose: import/export must not drag the engine layer in behind it.
import { carriesSessionData } from '../automatedCalibration/sessionManager';

/** Serialize one project (with its printer profile embedded) for sharing. */
export async function exportProject(p: CalibrationProject, printer?: PrinterProfile): Promise<string> {
  const file: BackupFile = {
    app: 'perfectfit-filament-calibration-wizard',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    projects: [p],
    printers: printer ? [printer] : []
  };
  return JSON.stringify(file, null, 2);
}

export async function exportAll(includePhotos: boolean): Promise<string> {
  const file: BackupFile = {
    app: 'perfectfit-filament-calibration-wizard',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    projects: await listProjects(),
    printers: await listPrinters(),
    settings: loadSettings()
  };
  if (includePhotos) {
    const photos = await idb.getAll<StoredPhoto>('photos');
    file.photos = await Promise.all(photos.map(async ph => ({
      meta: { id: ph.id, projectId: ph.projectId, stepId: ph.stepId, attemptId: ph.attemptId, createdAt: ph.createdAt, name: ph.name, type: ph.type },
      dataUrl: await blobToDataUrl(ph.blob)
    })));
  }
  return JSON.stringify(file, null, 2);
}

export interface ImportResult {
  ok: boolean;
  message: string;
  projectsImported: number;
  /** Printers actually written — new profiles plus any replaced ones. */
  printersImported: number;
  /** How many of `printersImported` overwrote an existing profile. */
  printersReplaced: number;
  /** Printers whose id already existed and were deliberately left untouched. */
  printersSkipped: number;
  photosImported: number;
  /** Photo entries in the file that could not be decoded and were NOT restored. */
  photosFailed: number;
  /** Whether app settings carried by the file were applied. */
  settingsRestored: boolean;
}

export interface ImportOptions {
  /**
   * Overwrite an existing printer profile when the file carries one with the
   * same id. Off by default (the existing profile wins, and the result says
   * so); on when the user has explicitly asked to repair a damaged profile
   * from a backup.
   */
  replaceExistingPrinters?: boolean;
  /**
   * Asked once, BEFORE anything is written, when the file carries printer
   * profiles whose ids already exist here. Returning true replaces them.
   * Ignored when `replaceExistingPrinters` is set explicitly. Lets the UI put
   * the choice to the user without a second import pass (which would duplicate
   * the projects the first pass had already written).
   */
  onPrinterCollision?: (collidingPrinters: PrinterProfile[]) => boolean | Promise<boolean>;
  /** Apply the app settings a full backup carries. Defaults to true. */
  restoreSettings?: boolean;
}

function emptyResult(ok: boolean, message: string): ImportResult {
  return {
    ok, message,
    projectsImported: 0, printersImported: 0, printersReplaced: 0,
    printersSkipped: 0, photosImported: 0, photosFailed: 0, settingsRestored: false
  };
}

/**
 * Validate the settings block of a backup before letting it near the app.
 *
 * `mvsSafetyMargin` scales the max volumetric flow the app recommends, so a
 * corrupt or hand-edited value is a print-safety problem, not a cosmetic one:
 * anything outside the range the Settings screen can produce (0–50 % headroom)
 * is discarded in favour of the default rather than trusted.
 */
function sanitizeSettings(raw: unknown): AppSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<AppSettings>;
  const out: AppSettings = { ...DEFAULT_SETTINGS };
  if (s.theme === 'auto' || s.theme === 'light' || s.theme === 'dark') out.theme = s.theme;
  if (typeof s.largeText === 'boolean') out.largeText = s.largeText;
  if (s.defaultMode === 'coach' || s.defaultMode === 'expert') out.defaultMode = s.defaultMode;
  if (typeof s.mvsSafetyMargin === 'number' && Number.isFinite(s.mvsSafetyMargin)
      && s.mvsSafetyMargin >= 0.5 && s.mvsSafetyMargin <= 1) {
    out.mvsSafetyMargin = s.mvsSafetyMargin;
  }
  return out;
}

/**
 * Import a backup or single-project file.
 *
 * All-or-nothing: every record is prepared in memory first and then written in
 * ONE IndexedDB transaction, so a failure partway leaves the database exactly
 * as it was. That matters because the previous per-record loop left everything
 * written up to the failure in place while telling the user the import had
 * failed — and the retry they were invited to make duplicated all of it.
 *
 * Existing projects are never overwritten: a colliding id gets a fresh id (a
 * copy is imported alongside the original). Printers are keyed to the projects
 * that reference them, so a colliding printer id is left alone by default and
 * reported as skipped; pass `replaceExistingPrinters` to restore it over the
 * top (the only way a backup can repair a damaged profile).
 */
export async function importBackup(json: string, options: ImportOptions = {}): Promise<ImportResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return emptyResult(false, 'That file is not valid JSON.');
  }
  const file = parsed as Partial<BackupFile>;
  if (file.app !== 'perfectfit-filament-calibration-wizard' || !Array.isArray(file.projects)) {
    return emptyResult(false, 'That file doesn\'t look like a PerfectFit export (missing app marker or projects).');
  }
  if ((file.schemaVersion ?? 0) > SCHEMA_VERSION) {
    return emptyResult(false, `This file was made by a newer app version (schema ${file.schemaVersion} > ${SCHEMA_VERSION}). Update the app first.`);
  }

  const migrated = migrate(file as BackupFile);

  const existingPrinters = new Set((await listPrinters()).map(p => p.id));
  const existingProjects = new Set((await listProjects()).map(p => p.id));
  const printerIdMap = new Map<string, string>();
  let printersImported = 0, printersReplaced = 0, printersSkipped = 0;
  let projectsImported = 0, photosImported = 0, photosFailed = 0;

  // Everything is staged here and committed as a single transaction below.
  const batch: { store: string; value: object }[] = [];
  const now = new Date().toISOString();

  const printersInFile = (migrated.printers ?? []).filter(p => !!p?.id && !!p.name);
  const colliding = printersInFile.filter(p => existingPrinters.has(p.id));
  let replaceExisting = options.replaceExistingPrinters ?? false;
  if (colliding.length && options.replaceExistingPrinters === undefined && options.onPrinterCollision) {
    replaceExisting = await options.onPrinterCollision(colliding);
  }

  for (const printer of printersInFile) {
    const id = printer.id;
    // Either way the id is the same, so projects in this file keep pointing at
    // the right profile whether it was replaced or left as it was.
    printerIdMap.set(printer.id, id);
    if (existingPrinters.has(id) && !replaceExisting) {
      printersSkipped++;
      continue;
    }
    if (existingPrinters.has(id)) printersReplaced++;
    batch.push({ store: 'printers', value: { ...printer, id, updatedAt: now } });
    printersImported++;
  }

  const projectIdMap = new Map<string, string>();
  for (const project of migrated.projects) {
    if (!project?.id || !project.filament) continue;
    let id = project.id;
    if (existingProjects.has(id)) {
      id = uid();
      project.filament.productLine = project.filament.productLine || '';
    }
    projectIdMap.set(project.id, id);
    const mappedPrinter = printerIdMap.get(project.printerProfileId) ?? project.printerProfileId;
    batch.push({ store: 'projects', value: { ...project, id, printerProfileId: mappedPrinter, updatedAt: now } });
    projectsImported++;
  }

  for (const ph of migrated.photos ?? []) {
    try {
      const blob = dataUrlToBlob(ph.dataUrl);
      const projectId = projectIdMap.get(ph.meta.projectId) ?? ph.meta.projectId;
      batch.push({ store: 'photos', value: { ...ph.meta, id: uid(), projectId, blob } });
      photosImported++;
    } catch {
      // A photo that cannot be decoded is NOT restored — say so rather than
      // letting a restore quietly drop every picture and still report success.
      photosFailed++;
    }
  }

  try {
    await putAllAtomic(batch);
  } catch (err) {
    return emptyResult(false,
      `Import failed — nothing was changed, so your existing data is untouched and you can safely try again. (${String(err)})`);
  }

  // Settings live in localStorage, outside the transaction above, so they are
  // applied only once the data is known to be committed.
  let settingsRestored = false;
  if (options.restoreSettings !== false && migrated.settings) {
    const clean = sanitizeSettings(migrated.settings);
    if (clean) { saveSettings(clean); settingsRestored = true; }
  }

  const parts = [`${projectsImported} project(s)`, `${printersImported} printer(s)`];
  if (photosImported) parts.push(`${photosImported} photo(s)`);
  let message = `Imported ${parts.join(', ')}.`;
  if (printersReplaced) message += ` ${printersReplaced} existing printer profile(s) were replaced.`;
  if (printersSkipped) message += ` ${printersSkipped} printer profile(s) already existed and were left unchanged — to restore those over the top (for example to repair a damaged profile), use Settings → Restore from backup.`;
  if (photosFailed) message += ` ${photosFailed} photo(s) could not be read from the file and were NOT restored.`;
  if (settingsRestored) message += ' Settings were restored.';

  return {
    ok: true, message,
    projectsImported, printersImported, printersReplaced, printersSkipped,
    photosImported, photosFailed, settingsRestored
  };
}

/** Migrate older schema versions forward. v6 is current. */
export function migrate(file: BackupFile): BackupFile {
  const v = file.schemaVersion ?? 1;
  let out = file;
  if (v < 2) {
    // v1 → v2: generatedProfiles added; absent means none.
    out = { ...out, schemaVersion: 2 };
  }
  if ((out.schemaVersion ?? 1) < 3) {
    // v2 → v3: flow-verify + shrinkage steps added; ensureProjectSteps below
    // inserts them as not-started.
    out = { ...out, schemaVersion: 3 };
  }
  if ((out.schemaVersion ?? 1) < 4) {
    // v3 → v4: PrinterProfile gained optional extended specs + database link.
    // Additive — printers without the new keys are already valid. Mark
    // pre-v4 printers as manual so the UI doesn't imply a database match.
    for (const printer of out.printers ?? []) {
      if (printer.databasePrinterId === undefined && printer.isManual === undefined) {
        printer.isManual = true;
      }
    }
    out = { ...out, schemaVersion: 4 };
  }
  if ((out.schemaVersion ?? 1) < 5) {
    // v4 → v5: CalibrationProject gained optional automated-calibration session
    // fields. Additive — projects without them are already valid (no automated
    // session). The defensive normalization below tidies the arrays when the
    // fields are present. Nothing to transform otherwise.
    out = { ...out, schemaVersion: 5 };
  }
  if ((out.schemaVersion ?? 1) < 6) {
    // v5 → v6: optional PrinterProfile.nozzles + CalibrationProject.nozzleIndex.
    // Both default to "absent" (legacy single-nozzle), and the optional
    // ooze-control step is NEVER injected into a legacy project's stepOrder
    // (it is not part of DEFAULT_ORDER, so ensureProjectSteps leaves it alone).
    out = { ...out, schemaVersion: 6 };
  }
  // Defensive normalization regardless of version:
  for (const p of out.projects ?? []) {
    p.timeline = Array.isArray(p.timeline) ? p.timeline : [];
    p.finals = p.finals ?? {};
    p.archived = !!p.archived;
    p.generatedProfiles = Array.isArray(p.generatedProfiles) ? p.generatedProfiles : [];
    for (const key of Object.keys(p.steps ?? {})) {
      const st = (p.steps as Record<string, { history?: unknown[] }>)[key];
      if (st && !Array.isArray(st.history)) st.history = [];
    }
    // A malformed nozzleIndex is dropped (absent = main nozzle) rather than guessed.
    if (p.nozzleIndex !== undefined &&
        (typeof p.nozzleIndex !== 'number' || !Number.isInteger(p.nozzleIndex) || p.nozzleIndex < 0)) {
      delete p.nozzleIndex;
    }
    // Automated session fields: only normalize when a session is present, so we
    // never fabricate a session on a plain manual project. The test is shared
    // with the session loader (`carriesSessionData`) so an imported project and
    // a loaded one can never disagree about whether a session is there — an
    // export carrying only `workingProfiles` used to skip this normalization.
    if (carriesSessionData(p)) {
      p.generatedJobs = Array.isArray(p.generatedJobs) ? p.generatedJobs : [];
      p.sessionWarnings = Array.isArray(p.sessionWarnings) ? p.sessionWarnings : [];
    }
    // Repairs a missing/empty stepOrder and back-fills steps added since export.
    // Only ever inserts, so an aux project's 'ooze-control' survives untouched.
    ensureProjectSteps(p);
  }
  for (const pr of out.printers ?? []) {
    if (!pr || pr.nozzles === undefined) continue;
    if (!Array.isArray(pr.nozzles)) {
      // Not an array at all — drop it; the Printers and New Project pages
      // iterate this and would otherwise throw after a "successful" import.
      delete pr.nozzles;
      continue;
    }
    // Drop individual malformed entries; an all-bad array falls back to the
    // legacy single-nozzle shape (absent) rather than rendering blank rows.
    const clean = pr.nozzles.filter(n =>
      !!n && typeof n === 'object' && typeof n.label === 'string' && typeof n.feed === 'string');
    if (clean.length) pr.nozzles = clean;
    else delete pr.nozzles;
  }
  return out;
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(',');
  const mime = /data:(.*?);base64/.exec(head)?.[1] ?? 'application/octet-stream';
  const bin = atob(body);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
