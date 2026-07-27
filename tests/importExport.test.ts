import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';

// localStorage shim for Node
const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear()
});

import { exportAll, exportProject, importBackup, migrate, dataUrlToBlob } from '../src/export/backup';
import {
  createProject, savePrinter, listProjects, listPrinters, saveProject, uid,
  loadSettings, saveSettings, DEFAULT_SETTINGS, SCHEMA_VERSION
} from '../src/storage/store';
import { DEFAULT_ORDER } from '../src/data/calibrations';
import type { BackupFile, PrinterProfile } from '../src/types';
import { idb } from '../src/storage/db';

function makePrinter(): PrinterProfile {
  return {
    id: uid(), name: 'Bench Printer', manufacturer: 'Test Co', nozzleDiameter: 0.4,
    maxNozzleTemp: 300, maxBedTemp: 110, maxVolumetricFlow: 20,
    extruderType: 'direct', retractionRange: { start: 0, end: 2 },
    notes: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
}

function makeProject(printerId: string) {
  return createProject({
    filament: {
      manufacturer: 'TestBrand', productLine: 'Line', material: 'PLA',
      color: 'Red', diameter: 1.75, startingProfile: 'Generic PLA'
    },
    printerProfileId: printerId, nozzleType: 'brass',
    slicer: { slicer: 'orca', version: '2.4.x' }, notes: '', mode: 'coach'
  });
}

/**
 * Make the nth IndexedDB write fail the way a real one does at commit time:
 * the request itself succeeds, then the transaction aborts (quota exceeded,
 * eviction). Returns a restore function.
 */
function failNthPut(n: number): () => void {
  const orig = IDBObjectStore.prototype.put;
  let seen = 0;
  IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: unknown[]) {
    const req = (orig as (...a: unknown[]) => IDBRequest).apply(this, args);
    if (++seen === n) {
      const t = this.transaction;
      req.addEventListener('success', () => { t.abort(); });
    }
    return req;
  } as typeof IDBObjectStore.prototype.put;
  return () => { IDBObjectStore.prototype.put = orig; };
}

beforeEach(async () => {
  await idb.clear('projects');
  await idb.clear('printers');
  await idb.clear('photos');
  mem.clear();
});

describe('export / import round-trip', () => {
  it('round-trips a single project with its printer', async () => {
    const printer = makePrinter();
    const project = makeProject(printer.id);
    const json = await exportProject(project, printer);

    const res = await importBackup(json);
    expect(res.ok).toBe(true);
    expect(res.projectsImported).toBe(1);
    expect(res.printersImported).toBe(1);

    const projects = await listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].filament.manufacturer).toBe('TestBrand');
    expect(projects[0].printerProfileId).toBe(printer.id);
  });

  it('rejects invalid JSON and foreign files', async () => {
    expect((await importBackup('not json')).ok).toBe(false);
    expect((await importBackup('{"app":"something-else","projects":[]}')).ok).toBe(false);
  });

  it('rejects files from a newer schema', async () => {
    const file = { app: 'perfectfit-filament-calibration-wizard', schemaVersion: SCHEMA_VERSION + 1, projects: [] };
    const res = await importBackup(JSON.stringify(file));
    expect(res.ok).toBe(false);
    expect(res.message).toContain('newer');
  });

  it('does not overwrite an existing project with the same id — imports a copy', async () => {
    const printer = makePrinter();
    await savePrinter(printer);
    const project = makeProject(printer.id);
    await saveProject(project);

    const json = await exportProject(project, printer);
    const res = await importBackup(json);
    expect(res.ok).toBe(true);

    const projects = await listProjects();
    expect(projects).toHaveLength(2);
    const ids = new Set(projects.map(p => p.id));
    expect(ids.size).toBe(2); // fresh id was assigned

    // printer with the same id is treated as the same profile, not duplicated
    expect(await listPrinters()).toHaveLength(1);
  });

  it('imports photos from a full backup', async () => {
    const printer = makePrinter();
    const project = makeProject(printer.id);
    const file: BackupFile = {
      app: 'perfectfit-filament-calibration-wizard',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      projects: [project],
      printers: [printer],
      photos: [{
        meta: {
          id: uid(), projectId: project.id, stepId: 'temperature', attemptId: 'a1',
          createdAt: new Date().toISOString(), name: 'test.png', type: 'image/png'
        },
        dataUrl: 'data:image/png;base64,' + Buffer.from('fakepng').toString('base64')
      }]
    };
    const res = await importBackup(JSON.stringify(file));
    expect(res.ok).toBe(true);
    expect(res.photosImported).toBe(1);
  });
});

describe('import is all-or-nothing', () => {
  function twoProjectBackup() {
    const printer = makePrinter();
    const a = makeProject(printer.id);
    const b = makeProject(printer.id);
    return JSON.stringify({
      app: 'perfectfit-filament-calibration-wizard',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      projects: [a, b],
      printers: [printer]
    } satisfies BackupFile);
  }

  it('writes nothing when a write fails partway, and never reports success', async () => {
    const json = twoProjectBackup();
    const restore = failNthPut(3); // printer + first project already written
    let res;
    try {
      // Must resolve with a failure result, not throw: a thrown error tells the
      // caller nothing about what landed in the database.
      res = await importBackup(json);
    } finally {
      restore();
    }

    expect(res.ok).toBe(false);
    expect(res.projectsImported).toBe(0);
    expect(res.printersImported).toBe(0);
    // Nothing may be left behind — otherwise the retry below duplicates it.
    expect(await listProjects()).toHaveLength(0);
    expect(await listPrinters()).toHaveLength(0);
  });

  it('a retry after a failed import imports exactly once', async () => {
    const json = twoProjectBackup();
    const restore = failNthPut(3);
    try { await importBackup(json); } catch { /* the buggy version threw here */ }
    restore();

    const res = await importBackup(json);
    expect(res.ok).toBe(true);
    expect(res.projectsImported).toBe(2);
    expect(await listProjects()).toHaveLength(2);
    expect(await listPrinters()).toHaveLength(1);
  });
});

describe('photo import failures are reported', () => {
  function backupWithPhotos(dataUrls: string[]) {
    const printer = makePrinter();
    const project = makeProject(printer.id);
    return JSON.stringify({
      app: 'perfectfit-filament-calibration-wizard',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      projects: [project],
      printers: [printer],
      photos: dataUrls.map(dataUrl => ({
        meta: {
          id: uid(), projectId: project.id, stepId: 'temperature', attemptId: 'a1',
          createdAt: new Date().toISOString(), name: 'p.png', type: 'image/png'
        },
        dataUrl
      }))
    } satisfies BackupFile);
  }

  it('counts undecodable photos and says so instead of claiming a clean restore', async () => {
    const good = 'data:image/png;base64,' + Buffer.from('ok').toString('base64');
    const res = await importBackup(backupWithPhotos([good, 'not-a-data-url', '']));
    expect(res.photosImported).toBe(1);
    expect(res.photosFailed).toBe(2);
    expect(res.message).toMatch(/2 photo/);
  });

  it('does not claim success for photos when every photo is broken', async () => {
    const res = await importBackup(backupWithPhotos(['broken', 'also-broken']));
    expect(res.photosImported).toBe(0);
    expect(res.photosFailed).toBe(2);
    expect(res.message).toMatch(/2 photo/);
  });
});

describe('printer id collisions', () => {
  it('reports the printers it left untouched rather than pretending they were restored', async () => {
    const printer = makePrinter();
    await savePrinter({ ...printer, name: 'Damaged profile' });
    const project = makeProject(printer.id);

    const res = await importBackup(await exportProject(project, printer));
    expect(res.ok).toBe(true);
    expect(res.printersImported).toBe(0);
    expect(res.printersSkipped).toBe(1);
    expect(res.message).toMatch(/already/i);
    // Default stays non-destructive.
    expect((await listPrinters())[0].name).toBe('Damaged profile');
  });

  it('repairs a damaged printer profile when the caller opts into replacing', async () => {
    const printer = makePrinter();
    await savePrinter({ ...printer, name: 'Damaged profile', maxNozzleTemp: 0 });
    const project = makeProject(printer.id);

    const res = await importBackup(await exportProject(project, printer), { replaceExistingPrinters: true });
    expect(res.ok).toBe(true);
    expect(res.printersReplaced).toBe(1);
    expect(res.printersSkipped).toBe(0);

    const printers = await listPrinters();
    expect(printers).toHaveLength(1);
    expect(printers[0].name).toBe('Bench Printer');
    expect(printers[0].maxNozzleTemp).toBe(300);
  });

  it('asks the caller before replacing, and still imports in a single pass', async () => {
    const printer = makePrinter();
    await savePrinter({ ...printer, name: 'Damaged profile' });
    const project = makeProject(printer.id);

    const asked: string[] = [];
    const res = await importBackup(await exportProject(project, printer), {
      onPrinterCollision: printers => { asked.push(...printers.map(p => p.name)); return true; }
    });

    expect(asked).toEqual(['Bench Printer']);
    expect(res.printersReplaced).toBe(1);
    // One pass: the projects are not imported twice by asking.
    expect(await listProjects()).toHaveLength(1);
    expect(await listPrinters()).toHaveLength(1);
  });

  it('keeps the existing profile when the caller declines', async () => {
    const printer = makePrinter();
    await savePrinter({ ...printer, name: 'Mine' });
    const res = await importBackup(await exportProject(makeProject(printer.id), printer), {
      onPrinterCollision: () => false
    });
    expect(res.printersSkipped).toBe(1);
    expect((await listPrinters())[0].name).toBe('Mine');
  });
});

describe('settings in a full backup', () => {
  it('restores the settings exportAll() promised', async () => {
    saveSettings({ theme: 'dark', largeText: true, defaultMode: 'expert', mvsSafetyMargin: 0.7 });
    const json = await exportAll(false);

    saveSettings({ ...DEFAULT_SETTINGS });
    const res = await importBackup(json);
    expect(res.ok).toBe(true);
    expect(res.settingsRestored).toBe(true);
    expect(loadSettings()).toEqual({ theme: 'dark', largeText: true, defaultMode: 'expert', mvsSafetyMargin: 0.7 });
  });

  it('discards an out-of-range safety margin instead of trusting the file', async () => {
    const file = {
      app: 'perfectfit-filament-calibration-wizard',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: '',
      projects: [],
      printers: [],
      // 5 would recommend FIVE TIMES the measured max flow.
      settings: { theme: 'dark', largeText: false, defaultMode: 'coach', mvsSafetyMargin: 5 }
    } as unknown as BackupFile;

    const res = await importBackup(JSON.stringify(file));
    expect(res.ok).toBe(true);
    expect(loadSettings().mvsSafetyMargin).toBe(DEFAULT_SETTINGS.mvsSafetyMargin);
    expect(loadSettings().theme).toBe('dark');
  });

  it('leaves settings alone for a single-project file that carries none', async () => {
    saveSettings({ theme: 'light', largeText: true, defaultMode: 'expert', mvsSafetyMargin: 0.9 });
    const printer = makePrinter();
    const res = await importBackup(await exportProject(makeProject(printer.id), printer));
    expect(res.settingsRestored).toBe(false);
    expect(loadSettings().theme).toBe('light');
  });
});

describe('data migration', () => {
  it('normalizes missing arrays and fields from older/partial files', () => {
    const file = {
      app: 'perfectfit-filament-calibration-wizard',
      schemaVersion: 0,
      exportedAt: '',
      projects: [{
        id: 'x', filament: {}, steps: { temperature: { status: 'completed', current: null } },
        stepOrder: ['temperature']
      }],
      printers: []
    } as unknown as BackupFile;
    const out = migrate(file);
    // migrate() always runs the chain to the current schema, so assert against
    // the constant rather than a literal that goes stale on the next bump.
    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
    const p = out.projects[0];
    expect(Array.isArray(p.timeline)).toBe(true);
    expect(p.finals).toBeDefined();
    expect(p.generatedProfiles).toEqual([]);
    expect(Array.isArray((p.steps as Record<string, { history: unknown[] }>).temperature.history)).toBe(true);
  });

  it('defaults stepOrder and steps when a project is imported without them', async () => {
    const file = {
      app: 'perfectfit-filament-calibration-wizard',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: '',
      projects: [{
        id: 'bare-project',
        filament: {
          manufacturer: 'TestBrand', productLine: '', material: 'PLA',
          color: 'Red', diameter: 1.75, startingProfile: 'Generic PLA'
        },
        printerProfileId: 'none'
        // no stepOrder, no steps
      }],
      printers: []
    } as unknown as BackupFile;
    const res = await importBackup(JSON.stringify(file));
    expect(res.ok).toBe(true);
    expect(res.projectsImported).toBe(1);

    const projects = await listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].stepOrder).toEqual(DEFAULT_ORDER);
    // A project imported without `steps` must come back with every canonical
    // step seeded as not-started (ensureProjectSteps), never `undefined` —
    // the dashboard and confidence score index into this map directly.
    for (const id of DEFAULT_ORDER) {
      expect(projects[0].steps[id], id).toBeDefined();
      expect(projects[0].steps[id].status, id).toBe('not-started');
    }
    // ...and nothing beyond the default order: the optional dual-nozzle step
    // is only ever added by New Project for aux/bowden-nozzle printers.
    expect(Object.keys(projects[0].steps).sort()).toEqual([...DEFAULT_ORDER].sort());
    expect(projects[0].steps['ooze-control']).toBeUndefined();
  });

  it('round-trips dual-nozzle fields: printer.nozzles, project.nozzleIndex, ooze-control step', async () => {
    const printer = makePrinter();
    printer.nozzles = [
      { label: 'Main (direct drive)', feed: 'direct' },
      { label: 'Auxiliary (bowden)', feed: 'bowden', maxSpeed: 200, maxAccel: 1000, notes: 'supports-oriented' }
    ];
    const project = makeProject(printer.id);
    project.nozzleIndex = 1;
    project.stepOrder.splice(project.stepOrder.indexOf('final-verification'), 0, 'ooze-control');

    const res = await importBackup(await exportProject(project, printer));
    expect(res.ok).toBe(true);

    const [imported] = await listProjects();
    expect(imported.nozzleIndex).toBe(1);
    expect(imported.stepOrder).toContain('ooze-control');
    expect(imported.stepOrder.indexOf('ooze-control')).toBeLessThan(imported.stepOrder.indexOf('final-verification'));
    const [importedPrinter] = await listPrinters();
    expect(importedPrinter.nozzles).toEqual(printer.nozzles);
  });

  it('legacy (v2) backups import without nozzle fields and without ooze-control injection', async () => {
    const printer = makePrinter();
    const project = makeProject(printer.id);
    const file = JSON.parse(await exportProject(project, printer)) as BackupFile;
    file.schemaVersion = 2;
    const res = await importBackup(JSON.stringify(file));
    expect(res.ok).toBe(true);

    const [imported] = await listProjects();
    expect(imported.nozzleIndex).toBeUndefined();
    expect(imported.stepOrder).toEqual(DEFAULT_ORDER);
    expect(imported.stepOrder).not.toContain('ooze-control');
    const [importedPrinter] = await listPrinters();
    expect(importedPrinter.nozzles).toBeUndefined();
  });

  it('migrate drops a malformed nozzleIndex instead of guessing', () => {
    const file = {
      app: 'perfectfit-filament-calibration-wizard',
      schemaVersion: 3,
      exportedAt: '',
      projects: [{ id: 'a', filament: {}, nozzleIndex: 'two', stepOrder: [...DEFAULT_ORDER], steps: {} }],
      printers: [{ id: 'p', name: 'P', nozzles: 'not-an-array' }]
    } as unknown as BackupFile;
    const out = migrate(file);
    expect(out.projects[0].nozzleIndex).toBeUndefined();
    expect(out.printers[0].nozzles).toBeUndefined();
  });

  it('adds v3 steps (flow-verify, shrinkage) to older projects at canonical positions', () => {
    const file = {
      app: 'perfectfit-filament-calibration-wizard',
      schemaVersion: 2,
      exportedAt: '',
      projects: [{
        id: 'x', filament: {}, finals: {}, timeline: [],
        steps: {
          temperature: { status: 'completed', current: null, history: [] },
          'pressure-advance': { status: 'completed', current: null, history: [] }
        },
        stepOrder: ['temperature', 'flow-pass1', 'flow-pass2', 'pressure-advance', 'retraction', 'max-volumetric-speed', 'final-verification']
      }],
      printers: []
    } as unknown as BackupFile;
    const out = migrate(file);
    const p = out.projects[0];
    expect(p.stepOrder).toEqual([
      'temperature', 'flow-pass1', 'flow-pass2', 'pressure-advance',
      'flow-verify', 'retraction', 'max-volumetric-speed', 'shrinkage', 'final-verification'
    ]);
    expect(p.steps['flow-verify'].status).toBe('not-started');
    expect(p.steps.shrinkage.status).toBe('not-started');
    // Existing progress untouched.
    expect(p.steps.temperature.status).toBe('completed');
    // The optional dual-nozzle step is never injected by migration.
    expect(p.stepOrder).not.toContain('ooze-control');
  });
});

describe('dataUrl helpers', () => {
  it('decodes data URLs to blobs with the right mime', () => {
    const blob = dataUrlToBlob('data:image/png;base64,' + Buffer.from('abc').toString('base64'));
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(3);
  });
});
