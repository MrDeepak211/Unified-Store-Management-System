import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireTenantActor } from "../auth.js";
import { withTenantTransaction } from "../db.js";
import { notifyInventoryChanged } from "./inventoryEvents.js";

type ReturnBody = { reason?: string; restock?: boolean; items?: Array<{ productId: string; quantity: number }> };

function amountToCents(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error("Invalid stored amount.");
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
}
function centsToAmount(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

export async function registerReturnsAndReportsRoutes(app: FastifyInstance) {
  app.post<{ Params: { saleId: string }; Body: ReturnBody }>("/api/v1/business/sales/:saleId/returns", async (request, reply) => {
    const actor = await requireTenantActor(request, ["owner", "admin", "manager"]);
    const key = request.headers["idempotency-key"];
    const body = request.body ?? {};
    if (typeof key !== "string" || key.length < 8 || key.length > 128) {
      return reply.code(400).send({ error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "A return requires an Idempotency-Key header." } });
    }
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "At least one return item is required." } });
    }
    const ids = body.items.map((item) => item.productId);
    if (new Set(ids).size !== ids.length || body.items.some((item) => !item.productId || !Number.isSafeInteger(item.quantity) || item.quantity < 1)) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Return items must have unique products and positive whole-number quantities." } });
    }
    const result = await withTenantTransaction(actor.tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [actor.tenantId, key]);
      const prior = await client.query("SELECT id, return_number AS \"returnNumber\", total::text FROM sales_returns WHERE tenant_id = $1 AND idempotency_key = $2", [actor.tenantId, key]);
      if (prior.rowCount) return { returnRecord: prior.rows[0], replayed: true };
      const sale = await client.query(
        "SELECT id, branch_id, status FROM sales_orders WHERE tenant_id = $1 AND id = $2 AND status IN ('confirmed','fulfilled')",
        [actor.tenantId, request.params.saleId],
      );
      if (!sale.rowCount) throw Object.assign(new Error("Sale not found or not eligible for return."), { statusCode: 404 });
      const restock = body.restock !== false;
      const returnId = randomUUID();
      const returnNumber = `RET-${randomUUID().slice(0, 8).toUpperCase()}`;
      await client.query(
        `INSERT INTO sales_returns (id, tenant_id, branch_id, sales_order_id, return_number, status, reason, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [returnId, actor.tenantId, sale.rows[0].branch_id, sale.rows[0].id, returnNumber, restock ? "restocked" : "inspection_pending", body.reason?.trim() || null, key],
      );
      let total = 0n;
      for (const item of body.items!) {
        const sold = await client.query(
          `SELECT id, quantity, unit_price::text
           FROM sales_order_items
           WHERE tenant_id = $1 AND order_id = $2 AND product_id = $3
           FOR UPDATE`,
          [actor.tenantId, sale.rows[0].id, item.productId],
        );
        if (!sold.rowCount) throw Object.assign(new Error("This product was not part of the original sale."), { statusCode: 409 });
        const already = await client.query(
          `SELECT COALESCE(SUM(ri.quantity), 0)::int AS quantity
           FROM sales_return_items ri
           JOIN sales_returns r ON r.tenant_id = ri.tenant_id AND r.id = ri.return_id
           WHERE r.tenant_id = $1 AND r.sales_order_id = $2 AND ri.sales_order_item_id = $3`,
          [actor.tenantId, sale.rows[0].id, sold.rows[0].id],
        );
        const remaining = Number(sold.rows[0].quantity) - Number(already.rows[0].quantity);
        if (item.quantity > remaining) throw Object.assign(new Error("Return quantity exceeds the unreturned quantity sold."), { statusCode: 409 });
        const unitCents = amountToCents(sold.rows[0].unit_price);
        const lineCents = unitCents * BigInt(item.quantity);
        total += lineCents;
        await client.query(
          `INSERT INTO sales_return_items (tenant_id, return_id, sales_order_item_id, product_id, quantity, unit_price, line_total)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [actor.tenantId, returnId, sold.rows[0].id, item.productId, item.quantity, sold.rows[0].unit_price, centsToAmount(lineCents)],
        );
        if (restock) {
          await client.query(
            `UPDATE inventory_balances SET on_hand = on_hand + $4, updated_at = now()
             WHERE tenant_id = $1 AND branch_id = $2 AND product_id = $3`,
            [actor.tenantId, sale.rows[0].branch_id, item.productId, item.quantity],
          );
          await client.query(
            `INSERT INTO inventory_movements
             (tenant_id, branch_id, product_id, movement_type, quantity_delta, reference_type, reference_id, idempotency_key)
             VALUES ($1, $2, $3, 'return', $4, 'sales_return', $5, $6)`,
            [actor.tenantId, sale.rows[0].branch_id, item.productId, item.quantity, returnId, `${key}:${item.productId}`],
          );
        }
      }
      const updated = await client.query(
        `UPDATE sales_returns SET total = $3 WHERE tenant_id = $1 AND id = $2
         RETURNING id, return_number AS "returnNumber", status, refund_status AS "refundStatus", total::text`,
        [actor.tenantId, returnId, centsToAmount(total)],
      );
      if (restock) await notifyInventoryChanged(client, { tenantId: actor.tenantId, branchId: sale.rows[0].branch_id, productIds: ids });
      return { returnRecord: updated.rows[0], replayed: false };
    });
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  app.get("/api/v1/business/reports/overview", async (request) => {
    const actor = await requireTenantActor(request);
    return withTenantTransaction(actor.tenantId, async (client) => {
      const [sales, stock, purchases, online] = await Promise.all([
        client.query(
          `SELECT COUNT(*)::int AS count, COALESCE(SUM(grand_total),0)::text AS revenue
           FROM sales_orders WHERE tenant_id = $1 AND channel = 'pos' AND status IN ('confirmed','fulfilled')
             AND created_at >= date_trunc('day', now())`,
          [actor.tenantId],
        ),
        client.query(
          `SELECT COALESCE(SUM(on_hand - reserved),0)::int AS available,
                  COUNT(*) FILTER (WHERE on_hand - reserved <= 5)::int AS low_stock
           FROM inventory_balances WHERE tenant_id = $1`,
          [actor.tenantId],
        ),
        client.query(
          `SELECT COALESCE(SUM(grand_total),0)::text AS spend
           FROM purchase_receipts WHERE tenant_id = $1 AND status = 'received'
             AND created_at >= date_trunc('day', now())`,
          [actor.tenantId],
        ),
        client.query(
          `SELECT COUNT(*)::int AS pending
           FROM sales_orders WHERE tenant_id = $1 AND channel = 'online' AND status = 'pending'`,
          [actor.tenantId],
        ),
      ]);
      return {
        today: { posSalesCount: sales.rows[0].count, posRevenue: sales.rows[0].revenue, purchaseSpend: purchases.rows[0].spend },
        inventory: stock.rows[0],
        online: { pendingOrders: online.rows[0].pending },
      };
    });
  });
}
