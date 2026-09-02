// localStorage is the fast, synchronous primary store (unchanged key/shape
// from before this module existed). IndexedDB is only ever a fallback: it's
// written to whenever localStorage's write failed or the payload is large
// enough that it might be close to the quota, and it's only ever READ during
// startup, and only when localStorage came back empty -- keeping the common
// case (localStorage already has the mission) fully synchronous-feeling.
const DB_NAME = "tf2-popfile-generator";
const DB_STORE = "state";
const SIZE_WARN_THRESHOLD = 2 * 1024 * 1024; // 2MB -- comfortably under typical 5-10MB quotas

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const req = tx.objectStore(DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    return undefined;
  }
}

async function idbSet(key, value) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch (err) {
    return false;
  }
}

// Stamped with savedAt so a caller could compare ages if it ever needed to;
// today only the size/failure fallback path actually reaches IndexedDB.
export function saveToStorage(storageKey, data) {
  const payload = { ...data, savedAt: Date.now() };
  const json = JSON.stringify(payload);

  let localOk = false;
  try {
    localStorage.setItem(storageKey, json);
    localOk = true;
  } catch (err) {
    localOk = false;
  }

  if (!localOk || json.length > SIZE_WARN_THRESHOLD) {
    idbSet(storageKey, payload);
  }

  return localOk;
}

// Synchronous localStorage read, exactly like before this module existed --
// callers use this for the immediate, first-paint state.
export function loadFromLocalStorage(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

// Only ever called when loadFromLocalStorage came back empty -- e.g. a
// previous session's save was too large for localStorage and only made it
// into IndexedDB. Async by nature; callers should render with defaults first
// and apply this if/when it resolves.
export async function loadFromIndexedDbFallback(storageKey) {
  const idb = await idbGet(storageKey);
  return idb && typeof idb === "object" ? idb : null;
}
