import type { StateStorage } from "zustand/middleware";

const DATABASE = "octopus-editor";
let opening: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  if (!opening)
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("drafts");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        opening = undefined;
        reject(request.error);
      };
    });
  return opening;
}

async function access<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  if (typeof indexedDB === "undefined")
    throw new Error("Draft recovery is unavailable in this browser.");
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("drafts", mode);
    const request = operation(tx.objectStore("drafts"));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(tx.error ?? new Error("Draft storage was interrupted."));
  });
}

export const draftStorage: StateStorage = {
  async getItem(name) {
    const value: unknown = await access("readonly", (store) => store.get(name));
    return typeof value === "string" ? value : null;
  },
  async setItem(name, value) {
    await access("readwrite", (store) => store.put(value, name));
  },
  async removeItem(name) {
    await access("readwrite", (store) => store.delete(name));
  },
};
