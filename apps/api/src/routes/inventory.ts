import { createRequestFingerprint } from "../idempotency.js";
import type { FastifyInstance } from "fastify";
import { assertBranchAccess, requireTenantActor } from "../auth.js";
import { withTenantTransaction } from "../db.js";
import { notifyInventoryChanged } from "./inventoryEvents.js";

const ADJUSTMENT_REASONS = ["damage", "shrinkage", "correction", "opening_balance", "found_stock", "other"] as const;
type AdjustmentReason = typeof ADJUSTMENT_REASONS[number];
type AdjustmentBody = {
  branchId?: string;
  productId?: string;
  delta?: number;
  reason?: AdjustmentReason;
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
    const reason = body.reason;
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (!body.branchId || !body.productId || !Number.isSafeInteger(body.delta) || body.delta === 0 || Math.abs(body.delta!) > 1000000 ||
        !ADJUSTMENT_REASONS.includes(reason as AdjustmentReason) || note.length > 500 ||
        (reason === "other" && note.length < 3)) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Branch, product, a non-zero whole-number delta, a valid reason and a note for 'other' are required." } });
    }

    const requestHash = createRequestFingerprint({
      branchId: body.branchId, productId: body.productId, delta: body.delta,
      reason, note: note || null,
    });
    const result = await withTenantTransaction(actor.tenantId, async (client) => {
      assertBranchAccess(actor, body.branchId!);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [actor.tenantId, key]);
      const prior = await client.query(
        "SELECT id, request_hash FROM inventory_movements WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1",
        [actor.tenantId, key],
      );
      if (prior.rowCount) {
        if (prior.rows[0].request_hash !== requestHash) return { conflict: true as const };
        return { movementId: prior.rows[0].id, replayed: true as const };
      }

      const updated = await client.query(
        `UPDATE inventory_balances
         SET on_hand = on_hand + $4, updated_at = now()
         WHERE tenant_id = $1 AND branch_id = $2 AND product_id = $3
           AND on_hand + $4 >= reserved
         RETURNING on_hand, reserved, on_hand - $4 AS quantity_before`,
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
        `INSERT INTO inventory_movements
         (tenant_id, branch_id, product_id, movement_type, quantity_delta, idempotency_key, notes,
          request_hash, adjustment_reason, quantity_before, quantity_after, actor_subject)
         VALUES ($1, $2, $3, 'adjustment', $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [actor.tenantId, body.branchId, body.productId, body.delta, key, note || null,
          requestHash, reason, updated.rows[0].quantity_before, updated.rows[0].on_hand, actor.authSubject],
      );
      await notifyInventoryChanged(client, { tenantId: actor.tenantId, branchId: body.branchId!, productIds: [body.productId!] });
      return {
        movementId: movement.rows[0].id,
        stock: { onHand: updated.rows[0].on_hand, reserved: updated.rows[0].reserved },
        replayed: false as const,
      };
    });
    if ("conflict" in result && result.conflict) {
      return reply.code(409).send({ error: { code: "IDEMPOTENCY_KEY_REUSED", message: "This Idempotency-Key was already used with a different inventory adjustment. Use a new key." } });
    }
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
}
