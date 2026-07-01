const DB_NAME = "FitTrackDB";
const DB_VERSION = 1;

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // 1. plan – stores the editable weekly routine configuration as data
      if (!db.objectStoreNames.contains("plan")) {
        db.createObjectStore("plan", { keyPath: "id" });
      }

      // 2. logs – stores logged sets; key format: "YYYY-MM-DD_exerciseId_setIndex"
      if (!db.objectStoreNames.contains("logs")) {
        const logsStore = db.createObjectStore("logs", { keyPath: "id" });
        logsStore.createIndex("by_date", "date", { unique: false });
        logsStore.createIndex("by_exercise", "exerciseId", { unique: false });
      }

      // 3. bodyweight – date-stamped kg entries; keyed by date string "YYYY-MM-DD"
      if (!db.objectStoreNames.contains("bodyweight")) {
        db.createObjectStore("bodyweight", { keyPath: "date" });
      }

      // 4. meta – streak metadata, app settings, and state snapshots; keyed by string key
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
    };

    request.onsuccess = (event) => {
      _db = event.target.result;

      _db.onversionchange = () => {
        _db.close();
        _db = null;
      };

      resolve(_db);
    };

    request.onerror = (event) => {
      console.error("[FitTrackDB] Failed to open database:", event.target.error);
      reject(event.target.error);
    };
  });
}

// Runs a single transaction operation and resolves with the result
function runTransaction(storeName, mode, operation) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);

        const request = operation(store);

        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => {
          console.error(
            `[FitTrackDB] Transaction error on store "${storeName}":`,
            event.target.error
          );
          reject(event.target.error);
        };
      })
  );
}

// --- Public API ---

/**
 * Retrieve a single record by key.
 * @param {string} store - Object store name
 * @param {string|number} key - The record key
 * @returns {Promise<any>} The record value, or undefined if not found
 */
async function get(store, key) {
  try {
    return await runTransaction(store, "readonly", (s) => s.get(key));
  } catch (err) {
    console.error(`[FitTrackDB] get(${store}, ${key}) failed:`, err);
    return undefined;
  }
}

/**
 * Insert or update a record (upsert).
 * @param {string} store - Object store name
 * @param {object} value - The record to store (must include keyPath field)
 * @returns {Promise<IDBValidKey>} The key of the stored record
 */
async function put(store, value) {
  try {
    return await runTransaction(store, "readwrite", (s) => s.put(value));
  } catch (err) {
    console.error(`[FitTrackDB] put(${store}) failed:`, err);
    throw err;
  }
}

/**
 * Delete a record by key.
 * @param {string} store - Object store name
 * @param {string|number} key - The record key to delete
 * @returns {Promise<undefined>}
 */
async function del(store, key) {
  try {
    return await runTransaction(store, "readwrite", (s) => s.delete(key));
  } catch (err) {
    console.error(`[FitTrackDB] delete(${store}, ${key}) failed:`, err);
    throw err;
  }
}

/**
 * Retrieve all records from a store.
 * @param {string} store - Object store name
 * @returns {Promise<any[]>} Array of all records
 */
async function getAll(store) {
  try {
    return await runTransaction(store, "readonly", (s) => s.getAll());
  } catch (err) {
    console.error(`[FitTrackDB] getAll(${store}) failed:`, err);
    return [];
  }
}

/**
 * Delete all records from a store (non-destructive to the store itself).
 * @param {string} store - Object store name
 * @returns {Promise<undefined>}
 */
async function clear(store) {
  try {
    return await runTransaction(store, "readwrite", (s) => s.clear());
  } catch (err) {
    console.error(`[FitTrackDB] clear(${store}) failed:`, err);
    throw err;
  }
}

export { get, put, del, getAll, clear };
