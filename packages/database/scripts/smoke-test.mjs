import pg from "pg";
import { randomUUID } from "node:crypto";

const { Pool } = pg;
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
const tenantA = randomUUID();
const tenantB = randomUUID();
const branchA = randomUUID();
const branchB = randomUUID();
const productA = randomUUID();
const productB = randomUUID();

try {
  await client.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'usms_runtime_test') THEN
      CREATE ROLE usms_runtime_test NOLOGIN NOBYPASSRLS;
    END IF;
  END $$`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, branches, products, inventory_balances,
    inventory_movements, sales_orders, sales_order_items, tenant_memberships, storefront_settings TO usms_runtime_test`);

  await client.query("BEGIN");
  await client.query("INSERT INTO tenants (id, name, slug) VALUES ($1, 'Smoke A', $2), ($3, 'Smoke B', $4)", [tenantA, `smoke-a-${tenantA.slice(0,8)}`, tenantB, `smoke-b-${tenantB.slice(0,8)}`]);
  await client.query("INSERT INTO branches (id, tenant_id, name, code, is_default) VALUES ($1,$2,'Main','MAIN',true),($3,$4,'Main','MAIN',true)", [branchA,tenantA,branchB,tenantB]);
  await client.query("INSERT INTO products (id, tenant_id, sku, name, price) VALUES ($1,$2,'SKU-A','Test Product A', '10.00'),($3,$4,'SKU-B','Test Product B','10.00')", [productA,tenantA,productB,tenantB]);
  await client.query("INSERT INTO inventory_balances (tenant_id, branch_id, product_id, on_hand, reserved) VALUES ($1,$2,$3,5,2),($4,$5,$6,9,0)", [tenantA,branchA,productA,tenantB,branchB,productB]);

  await client.query("SET LOCAL ROLE usms_runtime_test");
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
  const visible = await client.query("SELECT id FROM branches");
  if (visible.rowCount !== 1 || visible.rows[0].id !== branchA) throw new Error("Tenant RLS isolation test failed.");
  const hiddenProduct = await client.query("SELECT id FROM products WHERE id = $1", [productB]);
  if (hiddenProduct.rowCount !== 0) throw new Error("Cross-tenant product was visible.");

  const oversell = await client.query(
    `UPDATE inventory_balances SET on_hand = on_hand - 4
     WHERE tenant_id = $1 AND branch_id = $2 AND product_id = $3 AND on_hand - reserved >= 4
     RETURNING on_hand`,
    [tenantA,branchA,productA],
  );
  if (oversell.rowCount !== 0) throw new Error("Oversell guard allowed a sale beyond available stock.");

  const validSale = await client.query(
    `UPDATE inventory_balances SET on_hand = on_hand - 3
     WHERE tenant_id = $1 AND branch_id = $2 AND product_id = $3 AND on_hand - reserved >= 3
     RETURNING on_hand, reserved`,
    [tenantA,branchA,productA],
  );
  if (validSale.rowCount !== 1 || validSale.rows[0].on_hand !== 2 || validSale.rows[0].reserved !== 2) {
    throw new Error("Valid POS stock deduction failed.");
  }
  const oversubscribe = await client.query(
    `UPDATE inventory_balances SET reserved = reserved + 1
     WHERE tenant_id = $1 AND branch_id = $2 AND product_id = $3 AND on_hand - reserved >= 1
     RETURNING reserved`,
    [tenantA,branchA,productA],
  );
  if (oversubscribe.rowCount !== 0) throw new Error("Online reservation exceeded remaining available stock.");

  await client.query("ROLLBACK");

  // Exercise the same order-row serialization used by payment confirmation and reservation expiry.
  const raceTenant = randomUUID();
  const raceBranch = randomUUID();
  const raceProduct = randomUUID();
  const paidOrder = randomUUID();
  const expiredOrder = randomUUID();
  await client.query("BEGIN");
  await client.query("INSERT INTO tenants (id, name, slug) VALUES ($1, 'Payment Race Test', $2)", [raceTenant, `payment-race-${raceTenant.slice(0,8)}`]);
  await client.query("INSERT INTO branches (id, tenant_id, name, code, is_default) VALUES ($1,$2,'Main','MAIN',true)", [raceBranch, raceTenant]);
  await client.query("INSERT INTO products (id, tenant_id, sku, name, price) VALUES ($1,$2,'RACE-SKU','Race Product', '10.00')", [raceProduct, raceTenant]);
  await client.query("INSERT INTO inventory_balances (tenant_id, branch_id, product_id, on_hand, reserved) VALUES ($1,$2,$3,10,4)", [raceTenant, raceBranch, raceProduct]);
  await client.query(
    `INSERT INTO sales_orders (id, tenant_id, branch_id, channel, status, payment_status, order_number, subtotal, tax_total, grand_total, idempotency_key, reservation_expires_at)
     VALUES ($1,$2,$3,'online','pending','pending','RACE-PAID',20,0,20,'race-paid-key',now()+interval '15 minutes'),
            ($4,$2,$3,'online','pending','pending','RACE-EXPIRED',20,0,20,'race-expired-key',now()-interval '1 minute')`,
    [paidOrder, raceTenant, raceBranch, expiredOrder],
  );
  await client.query(
    "INSERT INTO sales_order_items (tenant_id, order_id, product_id, quantity, unit_price, tax_rate, line_total) VALUES ($1,$2,$3,2,10,0,20),($1,$4,$3,2,10,0,20)",
    [raceTenant, paidOrder, raceProduct, expiredOrder],
  );
  await client.query(
    `INSERT INTO payments (tenant_id, sales_order_id, provider, provider_order_id, amount_paise, currency, status, idempotency_key)
     VALUES ($1,$2,'razorpay','race-provider-paid',2000,'INR','created','race-payment-paid'),
            ($1,$3,'razorpay','race-provider-expired',2000,'INR','created','race-payment-expired')`,
    [raceTenant, paidOrder, expiredOrder],
  );
  await client.query("COMMIT");

  const settleClient = await pool.connect();
  const duplicateClient = await pool.connect();
  try {
    await settleClient.query("BEGIN");
    const firstLock = await settleClient.query("SELECT status, payment_status FROM sales_orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [raceTenant, paidOrder]);
    if (firstLock.rows[0]?.status !== "pending") throw new Error("Payment race fixture was not pending.");
    await duplicateClient.query("BEGIN");
    const waitingDuplicate = duplicateClient.query("SELECT status, payment_status FROM sales_orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [raceTenant, paidOrder]);
    await new Promise((resolve) => setTimeout(resolve, 75));
    await settleClient.query("UPDATE inventory_balances SET on_hand=on_hand-2,reserved=reserved-2 WHERE tenant_id=$1 AND branch_id=$2 AND product_id=$3 AND on_hand>=2 AND reserved>=2", [raceTenant,raceBranch,raceProduct]);
    await settleClient.query("INSERT INTO inventory_movements (tenant_id,branch_id,product_id,movement_type,quantity_delta,reference_type,reference_id,idempotency_key) VALUES ($1,$2,$3,'online_sale',-2,'sales_order',$4,'race-paid-sale'),($1,$2,$3,'reservation_release',-2,'sales_order',$4,'race-paid-release')", [raceTenant,raceBranch,raceProduct,paidOrder]);
    await settleClient.query("UPDATE sales_orders SET status='confirmed',payment_status='paid' WHERE tenant_id=$1 AND id=$2", [raceTenant,paidOrder]);
    await settleClient.query("UPDATE payments SET status='captured' WHERE tenant_id=$1 AND sales_order_id=$2", [raceTenant,paidOrder]);
    await settleClient.query("COMMIT");
    const duplicateState = (await waitingDuplicate).rows[0];
    if (duplicateState?.status !== "confirmed" || duplicateState?.payment_status !== "paid") throw new Error("Concurrent duplicate payment did not observe the settled order.");
    await duplicateClient.query("COMMIT");
    const paidState = await client.query("SELECT on_hand,reserved FROM inventory_balances WHERE tenant_id=$1 AND branch_id=$2 AND product_id=$3", [raceTenant,raceBranch,raceProduct]);
    const paidMovements = await client.query("SELECT movement_type,COUNT(*)::int AS count FROM inventory_movements WHERE tenant_id=$1 AND reference_id=$2 GROUP BY movement_type", [raceTenant,paidOrder]);
    if (paidState.rows[0]?.on_hand !== 8 || paidState.rows[0]?.reserved !== 0 ||
        paidMovements.rows.reduce((sum,row)=>sum+row.count,0) !== 2) {
      throw new Error("Concurrent payment settlement deducted or released stock more than once.");
    }
  } finally {
    await settleClient.query("ROLLBACK").catch(()=>{});
    await duplicateClient.query("ROLLBACK").catch(()=>{});
    settleClient.release();
    duplicateClient.release();
  }

  const expiryClient = await pool.connect();
  const latePaymentClient = await pool.connect();
  try {
    await expiryClient.query("BEGIN");
    const expiryLock = await expiryClient.query("SELECT status FROM sales_orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [raceTenant,expiredOrder]);
    if (expiryLock.rows[0]?.status !== "pending") throw new Error("Expired order fixture was not pending.");
    await latePaymentClient.query("BEGIN");
    const waitingLatePayment = latePaymentClient.query("SELECT status,payment_status FROM sales_orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [raceTenant,expiredOrder]);
    await new Promise((resolve) => setTimeout(resolve, 75));
    await expiryClient.query("UPDATE sales_orders SET status='cancelled',payment_status='failed' WHERE tenant_id=$1 AND id=$2 AND status='pending'", [raceTenant,expiredOrder]);
    await expiryClient.query("UPDATE inventory_balances SET reserved=reserved-2 WHERE tenant_id=$1 AND branch_id=$2 AND product_id=$3 AND reserved>=2", [raceTenant,raceBranch,raceProduct]);
    await expiryClient.query("INSERT INTO inventory_movements (tenant_id,branch_id,product_id,movement_type,quantity_delta,reference_type,reference_id,idempotency_key) VALUES ($1,$2,$3,'reservation_release',-2,'sales_order',$4,'race-expired-release')", [raceTenant,raceBranch,raceProduct,expiredOrder]);
    await expiryClient.query("COMMIT");
    const lateState = (await waitingLatePayment).rows[0];
    if (lateState?.status !== "cancelled" || lateState?.payment_status !== "failed") throw new Error("Late payment did not observe expired/cancelled order.");
    await latePaymentClient.query("COMMIT");
    const expiredStock = await client.query("SELECT on_hand,reserved FROM inventory_balances WHERE tenant_id=$1 AND branch_id=$2 AND product_id=$3", [raceTenant,raceBranch,raceProduct]);
    const expiredMovements = await client.query("SELECT COUNT(*)::int AS count FROM inventory_movements WHERE tenant_id=$1 AND reference_id=$2", [raceTenant,expiredOrder]);
    if (expiredStock.rows[0]?.on_hand !== 8 || expiredStock.rows[0]?.reserved !== 2 || expiredMovements.rows[0]?.count !== 1) {
      throw new Error("Late payment after expiry incorrectly deducted stock or released the reservation twice.");
    }
  } finally {
    await expiryClient.query("ROLLBACK").catch(()=>{});
    await latePaymentClient.query("ROLLBACK").catch(()=>{});
    expiryClient.release();
    latePaymentClient.release();
  }

  await client.query("DELETE FROM tenants WHERE id=$1", [raceTenant]);
  console.log("USMS database smoke tests passed: tenant isolation, stock guards, duplicate payment serialization and expiry-vs-payment race.");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
