import { randomUUID } from "node:crypto";
import { createRequestFingerprint } from "../idempotency.js";
import type { FastifyInstance } from "fastify";
import { assertBranchAccess, requireTenantActor } from "../auth.js";
import { withTenantTransaction } from "../db.js";
import { notifyInventoryChanged } from "./inventoryEvents.js";
import { issueSalesInvoice } from "../invoices.js";

type SaleBody = {
  branchId?: string;
  customerName?: string;
  customerPhone?: string;
  customerId?: string;
  paymentMethod?: "cash" | "upi" | "card" | "bank_transfer" | "credit";
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
    if (!body.branchId || !Array.isArray(body.items) || body.items.length === 0 || body.items.length > 100 || (body.paymentMethod !== undefined && !["cash","upi","card","bank_transfer","credit"].includes(body.paymentMethod))) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "A branch and at least one sale item are required." } });
    }
    const productIds = body.items.map((item) => item.productId);
    if (new Set(productIds).size !== productIds.length) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Each product may appear only once in a sale; combine its quantity." } });
    }
    for (const item of body.items) {
      if (!item.productId || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 100000) {
        return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Each item needs a product ID and a positive whole-number quantity." } });
      }
    }

    const requestHash = createRequestFingerprint({ branchId: body.branchId, customerId: body.customerId || null, customerName: body.customerId ? null : body.customerName?.trim() || null, customerPhone: body.customerId ? null : body.customerPhone?.trim() || null, paymentMethod: body.paymentMethod ?? "cash", items: [...body.items].sort((a, b) => a.productId.localeCompare(b.productId)) });

    try {
      const result = await withTenantTransaction(actor.tenantId, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [actor.tenantId, key]);
        const branch = await client.query(
          "SELECT id FROM branches WHERE tenant_id = $1 AND id = $2",
          [actor.tenantId, body.branchId],
        );
        if (!branch.rowCount) throw Object.assign(new Error("Selected branch was not found."), { statusCode: 404 });
        assertBranchAccess(actor, body.branchId!);

        const prior = await client.query(
          "SELECT id, order_number AS \"orderNumber\", status, grand_total::text AS \"grandTotal\", request_hash AS \"requestHash\" FROM sales_orders WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1",
          [actor.tenantId, key],
        );
        if (prior.rowCount) { if (prior.rows[0].requestHash !== requestHash) return { conflict: true as const }; return { order: prior.rows[0], replayed: true as const }; }

        let customerName = body.customerName?.trim() || null;
        let customerPhone = body.customerPhone?.trim() || null;
        if (body.customerId) {
          const customer = await client.query(
            "SELECT id, name, phone FROM customers WHERE tenant_id = $1 AND id = $2",
            [actor.tenantId, body.customerId],
          );
          if (!customer.rowCount) throw Object.assign(new Error("Selected customer was not found."), { statusCode: 404 });
          customerName = customer.rows[0].name;
          customerPhone = customer.rows[0].phone;
        }
        const orderNumber = `POS-${randomUUID().slice(0, 8).toUpperCase()}`;
        const orderId = (await client.query(
          `INSERT INTO sales_orders (tenant_id, branch_id, channel, status, order_number, customer_id, customer_name, customer_phone, payment_status, payment_method, idempotency_key, request_hash)
           VALUES ($1, $2, 'pos', 'confirmed', $3, $4, $5, $6, 'paid', $7, $8, $9) RETURNING id`,
          [actor.tenantId, body.branchId, orderNumber, body.customerId || null, customerName, customerPhone, body.paymentMethod ?? "cash", key, requestHash],
        )).rows[0].id as string;

        let subtotal = 0n;
        let taxTotal = 0n;
        for (const item of body.items!) {
          const productResult = await client.query(
            "SELECT id, name, sku, hsn_code, unit_of_measure, price::text, tax_rate::text FROM products WHERE tenant_id = $1 AND id = $2 AND is_active = true",
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
            throw Object.assign(new Error(`Insufficient available stock for product ${item.productId}.`), { statusCode: 409 });
          }

          const unitCents = decimalToCents(product.price);
          const lineCents = unitCents * BigInt(item.quantity);
          const taxCents = (lineCents * basisPoints(product.tax_rate) + 5000n) / 10000n;
          subtotal += lineCents;
          taxTotal += taxCents;
          await client.query(
            `INSERT INTO sales_order_items (tenant_id, order_id, product_id, quantity, unit_price, tax_rate, line_total, product_name_snapshot, sku_snapshot, hsn_code_snapshot, unit_of_measure_snapshot)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [actor.tenantId, orderId, item.productId, item.quantity, product.price, product.tax_rate, money(lineCents), product.name, product.sku, product.hsn_code, product.unit_of_measure],
          );
          await client.query(
            `INSERT INTO inventory_movements (tenant_id, branch_id, product_id, movement_type, quantity_delta, reference_type, reference_id, idempotency_key)
             VALUES ($1, $2, $3, 'pos_sale', $4, 'sales_order', $5, $6)`,
            [actor.tenantId, body.branchId, item.productId, -item.quantity, orderId, `${key}:${item.productId}`],
          );
        }

        await notifyInventoryChanged(client, { tenantId: actor.tenantId, branchId: body.branchId!, productIds: body.items!.map((item) => item.productId) });
        const grandTotal = subtotal + taxTotal;
        const updated = await client.query(
          `UPDATE sales_orders SET subtotal = $3, tax_total = $4, grand_total = $5
           WHERE tenant_id = $1 AND id = $2
           RETURNING id, order_number AS "orderNumber", status, subtotal::text, tax_total::text AS "taxTotal", grand_total::text AS "grandTotal"`,
          [actor.tenantId, orderId, money(subtotal), money(taxTotal), money(grandTotal)],
        );
        const invoice = await issueSalesInvoice(client, actor.tenantId, orderId);
        return { order: { ...updated.rows[0], invoiceNumber: invoice.invoiceNumber }, replayed: false };
      });
      if ("conflict" in result && result.conflict) return reply.code(409).send({ error: { code: "IDEMPOTENCY_KEY_REUSED", message: "This Idempotency-Key was already used with a different sale. Use a new key for a new sale." } });
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
