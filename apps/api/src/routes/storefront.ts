import type { FastifyInstance } from "fastify";
import { getPool } from "../db.js";

export async function registerStorefrontRoutes(app: FastifyInstance) {
  app.get<{ Params: { slug: string } }>("/api/v1/storefront/:slug", async (request, reply) => {
    const slug = request.params.slug.toLowerCase();
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      // Resolve the public tenant by its unique slug first. Tenant-owned settings
      // and catalogue tables are queried only after setting the transaction scope.
      const tenantResult = await client.query(
        "SELECT id FROM tenants WHERE slug = $1 AND status = 'active' LIMIT 1",
        [slug],
      );
      const tenantId = tenantResult.rows[0]?.id as string | undefined;
      if (!tenantId) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: { code: "STORE_NOT_FOUND", message: "This online store is unavailable." } });
      }
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const settingsResult = await client.query(
        `SELECT display_name AS "displayName", primary_color AS "primaryColor",
                logo_url AS "logoUrl", support_email AS "supportEmail", support_phone AS "supportPhone"
         FROM storefront_settings
         WHERE tenant_id = $1 AND is_published = true
         LIMIT 1`,
        [tenantId],
      );
      const store = settingsResult.rows[0];
      if (!store) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: { code: "STORE_NOT_FOUND", message: "This online store is not published." } });
      }
      const branch = await client.query(
        "SELECT id FROM branches WHERE tenant_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1",
        [tenantId],
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
        [tenantId, branch.rows[0].id],
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
}
