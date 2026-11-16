import { closePool, getPool, withTenantTransaction } from "../db.js";

async function releaseExpiredReservations() {
  const tenants = await getPool().query("SELECT id FROM tenants WHERE status = 'active'");
  let released = 0;
  for (const tenant of tenants.rows) {
    released += await withTenantTransaction(tenant.id as string, async (client) => {
      const orders = await client.query(
        `SELECT id FROM sales_orders
         WHERE tenant_id = $1 AND channel = 'online' AND status = 'pending'
           AND reservation_expires_at IS NOT NULL AND reservation_expires_at <= now()
         ORDER BY reservation_expires_at
         LIMIT 50
         FOR UPDATE SKIP LOCKED`,
        [tenant.id],
      );
      let count = 0;
      for (const order of orders.rows) {
        const cancelled = await client.query(
          `UPDATE sales_orders
           SET status = 'cancelled',
               payment_status = CASE WHEN payment_status = 'pending' THEN 'failed' ELSE payment_status END
           WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
           RETURNING id`,
          [tenant.id, order.id],
        );
        if (!cancelled.rowCount) continue;
        const items = await client.query(
          "SELECT product_id, quantity FROM sales_order_items WHERE tenant_id = $1 AND order_id = $2",
          [tenant.id, order.id],
        );
        for (const item of items.rows) {
          const releasedStock = await client.query(
            `UPDATE inventory_balances
             SET reserved = reserved - $4, updated_at = now()
             WHERE tenant_id = $1 AND branch_id = (
               SELECT branch_id FROM sales_orders WHERE tenant_id = $1 AND id = $2
             ) AND product_id = $3 AND reserved >= $4
             RETURNING reserved`,
            [tenant.id, order.id, item.product_id, item.quantity],
          );
          if (!releasedStock.rowCount) throw new Error(`Reservation balance mismatch for order ${order.id}.`);
          await client.query(
            `INSERT INTO inventory_movements
             (tenant_id, branch_id, product_id, movement_type, quantity_delta, reference_type, reference_id, idempotency_key, notes)
             SELECT $1, branch_id, $3, 'reservation_release', -$4, 'sales_order', $2, $5, 'Expired online checkout reservation'
             FROM sales_orders WHERE tenant_id = $1 AND id = $2`,
            [tenant.id, order.id, item.product_id, item.quantity, `expire:${order.id}:${item.product_id}`],
          );
        }
        count += 1;
      }
      return count;
    });
  }
  if (released) console.log(`Released ${released} expired USMS checkout reservation(s).`);
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try { await releaseExpiredReservations(); }
  catch (error) { console.error("Reservation expiry worker failed:", error); }
  finally { running = false; }
}

await tick();
const interval = setInterval(() => void tick(), 30_000);
const shutdown = async () => {
  clearInterval(interval);
  await closePool();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
console.log("USMS reservation expiry worker is running (30-second interval).");
