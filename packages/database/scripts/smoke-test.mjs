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
  console.log("USMS database smoke tests passed: tenant isolation, POS deduction and online reservation guards.");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
