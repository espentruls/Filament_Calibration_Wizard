/**
 * Minimal IndexedDB wrapper. Stores: projects, printers, photos.
 * Settings live in localStorage (small, synchronous needs).
 */

/**
 * NOT branding — the database's identity. The app was renamed from
 * "Trim X2D" to "Trim" in 3.0.0 and this name deliberately did not change:
 * IndexedDB opens databases BY NAME, so renaming it would open a new, empty
 * database and every existing project, printer and photo would silently vanish.
 * It stays as it is for as long as anyone might still have 2.x data.
 */
const DB_NAME = 'perfectfit-db';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('printers')) db.createObjectStore('printers', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('photos')) {
        const photos = db.createObjectStore('photos', { keyPath: 'id' });
        photos.createIndex('byProject', 'projectId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
  });
  return dbPromise;
}

/**
 * Run one request in its own transaction.
 *
 * The promise settles on the TRANSACTION, not on the request: a request can
 * succeed and the transaction still abort at commit time (quota exceeded,
 * storage eviction, the tab being evicted mid-commit), which would silently
 * lose the write while the caller believed it was saved. Resolving on
 * `complete` means a resolved promise always corresponds to durable data, and
 * a failed save always surfaces as a rejection.
 */
function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(db => new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result: T;
    let failure: Error | null = null;
    const req = fn(t.objectStore(store));
    req.onsuccess = () => { result = req.result as T; };
    req.onerror = () => { failure = req.error ?? new Error(`IndexedDB error on ${store}`); };
    t.oncomplete = () => resolve(result);
    t.onabort = () => reject(failure ?? t.error ?? new Error(`IndexedDB transaction aborted on ${store}`));
    t.onerror = () => reject(failure ?? t.error ?? new Error(`IndexedDB transaction failed on ${store}`));
  }));
}

/**
 * Write a batch of records across several stores in ONE transaction.
 *
 * IndexedDB rolls the whole transaction back if any request fails or the
 * commit aborts, so this is genuinely all-or-nothing: a rejected promise means
 * NOTHING was written, and the caller can report a clean failure and let the
 * user retry without duplicating anything.
 */
export function putAllAtomic(batch: { store: string; value: object }[]): Promise<void> {
  if (!batch.length) return Promise.resolve();
  const stores = [...new Set(batch.map(b => b.store))];
  return openDb().then(db => new Promise<void>((resolve, reject) => {
    const t = db.transaction(stores, 'readwrite');
    let failure: Error | null = null;
    t.oncomplete = () => resolve();
    t.onabort = () => reject(failure ?? t.error ?? new Error('IndexedDB batch aborted'));
    t.onerror = () => reject(failure ?? t.error ?? new Error('IndexedDB batch failed'));
    for (const item of batch) {
      // An un-handled request error aborts the transaction on its own, which is
      // exactly what we want; the handler only captures a better message.
      const req = t.objectStore(item.store).put(item.value);
      req.onerror = () => { failure = req.error ?? new Error(`IndexedDB error on ${item.store}`); };
    }
  }));
}

export const idb = {
  get: <T>(store: string, key: string) => tx<T | undefined>(store, 'readonly', s => s.get(key)),
  getAll: <T>(store: string) => tx<T[]>(store, 'readonly', s => s.getAll()),
  put: <T extends object>(store: string, value: T) => tx<IDBValidKey>(store, 'readwrite', s => s.put(value)),
  delete: (store: string, key: string) => tx<undefined>(store, 'readwrite', s => s.delete(key)),
  clear: (store: string) => tx<undefined>(store, 'readwrite', s => s.clear()),
  getAllByIndex: <T>(store: string, index: string, key: string) =>
    openDb().then(db => new Promise<T[]>((resolve, reject) => {
      const t = db.transaction(store, 'readonly');
      let result: T[] = [];
      let failure: Error | null = null;
      const req = t.objectStore(store).index(index).getAll(key);
      req.onsuccess = () => { result = req.result as T[]; };
      req.onerror = () => { failure = req.error ?? new Error('IndexedDB index error'); };
      t.oncomplete = () => resolve(result);
      t.onabort = () => reject(failure ?? t.error ?? new Error('IndexedDB index read aborted'));
      t.onerror = () => reject(failure ?? t.error ?? new Error('IndexedDB index read failed'));
    }))
};
