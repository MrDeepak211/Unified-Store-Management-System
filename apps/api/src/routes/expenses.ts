import type { FastifyInstance } from "fastify";
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
    const expense = await withTenantTransaction(actor.tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [actor.tenantId, key]);
      const result = await client.query(
        `INSERT INTO expenses (tenant_id, branch_id, category, description, amount, payment_method, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
         RETURNING id, category, description, amount::text, payment_method AS "paymentMethod", expense_date AS "expenseDate"`,
        [actor.tenantId, body.branchId, category, description, amount, body.paymentMethod, key],
      );
      return result.rows[0];
    });
    return reply.code(201).send({ expense });
  });
}
