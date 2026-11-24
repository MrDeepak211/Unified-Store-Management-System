import { createRequestFingerprint } from "../idempotency.js";
import type { FastifyInstance } from "fastify";
import { assertBranchAccess, requireTenantActor } from "../auth.js";
import { withTenantTransaction } from "../db.js";
import { notifyInventoryChanged } from "./inventoryEvents.js";

type StartBody = { branchId?: string; productIds?: string[] };
type CountBody = { countedQuantity?: number };

export async function registerInventoryReconciliationRoutes(app: FastifyInstance) {
  app.post<{ Body: StartBody }>("/api/v1/business/inventory/count-sessions", async (request, reply) => {
    const actor = await requireTenantActor(request, ["owner", "admin", "manager"]);
    const body = request.body ?? {};
    if (!body.branchId || (body.productIds && (!Array.isArray(body.productIds) || body.productIds.length > 500 || new Set(body.productIds).size !== body.productIds.length))) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Choose a branch and at most 500 unique products." } });
    }
    assertBranchAccess(actor, body.branchId);
    const result = await withTenantTransaction(actor.tenantId, async (client) => {
      const branch = await client.query("SELECT id FROM branches WHERE tenant_id = $1 AND id = $2", [actor.tenantId, body.branchId]);
      if (!branch.rowCount) throw Object.assign(new Error("Branch not found."), { statusCode: 404 });
      const session = await client.query(
        "INSERT INTO inventory_count_sessions (tenant_id, branch_id, created_by) VALUES ($1,$2,$3) RETURNING id, status, created_at AS \"createdAt\"",
        [actor.tenantId, body.branchId, actor.authSubject],
      );
      const items = await client.query(
        `INSERT INTO inventory_count_items (tenant_id, session_id, branch_id, product_id, expected_quantity)
         SELECT $1, $2, b.branch_id, b.product_id, b.on_hand
         FROM inventory_balances b JOIN products p ON p.tenant_id = b.tenant_id AND p.id = b.product_id
         WHERE b.tenant_id = $1 AND b.branch_id = $3 AND p.is_active = true
           AND ($4::uuid[] IS NULL OR b.product_id = ANY($4::uuid[]))
         RETURNING id`,
        [actor.tenantId, session.rows[0].id, body.branchId, body.productIds?.length ? body.productIds : null],
      );
      if (!items.rowCount) throw Object.assign(new Error("No stock records found for the selected branch/products."), { statusCode: 404 });
      return { session: session.rows[0], itemCount: items.rowCount };
    });
    return reply.code(201).send(result);
  });

  app.get<{ Params: { sessionId: string } }>("/api/v1/business/inventory/count-sessions/:sessionId", async (request) => {
    const actor = await requireTenantActor(request);
    return withTenantTransaction(actor.tenantId, async (client) => {
      const session = await client.query(
        `SELECT s.id, s.branch_id AS "branchId", b.name AS "branchName", s.status,
                s.created_by AS "createdBy", s.created_at AS "createdAt",
                s.approved_by AS "approvedBy", s.approved_at AS "approvedAt"
         FROM inventory_count_sessions s JOIN branches b ON b.tenant_id=s.tenant_id AND b.id=s.branch_id
         WHERE s.tenant_id=$1 AND s.id=$2`,
        [actor.tenantId, request.params.sessionId],
      );
      if (!session.rowCount) throw Object.assign(new Error("Count session not found."), { statusCode: 404 });
      assertBranchAccess(actor, session.rows[0].branchId);
      const items = await client.query(
        `SELECT i.id, i.product_id AS "productId", p.name AS "productName", p.sku,
                i.expected_quantity AS "expectedQuantity", i.counted_quantity AS "countedQuantity",
                CASE WHEN i.counted_quantity IS NULL THEN NULL ELSE i.counted_quantity-i.expected_quantity END AS variance,
                i.counted_by AS "countedBy", i.counted_at AS "countedAt"
         FROM inventory_count_items i JOIN products p ON p.tenant_id=i.tenant_id AND p.id=i.product_id
         WHERE i.tenant_id=$1 AND i.session_id=$2 ORDER BY p.name`,
        [actor.tenantId, request.params.sessionId],
      );
      return { session: session.rows[0], items: items.rows };
    });
  });

  app.patch<{ Params: { sessionId: string; itemId: string }; Body: CountBody }>("/api/v1/business/inventory/count-sessions/:sessionId/items/:itemId", async (request, reply) => {
    const actor = await requireTenantActor(request, ["owner", "admin", "manager", "cashier"]);
    const quantity = request.body?.countedQuantity;
    if (!Number.isSafeInteger(quantity) || quantity! < 0 || quantity! > 100000000) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Counted quantity must be a non-negative whole number." } });
    }
    const result = await withTenantTransaction(actor.tenantId, async (client) => {
      const session = await client.query("SELECT branch_id, status FROM inventory_count_sessions WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [actor.tenantId, request.params.sessionId]);
      if (!session.rowCount) throw Object.assign(new Error("Count session not found."), { statusCode: 404 });
      assertBranchAccess(actor, session.rows[0].branch_id);
      if (session.rows[0].status !== "open") throw Object.assign(new Error("This count session is no longer open."), { statusCode: 409 });
      const updated = await client.query(
        `UPDATE inventory_count_items SET counted_quantity=$4, counted_by=$5, counted_at=now()
         WHERE tenant_id=$1 AND session_id=$2 AND id=$3
         RETURNING id, expected_quantity AS "expectedQuantity", counted_quantity AS "countedQuantity",
                   counted_quantity-expected_quantity AS variance`,
        [actor.tenantId, request.params.sessionId, request.params.itemId, quantity, actor.authSubject],
      );
      if (!updated.rowCount) throw Object.assign(new Error("Count item not found."), { statusCode: 404 });
      return updated.rows[0];
    });
    return reply.send({ item: result });
  });

  app.post<{ Params: { sessionId: string } }>("/api/v1/business/inventory/count-sessions/:sessionId/approve", async (request, reply) => {
    const actor = await requireTenantActor(request, ["owner", "admin"]);
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8 || key.length > 128) return reply.code(400).send({ error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Approval requires an Idempotency-Key header." } });
    const result = await withTenantTransaction(actor.tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [actor.tenantId, key]);
      const session = await client.query("SELECT id, branch_id, status, approved_by, approval_key FROM inventory_count_sessions WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [actor.tenantId, request.params.sessionId]);
      if (!session.rowCount) throw Object.assign(new Error("Count session not found."), { statusCode: 404 });
      assertBranchAccess(actor, session.rows[0].branch_id);
      const prior = await client.query("SELECT id FROM inventory_movements WHERE tenant_id=$1 AND idempotency_key=$2", [actor.tenantId, key]);
      if (session.rows[0].status === "approved" && session.rows[0].approval_key === key) return { approved: true, replayed: true, movementCount: prior.rowCount };
      if (session.rows[0].status !== "open") throw Object.assign(new Error("Only open count sessions can be approved, and the approval key must match for a replay."), { statusCode: 409 });
      const items = await client.query(
        `SELECT i.id, i.product_id, i.expected_quantity, i.counted_quantity, b.on_hand
         FROM inventory_count_items i JOIN inventory_balances b
           ON b.tenant_id=i.tenant_id AND b.branch_id=i.branch_id AND b.product_id=i.product_id
         WHERE i.tenant_id=$1 AND i.session_id=$2 ORDER BY i.product_id FOR UPDATE OF b`,
        [actor.tenantId, request.params.sessionId],
      );
      if (!items.rowCount || items.rows.some((item: any) => item.counted_quantity === null)) throw Object.assign(new Error("Count every item before approval."), { statusCode: 409 });
      if (items.rows.some((item: any) => item.on_hand !== item.expected_quantity)) throw Object.assign(new Error("Stock changed after the count started. Start a fresh count to avoid overwriting newer movements."), { statusCode: 409 });
      const changed = items.rows.filter((item: any) => item.counted_quantity !== item.expected_quantity);
      for (const item of changed) {
        const delta = Number(item.counted_quantity) - Number(item.expected_quantity);
        const hash = createRequestFingerprint({ sessionId: request.params.sessionId, productId: item.product_id, expected: item.expected_quantity, counted: item.counted_quantity });
        const movement = await client.query(
          `UPDATE inventory_balances SET on_hand=$4, updated_at=now()
           WHERE tenant_id=$1 AND branch_id=$2 AND product_id=$3 AND on_hand=$5 AND $4 >= reserved
           RETURNING on_hand, reserved`,
          [actor.tenantId, session.rows[0].branch_id, item.product_id, item.counted_quantity, item.expected_quantity],
        );
        if (!movement.rowCount) throw Object.assign(new Error("Count would reduce stock below reserved quantity or stock changed during approval."), { statusCode: 409 });
        const inserted = await client.query(
          `INSERT INTO inventory_movements
           (tenant_id, branch_id, product_id, movement_type, quantity_delta, idempotency_key, notes,
            request_hash, adjustment_reason, quantity_before, quantity_after, actor_subject, reference_type, reference_id)
           VALUES ($1,$2,$3,'adjustment',$4,$5,$6,$7,'correction',$8,$9,$10,'inventory_count',$11) RETURNING id`,
          [actor.tenantId, session.rows[0].branch_id, item.product_id, delta, `${key}:${item.product_id}`,
            `Approved physical stock count ${request.params.sessionId}`, hash, item.expected_quantity, item.counted_quantity, actor.authSubject, request.params.sessionId],
        );
        await client.query("UPDATE inventory_count_items SET posted_movement_id=$3 WHERE tenant_id=$1 AND id=$2", [actor.tenantId, item.id, inserted.rows[0].id]);
      }
      await client.query("UPDATE inventory_count_sessions SET status='approved', approved_by=$3, approved_at=now(), approval_key=$4 WHERE tenant_id=$1 AND id=$2", [actor.tenantId, request.params.sessionId, actor.authSubject, key]);
      if (changed.length) await notifyInventoryChanged(client, { tenantId: actor.tenantId, branchId: session.rows[0].branch_id, productIds: changed.map((item: any) => item.product_id) });
      return { approved: true, replayed: false, movementCount: changed.length };
    });
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
}
