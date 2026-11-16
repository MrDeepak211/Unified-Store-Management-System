import { EventEmitter } from "node:events";
import { Client, type PoolClient } from "pg";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireTenantActor } from "../auth.js";
import { getPool, withTenantTransaction } from "../db.js";

type InventoryEvent = { tenantId: string; branchId: string; productIds: string[]; changedAt: string };
const emitter = new EventEmitter();
emitter.setMaxListeners(0);
let listener: Client | undefined;

export async function startInventoryEventListener() {
  if (listener) return;
  if (!process.env.DATABASE_URL) return;
  listener = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
  });
  await listener.connect();
  await listener.query("LISTEN usms_inventory");
  listener.on("notification", (message) => {
    if (message.channel !== "usms_inventory" || !message.payload) return;
    try {
      const event = JSON.parse(message.payload) as InventoryEvent;
      emitter.emit("inventory", event);
    } catch { /* Ignore malformed internal notifications. */ }
  });
  listener.on("error", (error) => console.error("USMS inventory event listener error:", error));
}

export async function stopInventoryEventListener() {
  if (!listener) return;
  await listener.end();
  listener = undefined;
}

export async function notifyInventoryChanged(
  client: PoolClient,
  event: Omit<InventoryEvent, "changedAt">,
) {
  await client.query("SELECT pg_notify('usms_inventory', $1)", [
    JSON.stringify({ ...event, changedAt: new Date().toISOString() }),
  ]);
}

function streamInventoryEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  tenantId: string,
) {
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write("retry: 3000\n\n");
  const send = (event: InventoryEvent) => {
    if (event.tenantId === tenantId) response.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 20_000);
  emitter.on("inventory", send);
  response.on("close", () => {
    clearInterval(heartbeat);
    emitter.off("inventory", send);
  });
}

export async function registerInventoryEventRoutes(app: FastifyInstance) {
  app.get("/api/v1/business/events", async (request, reply) => {
    const actor = await requireTenantActor(request);
    streamInventoryEvents(request, reply, actor.tenantId);
  });

  app.get<{ Params: { slug: string } }>("/api/v1/storefront/:slug/events", async (request, reply) => {
    const tenant = await getPool().query(
      "SELECT id FROM tenants WHERE slug = $1 AND status = 'active' LIMIT 1",
      [request.params.slug.toLowerCase()],
    );
    const tenantId = tenant.rows[0]?.id as string | undefined;
    if (!tenantId) return reply.code(404).send({ error: { code: "STORE_NOT_FOUND", message: "Store not found." } });
    const published = await withTenantTransaction(tenantId, async (client) => {
      const result = await client.query("SELECT 1 FROM storefront_settings WHERE tenant_id = $1 AND is_published = true", [tenantId]);
      return Boolean(result.rowCount);
    });
    if (!published) return reply.code(404).send({ error: { code: "STORE_NOT_FOUND", message: "Store not found." } });
    streamInventoryEvents(request, reply, tenantId);
  });
}
