import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';

import { idb, putAllAtomic } from '../src/storage/db';

/**
 * Abort a transaction at the moment its put request succeeds — what a
 * commit-time failure (quota exceeded, storage eviction) looks like from the
 * outside. The request reports success; the data never lands.
 */
function abortOnNthPut(n: number): () => void {
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
});

describe('a save only reports success once the transaction commits', () => {
  it('rejects when the transaction aborts after the request succeeded', async () => {
    const restore = abortOnNthPut(1);
    let resolved = false, rejected = false;
    try {
      await idb.put('printers', { id: 'p1', name: 'Bench' });
      resolved = true;
    } catch {
      rejected = true;
    } finally {
      restore();
    }

    // The write is definitively not there...
    expect(await idb.get('printers', 'p1')).toBeUndefined();
    // ...so it must not have been reported as saved.
    expect({ resolved, rejected }).toEqual({ resolved: false, rejected: true });
  });

  it('still resolves with the request result on a normal commit', async () => {
    await idb.put('printers', { id: 'p2', name: 'Ok' });
    expect(await idb.get('printers', 'p2')).toEqual({ id: 'p2', name: 'Ok' });
    expect(await idb.getAll('printers')).toHaveLength(1);
  });
});

describe('putAllAtomic', () => {
  it('writes every record across stores in one transaction', async () => {
    await putAllAtomic([
      { store: 'printers', value: { id: 'pr1', name: 'A' } },
      { store: 'projects', value: { id: 'pj1' } },
      { store: 'projects', value: { id: 'pj2' } }
    ]);
    expect(await idb.getAll('printers')).toHaveLength(1);
    expect(await idb.getAll('projects')).toHaveLength(2);
  });

  it('writes NOTHING when any record in the batch fails', async () => {
    const restore = abortOnNthPut(3);
    await expect(putAllAtomic([
      { store: 'printers', value: { id: 'pr1', name: 'A' } },
      { store: 'projects', value: { id: 'pj1' } },
      { store: 'projects', value: { id: 'pj2' } }
    ])).rejects.toBeTruthy();
    restore();

    expect(await idb.getAll('printers')).toHaveLength(0);
    expect(await idb.getAll('projects')).toHaveLength(0);
  });

  it('is a no-op for an empty batch', async () => {
    await expect(putAllAtomic([])).resolves.toBeUndefined();
  });
});
