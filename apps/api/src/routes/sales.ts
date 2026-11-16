import type { FastifyInstance } from "fastify";
import { requireTenantActor } from "../auth.js";
import { withTenantTransaction } from "../db.js";

type SaleBody = {
  branchId?: string;
  customerName?: string;
  customerPhone?: string;
  items?: Array<{ productId: string; quantity: number }>;
};

function decimalToCents(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error("Invalid decimal amount from database.");
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
}

function basisPoints(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error("Invalid tax rate from database.");
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
}

function money(cents: bigint): string {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

export async function registerSaleRoutes(app: FastifyInstance) {
  app.post<{ Body: SaleBody }>("/api/v1/pos/sales", async (request, reply) => {
    const actor = await requireTenantActor(request, ["owner", "admin", "manager", "cashier"]);
    const key = request.headers["idempotency-key"];
    const body = request.body ?? {};
    if (typeof key !== "string" || key.length < 8 || key.length > 128) {
      return reply.code(400).send({ error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Send a unique Idempotency-Key header (8–128 characters)." } });
    }
    if (!body.branchId || !Array.isArray(body.items) || body.items.length === 0 || body.items.length > 100) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "A branch and at least one sale item are required." } });
    }
    for (const item of body.items) {
      if (!item.productId || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 100000) {
        return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Each item needs a product ID and a positive whole-number quantity." } });
      }
    }

    try {
      const result = await withTenantTransaction(actor.tenantId, async (client) => {
        const prior = await client.query(
          "SELECT id, order_number, status, grand_total::text FROM sales_orders WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1",
          [actor.tenantId, key],
        );
        if (prior.rowCount) return { order: prior.rows[0], replayed: true };

        const branch = await client.query("SELECT id FROM branches WHERE tenant_id = $1 AND id = $2", [actor.tenantId, body.branchId]);
        if (!branch.rowCount) throw Object.assign(new Error("Selected branch was not found."), { statusCode: 404 });

        const orderNumber = `POS-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
        const orderId = (await client.query(
          `INSERT INTO sales_orders (tenant_id, branch_id, channel, status, order_number, customer_name, customer_phone, idempotency_key)
           VALUES ($1, $2, 'pos', 'confirmed', $3, $4, $5, $6) RETURNING id`,
          [actor.tenantId, body.branchId, orderNumber, body.customerName?.trim() || null, body.customerPhone?.trim() || null, key],
        )).rows[0].id as string;

        let subtotal = 0n;
        let taxTotal = 0n;
        for (const item of body.items!) {
          const productResult = await client.query(
            "SELECT id, price::text, tax_rate::text FROM products WHERE tenant_id = $1 AND id = $2 AND is_active = true",
            [actor.tenantId, item.productId],
          );
          const product = productResult.rows[0];
          if (!product) throw Object.assign(new Error("A product in this sale is unavailable."), { statusCode: 404 });

          const stock = await client.query(
            `UPDATE inventory_balances
             SET on_hand = on_hand - $4, updated_at = now()
             WHERE tenant_id = $1 AND branch_id = $2 AND product_id = $3 AND on_hand - reserved >= $4
             RETURNING on_hand`,
            [actor.tenantId, body.branchId, item.productId, item.quantity],
          );
          if (!stock.rowCount) {
            throw Object.assign(new Error(`Insufficient available stock for SKU product ${item.productId}.`), { statusCode: 409 });
          }

          const unitCents = decimalToCents(product.price);
          const lineCents = unitCents * BigInt(item.quantity);
          const taxCents = (lineCents * basisPoints(product.tax_rate) + 5000n) / 10000n;
          subtotal += lineCents;
          taxTotal += taxCents;
          await client.query(
            `INSERT INTO sales_order_items (tenant_id, order_id, product_id, quantity, unit_price, tax_rate, line_total)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [actor.tenantId, orderId, item.productId, item.quantity, product.price, product.tax_rate, money(lineCents)],
          );
          await client.query(
            `INSERT INTO inventory_movements (tenant_id, branch_id, product_id, movement_type, quantity_delta, reference_type, reference_id, idempotency_key)
             VALUES ($1, $2, $3, 'pos_sale', $4, 'sales_order', $5, $6)`,
            [actor.tenantId, body.branchId, item.productId, -item.quantity, orderId, `${key}:${item.productId}`],
          );
        }

        const grandTotal = subtotal + taxTotal;
        const updated = await client.query(
          `UPDATE sales_orders SET subtotal = $3, tax_total = $4, grand_total = $5
           WHERE tenant_id = $1 AND id = $2
           RETURNING id, order_number AS "orderNumber", status, subtotal::text, tax_total::text AS "taxTotal", grand_total::text AS "grandTotal"`,
          [actor.tenantId, orderId, money(subtotal), money(taxTotal), money(grandTotal)],
        );
        return { order: updated.rows[0], replayed: false };
      });
      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (error) {
      const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 500;
      if (statusCode === 409 || statusCode === 404) {
        return reply.code(statusCode).send({ error: { code: statusCode === 409 ? "INSUFFICIENT_STOCK" : "NOT_FOUND", message: error instanceof Error ? error.message : "Request failed." } });
      }
      throw error;
    }
  });
}
