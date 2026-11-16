export interface PendingSaleEvent { id: string; createdAt: string; payload: unknown; status: "pending" }
const DB_NAME = "usms-pos";
const STORE_NAME = "pending-sales";

function openQueueDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB is unavailable."));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "id" }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open POS queue."));
  });
}

/** Local durable queue only. The server must still validate and idempotently reconcile every event. */
export async function enqueuePendingSale(payload: unknown): Promise<PendingSaleEvent> {
  const event: PendingSaleEvent = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), payload, status: "pending" };
  const db = await openQueueDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).add(event);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not enqueue sale."));
    tx.onabort = () => reject(tx.error ?? new Error("Queue transaction aborted."));
  });
  db.close();
  return event;
}

export async function listPendingSales(): Promise<PendingSaleEvent[]> {
  const db = await openQueueDb();
  const rows = await new Promise<PendingSaleEvent[]>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result as PendingSaleEvent[]);
    request.onerror = () => reject(request.error ?? new Error("Could not read POS queue."));
  });
  db.close();
  return rows;
}
