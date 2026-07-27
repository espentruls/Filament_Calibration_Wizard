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

import { clearAppLocalStorage, eraseAllLocalData, safetyMarginFromHeadroomPercent } from '../src/ui/settings';
import {
  saveSettings, saveDraft, loadDraft, savePrinter, listPrinters, DEFAULT_SETTINGS
} from '../src/storage/store';
import { saveExperimentalFeatures, loadExperimentalFeatures } from '../src/slicerIntegration/featureFlags';
import { idb } from '../src/storage/db';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

  // The stores are cleared one transaction at a time — IndexedDB has no
  // cross-store clear — so a failure on the first one used to abandon the rest.
  // The user asked for EVERYTHING to go; leaving almost all of it behind, with
  // an error that does not say what survived, is the worst of both.
  it('erases everything it can and names what it could not, instead of stopping at the first failure', async () => {
    await savePrinter({
      id: 'p1', name: 'Bench', manufacturer: 'T', nozzleDiameter: 0.4,
      maxNozzleTemp: 300, maxBedTemp: 110, maxVolumetricFlow: 20,
      extruderType: 'direct', retractionRange: { start: 0, end: 2 },
      notes: '', createdAt: '', updatedAt: ''
    });
    await idb.put('projects', { id: 'proj-1', name: 'A project' });
    saveSettings({ ...DEFAULT_SETTINGS, theme: 'dark' });

    // Make only the `projects` clear fail, the way a real one does: the
    // request succeeds and the transaction then aborts.
    const origClear = IDBObjectStore.prototype.clear;
    IDBObjectStore.prototype.clear = function (this: IDBObjectStore) {
      const req = (origClear as () => IDBRequest).apply(this);
      if (this.name === 'projects') {
        const t = this.transaction;
        req.addEventListener('success', () => { t.abort(); });
      }
      return req;
    } as typeof IDBObjectStore.prototype.clear;

    let thrown: unknown;
    try {
      await eraseAllLocalData();
    } catch (err) {
      thrown = err;
    } finally {
      IDBObjectStore.prototype.clear = origClear;
    }

    expect(thrown, 'a partial erase must not report success').toBeTruthy();
    expect(String(thrown)).toMatch(/projects/);
    // Everything that COULD be erased was.
    expect(await listPrinters()).toHaveLength(0);
    expect(await idb.getAll('photos')).toHaveLength(0);
    expect(localStorage.getItem('perfectfit.settings')).toBeNull();
    // …and the one that failed is still there, which is what the error says.
    expect(await idb.getAll('projects')).toHaveLength(1);
  });

  // Drafts are per project AND per step. If they were stored one key per
  // draft, a prefix walk would still catch them — but only if every one of
  // those keys carries the prefix. Erase must leave nothing behind whatever
  // the shape is, so exercise a realistic spread rather than a single draft.
  it('leaves no draft behind, however many projects and steps have one', () => {
    const drafts = ['a', 'b', 'c', 'd'].flatMap(p =>
      ['temperature', 'flow-pass1', 'retraction', 'ooze-control'].map(s => `${p}:${s}`));
    for (const k of drafts) saveDraft(k, { value: k });
    for (const k of drafts) expect(loadDraft(k), k).not.toBeNull();

    clearAppLocalStorage();

    for (const k of drafts) expect(loadDraft(k), k).toBeNull();
    expect(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))).toEqual([]);
  });

  // Every module that persists something writes through a named key constant.
  // The erase is a PREFIX walk, so a key added later without the prefix would
  // survive an erase silently — and the user was told everything was deleted.
  // This reads the source rather than the runtime so it fails the moment such
  // a key is introduced, not once someone happens to exercise that module.
  it('every localStorage key in the source carries the prefix the erase walks', () => {
    const srcRoot = join(__dirname, '..', 'src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.ts')) files.push(p);
      }
    };
    walk(srcRoot);
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    let keysChecked = 0;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      // Direct literals: localStorage.setItem('some.key', …)
      for (const m of text.matchAll(/localStorage\.(?:setItem|getItem|removeItem)\(\s*(['"`])([^'"`]+)\1/g)) {
        keysChecked++;
        if (!m[2].startsWith('perfectfit.')) offenders.push(`${file}: ${m[2]}`);
      }
      // Indirect: localStorage.setItem(SOME_KEY, …) with `const SOME_KEY = '…'`.
      for (const m of text.matchAll(/localStorage\.(?:setItem|getItem|removeItem)\(\s*([A-Z][A-Z0-9_]*)\b/g)) {
        const decl = new RegExp(`\\b${m[1]}\\s*=\\s*(['"\`])([^'"\`]+)\\1`).exec(text);
        expect(decl, `${file}: could not resolve ${m[1]}`).not.toBeNull();
        keysChecked++;
        if (!decl![2].startsWith('perfectfit.')) offenders.push(`${file}: ${m[1]} = ${decl![2]}`);
      }
    }
    // The known keys are settings, autosave, experimentalFeatures and the
    // preset-backup first-run marker — reached through several accessors.
    expect(keysChecked).toBeGreaterThanOrEqual(4);
    expect(offenders).toEqual([]);
  });

  // The three writers, driven through their real save paths, then erased.
  it('removes what every persisting module actually wrote', () => {
    saveSettings({ ...DEFAULT_SETTINGS, theme: 'dark' });
    saveDraft('proj:temperature', { some: 'draft' });
    saveExperimentalFeatures({ ...loadExperimentalFeatures(), slicerProfileGeneration: true });
    localStorage.setItem('perfectfit.presetBackupFirstRunPrompt', '{"at":"now"}');
    localStorage.setItem('someone-else', 'keep');

    clearAppLocalStorage();

    const left = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    expect(left).toEqual(['someone-else']);
  });
});

/**
 * `mvsSafetyMargin` scales the max volumetric flow the app recommends, and the
 * Settings screen is the only writer of it. `min`/`max` on an <input
 * type="number"> do NOT clamp what a user types — they only mark the field
 * invalid — so the box has to be read defensively or the app can persist a
 * value its own import path would throw out.
 */
describe('the max-flow safety margin the Settings screen writes', () => {
  const ACCEPTED = (v: number) => Number.isFinite(v) && v >= 0.5 && v <= 1;

  it('maps the documented headroom percentages to the stored factor', () => {
    expect(safetyMarginFromHeadroomPercent('15')).toBe(0.85);
    expect(safetyMarginFromHeadroomPercent('0')).toBe(1);
    expect(safetyMarginFromHeadroomPercent('50')).toBe(0.5);
  });

  it('never persists a factor the import path would reject', () => {
    // Everything a number input will hand back: typed past the max, negative,
    // blank, and non-numeric text (Firefox returns '' for the last).
    for (const raw of ['500', '51', '-10', 'abc', '', ' ', '1e9', 'NaN', 'Infinity']) {
      const v = safetyMarginFromHeadroomPercent(raw);
      expect(ACCEPTED(v), `headroom "${raw}" stored ${v}`).toBe(true);
    }
  });

  it('a value typed past the maximum cannot inflate the recommended flow', () => {
    // 500 % "headroom" would otherwise store -4 and recommend a NEGATIVE limit;
    // 51 % would quietly slip past the range the backup importer enforces.
    expect(safetyMarginFromHeadroomPercent('500')).toBe(0.5);
    expect(safetyMarginFromHeadroomPercent('51')).toBe(0.5);
    expect(safetyMarginFromHeadroomPercent('-10')).toBe(1);
  });

  it('an emptied box keeps the current setting rather than silently meaning 0% headroom', () => {
    expect(safetyMarginFromHeadroomPercent('')).toBe(DEFAULT_SETTINGS.mvsSafetyMargin);
    expect(safetyMarginFromHeadroomPercent('abc')).toBe(DEFAULT_SETTINGS.mvsSafetyMargin);
  });
});
