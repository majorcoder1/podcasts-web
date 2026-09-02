// IndexedDB layer. Mirrors the Room schema: podcasts, episodes, queue, settings.

const NAME = 'podcasts';
const VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains('podcasts')) {
        const podcasts = db.createObjectStore('podcasts', { keyPath: 'feedUrl' });
        podcasts.createIndex('isSubscribed', 'isSubscribed');
        podcasts.createIndex('subscribedAt', 'subscribedAt');
      }

      if (!db.objectStoreNames.contains('episodes')) {
        const episodes = db.createObjectStore('episodes', { keyPath: 'guid' });
        episodes.createIndex('feedUrl', 'feedUrl');
        episodes.createIndex('publishedAt', 'publishedAt');
        episodes.createIndex('downloadState', 'downloadState');
        episodes.createIndex('lastPlayedAt', 'lastPlayedAt');
      }

      if (!db.objectStoreNames.contains('queue')) {
        db.createObjectStore('queue', { keyPath: 'guid' });
      }

      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings');
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function await_(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function get(store, key) {
  const db = await open();
  return await_(db.transaction(store).objectStore(store).get(key));
}

export async function getAll(store, query, count) {
  const db = await open();
  return await_(db.transaction(store).objectStore(store).getAll(query, count));
}

export async function getAllByIndex(store, index, query, count) {
  const db = await open();
  return await_(db.transaction(store).objectStore(store).index(index).getAll(query, count));
}

export async function put(store, value, key) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  const request = key === undefined
    ? tx.objectStore(store).put(value)
    : tx.objectStore(store).put(value, key);
  const result = await await_(request);
  await done(tx);
  return result;
}

export async function putMany(store, values) {
  if (!values.length) return;
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  const objectStore = tx.objectStore(store);
  values.forEach((value) => objectStore.put(value));
  await done(tx);
}

export async function remove(store, key) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await done(tx);
}

export async function clear(store) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  await done(tx);
}

/**
 * Read-modify-write inside one transaction, so two callers cannot clobber each
 * other's fields on the same record.
 */
export async function update(store, key, mutate) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  const objectStore = tx.objectStore(store);
  const existing = await await_(objectStore.get(key));
  if (!existing) {
    await done(tx);
    return null;
  }
  const next = mutate({ ...existing });
  if (next) objectStore.put(next);
  await done(tx);
  return next;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
