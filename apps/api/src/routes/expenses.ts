import type { FastifyInstance } from "fastify";
import { createRequestFingerprint } from "../idempotency.js";
import { assertBranchAccess, requireTenantActor } from "../auth.js";
import { withTenantTransaction } from "../db.js";

type ExpenseBody = { branchId?: string; category?: string; description?: string; amount?: string | number; paymentMethod?: "cash" | "upi" | "card" | "bank_transfer" };

export async function registerExpenseRoutes(app: FastifyInstance) {
  app.get("/api/v1/business/expenses", async (request) => {
    const actor = await requireTenantActor(request);
    return withTenantTransaction(actor.tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, branch_id AS "branchId", category, description, amount::text,
                payment_method AS "paymentMethod", expense_date AS "expenseDate", created_at AS "createdAt"
         FROM expenses WHERE tenant_id = $1 AND ($2::uuid[] IS NULL OR branch_id = ANY($2))
         ORDER BY expense_date DESC, created_at DESC LIMIT 200`,
        [actor.tenantId, actor.branchIds.length ? actor.branchIds : null],
      );
      return { expenses: result.rows };
    });
  });

  app.post<{ Body: ExpenseBody }>("/api/v1/business/expenses", async (request, reply) => {
    const actor = await requireTenantActor(request, ["owner", "admin", "manager"]);
    const key = request.headers["idempotency-key"];
    const body = request.body ?? {};
    const category = typeof body.category === "string" ? body.category.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const amount = String(body.amount ?? "");
    if (typeof key !== "string" || key.length < 8 || key.length > 128) return reply.code(400).send({ error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Expense requires an Idempotency-Key header." } });
    if (!body.branchId || category.length < 2 || category.length > 60 || description.length < 2 || description.length > 240 ||
        !/^\d+(?:\.\d{1,2})?$/.test(amount) || !Number.isFinite(Number(amount)) || Number(amount) <= 0 || Number(amount) > 9999999999.99 ||
        !["cash","upi","card","bank_transfer"].includes(body.paymentMethod ?? "")) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Provide a branch, category, description, positive amount and payment method." } });
    }
    assertBranchAccess(actor, body.branchId);
    const requestHash = createRequestFingerprint({ branchId: body.branchId, category, description, amount, paymentMethod: body.paymentMethod });
    const result = await withTenantTransaction(actor.tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [actor.tenantId, key]);
      const prior = await client.query(
        `SELECT id, request_hash AS "requestHash" FROM expenses WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1`,
        [actor.tenantId, key],
      );
      if (prior.rowCount) {
        if (prior.rows[0].requestHash !== requestHash) return { conflict: true as const };
        const existing = await client.query(
          `SELECT id, category, description, amount::text, payment_method AS "paymentMethod", expense_date AS "expenseDate" FROM expenses WHERE tenant_id = $1 AND id = $2`,
          [actor.tenantId, prior.rows[0].id],
        );
        return { expense: existing.rows[0], replayed: true as const };
      }
      const inserted = await client.query(
        `INSERT INTO expenses (tenant_id, branch_id, category, description, amount, payment_method, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, category, description, amount::text, payment_method AS "paymentMethod", expense_date AS "expenseDate"`,
        [actor.tenantId, body.branchId, category, description, amount, body.paymentMethod, key, requestHash],
      );
      return { expense: inserted.rows[0], replayed: false as const };
    });
    if ("conflict" in result && result.conflict) return reply.code(409).send({ error: { code: "IDEMPOTENCY_KEY_REUSED", message: "This Idempotency-Key was already used with a different expense. Use a new key." } });
    return reply.code(result.replayed ? 200 : 201).send({ expense: result.expense });
  });
}
