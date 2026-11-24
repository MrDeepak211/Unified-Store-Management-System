import { randomUUID } from "node:crypto";
import { createRequestFingerprint } from "../idempotency.js";
import type { FastifyInstance } from "fastify";
import { assertBranchAccess, requireTenantActor } from "../auth.js";
import { withTenantTransaction } from "../db.js";
import { notifyInventoryChanged } from "./inventoryEvents.js";

type PartyBody = { name?: string; phone?: string; email?: string; gstin?: string };
type PurchaseBody = {
  branchId?: string;
  supplierId?: string;
  items?: Array<{ productId: string; quantity: number; unitCost: string | number; taxRate?: string | number }>;
};

function toCents(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error("Invalid decimal amount.");
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
}
function toBasisPoints(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error("Invalid tax rate.");
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
}
function formatMoney(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

export async function registerPartyAndPurchaseRoutes(app: FastifyInstance) {
  app.get("/api/v1/business/purchases/receipts", async (request) => {
    const actor = await requireTenantActor(request);
    return withTenantTransaction(actor.tenantId, async (client) => {
      const result = await client.query(
        `SELECT r.id, r.receipt_number AS "receiptNumber", r.status, r.grand_total::text AS "grandTotal",
                r.created_at AS "createdAt", s.name AS "supplierName"
         FROM purchase_receipts r
         LEFT JOIN suppliers s ON s.tenant_id = r.tenant_id AND s.id = r.supplier_id
         WHERE r.tenant_id = $1 AND ($2::uuid[] IS NULL OR r.branch_id = ANY($2))
         ORDER BY r.created_at DESC LIMIT 100`,
        [actor.tenantId, actor.branchIds.length ? actor.branchIds : null],
      );
      return { receipts: result.rows };
    });
  });

  app.get("/api/v1/business/customers", async (request) => {
    const actor = await requireTenantActor(request);
    return withTenantTransaction(actor.tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, name, phone, email, gstin, billing_address AS "billingAddress", created_at AS "createdAt"
         FROM customers WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 500`,
        [actor.tenantId],
      );
      return { customers: result.rows };
    });
  });

  app.post<{ Body: PartyBody }>("/api/v1/business/customers", async (request, reply) => {
    const actor = await requireTenantActor(request, ["owner", "admin", "manager", "cashier"]);
    const body = request.body ?? {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 2 || name.length > 120) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Customer name is required." } });
    }
    const customer = await withTenantTransaction(actor.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO customers (tenant_id, name, phone, email, gstin)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, phone, email, gstin`,
        [actor.tenantId, name, body.phone?.trim() || null, body.email?.trim() || null, body.gstin?.trim().toUpperCase() || null],
      );
      return result.rows[0];
    });
    return reply.code(201).send({ customer });
  });

  app.get("/api/v1/business/suppliers", async (request) => {
    const actor = await requireTenantActor(request);
    return withTenantTransaction(actor.tenantId, async (client) => {
      const result = await client.query(
        `SELECT s.id, s.name, s.phone, s.email, s.gstin, s.address, s.created_at AS "createdAt",
                COALESCE((SELECT SUM(r.grand_total) FROM purchase_receipts r
                  WHERE r.tenant_id=s.tenant_id AND r.supplier_id=s.id AND r.status='received'
                    AND ($2::uuid[] IS NULL OR r.branch_id=ANY($2))),0)::text AS "totalPurchased",
                COALESCE((SELECT SUM(p.amount) FROM supplier_payments p
                  WHERE p.tenant_id=s.tenant_id AND p.supplier_id=s.id
                    AND ($2::uuid[] IS NULL OR p.branch_id=ANY($2))),0)::text AS "totalPaid",
                GREATEST(
                  COALESCE((SELECT SUM(r.grand_total) FROM purchase_receipts r
                    WHERE r.tenant_id=s.tenant_id AND r.supplier_id=s.id AND r.status='received'),0)
                  - COALESCE((SELECT SUM(p.amount) FROM supplier_payments p
                    WHERE p.tenant_id=s.tenant_id AND p.supplier_id=s.id),0),0
                )::text AS "outstanding"
         FROM suppliers s WHERE s.tenant_id = $1 ORDER BY s.created_at DESC LIMIT 500`,
        [actor.tenantId, actor.branchIds.length ? actor.branchIds : null],
      );
      return { suppliers: result.rows };
    });
  });

  app.post<{ Body: PartyBody }>("/api/v1/business/suppliers", async (request, reply) => {
    const actor = await requireTenantActor(request, ["owner", "admin", "manager"]);
    const body = request.body ?? {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 2 || name.length > 120) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Supplier name is required." } });
    }
    const supplier = await withTenantTransaction(actor.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO suppliers (tenant_id, name, phone, email, gstin)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, phone, email, gstin`,
        [actor.tenantId, name, body.phone?.trim() || null, body.email?.trim() || null, body.gstin?.trim().toUpperCase() || null],
      );
      return result.rows[0];
    });
    return reply.code(201).send({ supplier });
  });

  app.post<{ Params: { receiptId: string }; Body: { reason?: string; items?: Array<{ receiptItemId: string; quantity: number }> } }>(
    "/api/v1/business/purchases/receipts/:receiptId/returns", async (request, reply) => {
      const actor = await requireTenantActor(request, ["owner", "admin", "manager"]);
      const key = request.headers["idempotency-key"];
      const body = request.body ?? {};
      const reason = body.reason?.trim() || null;
      if (typeof key !== "string" || key.length < 8 || key.length > 128) {
        return reply.code(400).send({ error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Purchase return requires an Idempotency-Key header." } });
      }
      if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100 ||
          new Set(body.items.map((item) => item.receiptItemId)).size !== body.items.length ||
          body.items.some((item) => !item.receiptItemId || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 100000) ||
          (reason && reason.length > 500)) {
        return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Provide unique receipt items with positive whole-number return quantities." } });
      }
      const requestHash = createRequestFingerprint({ receiptId: request.params.receiptId, reason, items: [...body.items].sort((a,b) => a.receiptItemId.localeCompare(b.receiptItemId)) });
      const result = await withTenantTransaction(actor.tenantId, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [actor.tenantId, key]);
        const prior = await client.query(
          "SELECT id, return_number, credit_total::text, request_hash FROM supplier_purchase_returns WHERE tenant_id=$1 AND idempotency_key=$2",
          [actor.tenantId, key],
        );
        if (prior.rowCount) {
          if (prior.rows[0].request_hash !== requestHash) return { conflict: true as const };
          return { creditNote: { id: prior.rows[0].id, returnNumber: prior.rows[0].return_number, creditTotal: prior.rows[0].credit_total }, replayed: true as const };
        }
        const receipt = await client.query(
          "SELECT id, branch_id, supplier_id, status FROM purchase_receipts WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [actor.tenantId, request.params.receiptId],
        );
        if (!receipt.rowCount || receipt.rows[0].status !== "received" || !receipt.rows[0].supplier_id) {
          throw Object.assign(new Error("A received purchase with a supplier is required for a supplier return."), { statusCode: 409 });
        }
        assertBranchAccess(actor, receipt.rows[0].branch_id);
        let subtotal = 0n;
        let taxTotal = 0n;
        const prepared: Array<{ receiptItemId: string; productId: string; quantity: number; unitCost: string; taxRate: string; line: bigint; tax: bigint }> = [];
        for (const item of body.items!) {
          const source = await client.query(
            `SELECT id, product_id, quantity, unit_cost::text, tax_rate::text
             FROM purchase_receipt_items
             WHERE tenant_id=$1 AND receipt_id=$2 AND id=$3 FOR UPDATE`,
            [actor.tenantId, receipt.rows[0].id, item.receiptItemId],
          );
          if (!source.rowCount) throw Object.assign(new Error("A selected item does not belong to this purchase receipt."), { statusCode: 404 });
          const returned = await client.query(
            `SELECT COALESCE(SUM(ri.quantity),0)::int AS quantity
             FROM supplier_purchase_return_items ri
             JOIN supplier_purchase_returns r ON r.tenant_id=ri.tenant_id AND r.id=ri.return_id
             WHERE ri.tenant_id=$1 AND ri.purchase_receipt_item_id=$2 AND r.status='posted'`,
            [actor.tenantId, item.receiptItemId],
          );
          const remaining = Number(source.rows[0].quantity) - Number(returned.rows[0].quantity);
          if (item.quantity > remaining) throw Object.assign(new Error("Return quantity exceeds the unreturned quantity received."), { statusCode: 409 });
          const unitCost = source.rows[0].unit_cost as string;
          const taxRate = source.rows[0].tax_rate as string;
          const line = toCents(unitCost) * BigInt(item.quantity);
          const tax = (line * toBasisPoints(taxRate) + 5000n) / 10000n;
          subtotal += line; taxTotal += tax;
          prepared.push({ receiptItemId: item.receiptItemId, productId: source.rows[0].product_id, quantity: item.quantity, unitCost, taxRate, line, tax });
        }
        const returnId = randomUUID();
        const returnNumber = `PR-${randomUUID().slice(0,8).toUpperCase()}`;
        const creditTotal = subtotal + taxTotal;
        await client.query(
          `INSERT INTO supplier_purchase_returns
           (id,tenant_id,branch_id,supplier_id,purchase_receipt_id,return_number,reason,subtotal,tax_total,credit_total,idempotency_key,request_hash,actor_subject)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [returnId,actor.tenantId,receipt.rows[0].branch_id,receipt.rows[0].supplier_id,receipt.rows[0].id,returnNumber,reason,formatMoney(subtotal),formatMoney(taxTotal),formatMoney(creditTotal),key,requestHash,actor.authSubject],
        );
        for (const item of prepared) {
          const stock = await client.query(
            `UPDATE inventory_balances SET on_hand=on_hand-$4, updated_at=now()
             WHERE tenant_id=$1 AND branch_id=$2 AND product_id=$3 AND on_hand-reserved >= $4
             RETURNING on_hand+$4 AS "quantityBefore", on_hand AS "quantityAfter"`,
            [actor.tenantId,receipt.rows[0].branch_id,item.productId,item.quantity],
          );
          if (!stock.rowCount) throw Object.assign(new Error("Insufficient unreserved stock to return this quantity to the supplier."), { statusCode: 409 });
          await client.query(
            `INSERT INTO supplier_purchase_return_items
             (tenant_id,return_id,purchase_receipt_item_id,product_id,quantity,unit_cost,tax_rate,line_total,tax_total)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [actor.tenantId,returnId,item.receiptItemId,item.productId,item.quantity,item.unitCost,item.taxRate,formatMoney(item.line),formatMoney(item.tax)],
          );
          await client.query(
            `INSERT INTO inventory_movements
             (tenant_id,branch_id,product_id,movement_type,quantity_delta,reference_type,reference_id,idempotency_key,notes)
             VALUES ($1,$2,$3,'return',$4,'supplier_purchase_return',$5,$6,$7)`,
            [actor.tenantId,receipt.rows[0].branch_id,item.productId,-item.quantity,returnId,`${key}:${item.productId}`,reason],
          );
        }
        await notifyInventoryChanged(client,{tenantId:actor.tenantId,branchId:receipt.rows[0].branch_id,productIds:prepared.map(item=>item.productId)});
        return { creditNote: { id:returnId, returnNumber, creditTotal:formatMoney(creditTotal), status:"posted" }, replayed:false as const };
      });
      if ("conflict" in result && result.conflict) return reply.code(409).send({ error: { code: "IDEMPOTENCY_KEY_REUSED", message: "This Idempotency-Key was already used for a different purchase return." } });
      return reply.code(result.replayed ? 200 : 201).send(result);
    }
  );

  app.post<{ Params: { supplierId: string }; Body: { branchId?: string; amount?: string | number; paymentMethod?: "cash" | "upi" | "card" | "bank_transfer"; reference?: string; notes?: string } }>(
    "/api/v1/business/suppliers/:supplierId/payments", async (request, reply) => {
      const actor = await requireTenantActor(request, ["owner", "admin", "manager"]);
      const key = request.headers["idempotency-key"];
      const body = request.body ?? {};
      const amount = String(body.amount ?? "");
      const reference = body.reference?.trim() || null;
      const notes = body.notes?.trim() || null;
      if (typeof key !== "string" || key.length < 8 || key.length > 128) {
        return reply.code(400).send({ error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Supplier payment requires an Idempotency-Key header." } });
      }
      if (!body.branchId || !/^\d+(?:\.\d{1,2})?$/.test(amount) || !Number.isFinite(Number(amount)) ||
          Number(amount) <= 0 || Number(amount) > 9999999999.99 ||
          !["cash", "upi", "card", "bank_transfer"].includes(body.paymentMethod ?? "") ||
          (reference && reference.length > 120) || (notes && notes.length > 500)) {
        return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Provide a branch, positive amount, valid payment method and concise optional reference/notes." } });
      }
      assertBranchAccess(actor, body.branchId);
      const requestHash = createRequestFingerprint({ supplierId: request.params.supplierId, branchId: body.branchId, amount, paymentMethod: body.paymentMethod, reference, notes });
      const result = await withTenantTransaction(actor.tenantId, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [actor.tenantId, key]);
        const prior = await client.query(
          "SELECT id, request_hash FROM supplier_payments WHERE tenant_id=$1 AND idempotency_key=$2",
          [actor.tenantId, key],
        );
        if (prior.rowCount) {
          if (prior.rows[0].request_hash !== requestHash) return { conflict: true as const };
          const existing = await client.query(
            `SELECT id, supplier_id AS "supplierId", branch_id AS "branchId", amount::text,
                    payment_method AS "paymentMethod", reference, notes, created_at AS "createdAt"
             FROM supplier_payments WHERE tenant_id=$1 AND id=$2`,
            [actor.tenantId, prior.rows[0].id],
          );
          return { payment: existing.rows[0], replayed: true as const };
        }
        const supplier = await client.query("SELECT id FROM suppliers WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [actor.tenantId, request.params.supplierId]);
        if (!supplier.rowCount) throw Object.assign(new Error("Supplier not found."), { statusCode: 404 });
        const totals = await client.query(
          `SELECT
             COALESCE((SELECT SUM(grand_total) FROM purchase_receipts WHERE tenant_id=$1 AND supplier_id=$2 AND status='received'),0)::text AS purchased,
             COALESCE((SELECT SUM(credit_total) FROM supplier_purchase_returns WHERE tenant_id=$1 AND supplier_id=$2 AND status='posted'),0)::text AS returned,
             COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE tenant_id=$1 AND supplier_id=$2),0)::text AS paid`,
          [actor.tenantId, request.params.supplierId],
        );
        const outstanding = toCents(totals.rows[0].purchased) - toCents(totals.rows[0].returned) - toCents(totals.rows[0].paid);
        if (toCents(amount) > outstanding) throw Object.assign(new Error("Supplier payment exceeds the outstanding balance."), { statusCode: 409 });
        const created = await client.query(
          `INSERT INTO supplier_payments
           (tenant_id, branch_id, supplier_id, amount, payment_method, reference, notes, idempotency_key, request_hash, actor_subject)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING id, supplier_id AS "supplierId", branch_id AS "branchId", amount::text,
                     payment_method AS "paymentMethod", reference, notes, created_at AS "createdAt"`,
          [actor.tenantId, body.branchId, request.params.supplierId, amount, body.paymentMethod, reference, notes, key, requestHash, actor.authSubject],
        );
        return { payment: created.rows[0], replayed: false as const };
      });
      if ("conflict" in result && result.conflict) return reply.code(409).send({ error: { code: "IDEMPOTENCY_KEY_REUSED", message: "This Idempotency-Key was already used for a different supplier payment." } });
      return reply.code(result.replayed ? 200 : 201).send(result);
    }
  );

  app.get<{ Params: { supplierId: string } }>("/api/v1/business/suppliers/:supplierId/statement", async (request) => {
    const actor = await requireTenantActor(request);
    return withTenantTransaction(actor.tenantId, async (client) => {
      const supplier = await client.query("SELECT id, name FROM suppliers WHERE tenant_id=$1 AND id=$2", [actor.tenantId, request.params.supplierId]);
      if (!supplier.rowCount) throw Object.assign(new Error("Supplier not found."), { statusCode: 404 });
      const rows = await client.query(
        `WITH ledger AS (
           SELECT r.id, r.receipt_number AS reference, r.created_at AS "createdAt",
                  'purchase'::text AS type, r.grand_total::numeric AS debit, 0::numeric AS credit
           FROM purchase_receipts r
           WHERE r.tenant_id=$1 AND r.supplier_id=$2 AND r.status='received'
             AND ($3::uuid[] IS NULL OR r.branch_id=ANY($3))
           UNION ALL
           SELECT p.id, COALESCE(p.reference, p.id::text) AS reference, p.created_at AS "createdAt",
                  'payment'::text AS type, 0::numeric AS debit, p.amount AS credit
           FROM supplier_payments p
           WHERE p.tenant_id=$1 AND p.supplier_id=$2
             AND ($3::uuid[] IS NULL OR p.branch_id=ANY($3))
           UNION ALL
           SELECT cr.id, cr.return_number AS reference, cr.created_at AS "createdAt",
                  'purchase_return'::text AS type, 0::numeric AS debit, cr.credit_total AS credit
           FROM supplier_purchase_returns cr
           WHERE cr.tenant_id=$1 AND cr.supplier_id=$2 AND cr.status='posted'
             AND ($3::uuid[] IS NULL OR cr.branch_id=ANY($3))
         )
         SELECT id, reference, "createdAt", type, debit::text, credit::text,
                SUM(debit-credit) OVER (ORDER BY "createdAt", id ROWS UNBOUNDED PRECEDING)::text AS balance
         FROM ledger ORDER BY "createdAt", id`,
        [actor.tenantId, request.params.supplierId, actor.branchIds.length ? actor.branchIds : null],
      );
      let purchased = 0n;
      let paid = 0n;
      let returned = 0n;
      for (const row of rows.rows as Array<{ debit: string; credit: string; type: string }>) {
        if (row.type === "purchase") purchased += toCents(row.debit);
        else if (row.type === "purchase_return") returned += toCents(row.credit);
        else paid += toCents(row.credit);
      }
      return {
        supplier: supplier.rows[0],
        summary: { totalPurchased: formatMoney(purchased), totalReturned: formatMoney(returned), totalPaid: formatMoney(paid), outstanding: formatMoney(purchased - returned - paid) },
        entries: rows.rows,
      };
    });
  });

  app.post<{ Body: PurchaseBody }>("/api/v1/business/purchases/receipts", async (request, reply) => {
    const actor = await requireTenantActor(request, ["owner", "admin", "manager"]);
    const key = request.headers["idempotency-key"];
    const body = request.body ?? {};
    if (typeof key !== "string" || key.length < 8 || key.length > 128) {
      return reply.code(400).send({ error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Goods receipt requires an Idempotency-Key header." } });
    }
    if (!body.branchId || !Array.isArray(body.items) || body.items.length === 0 || body.items.length > 100) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Branch and at least one received item are required." } });
    }
    const ids = body.items.map((item) => item.productId);
    if (new Set(ids).size !== ids.length || body.items.some((item) =>
      !item.productId || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 100000 ||
      !/^\d+(\.\d{1,2})?$/.test(String(item.unitCost)) ||
      !/^\d+(\.\d{1,2})?$/.test(String(item.taxRate ?? "0")) || Number(item.taxRate ?? 0) > 100
    )) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Received items must have unique products, valid quantities, costs and tax rates." } });
    }

    const requestHash = createRequestFingerprint({ branchId: body.branchId, supplierId: body.supplierId || null, items: [...body.items].map((item) => ({ productId: item.productId, quantity: item.quantity, unitCost: String(item.unitCost), taxRate: String(item.taxRate ?? "0") })).sort((a, b) => a.productId.localeCompare(b.productId)) });
    const result = await withTenantTransaction(actor.tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [actor.tenantId, key]);
      assertBranchAccess(actor, body.branchId!);
      const branch = await client.query("SELECT id FROM branches WHERE tenant_id = $1 AND id = $2", [actor.tenantId, body.branchId]);
      if (!branch.rowCount) throw Object.assign(new Error("Selected branch was not found."), { statusCode: 404 });
      const prior = await client.query(
        "SELECT id, receipt_number, grand_total::text, request_hash FROM purchase_receipts WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1",
        [actor.tenantId, key],
      );
      if (prior.rowCount) {
        if (prior.rows[0].request_hash !== requestHash) return { conflict: true as const };
        return { receipt: { id: prior.rows[0].id, receiptNumber: prior.rows[0].receipt_number, grandTotal: prior.rows[0].grand_total }, replayed: true as const };
      }
      if (body.supplierId) {
        const supplier = await client.query("SELECT id FROM suppliers WHERE tenant_id = $1 AND id = $2", [actor.tenantId, body.supplierId]);
        if (!supplier.rowCount) throw Object.assign(new Error("Selected supplier was not found."), { statusCode: 404 });
      }
      const receiptId = randomUUID();
      const receiptNumber = `GRN-${randomUUID().slice(0, 8).toUpperCase()}`;
      await client.query(
        `INSERT INTO purchase_receipts (id, tenant_id, branch_id, supplier_id, receipt_number, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [receiptId, actor.tenantId, body.branchId, body.supplierId || null, receiptNumber, key, requestHash],
      );
      let subtotal = 0n;
      let taxTotal = 0n;
      for (const item of body.items!) {
        const product = await client.query("SELECT id FROM products WHERE tenant_id = $1 AND id = $2", [actor.tenantId, item.productId]);
        if (!product.rowCount) throw Object.assign(new Error("A received product was not found."), { statusCode: 404 });
        const cost = String(item.unitCost);
        const rate = String(item.taxRate ?? "0");
        const line = toCents(cost) * BigInt(item.quantity);
        const tax = (line * toBasisPoints(rate) + 5000n) / 10000n;
        subtotal += line;
        taxTotal += tax;
        await client.query(
          `INSERT INTO purchase_receipt_items (tenant_id, receipt_id, product_id, quantity, unit_cost, tax_rate, line_total)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [actor.tenantId, receiptId, item.productId, item.quantity, cost, rate, formatMoney(line)],
        );
        await client.query(
          `UPDATE inventory_balances SET on_hand = on_hand + $4, updated_at = now()
           WHERE tenant_id = $1 AND branch_id = $2 AND product_id = $3`,
          [actor.tenantId, body.branchId, item.productId, item.quantity],
        );
        await client.query(
          `INSERT INTO inventory_movements
           (tenant_id, branch_id, product_id, movement_type, quantity_delta, reference_type, reference_id, idempotency_key)
           VALUES ($1, $2, $3, 'purchase', $4, 'purchase_receipt', $5, $6)`,
          [actor.tenantId, body.branchId, item.productId, item.quantity, receiptId, `${key}:${item.productId}`],
        );
      }
      const grandTotal = subtotal + taxTotal;
      const receipt = await client.query(
        `UPDATE purchase_receipts SET subtotal = $2, tax_total = $3, grand_total = $4
         WHERE tenant_id = $1 AND id = $5
         RETURNING id, receipt_number AS "receiptNumber", status, subtotal::text,
                   tax_total::text AS "taxTotal", grand_total::text AS "grandTotal"`,
        [actor.tenantId, formatMoney(subtotal), formatMoney(taxTotal), formatMoney(grandTotal), receiptId],
      );
      await notifyInventoryChanged(client, { tenantId: actor.tenantId, branchId: body.branchId!, productIds: ids });
      return { receipt: receipt.rows[0], replayed: false };
    });
    if ("conflict" in result && result.conflict) return reply.code(409).send({ error: { code: "IDEMPOTENCY_KEY_REUSED", message: "This Idempotency-Key was already used with a different goods receipt. Use a new key." } });
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
}
