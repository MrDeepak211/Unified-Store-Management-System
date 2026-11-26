import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { buildApp } from "./app.js";
import { closePool, getPool } from "./db.js";

const issuer = "http://127.0.0.1:45873/auth/v1";
const audience = "authenticated";
const tenantA = randomUUID();
const tenantB = randomUUID();
const branchA = randomUUID();
const branchB = randomUUID();
const branchC = randomUUID();
const ownerSubject = randomUUID();
const cashierSubject = randomUUID();
const managerSubject = randomUUID();
const inactiveSubject = randomUUID();
let server: Server;
let jwksUrl = "";
let ownerToken = "";
let cashierToken = "";
let managerToken = "";
let inactiveToken = "";
let app: Awaited<ReturnType<typeof buildApp>>;

async function sign(subject: string, privateKey: KeyLike, kid: string) {
  return new SignJWT({ email: `${subject}@usms.test` })
    .setProtectedHeader({ alg: "ES256", kid, typ: "JWT" })
    .setSubject(subject)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey as never);
}

before(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for authenticated API integration tests.");
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  const kid = "usms-ci-integration-key";
  const document = { keys: [{ ...jwk, kid, use: "sig", alg: "ES256" }] };
  server = createServer((request, response) => {
    if (request.url === "/.well-known/jwks.json") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(document));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind local JWKS test server.");
  jwksUrl = `http://127.0.0.1:${address.port}/.well-known/jwks.json`;
  process.env.SUPABASE_JWKS_URL = jwksUrl;
  process.env.SUPABASE_JWT_ISSUER = issuer;
  process.env.SUPABASE_JWT_AUDIENCE = audience;

  const pool = getPool();
  await pool.query("INSERT INTO tenants (id, name, slug) VALUES ($1, 'Integration A', $2), ($3, 'Integration B', $4)", [
    tenantA, `it-${tenantA}`, tenantB, `it-${tenantB}`,
  ]);
  await pool.query(
    "INSERT INTO branches (id, tenant_id, name, code, is_default) VALUES ($1, $2, 'Main', 'MAIN', true), ($3, $4, 'Other', 'OTHER', true)",
    [branchA, tenantA, branchB, tenantB],
  );
  await pool.query(
    "INSERT INTO branches (id, tenant_id, name, code, is_default) VALUES ($1, $2, 'Restricted', 'RESTRICTED', false)",
    [branchC, tenantA],
  );
  await pool.query(
    `INSERT INTO tenant_memberships (tenant_id, auth_subject, email, role, branch_ids, is_active)
     VALUES ($1, $2, 'owner@usms.test', 'owner', '{}', true),
            ($1, $3, 'cashier@usms.test', 'cashier', ARRAY[$4]::uuid[], true),
            ($1, $7, 'manager@usms.test', 'manager', ARRAY[$4]::uuid[], true),
            ($5, $6, 'inactive@usms.test', 'owner', '{}', false)`,
    [tenantA, ownerSubject, cashierSubject, branchA, tenantB, inactiveSubject, managerSubject],
  );
  ownerToken = await sign(ownerSubject, privateKey, kid);
  cashierToken = await sign(cashierSubject, privateKey, kid);
  managerToken = await sign(managerSubject, privateKey, kid);
  inactiveToken = await sign(inactiveSubject, privateKey, kid);
  app = await buildApp();
});

after(async () => {
  if (app) await app.close();
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (process.env.DATABASE_URL) {
    const pool = getPool();
    await pool.query("DELETE FROM inventory_count_items WHERE tenant_id = $1", [tenantA]);
    await pool.query("DELETE FROM inventory_count_sessions WHERE tenant_id = $1", [tenantA]);
    await pool.query("DELETE FROM inventory_movements WHERE tenant_id = $1", [tenantA]);
    await pool.query("DELETE FROM inventory_balances WHERE tenant_id = $1", [tenantA]);
    await pool.query("DELETE FROM inventory_balances WHERE tenant_id = $1", [tenantB]);
    await pool.query("DELETE FROM inventory_balances WHERE branch_id IN (SELECT id FROM branches WHERE tenant_id = ANY($1::uuid[]))", [[tenantA, tenantB]]);
    await pool.query("DELETE FROM supplier_payment_allocations WHERE tenant_id = $1", [tenantA]);
    await pool.query("DELETE FROM supplier_payments WHERE tenant_id = $1", [tenantA]);
    await pool.query("DELETE FROM supplier_purchase_return_items WHERE tenant_id = $1", [tenantA]);
    await pool.query("DELETE FROM supplier_purchase_returns WHERE tenant_id = $1", [tenantA]);
    await pool.query("DELETE FROM sales_returns WHERE tenant_id = $1", [tenantA]);
    await pool.query("DELETE FROM purchase_receipt_items WHERE tenant_id = $1", [tenantA]);
    await pool.query("DELETE FROM purchase_receipts WHERE tenant_id = $1", [tenantA]);
    await pool.query("DELETE FROM suppliers WHERE tenant_id = $1", [tenantA]);
    await pool.query("DELETE FROM products WHERE tenant_id = $1", [tenantA]);
    await pool.query("DELETE FROM products WHERE tenant_id = $1", [tenantB]);
    await pool.query("DELETE FROM inventory_transfers WHERE tenant_id = $1", [tenantA]);
    await pool.query("DELETE FROM sales_orders WHERE tenant_id = $1", [tenantA]);
    await pool.query("DELETE FROM tenant_memberships WHERE tenant_id = ANY($1::uuid[])", [[tenantA, tenantB]]);
    await pool.query("DELETE FROM branches WHERE tenant_id = ANY($1::uuid[])", [[tenantA, tenantB]]);
    await pool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [[tenantA, tenantB]]);
    await closePool();
  }
});

test("authenticated tenant membership, inactive access, roles and branch scope are enforced", async () => {
  const ownerHeaders = { authorization: `Bearer ${ownerToken}`, "x-usms-tenant": tenantA };
  const cashierHeaders = { authorization: `Bearer ${cashierToken}`, "x-usms-tenant": tenantA };
  const managerHeaders = { authorization: `Bearer ${managerToken}`, "x-usms-tenant": tenantA };

  const ownerProducts = await app.inject({ method: "GET", url: "/api/v1/business/products", headers: ownerHeaders });
  assert.equal(ownerProducts.statusCode, 200, ownerProducts.body);

  const crossTenant = await app.inject({
    method: "GET", url: "/api/v1/business/products",
    headers: { authorization: `Bearer ${ownerToken}`, "x-usms-tenant": tenantB },
  });
  assert.equal(crossTenant.statusCode, 403, crossTenant.body);

  const inactive = await app.inject({
    method: "GET", url: "/api/v1/business/products",
    headers: { authorization: `Bearer ${inactiveToken}`, "x-usms-tenant": tenantB },
  });
  assert.equal(inactive.statusCode, 403, inactive.body);

  const cashierStaff = await app.inject({ method: "GET", url: "/api/v1/business/staff", headers: cashierHeaders });
  assert.equal(cashierStaff.statusCode, 403, cashierStaff.body);

  const ownerStaff = await app.inject({ method: "GET", url: "/api/v1/business/staff", headers: ownerHeaders });
  assert.equal(ownerStaff.statusCode, 200, ownerStaff.body);

  const cashierCategoryWrite = await app.inject({
    method: "POST", url: "/api/v1/business/categories",
    headers: { ...cashierHeaders, "content-type": "application/json" }, payload: { name: "Test" },
  });
  assert.equal(cashierCategoryWrite.statusCode, 403, cashierCategoryWrite.body);

  const ownerValidation = await app.inject({
    method: "POST", url: "/api/v1/business/categories",
    headers: { ...ownerHeaders, "content-type": "application/json" }, payload: { name: "" },
  });
  assert.equal(ownerValidation.statusCode, 400, ownerValidation.body);

  const assignedBranch = await app.inject({
    method: "GET", url: `/api/v1/business/products?branchId=${branchA}`, headers: cashierHeaders,
  });
  assert.equal(assignedBranch.statusCode, 200, assignedBranch.body);

  const unassignedBranch = await app.inject({
    method: "GET", url: `/api/v1/business/products?branchId=${branchB}`, headers: cashierHeaders,
  });
  assert.equal(unassignedBranch.statusCode, 403, unassignedBranch.body);

  const managerProductOnUnassignedBranch = await app.inject({
    method: "POST", url: "/api/v1/business/products",
    headers: { ...managerHeaders, "content-type": "application/json" },
    payload: { sku: "UNASSIGNED-001", name: "Blocked Product", branchId: branchB, price: "10.00", taxRate: "0" },
  });
  assert.equal(managerProductOnUnassignedBranch.statusCode, 403, managerProductOnUnassignedBranch.body);

  const pool = getPool();
  const replaySaleId = randomUUID();
  const replayTransferId = randomUUID();
  const replayReturnId = randomUUID();
  const replayPurchaseId = randomUUID();
  await pool.query(
    `INSERT INTO sales_orders (id, tenant_id, branch_id, channel, status, order_number, idempotency_key)
     VALUES ($1, $2, $3, 'pos', 'confirmed', $4, 'manager-sale-replay-key')`,
    [replaySaleId, tenantA, branchC, `IT-${replaySaleId.slice(0, 8)}`],
  );
  await pool.query(
    `INSERT INTO inventory_transfers (id, tenant_id, from_branch_id, to_branch_id, transfer_number, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, 'manager-transfer-replay-key')`,
    [replayTransferId, tenantA, branchA, branchC, `TRF-${replayTransferId.slice(0, 8)}`],
  );
  await pool.query(
    `INSERT INTO sales_returns (id, tenant_id, branch_id, sales_order_id, return_number, status, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, 'inspection_pending', 'manager-return-replay-key')`,
    [replayReturnId, tenantA, branchC, replaySaleId, `RET-${replayReturnId.slice(0, 8)}`],
  );
  await pool.query(
    `INSERT INTO purchase_receipts (id, tenant_id, branch_id, receipt_number, idempotency_key)
     VALUES ($1, $2, $3, $4, 'manager-purchase-replay-key')`,
    [replayPurchaseId, tenantA, branchC, `GRN-${replayPurchaseId.slice(0, 8)}`],
  );

  const replayedSale = await app.inject({
    method: "POST", url: "/api/v1/pos/sales",
    headers: { ...managerHeaders, "content-type": "application/json", "idempotency-key": "manager-sale-replay-key" },
    payload: { branchId: branchC, items: [{ productId: randomUUID(), quantity: 1 }] },
  });
  assert.equal(replayedSale.statusCode, 403, replayedSale.body);

  const replayedTransfer = await app.inject({
    method: "POST", url: "/api/v1/business/inventory/transfers",
    headers: { ...managerHeaders, "content-type": "application/json", "idempotency-key": "manager-transfer-replay-key" },
    payload: { fromBranchId: branchA, toBranchId: branchC, items: [{ productId: randomUUID(), quantity: 1 }] },
  });
  assert.equal(replayedTransfer.statusCode, 403, replayedTransfer.body);

  const replayedReturn = await app.inject({
    method: "POST", url: `/api/v1/business/sales/${replaySaleId}/returns`,
    headers: { ...managerHeaders, "content-type": "application/json", "idempotency-key": "manager-return-replay-key" },
    payload: { items: [{ productId: randomUUID(), quantity: 1 }] },
  });
  assert.equal(replayedReturn.statusCode, 403, replayedReturn.body);

  const replayedPurchase = await app.inject({
    method: "POST", url: "/api/v1/business/purchases/receipts",
    headers: { ...managerHeaders, "content-type": "application/json", "idempotency-key": "manager-purchase-replay-key" },
    payload: { branchId: branchC, items: [{ productId: randomUUID(), quantity: 1, unitCost: "10.00" }] },
  });
  assert.equal(replayedPurchase.statusCode, 403, replayedPurchase.body);
});


test("inventory reconciliation enforces tenant, branch, role, completeness, stale-stock and approval replay rules", async () => {
  const pool = getPool();
  const ownerHeaders = { authorization: `Bearer ${ownerToken}`, "x-usms-tenant": tenantA };
  const cashierHeaders = { authorization: `Bearer ${cashierToken}`, "x-usms-tenant": tenantA };
  const managerHeaders = { authorization: `Bearer ${managerToken}`, "x-usms-tenant": tenantA };
  const productA = randomUUID();
  const productB = randomUUID();
  const foreignProduct = randomUUID();
  await pool.query(
    `INSERT INTO products (id, tenant_id, sku, name, price, tax_rate)
     VALUES ($1,$2,'COUNT-A','Count product A',10,0), ($3,$2,'COUNT-B','Count product B',20,0), ($4,$5,'FOREIGN','Foreign product',5,0)`,
    [productA, tenantA, productB, foreignProduct, tenantB],
  );
  await pool.query(
    `INSERT INTO inventory_balances (tenant_id, branch_id, product_id, on_hand, reserved)
     VALUES ($1,$2,$3,10,2), ($1,$2,$4,5,0), ($5,$6,$7,8,0)`,
    [tenantA, branchA, productA, productB, tenantB, branchB, foreignProduct],
  );

  const start = await app.inject({
    method: "POST", url: "/api/v1/business/inventory/count-sessions",
    headers: { ...managerHeaders, "content-type": "application/json" },
    payload: { branchId: branchA },
  });
  assert.equal(start.statusCode, 201, start.body);
  const sessionId = start.json().session.id as string;
  const listed = await app.inject({ method: "GET", url: `/api/v1/business/inventory/count-sessions/${sessionId}`, headers: ownerHeaders });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().items.length, 2);

  const foreignTenantRead = await app.inject({
    method: "GET", url: `/api/v1/business/inventory/count-sessions/${sessionId}`,
    headers: { authorization: `Bearer ${inactiveToken}`, "x-usms-tenant": tenantB },
  });
  assert.equal(foreignTenantRead.statusCode, 403, foreignTenantRead.body);

  const restrictedBranchStart = await app.inject({
    method: "POST", url: "/api/v1/business/inventory/count-sessions",
    headers: { ...managerHeaders, "content-type": "application/json" },
    payload: { branchId: branchC },
  });
  assert.equal(restrictedBranchStart.statusCode, 403, restrictedBranchStart.body);

  const firstItem = listed.json().items.find((item: { productId: string }) => item.productId === productA);
  const secondItem = listed.json().items.find((item: { productId: string }) => item.productId === productB);
  assert.ok(firstItem?.id);
  assert.ok(secondItem?.id);

  const cashierCanRecord = await app.inject({
    method: "PATCH", url: `/api/v1/business/inventory/count-sessions/${sessionId}/items/${firstItem.id}`,
    headers: { ...cashierHeaders, "content-type": "application/json" }, payload: { countedQuantity: 9 },
  });
  assert.equal(cashierCanRecord.statusCode, 200, cashierCanRecord.body);

  const cashierCannotApprove = await app.inject({
    method: "POST", url: `/api/v1/business/inventory/count-sessions/${sessionId}/approve`,
    headers: { ...cashierHeaders, "idempotency-key": "cashier-count-approval" },
  });
  assert.equal(cashierCannotApprove.statusCode, 403, cashierCannotApprove.body);

  const incompleteApproval = await app.inject({
    method: "POST", url: `/api/v1/business/inventory/count-sessions/${sessionId}/approve`,
    headers: { ...ownerHeaders, "idempotency-key": "owner-count-incomplete" },
  });
  assert.equal(incompleteApproval.statusCode, 409, incompleteApproval.body);

  const invalidCount = await app.inject({
    method: "PATCH", url: `/api/v1/business/inventory/count-sessions/${sessionId}/items/${secondItem.id}`,
    headers: { ...managerHeaders, "content-type": "application/json" }, payload: { countedQuantity: -1 },
  });
  assert.equal(invalidCount.statusCode, 400, invalidCount.body);

  const secondCount = await app.inject({
    method: "PATCH", url: `/api/v1/business/inventory/count-sessions/${sessionId}/items/${secondItem.id}`,
    headers: { ...managerHeaders, "content-type": "application/json" }, payload: { countedQuantity: 5 },
  });
  assert.equal(secondCount.statusCode, 200, secondCount.body);

  await pool.query("UPDATE inventory_balances SET on_hand=11 WHERE tenant_id=$1 AND branch_id=$2 AND product_id=$3", [tenantA, branchA, productA]);
  const staleApproval = await app.inject({
    method: "POST", url: `/api/v1/business/inventory/count-sessions/${sessionId}/approve`,
    headers: { ...ownerHeaders, "idempotency-key": "owner-count-stale" },
  });
  assert.equal(staleApproval.statusCode, 409, staleApproval.body);
  const unchangedAfterStale = await pool.query("SELECT on_hand FROM inventory_balances WHERE tenant_id=$1 AND branch_id=$2 AND product_id=$3", [tenantA, branchA, productB]);
  assert.equal(unchangedAfterStale.rows[0].on_hand, 5, "stale approval must not partially post any product");

  const fresh = await app.inject({
    method: "POST", url: "/api/v1/business/inventory/count-sessions",
    headers: { ...ownerHeaders, "content-type": "application/json" }, payload: { branchId: branchA, productIds: [productA] },
  });
  assert.equal(fresh.statusCode, 201, fresh.body);
  const freshId = fresh.json().session.id as string;
  const freshDetails = await app.inject({ method: "GET", url: `/api/v1/business/inventory/count-sessions/${freshId}`, headers: ownerHeaders });
  const freshItem = freshDetails.json().items[0];
  assert.equal(freshItem.expectedQuantity, 11);
  const recordFresh = await app.inject({
    method: "PATCH", url: `/api/v1/business/inventory/count-sessions/${freshId}/items/${freshItem.id}`,
    headers: { ...managerHeaders, "content-type": "application/json" }, payload: { countedQuantity: 7 },
  });
  assert.equal(recordFresh.statusCode, 200, recordFresh.body);
  const approvalKey = "owner-count-approval-key-001";
  const approval = await app.inject({
    method: "POST", url: `/api/v1/business/inventory/count-sessions/${freshId}/approve`,
    headers: { ...ownerHeaders, "idempotency-key": approvalKey },
  });
  assert.equal(approval.statusCode, 201, approval.body);
  assert.equal(approval.json().movementCount, 1);
  const replay = await app.inject({
    method: "POST", url: `/api/v1/business/inventory/count-sessions/${freshId}/approve`,
    headers: { ...ownerHeaders, "idempotency-key": approvalKey },
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().replayed, true);
  const differentKey = await app.inject({
    method: "POST", url: `/api/v1/business/inventory/count-sessions/${freshId}/approve`,
    headers: { ...ownerHeaders, "idempotency-key": "owner-count-different-key" },
  });
  assert.equal(differentKey.statusCode, 409, differentKey.body);
  const finalBalance = await pool.query("SELECT on_hand, reserved FROM inventory_balances WHERE tenant_id=$1 AND branch_id=$2 AND product_id=$3", [tenantA, branchA, productA]);
  assert.equal(finalBalance.rows[0].on_hand, 7);
  assert.equal(finalBalance.rows[0].reserved, 2);
  const audit = await pool.query("SELECT COUNT(*)::int AS count FROM inventory_movements WHERE tenant_id=$1 AND reference_type='inventory_count' AND reference_id=$2", [tenantA, freshId]);
  assert.equal(audit.rows[0].count, 1, "same-key approval replay must not duplicate audit movements");
});


test("supplier payments reconcile partial balances, reject overpayment and replay idempotently", async () => {
  const pool = getPool();
  const ownerHeaders = { authorization: `Bearer ${ownerToken}`, "x-usms-tenant": tenantA };
  const supplierId = randomUUID();
  const receiptId = randomUUID();
  await pool.query("INSERT INTO suppliers (id, tenant_id, name) VALUES ($1,$2,'Ledger Test Supplier')", [supplierId, tenantA]);
  const productId = randomUUID();
  await pool.query("INSERT INTO products (id, tenant_id, sku, name, price, tax_rate) VALUES ($1,$2,'SUP-RETURN-001','Returnable supplier item',30,0)", [productId, tenantA]);
  await pool.query("INSERT INTO inventory_balances (tenant_id, branch_id, product_id, on_hand, reserved) VALUES ($1,$2,$3,5,1)", [tenantA, branchA, productId]);
  await pool.query(
    `INSERT INTO purchase_receipts (id, tenant_id, branch_id, supplier_id, receipt_number, status, subtotal, tax_total, grand_total, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,'received',100,0,100,$6)`,
    [receiptId, tenantA, branchA, supplierId, `GRN-${receiptId.slice(0,8)}`, `receipt-${receiptId}`],
  );
  const receiptItemId = randomUUID();
  await pool.query(
    `INSERT INTO purchase_receipt_items (id,tenant_id,receipt_id,product_id,quantity,unit_cost,tax_rate,line_total)
     VALUES ($1,$2,$3,$4,5,20,0,100)`,
    [receiptItemId,tenantA,receiptId,productId],
  );

  const paymentHeaders = { ...ownerHeaders, "content-type": "application/json", "idempotency-key": "supplier-payment-key-001" };
  const payment = await app.inject({
    method: "POST", url: `/api/v1/business/suppliers/${supplierId}/payments`,
    headers: paymentHeaders,
    payload: { branchId: branchA, amount: "40.00", paymentMethod: "cash", reference: "Cash voucher 1" },
  });
  assert.equal(payment.statusCode, 201, payment.body);
  assert.equal(payment.json().payment.amount, "40.00");

  const replay = await app.inject({
    method: "POST", url: `/api/v1/business/suppliers/${supplierId}/payments`,
    headers: paymentHeaders,
    payload: { branchId: branchA, amount: "40.00", paymentMethod: "cash", reference: "Cash voucher 1" },
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().replayed, true);

  const changedReplay = await app.inject({
    method: "POST", url: `/api/v1/business/suppliers/${supplierId}/payments`,
    headers: paymentHeaders,
    payload: { branchId: branchA, amount: "41.00", paymentMethod: "cash", reference: "Cash voucher 1" },
  });
  assert.equal(changedReplay.statusCode, 409, changedReplay.body);

  const overpayment = await app.inject({
    method: "POST", url: `/api/v1/business/suppliers/${supplierId}/payments`,
    headers: { ...ownerHeaders, "content-type": "application/json", "idempotency-key": "supplier-payment-key-002" },
    payload: { branchId: branchA, amount: "60.01", paymentMethod: "upi" },
  });
  assert.equal(overpayment.statusCode, 409, overpayment.body);

  const purchaseReturn = await app.inject({
    method: "POST", url: `/api/v1/business/purchases/receipts/${receiptId}/returns`,
    headers: { ...ownerHeaders, "content-type": "application/json", "idempotency-key": "supplier-return-key-001" },
    payload: { reason: "Damaged packaging", items: [{ receiptItemId, quantity: 1 }] },
  });
  assert.equal(purchaseReturn.statusCode, 201, purchaseReturn.body);
  assert.equal(purchaseReturn.json().creditNote.creditTotal, "20.00");
  const returnReplay = await app.inject({
    method: "POST", url: `/api/v1/business/purchases/receipts/${receiptId}/returns`,
    headers: { ...ownerHeaders, "content-type": "application/json", "idempotency-key": "supplier-return-key-001" },
    payload: { reason: "Damaged packaging", items: [{ receiptItemId, quantity: 1 }] },
  });
  assert.equal(returnReplay.statusCode, 200, returnReplay.body);
  assert.equal(returnReplay.json().replayed, true);
  const overReturn = await app.inject({
    method: "POST", url: `/api/v1/business/purchases/receipts/${receiptId}/returns`,
    headers: { ...ownerHeaders, "content-type": "application/json", "idempotency-key": "supplier-return-key-002" },
    payload: { items: [{ receiptItemId, quantity: 5 }] },
  });
  assert.equal(overReturn.statusCode, 409, overReturn.body);
  const afterReturnStock = await pool.query("SELECT on_hand,reserved FROM inventory_balances WHERE tenant_id=$1 AND branch_id=$2 AND product_id=$3", [tenantA,branchA,productId]);
  assert.equal(afterReturnStock.rows[0].on_hand, 4);
  assert.equal(afterReturnStock.rows[0].reserved, 1);

  const paymentAllocationHeaders = { ...ownerHeaders, "content-type": "application/json", "idempotency-key": "supplier-allocation-payment-001" };
  const paymentAllocation = await app.inject({
    method: "POST", url: `/api/v1/business/suppliers/${supplierId}/allocations`,
    headers: paymentAllocationHeaders,
    payload: { sourceType: "payment", sourceId: payment.json().payment.id, allocations: [{ receiptId, amount: "25.00" }] },
  });
  assert.equal(paymentAllocation.statusCode, 201, paymentAllocation.body);
  assert.equal(paymentAllocation.json().allocatedAmount, "25.00");
  const paymentAllocationReplay = await app.inject({
    method: "POST", url: `/api/v1/business/suppliers/${supplierId}/allocations`,
    headers: paymentAllocationHeaders,
    payload: { sourceType: "payment", sourceId: payment.json().payment.id, allocations: [{ receiptId, amount: "25.00" }] },
  });
  assert.equal(paymentAllocationReplay.statusCode, 200, paymentAllocationReplay.body);
  assert.equal(paymentAllocationReplay.json().replayed, true);
  const paymentOverAllocation = await app.inject({
    method: "POST", url: `/api/v1/business/suppliers/${supplierId}/allocations`,
    headers: { ...ownerHeaders, "content-type": "application/json", "idempotency-key": "supplier-allocation-payment-002" },
    payload: { sourceType: "payment", sourceId: payment.json().payment.id, allocations: [{ receiptId, amount: "15.01" }] },
  });
  assert.equal(paymentOverAllocation.statusCode, 409, paymentOverAllocation.body);

  const creditAllocation = await app.inject({
    method: "POST", url: `/api/v1/business/suppliers/${supplierId}/allocations`,
    headers: { ...ownerHeaders, "content-type": "application/json", "idempotency-key": "supplier-allocation-credit-001" },
    payload: { sourceType: "credit_note", sourceId: purchaseReturn.json().creditNote.id, allocations: [{ receiptId, amount: "10.00" }] },
  });
  assert.equal(creditAllocation.statusCode, 201, creditAllocation.body);
  const receiptOverAllocation = await app.inject({
    method: "POST", url: `/api/v1/business/suppliers/${supplierId}/allocations`,
    headers: { ...ownerHeaders, "content-type": "application/json", "idempotency-key": "supplier-allocation-credit-002" },
    payload: { sourceType: "credit_note", sourceId: purchaseReturn.json().creditNote.id, allocations: [{ receiptId, amount: "10.01" }] },
  });
  assert.equal(receiptOverAllocation.statusCode, 409, receiptOverAllocation.body);

  const statement = await app.inject({
    method: "GET", url: `/api/v1/business/suppliers/${supplierId}/statement`, headers: ownerHeaders,
  });
  assert.equal(statement.statusCode, 200, statement.body);
  assert.equal(statement.json().summary.totalPurchased, "100.00");
  assert.equal(statement.json().summary.totalReturned, "20.00");
  assert.equal(statement.json().summary.totalPaid, "40.00");
  assert.equal(statement.json().summary.outstanding, "40.00");
  assert.equal(statement.json().entries.length, 3);
  const statementPrint = await app.inject({
    method: "GET", url: `/api/v1/business/suppliers/${supplierId}/statement.print`, headers: ownerHeaders,
  });
  assert.equal(statementPrint.statusCode, 200, statementPrint.body);
  assert.match(statementPrint.headers["content-type"] ?? "", /text\/html/);
  assert.match(statementPrint.body, /Supplier Statement/);
  assert.match(statementPrint.body, /Print \/ Save as PDF/);
  assert.match(statementPrint.body, /Receipt allocation reconciliation/);
  assert.match(statementPrint.body, /window\.print\(\)/);
  const statementCsv = await app.inject({
    method: "GET", url: `/api/v1/business/suppliers/${supplierId}/statement.csv`, headers: ownerHeaders,
  });
  assert.equal(statementCsv.statusCode, 200, statementCsv.body);
  assert.match(statementCsv.headers["content-type"] ?? "", /text\/csv/);
  assert.match(statementCsv.headers["content-disposition"] ?? "", /attachment; filename=supplier-statement\.csv/);
  assert.match(statementCsv.body, /Running balance/);
  assert.match(statementCsv.body, /purchase_return/);


  const receiptBalances = await app.inject({
    method: "GET", url: `/api/v1/business/suppliers/${supplierId}/receipt-balances`, headers: ownerHeaders,
  });
  assert.equal(receiptBalances.statusCode, 200, receiptBalances.body);
  assert.equal(receiptBalances.json().receipts[0].allocatedPayments, "25.00");
  assert.equal(receiptBalances.json().receipts[0].allocatedCredits, "10.00");
  assert.equal(receiptBalances.json().receipts[0].outstanding, "65.00");
  assert.equal(statement.json().summary.allocatedPayments, "25.00");
  assert.equal(statement.json().summary.allocatedCredits, "10.00");
  assert.equal(statement.json().summary.unallocatedPayments, "15.00");
  assert.equal(statement.json().summary.unallocatedCredits, "10.00");
  const allocationHistory = await app.inject({
    method: "GET", url: `/api/v1/business/suppliers/${supplierId}/allocation-history`, headers: ownerHeaders,
  });
  assert.equal(allocationHistory.statusCode, 200, allocationHistory.body);
  assert.equal(allocationHistory.json().allocations.length, 2);
  assert.deepEqual(new Set(allocationHistory.json().allocations.map((row: { source_type: string }) => row.source_type)), new Set(["payment", "credit_note"]));
  const supplierList = await app.inject({ method: "GET", url: "/api/v1/business/suppliers", headers: ownerHeaders });
  const supplier = supplierList.json().suppliers.find((row: { id: string }) => row.id === supplierId);
  assert.equal(supplier.outstanding, "40.00");

  const paymentCount = await pool.query("SELECT COUNT(*)::int AS count FROM supplier_payments WHERE tenant_id=$1 AND supplier_id=$2", [tenantA, supplierId]);
  assert.equal(paymentCount.rows[0].count, 1, "idempotent replay must not create a duplicate supplier payment");
  const returnCount = await pool.query("SELECT COUNT(*)::int AS count FROM supplier_purchase_returns WHERE tenant_id=$1 AND supplier_id=$2", [tenantA,supplierId]);
  assert.equal(returnCount.rows[0].count, 1, "idempotent replay must not create a duplicate supplier credit note");
});
