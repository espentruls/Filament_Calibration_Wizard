import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';

// localStorage shim for Node — with `length`/`key()`, which is how the erase
// walks the origin's keys.
const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  get length() { return mem.size; },
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear()
});

import { clearAppLocalStorage, eraseAllLocalData } from '../src/ui/settings';
import { saveSettings, saveDraft, savePrinter, listPrinters, DEFAULT_SETTINGS } from '../src/storage/store';
import { idb } from '../src/storage/db';

beforeEach(async () => {
  await idb.clear('projects');
  await idb.clear('printers');
  await idb.clear('photos');
  mem.clear();
});

describe('erasing all local data', () => {
  it('removes this app\'s own localStorage keys and nothing else', () => {
    saveSettings({ ...DEFAULT_SETTINGS, theme: 'dark' });
    saveDraft('proj:temperature', { some: 'draft' });
    localStorage.setItem('perfectfit.experimentalFeatures', '{}');
    // The browser build can share an origin with anything else.
    localStorage.setItem('other-app.session', 'someone-elses-data');
    localStorage.setItem('analytics_id', '42');

    const removed = clearAppLocalStorage();

    expect(removed).toBe(3);
    expect(localStorage.getItem('perfectfit.settings')).toBeNull();
    expect(localStorage.getItem('perfectfit.autosave')).toBeNull();
    expect(localStorage.getItem('perfectfit.experimentalFeatures')).toBeNull();
    expect(localStorage.getItem('other-app.session')).toBe('someone-elses-data');
    expect(localStorage.getItem('analytics_id')).toBe('42');
  });

  it('clears the app\'s IndexedDB stores while leaving foreign keys alone', async () => {
    await savePrinter({
      id: 'p1', name: 'Bench', manufacturer: 'T', nozzleDiameter: 0.4,
      maxNozzleTemp: 300, maxBedTemp: 110, maxVolumetricFlow: 20,
      extruderType: 'direct', retractionRange: { start: 0, end: 2 },
      notes: '', createdAt: '', updatedAt: ''
    });
    saveSettings({ ...DEFAULT_SETTINGS });
    localStorage.setItem('unrelated', 'keep me');

    await eraseAllLocalData();

    expect(await listPrinters()).toHaveLength(0);
    expect(localStorage.getItem('perfectfit.settings')).toBeNull();
    expect(localStorage.getItem('unrelated')).toBe('keep me');
  });
});
