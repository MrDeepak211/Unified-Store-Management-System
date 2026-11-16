import type { FastifyInstance } from "fastify";
import { requireTenantActor } from "../auth.js";
import { withTenantTransaction } from "../db.js";

type ProductInput = {
  branchId?: string;
  sku?: string;
  name?: string;
  description?: string;
  price?: string | number;
  taxRate?: string | number;
  hsnCode?: string;
  unitOfMeasure?: string;
};

export async function registerProductRoutes(app: FastifyInstance) {
  app.get("/api/v1/business/products", async (request) => {
    const actor = await requireTenantActor(request);
    return withTenantTransaction(actor.tenantId, async (client) => {
      const result = await client.query(
        `SELECT p.id, p.sku, p.name, p.description, p.price::text, p.tax_rate::text AS "taxRate", p.hsn_code AS "hsnCode", p.unit_of_measure AS "unitOfMeasure",
                p.is_active AS "isActive", COALESCE(SUM(ib.on_hand - ib.reserved), 0)::int AS "availableStock"
         FROM products p
         LEFT JOIN inventory_balances ib ON ib.tenant_id = p.tenant_id AND ib.product_id = p.id
         WHERE p.tenant_id = $1
         GROUP BY p.id
         ORDER BY p.name ASC`,
        [actor.tenantId],
      );
      return { products: result.rows };
    });
  });

  app.post<{ Body: ProductInput }>("/api/v1/business/products", async (request, reply) => {
    const actor = await requireTenantActor(request, ["owner", "admin", "manager"]);
    const body = request.body ?? {};
    const sku = typeof body.sku === "string" ? body.sku.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const branchId = typeof body.branchId === "string" ? body.branchId : "";
    const price = String(body.price ?? "");
    const taxRate = String(body.taxRate ?? "0");
    const hsnCode = typeof body.hsnCode === "string" ? body.hsnCode.trim() : "";
    const unitOfMeasure = typeof body.unitOfMeasure === "string" ? body.unitOfMeasure.trim() : "PCS";
    if (!sku || !name || !branchId || !/^\d+(\.\d{1,2})?$/.test(price) || !/^\d+(\.\d{1,2})?$/.test(taxRate)) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "SKU, name, branch, valid price and tax rate are required." } });
    }
    if ((hsnCode && !/^\d{4}(?:\d{2}(?:\d{2})?)?$/.test(hsnCode)) || unitOfMeasure.length < 1 || unitOfMeasure.length > 20) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "HSN code must be 4, 6 or 8 digits and unit must be 1–20 characters." } });
    }
    if (Number(taxRate) > 100) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Tax rate must be between 0 and 100." } });
    }

    const product = await withTenantTransaction(actor.tenantId, async (client) => {
      const branch = await client.query("SELECT id FROM branches WHERE tenant_id = $1 AND id = $2", [actor.tenantId, branchId]);
      if (!branch.rowCount) return null;
      const inserted = await client.query(
        `INSERT INTO products (tenant_id, sku, name, description, price, tax_rate, hsn_code, unit_of_measure)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, sku, name, description, price::text, tax_rate::text AS "taxRate", hsn_code AS "hsnCode", unit_of_measure AS "unitOfMeasure"`,
        [actor.tenantId, sku, name, (typeof body.description === "string" ? body.description.trim() : "") || null, price, taxRate, hsnCode || null, unitOfMeasure],
      );
      const row = inserted.rows[0];
      await client.query(
        `INSERT INTO inventory_balances (tenant_id, branch_id, product_id, on_hand, reserved)
         VALUES ($1, $2, $3, 0, 0)`,
        [actor.tenantId, branchId, row.id],
      );
      return row;
    });
    if (!product) return reply.code(404).send({ error: { code: "BRANCH_NOT_FOUND", message: "The selected branch does not belong to this shop." } });
    return reply.code(201).send({ product });
  });
}
