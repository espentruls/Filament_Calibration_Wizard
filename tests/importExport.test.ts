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

import { exportProject, importBackup, migrate, dataUrlToBlob } from '../src/export/backup';
import { createProject, savePrinter, listProjects, listPrinters, saveProject, uid, SCHEMA_VERSION } from '../src/storage/store';
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
    expect(out.schemaVersion).toBe(3);
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
    expect(projects[0].steps).toEqual({});
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
});

describe('dataUrl helpers', () => {
  it('decodes data URLs to blobs with the right mime', () => {
    const blob = dataUrlToBlob('data:image/png;base64,' + Buffer.from('abc').toString('base64'));
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(3);
  });
});
