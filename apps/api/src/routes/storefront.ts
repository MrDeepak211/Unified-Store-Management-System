import type { FastifyInstance } from "fastify";
import { withTenantTransaction } from "../db.js";

export async function registerStorefrontRoutes(app: FastifyInstance) {
  app.get<{ Params: { slug: string } }>("/api/v1/storefront/:slug", async (request, reply) => {
    const slug = request.params.slug.toLowerCase();
    const clientPool = await import("../db.js").then((m) => m.getPool());
    const client = await clientPool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query(
        `SELECT t.id AS "tenantId", s.display_name AS "displayName", s.primary_color AS "primaryColor",
                s.logo_url AS "logoUrl", s.support_email AS "supportEmail", s.support_phone AS "supportPhone"
         FROM tenants t
         JOIN storefront_settings s ON s.tenant_id = t.id
         WHERE t.slug = $1 AND t.status = 'active' AND s.is_published = true
         LIMIT 1`,
        [slug],
      );
      const store = found.rows[0];
      if (!store) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: { code: "STORE_NOT_FOUND", message: "This online store is unavailable." } });
      }
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [store.tenantId]);
      const branch = await client.query(
        "SELECT id FROM branches WHERE tenant_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1",
        [store.tenantId],
      );
      if (!branch.rowCount) {
        await client.query("COMMIT");
        return { store, products: [] };
      }
      const products = await client.query(
        `SELECT p.id, p.sku, p.name, p.description, p.price::text,
                p.tax_rate::text AS "taxRate",
                COALESCE(ib.on_hand - ib.reserved, 0)::int AS "availableStock"
         FROM products p
         LEFT JOIN inventory_balances ib
           ON ib.tenant_id = p.tenant_id AND ib.product_id = p.id AND ib.branch_id = $2
         WHERE p.tenant_id = $1 AND p.is_active = true
         ORDER BY p.name ASC`,
        [store.tenantId, branch.rows[0].id],
      );
      await client.query("COMMIT");
      return { store, products: products.rows };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  // This endpoint is intentionally read-only in the first delivery slice.
  // Online checkout will reserve stock transactionally before any payment attempt.
}
