import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  get length() { return mem.size; },
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear()
});

// Only `toast` is replaced — everything else in the DOM helpers is the real
// thing, so this test still fails if the module stops loading.
const toastSpy = vi.fn();
vi.mock('../src/ui/dom', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/ui/dom')>()),
  toast: (...a: unknown[]) => toastSpy(...a)
}));

import { completeStep } from '../src/ui/wizard';
import { createProject, savePrinter, saveProject, getProject, uid } from '../src/storage/store';
import { idb } from '../src/storage/db';
import type { PrinterProfile } from '../src/types';

/** Abort the nth put's transaction — a commit-time save failure. */
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

function makePrinter(): PrinterProfile {
  return {
    id: uid(), name: 'Bench Printer', manufacturer: 'Test Co', nozzleDiameter: 0.4,
    maxNozzleTemp: 300, maxBedTemp: 110, maxVolumetricFlow: 20,
    extruderType: 'direct', retractionRange: { start: 0, end: 2 },
    notes: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
}

async function newProject() {
  const printer = makePrinter();
  await savePrinter(printer);
  const project = createProject({
    filament: {
      manufacturer: 'TestBrand', productLine: 'Line', material: 'PLA',
      color: 'Red', diameter: 1.75, startingProfile: 'Generic PLA'
    },
    printerProfileId: printer.id, nozzleType: 'brass',
    slicer: { slicer: 'orca', version: '2.4.x' }, notes: '', mode: 'coach'
  });
  await saveProject(project);
  return project;
}

function stepArgs(
  project: Awaited<ReturnType<typeof newProject>>,
  pendingPhotos: { id?: string; name: string; type: string; blob: Blob }[] = []
) {
  return {
    project,
    stepId: 'temperature' as const,
    state: { stage: 'done' as const, method: 'tower', prereqs: [] as string[], settings: {}, result: {} },
    out: {
      computed: { best: 210 }, calcs: [], warnings: [],
      enterInSlicer: [{ label: 'Nozzle temperature', value: '210 °C' }],
      finalsPatch: { nozzleTemp: 210 }
    },
    confidence: 'high' as const,
    retest: false,
    notes: 'clear winner',
    pendingPhotos,
    draftKey: `${project.id}:temperature`,
    label: 'Temperature'
  };
}

beforeEach(async () => {
  await idb.clear('projects');
  await idb.clear('printers');
  await idb.clear('photos');
  mem.clear();
  toastSpy.mockClear();
});

describe('saving a completed calibration step', () => {
  it('reports the failure instead of letting the user believe it was recorded', async () => {
    const project = await newProject();
    const restore = failNthPut(1);
    const saved = await completeStep(stepArgs(project));
    restore();

    expect(saved).toBe(false);
    expect(toastSpy.mock.calls.map(c => c[1])).toEqual(['error']);
    expect(String(toastSpy.mock.calls[0][0])).toMatch(/could not save/i);

    const reloaded = await getProject(project.id);
    expect(reloaded?.steps.temperature.status).toBe('not-started');
  });

  it('leaves the on-screen project exactly as it was after a failed save', async () => {
    const project = await newProject();
    const before = JSON.parse(JSON.stringify(project));

    const restore = failNthPut(1);
    await completeStep(stepArgs(project));
    restore();

    expect(project).toEqual(before);
  });

  it('records the result exactly once when the user retries after a failure', async () => {
    const project = await newProject();
    const photos = [{ name: 'a.png', type: 'image/png', blob: new Blob(['a']) }];

    const restore = failNthPut(2); // the photo lands, the project save aborts
    expect(await completeStep(stepArgs(project, photos))).toBe(false);
    restore();

    // The user presses "Save & continue" again.
    expect(await completeStep(stepArgs(project, photos))).toBe(true);

    const reloaded = await getProject(project.id);
    expect(reloaded?.steps.temperature.status).toBe('completed');
    expect(reloaded?.steps.temperature.history).toHaveLength(0);
    expect(reloaded?.timeline.filter(t => t.kind === 'completed')).toHaveLength(1);
    expect(reloaded?.steps.temperature.current?.photoIds).toHaveLength(1);
    expect(await idb.getAll('photos')).toHaveLength(1);
  });

  it('confirms the save on the happy path and keeps prior attempts in history', async () => {
    const project = await newProject();
    expect(await completeStep(stepArgs(project))).toBe(true);
    expect(await completeStep(stepArgs(project))).toBe(true);

    expect(toastSpy.mock.calls.map(c => c[1])).toEqual(['success', 'success']);
    const reloaded = await getProject(project.id);
    expect(reloaded?.steps.temperature.status).toBe('completed');
    expect(reloaded?.steps.temperature.history).toHaveLength(1);
    expect(reloaded?.finals.nozzleTemp).toBe(210);
  });
});
