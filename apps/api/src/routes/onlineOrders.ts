import { createHash, createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getPool } from "../db.js";
import { notifyInventoryChanged } from "./inventoryEvents.js";

type OnlineOrderBody = {
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  items?: Array<{ productId: string; quantity: number }>;
};

function cents(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error("Invalid price in product catalogue.");
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
}
function taxPoints(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error("Invalid tax rate in product catalogue.");
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
}
function money(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

export async function registerOnlineOrderRoutes(app: FastifyInstance) {
  app.post<{ Params: { slug: string }; Body: OnlineOrderBody }>("/api/v1/storefront/:slug/orders", async (request, reply) => {
    const key = request.headers["idempotency-key"];
    const body = request.body ?? {};
    if (typeof key !== "string" || key.length < 8 || key.length > 128) {
      return reply.code(400).send({ error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Checkout requires a unique Idempotency-Key header." } });
    }
    if (!body.customerName?.trim() || !body.customerPhone?.trim() || !Array.isArray(body.items) || body.items.length === 0 || body.items.length > 50) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Customer name, phone and at least one item are required." } });
    }
    const ids = body.items.map((item) => item.productId);
    if (new Set(ids).size !== ids.length || body.items.some((item) => !item.productId || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 100)) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Use unique products with whole-number quantities from 1 to 100." } });
    }

    const trackingSecret = process.env.ORDER_TRACKING_SECRET;
    if (!trackingSecret || trackingSecret.length < 32) {
      return reply.code(503).send({ error: { code: "CHECKOUT_NOT_CONFIGURED", message: "Online checkout is not configured yet." } });
    }
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const tenantResult = await client.query(
        "SELECT id FROM tenants WHERE slug = $1 AND status = 'active' LIMIT 1",
        [request.params.slug.toLowerCase()],
      );
      const tenantId = tenantResult.rows[0]?.id as string | undefined;
      if (!tenantId) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: { code: "STORE_NOT_FOUND", message: "This store is unavailable." } });
      }
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const settings = await client.query("SELECT 1 FROM storefront_settings WHERE tenant_id = $1 AND is_published = true", [tenantId]);
      if (!settings.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: { code: "STORE_NOT_PUBLISHED", message: "This online store is not accepting orders." } });
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [tenantId, key]);
      const prior = await client.query(
        `SELECT id, order_number AS "orderNumber", status, grand_total::text AS "grandTotal"
         FROM sales_orders WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1`,
        [tenantId, key],
      );
      if (prior.rowCount) {
        const trackingToken = createHmac("sha256", trackingSecret).update(`${tenantId}:${key}`).digest("base64url");
        await client.query("COMMIT");
        return reply.code(200).send({ order: prior.rows[0], trackingToken, replayed: true });
      }
      const branch = await client.query(
        "SELECT id FROM branches WHERE tenant_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1",
        [tenantId],
      );
      if (!branch.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: { code: "STORE_NOT_READY", message: "This store has no active branch." } });
      }
      const branchId = branch.rows[0].id as string;
      const orderId = randomUUID();
      const orderNumber = `WEB-${randomUUID().slice(0, 8).toUpperCase()}`;
      const trackingToken = createHmac("sha256", trackingSecret).update(`${tenantId}:${key}`).digest("base64url");
      const trackingHash = createHash("sha256").update(trackingToken).digest("hex");
      await client.query(
        `INSERT INTO sales_orders
          (id, tenant_id, branch_id, channel, status, payment_status, order_number, customer_name, customer_phone,
           subtotal, tax_total, grand_total, idempotency_key, reservation_expires_at, public_tracking_token_hash)
         VALUES ($1, $2, $3, 'online', 'pending', 'pending', $4, $5, $6, 0, 0, 0, $7, now() + interval '15 minutes', $8)`,
        [orderId, tenantId, branchId, orderNumber, body.customerName.trim(), body.customerPhone.trim(), key, trackingHash],
      );

      let subtotal = 0n;
      let taxTotal = 0n;
      for (const item of body.items) {
        const productResult = await client.query(
          "SELECT id, price::text, tax_rate::text FROM products WHERE tenant_id = $1 AND id = $2 AND is_active = true",
          [tenantId, item.productId],
        );
        const product = productResult.rows[0];
        if (!product) throw Object.assign(new Error("A product in your cart is no longer available."), { statusCode: 404 });
        const reserved = await client.query(
          `UPDATE inventory_balances
           SET reserved = reserved + $4, updated_at = now()
           WHERE tenant_id = $1 AND branch_id = $2 AND product_id = $3 AND on_hand - reserved >= $4
           RETURNING on_hand, reserved`,
          [tenantId, branchId, item.productId, item.quantity],
        );
        if (!reserved.rowCount) throw Object.assign(new Error("One or more items no longer have enough stock."), { statusCode: 409 });

        const lineCents = cents(product.price) * BigInt(item.quantity);
        const lineTax = (lineCents * taxPoints(product.tax_rate) + 5000n) / 10000n;
        subtotal += lineCents;
        taxTotal += lineTax;
        await client.query(
          `INSERT INTO sales_order_items (tenant_id, order_id, product_id, quantity, unit_price, tax_rate, line_total)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [tenantId, orderId, item.productId, item.quantity, product.price, product.tax_rate, money(lineCents)],
        );
        await client.query(
          `INSERT INTO inventory_movements
           (tenant_id, branch_id, product_id, movement_type, quantity_delta, reference_type, reference_id, idempotency_key)
           VALUES ($1, $2, $3, 'reservation', $4, 'sales_order', $5, $6)`,
          [tenantId, branchId, item.productId, item.quantity, orderId, `${key}:reserve:${item.productId}`],
        );
      }
      await notifyInventoryChanged(client, { tenantId, branchId, productIds: body.items.map((item) => item.productId) });
      const grandTotal = subtotal + taxTotal;
      const order = await client.query(
        `UPDATE sales_orders SET subtotal = $2, tax_total = $3, grand_total = $4
         WHERE tenant_id = $1 AND id = $5
         RETURNING id, order_number AS "orderNumber", status, payment_status AS "paymentStatus",
                   subtotal::text, tax_total::text AS "taxTotal", grand_total::text AS "grandTotal",
                   reservation_expires_at AS "reservationExpiresAt"`,
        [tenantId, money(subtotal), money(taxTotal), money(grandTotal), orderId],
      );
      await client.query("COMMIT");
      return reply.code(201).send({
        order: order.rows[0],
        trackingToken,
        checkout: { status: "awaiting_payment", message: "Stock is reserved for 15 minutes. Payment gateway integration is the next step." },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 500;
      if (statusCode === 404 || statusCode === 409) {
        return reply.code(statusCode).send({ error: { code: statusCode === 404 ? "PRODUCT_UNAVAILABLE" : "INSUFFICIENT_STOCK", message: error instanceof Error ? error.message : "Checkout failed." } });
      }
      throw error;
    } finally {
      client.release();
    }
  });

  app.get<{ Params: { slug: string; orderId: string }; Querystring: { token?: string } }>("/api/v1/storefront/:slug/orders/:orderId", async (request, reply) => {
    const token = request.query.token;
    if (!token || token.length < 32 || token.length > 128) {
      return reply.code(400).send({ error: { code: "TRACKING_TOKEN_REQUIRED", message: "A valid order tracking token is required." } });
    }
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const tenantResult = await client.query(
        "SELECT id FROM tenants WHERE slug = $1 AND status = 'active' LIMIT 1",
        [request.params.slug.toLowerCase()],
      );
      const tenantId = tenantResult.rows[0]?.id as string | undefined;
      if (!tenantId) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: { code: "ORDER_NOT_FOUND", message: "Order not found." } });
      }
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const orderResult = await client.query(
        `SELECT id, order_number AS "orderNumber", status, payment_status AS "paymentStatus",
                grand_total::text AS "grandTotal", created_at AS "createdAt",
                reservation_expires_at AS "reservationExpiresAt"
         FROM sales_orders
         WHERE tenant_id = $1 AND id = $2 AND public_tracking_token_hash = $3
         LIMIT 1`,
        [tenantId, request.params.orderId, tokenHash],
      );
      if (!orderResult.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: { code: "ORDER_NOT_FOUND", message: "Order not found." } });
      }
      const items = await client.query(
        `SELECT p.name, i.quantity, i.unit_price::text AS "unitPrice", i.line_total::text AS "lineTotal"
         FROM sales_order_items i
         JOIN products p ON p.tenant_id = i.tenant_id AND p.id = i.product_id
         WHERE i.tenant_id = $1 AND i.order_id = $2`,
        [tenantId, request.params.orderId],
      );
      await client.query("COMMIT");
      return { order: orderResult.rows[0], items: items.rows };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

}
