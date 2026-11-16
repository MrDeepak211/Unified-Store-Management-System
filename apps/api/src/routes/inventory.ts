import type { FastifyInstance } from "fastify";
import { assertBranchAccess, requireTenantActor } from "../auth.js";
import { withTenantTransaction } from "../db.js";
import { notifyInventoryChanged } from "./inventoryEvents.js";

type AdjustmentBody = {
  branchId?: string;
  productId?: string;
  delta?: number;
  note?: string;
};

export async function registerInventoryRoutes(app: FastifyInstance) {
  app.post<{ Body: AdjustmentBody }>("/api/v1/business/inventory/adjustments", async (request, reply) => {
    const actor = await requireTenantActor(request, ["owner", "admin", "manager"]);
    const key = request.headers["idempotency-key"];
    const body = request.body ?? {};
    if (typeof key !== "string" || key.length < 8 || key.length > 128) {
      return reply.code(400).send({ error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Send a unique Idempotency-Key header." } });
    }
    if (!body.branchId || !body.productId || !Number.isSafeInteger(body.delta) || body.delta === 0 || Math.abs(body.delta!) > 1000000) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Branch, product and a non-zero whole-number stock adjustment are required." } });
    }

    const result = await withTenantTransaction(actor.tenantId, async (client) => {
      assertBranchAccess(actor, body.branchId!);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [actor.tenantId, key]);
      const prior = await client.query(
        "SELECT id FROM inventory_movements WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1",
        [actor.tenantId, key],
      );
      if (prior.rowCount) return { movementId: prior.rows[0].id, replayed: true };

      const updated = await client.query(
        `UPDATE inventory_balances
         SET on_hand = on_hand + $4, updated_at = now()
         WHERE tenant_id = $1 AND branch_id = $2 AND product_id = $3
           AND on_hand + $4 >= reserved
         RETURNING on_hand, reserved`,
        [actor.tenantId, body.branchId, body.productId, body.delta],
      );
      if (!updated.rowCount) {
        const exists = await client.query(
          "SELECT 1 FROM inventory_balances WHERE tenant_id = $1 AND branch_id = $2 AND product_id = $3",
          [actor.tenantId, body.branchId, body.productId],
        );
        if (!exists.rowCount) throw Object.assign(new Error("Product or branch stock record was not found."), { statusCode: 404 });
        throw Object.assign(new Error("This adjustment would reduce stock below reserved quantity."), { statusCode: 409 });
      }
      const movement = await client.query(
        `INSERT INTO inventory_movements (tenant_id, branch_id, product_id, movement_type, quantity_delta, idempotency_key, notes)
         VALUES ($1, $2, $3, 'adjustment', $4, $5, $6) RETURNING id`,
        [actor.tenantId, body.branchId, body.productId, body.delta, key, body.note?.trim() || null],
      );
      await notifyInventoryChanged(client, { tenantId: actor.tenantId, branchId: body.branchId!, productIds: [body.productId!] });
      return { movementId: movement.rows[0].id, stock: updated.rows[0], replayed: false };
    }).catch((error: unknown) => {
      throw error;
    });
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
}
