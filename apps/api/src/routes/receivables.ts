import { createRequestFingerprint } from "../idempotency.js";
import type { FastifyInstance } from "fastify";
import { assertBranchAccess, requireTenantActor } from "../auth.js";
import { withTenantTransaction } from "../db.js";
import { applyCreditCollection } from "../receivableMath.js";

type CollectionBody = { amount?: string | number; paymentMethod?: "cash" | "upi" | "card" | "bank_transfer"; reference?: string };
function cents(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error("Invalid stored money amount.");
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
}
function money(value: bigint): string { return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`; }

export async function registerReceivableRoutes(app: FastifyInstance) {
  app.get("/api/v1/business/receivables", async (request) => {
    const actor = await requireTenantActor(request);
    return withTenantTransaction(actor.tenantId, async (client) => {
      const result = await client.query(
        `SELECT o.id AS "saleId", o.order_number AS "orderNumber", o.customer_name AS "customerName",
                o.customer_phone AS "customerPhone", o.grand_total::text AS "grandTotal",
                COALESCE(SUM(c.amount), 0)::text AS "collectedAmount",
                (o.grand_total - COALESCE(SUM(c.amount), 0))::text AS "outstandingAmount",
                o.created_at AS "createdAt", b.name AS "branchName"
         FROM sales_orders o
         JOIN branches b ON b.tenant_id = o.tenant_id AND b.id = o.branch_id
         LEFT JOIN pos_credit_collections c ON c.tenant_id = o.tenant_id AND c.sales_order_id = o.id
         WHERE o.tenant_id = $1 AND o.channel = 'pos' AND o.payment_method = 'credit'
           AND o.status IN ('confirmed','fulfilled')
           AND ($2::uuid[] IS NULL OR o.branch_id = ANY($2))
         GROUP BY o.id, b.name
         HAVING o.grand_total > COALESCE(SUM(c.amount), 0)
         ORDER BY o.created_at DESC LIMIT 250`,
        [actor.tenantId, actor.branchIds.length ? actor.branchIds : null],
      );
      return { receivables: result.rows };
    });
  });

  app.post<{ Params: { saleId: string }; Body: CollectionBody }>("/api/v1/business/sales/:saleId/collections", async (request, reply) => {
    const actor = await requireTenantActor(request, ["owner", "admin", "manager", "cashier"]);
    const key = request.headers["idempotency-key"];
    const body = request.body ?? {};
    if (typeof key !== "string" || key.length < 8 || key.length > 128) return reply.code(400).send({ error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "A unique Idempotency-Key is required." } });
    const amount = String(body.amount ?? "");
    const paymentMethod = body.paymentMethod;
    if (!/^\d+(\.\d{1,2})?$/.test(amount) || cents(amount) <= 0n || !paymentMethod || !["cash","upi","card","bank_transfer"].includes(paymentMethod)) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Enter a positive amount and a valid collection method." } });
    }
    const reference = body.reference?.trim().slice(0, 120) || null;
    const requestHash = createRequestFingerprint({ saleId: request.params.saleId, amount: money(cents(amount)), paymentMethod: body.paymentMethod, reference });
    const result = await withTenantTransaction(actor.tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [actor.tenantId, key]);
      const sale = await client.query(
        `SELECT id, branch_id, channel, status, payment_method, grand_total::text AS "grandTotal", payment_status AS "paymentStatus"
         FROM sales_orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [actor.tenantId, request.params.saleId],
      );
      if (!sale.rowCount) throw Object.assign(new Error("Sale not found."), { statusCode: 404 });
      assertBranchAccess(actor, sale.rows[0].branch_id);
      if (sale.rows[0].channel !== "pos" || sale.rows[0].payment_method !== "credit" || !["confirmed","fulfilled"].includes(sale.rows[0].status ?? "confirmed")) {
        throw Object.assign(new Error("Only completed POS credit sales can receive collections."), { statusCode: 409 });
      }
      const prior = await client.query("SELECT id, request_hash FROM pos_credit_collections WHERE tenant_id = $1 AND idempotency_key = $2", [actor.tenantId, key]);
      if (prior.rowCount) {
        if (prior.rows[0].request_hash !== requestHash) return { conflict: true as const };
        const totals = await client.query("SELECT COALESCE(SUM(amount),0)::text AS collected FROM pos_credit_collections WHERE tenant_id = $1 AND sales_order_id = $2", [actor.tenantId, request.params.saleId]);
        const collected = cents(totals.rows[0].collected);
        const total = cents(sale.rows[0].grandTotal);
        const outstanding = total - collected;
        return { replayed: true as const, collectionId: prior.rows[0].id, collectedAmount: money(collected), outstandingAmount: money(outstanding), paymentStatus: outstanding === 0n ? "paid" as const : "pending" as const };
      }
      const totals = await client.query("SELECT COALESCE(SUM(amount),0)::text AS collected FROM pos_credit_collections WHERE tenant_id = $1 AND sales_order_id = $2", [actor.tenantId, request.params.saleId]);
      let settlement: ReturnType<typeof applyCreditCollection>;
      try {
        settlement = applyCreditCollection(sale.rows[0].grandTotal, totals.rows[0].collected, amount);
      } catch (error) {
        throw Object.assign(new Error(error instanceof Error ? error.message : "Invalid collection amount."), { statusCode: 409 });
      }
      const received = cents(amount);
      const inserted = await client.query(
        `INSERT INTO pos_credit_collections (tenant_id, sales_order_id, amount, payment_method, reference, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [actor.tenantId, request.params.saleId, money(received), paymentMethod, reference, key, requestHash],
      );
      if (settlement.paymentStatus === "paid") await client.query("UPDATE sales_orders SET payment_status = 'paid' WHERE tenant_id = $1 AND id = $2", [actor.tenantId, request.params.saleId]);
      return { replayed: false as const, collectionId: inserted.rows[0].id, ...settlement };
    });
    if ("conflict" in result && result.conflict) return reply.code(409).send({ error: { code: "IDEMPOTENCY_KEY_REUSED", message: "This Idempotency-Key was already used with a different collection." } });
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
}
