import { useEffect, useState } from "react";
import { listPendingSales } from "./offlineQueue";
const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
export default function App() {
  const [pending, setPending] = useState<number | null>(null);
  const [api, setApi] = useState("Not checked");
  const [queueError, setQueueError] = useState("");
  useEffect(() => { void listPendingSales().then(rows => setPending(rows.length)).catch(error => setQueueError(error instanceof Error ? error.message : "Local queue unavailable")); }, []);
  async function checkApi() {
    setApi("Checking…");
    try {
      const response = await fetch(API_URL + "/health");
      if (!response.ok) throw new Error("API returned " + response.status);
      const data = await response.json() as { status?: string };
      setApi(data.status === "ok" ? "Connected" : "Unexpected response");
    } catch { setApi("Offline / unavailable"); }
  }
  return <main className="shell"><header className="topbar"><div className="brand"><span className="mark">U</span> USMS <span className="tag">POINT OF SALE</span></div><span className="tag">STORE TERMINAL</span></header><section className="hero"><span className="eyebrow">BUILT FOR THE COUNTER</span><h1>Billing keeps moving, even when the internet doesn't.</h1><p>USMS POS is designed around fast counter operations, a durable local queue, and safe server reconciliation when connectivity returns.</p><button className="button" onClick={checkApi}>Check shared API ↗</button></section><section className="workspace"><div className="heading"><div><span className="eyebrow">TERMINAL STATUS</span><h2>Local device readiness</h2></div><span className="muted">Offline-first foundation</span></div><div className="grid"><div className="card"><span>Queued sales</span><strong>{pending === null ? "—" : pending}</strong><small>Stored locally in IndexedDB</small></div><div className="card"><span>API connection</span><strong>{api}</strong><small>{API_URL}</small></div><div className="card"><span>Terminal pairing</span><strong>Not paired</strong><small>Tenant and branch assignment pending</small></div></div><div className="notice">{queueError ? "Local queue: " + queueError : "Local queue storage is initialized. Sale creation, sync, stock conflict handling, payments, and final invoice numbering are not enabled yet."}</div></section><footer><span>USMS · Unified Store Management System</span><span>POS foundation · 0.1.0</span></footer></main>;
}
