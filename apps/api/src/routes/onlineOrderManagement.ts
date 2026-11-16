import type { FastifyInstance } from "fastify";
import { assertBranchAccess, requireTenantActor } from "../auth.js";
import { withTenantTransaction } from "../db.js";
import { notifyInventoryChanged } from "./inventoryEvents.js";

export async function registerOnlineOrderManagementRoutes(app: FastifyInstance) {
  app.get("/api/v1/business/online-orders", async (request) => {
    const actor = await requireTenantActor(request);
    return withTenantTransaction(actor.tenantId, async (client) => {
      const result = await client.query(
        `SELECT o.id, o.order_number AS "orderNumber", o.status, o.payment_status AS "paymentStatus",
                o.customer_name AS "customerName", o.customer_phone AS "customerPhone", o.customer_email AS "customerEmail",\n                o.shipping_address AS "deliveryAddress",
                o.grand_total::text AS "grandTotal", o.created_at AS "createdAt",
                o.reservation_expires_at AS "reservationExpiresAt", o.branch_id AS "branchId",
                b.name AS "branchName",
                COALESCE(json_agg(json_build_object(
                  'productId', i.product_id, 'productName', i.product_name_snapshot,
                  'quantity', i.quantity, 'unitPrice', i.unit_price::text, 'lineTotal', i.line_total::text
                )) FILTER (WHERE i.id IS NOT NULL), '[]'::json) AS items
         FROM sales_orders o
         JOIN branches b ON b.tenant_id = o.tenant_id AND b.id = o.branch_id
         LEFT JOIN sales_order_items i ON i.tenant_id = o.tenant_id AND i.order_id = o.id
         WHERE o.tenant_id = $1 AND o.channel = 'online'
           AND ($2::uuid[] IS NULL OR o.branch_id = ANY($2))
         GROUP BY o.id, b.name
         ORDER BY o.created_at DESC LIMIT 200`,
        [actor.tenantId, actor.branchIds.length ? actor.branchIds : null],
      );
      return { orders: result.rows };
    });
  });

  app.post<{ Params: { orderId: string } }>("/api/v1/business/online-orders/:orderId/fulfil", async (request, reply) => {
    const actor = await requireTenantActor(request, ["owner", "admin", "manager"]);
    const result = await withTenantTransaction(actor.tenantId, async (client) => {
      const order = await client.query(
        "SELECT id, branch_id, status, payment_status FROM sales_orders WHERE tenant_id = $1 AND id = $2 AND channel = 'online' FOR UPDATE",
        [actor.tenantId, request.params.orderId],
      );
      if (!order.rowCount) return { error: "NOT_FOUND" as const };
      assertBranchAccess(actor, order.rows[0].branch_id);
      if (order.rows[0].status === "fulfilled") return { order: { id: order.rows[0].id, status: "fulfilled" }, replayed: true };
      if (order.rows[0].status !== "confirmed" || order.rows[0].payment_status !== "paid") {
        return { error: "NOT_PAID" as const };
      }
      await client.query("UPDATE sales_orders SET status = 'fulfilled' WHERE tenant_id = $1 AND id = $2", [actor.tenantId, request.params.orderId]);
      return { order: { id: order.rows[0].id, status: "fulfilled" }, replayed: false };
    });
    if ("error" in result) return reply.code(result.error === "NOT_FOUND" ? 404 : 409).send({ error: { code: result.error, message: result.error === "NOT_FOUND" ? "Online order not found." : "Only paid orders can be fulfilled." } });
    return result;
  });

  app.post<{ Params: { orderId: string } }>("/api/v1/business/online-orders/:orderId/cancel", async (request, reply) => {
    const actor = await requireTenantActor(request, ["owner", "admin", "manager"]);
    const result = await withTenantTransaction(actor.tenantId, async (client) => {
      const order = await client.query(
        "SELECT id, branch_id, status, payment_status FROM sales_orders WHERE tenant_id = $1 AND id = $2 AND channel = 'online' FOR UPDATE",
        [actor.tenantId, request.params.orderId],
      );
      if (!order.rowCount) return { error: "NOT_FOUND" as const };
      assertBranchAccess(actor, order.rows[0].branch_id);
      if (order.rows[0].status === "cancelled") return { order: { id: order.rows[0].id, status: "cancelled" }, replayed: true };
      if (order.rows[0].status !== "pending" || order.rows[0].payment_status !== "pending") {
        return { error: "PAYMENT_REQUIRES_REFUND" as const };
      }
      const items = await client.query("SELECT product_id, quantity FROM sales_order_items WHERE tenant_id = $1 AND order_id = $2", [actor.tenantId, request.params.orderId]);
      for (const item of items.rows) {
        const stock = await client.query(
          `UPDATE inventory_balances SET reserved = reserved - $4, updated_at = now()
           WHERE tenant_id = $1 AND branch_id = $2 AND product_id = $3 AND reserved >= $4`,
          [actor.tenantId, order.rows[0].branch_id, item.product_id, item.quantity],
        );
        if (!stock.rowCount) throw new Error("Reservation balance mismatch during cancellation.");
        await client.query(
          `INSERT INTO inventory_movements (tenant_id, branch_id, product_id, movement_type, quantity_delta, reference_type, reference_id, idempotency_key, notes)
           VALUES ($1, $2, $3, 'reservation_release', $4, 'sales_order', $5, $6, 'Shop cancelled unpaid online order')`,
          [actor.tenantId, order.rows[0].branch_id, item.product_id, -item.quantity, order.rows[0].id, `shop-cancel:${order.rows[0].id}:${item.product_id}`],
        );
      }
      await client.query("UPDATE sales_orders SET status = 'cancelled', payment_status = 'failed' WHERE tenant_id = $1 AND id = $2", [actor.tenantId, request.params.orderId]);
      await notifyInventoryChanged(client, { tenantId: actor.tenantId, branchId: order.rows[0].branch_id, productIds: items.rows.map((item) => item.product_id as string) });
      return { order: { id: order.rows[0].id, status: "cancelled" }, replayed: false };
    });
    if ("error" in result) return reply.code(result.error === "NOT_FOUND" ? 404 : 409).send({ error: { code: result.error, message: result.error === "NOT_FOUND" ? "Online order not found." : "Paid orders require a verified refund workflow and cannot be cancelled here." } });
    return result;
  });
}
