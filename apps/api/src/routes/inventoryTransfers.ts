import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { assertBranchAccess, requireTenantActor } from "../auth.js";
import { withTenantTransaction } from "../db.js";
import { notifyInventoryChanged } from "./inventoryEvents.js";

type TransferBody = { fromBranchId?: string; toBranchId?: string; items?: Array<{ productId: string; quantity: number }> };

export async function registerInventoryTransferRoutes(app: FastifyInstance) {
  app.post<{ Body: TransferBody }>("/api/v1/business/inventory/transfers", async (request, reply) => {
    const actor = await requireTenantActor(request, ["owner", "admin", "manager"]);
    const key = request.headers["idempotency-key"];
    const body = request.body ?? {};
    if (typeof key !== "string" || key.length < 8 || key.length > 128) {
      return reply.code(400).send({ error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "A transfer requires an Idempotency-Key header." } });
    }
    if (!body.fromBranchId || !body.toBranchId || body.fromBranchId === body.toBranchId ||
        !Array.isArray(body.items) || !body.items.length || body.items.length > 100) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Select two different branches and at least one product." } });
    }
    const productIds = body.items.map((item) => item.productId);
    if (new Set(productIds).size !== productIds.length || body.items.some((item) => !item.productId || !Number.isSafeInteger(item.quantity) || item.quantity < 1)) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Transfer items must have unique products and positive whole-number quantities." } });
    }
    try {
      const result = await withTenantTransaction(actor.tenantId, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [actor.tenantId, key]);
        assertBranchAccess(actor, body.fromBranchId!);
        assertBranchAccess(actor, body.toBranchId!);
        const branches = await client.query(
          "SELECT id FROM branches WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
          [actor.tenantId, [body.fromBranchId, body.toBranchId]],
        );
        if (branches.rowCount !== 2) throw Object.assign(new Error("Both branches must belong to this shop."), { statusCode: 404 });
        const prior = await client.query(
          "SELECT id, transfer_number AS \"transferNumber\", status FROM inventory_transfers WHERE tenant_id = $1 AND idempotency_key = $2",
          [actor.tenantId, key],
        );
        if (prior.rowCount) return { transfer: prior.rows[0], replayed: true };
        const transferId = randomUUID();
        const transferNumber = `TRF-${randomUUID().slice(0, 8).toUpperCase()}`;
        await client.query(
          `INSERT INTO inventory_transfers (id, tenant_id, from_branch_id, to_branch_id, transfer_number, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [transferId, actor.tenantId, body.fromBranchId, body.toBranchId, transferNumber, key],
        );
        for (const item of body.items!) {
          const product = await client.query("SELECT id FROM products WHERE tenant_id = $1 AND id = $2", [actor.tenantId, item.productId]);
          if (!product.rowCount) throw Object.assign(new Error("A selected product does not belong to this shop."), { statusCode: 404 });
          const outgoing = await client.query(
            `UPDATE inventory_balances SET on_hand = on_hand - $4, updated_at = now()
             WHERE tenant_id = $1 AND branch_id = $2 AND product_id = $3 AND on_hand - reserved >= $4
             RETURNING on_hand`,
            [actor.tenantId, body.fromBranchId, item.productId, item.quantity],
          );
          if (!outgoing.rowCount) throw Object.assign(new Error("The source branch does not have enough available stock."), { statusCode: 409 });
          await client.query(
            `INSERT INTO inventory_balances (tenant_id, branch_id, product_id, on_hand, reserved)
             VALUES ($1, $2, $3, $4, 0)
             ON CONFLICT (tenant_id, branch_id, product_id)
             DO UPDATE SET on_hand = inventory_balances.on_hand + EXCLUDED.on_hand, updated_at = now()`,
            [actor.tenantId, body.toBranchId, item.productId, item.quantity],
          );
          await client.query(
            `INSERT INTO inventory_transfer_items (tenant_id, transfer_id, product_id, quantity)
             VALUES ($1, $2, $3, $4)`,
            [actor.tenantId, transferId, item.productId, item.quantity],
          );
          await client.query(
            `INSERT INTO inventory_movements (tenant_id, branch_id, product_id, movement_type, quantity_delta, reference_type, reference_id, idempotency_key)
             VALUES ($1, $2, $3, 'transfer_out', $4, 'inventory_transfer', $5, $6),
                    ($1, $7, $3, 'transfer_in', $8, 'inventory_transfer', $5, $9)`,
            [actor.tenantId, body.fromBranchId, item.productId, -item.quantity, transferId, `${key}:out:${item.productId}`, body.toBranchId, item.quantity, `${key}:in:${item.productId}`],
          );
        }
        await notifyInventoryChanged(client, { tenantId: actor.tenantId, branchId: body.fromBranchId!, productIds });
        await notifyInventoryChanged(client, { tenantId: actor.tenantId, branchId: body.toBranchId!, productIds });
        return { transfer: { id: transferId, transferNumber, status: "completed" }, replayed: false };
      });
      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (error) {
      const status = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 500;
      if (status === 404 || status === 409) return reply.code(status).send({ error: { code: status === 404 ? "BRANCH_OR_PRODUCT_NOT_FOUND" : "INSUFFICIENT_STOCK", message: error instanceof Error ? error.message : "Transfer failed." } });
      throw error;
    }
  });
}
