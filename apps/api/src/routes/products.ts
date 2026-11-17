import type { FastifyInstance } from "fastify";
import { assertBranchAccess, isTenantId, requireTenantActor } from "../auth.js";
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
  barcode?: string;
  categoryId?: string;
};

export async function registerProductRoutes(app: FastifyInstance) {
  app.get("/api/v1/business/categories", async (request) => {
    const actor = await requireTenantActor(request);
    return withTenantTransaction(actor.tenantId, async (client) => {
      const result = await client.query("SELECT id, name FROM product_categories WHERE tenant_id = $1 ORDER BY name", [actor.tenantId]);
      return { categories: result.rows };
    });
  });

  app.post<{ Body: { name?: string } }>("/api/v1/business/categories", async (request, reply) => {
    const actor = await requireTenantActor(request, ["owner", "admin", "manager"]);
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    if (name.length < 2 || name.length > 80) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Category name must be 2–80 characters." } });
    const category = await withTenantTransaction(actor.tenantId, async (client) => {
      const result = await client.query("INSERT INTO product_categories (tenant_id, name) VALUES ($1, $2) RETURNING id, name", [actor.tenantId, name]);
      return result.rows[0];
    });
    return reply.code(201).send({ category });
  });

  app.get<{ Querystring: { branchId?: string } }>("/api/v1/business/products", async (request) => {
    const actor = await requireTenantActor(request);
    if (request.query.branchId) assertBranchAccess(actor, request.query.branchId);
    return withTenantTransaction(actor.tenantId, async (client) => {
      const result = await client.query(
        `SELECT p.id, p.sku, p.name, p.description, p.price::text, p.tax_rate::text AS "taxRate", p.hsn_code AS "hsnCode", p.unit_of_measure AS "unitOfMeasure", p.barcode, p.category_id AS "categoryId", c.name AS "categoryName",
                p.is_active AS "isActive", COALESCE(SUM(ib.on_hand - ib.reserved), 0)::int AS "availableStock"
         FROM products p
         LEFT JOIN inventory_balances ib ON ib.tenant_id = p.tenant_id AND ib.product_id = p.id AND ($2::uuid IS NULL OR ib.branch_id = $2)
         LEFT JOIN product_categories c ON c.tenant_id = p.tenant_id AND c.id = p.category_id
         WHERE p.tenant_id = $1
         GROUP BY p.id, c.name
         ORDER BY p.name ASC`,
        [actor.tenantId, request.query.branchId ?? null],
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
    const barcode = typeof body.barcode === "string" ? body.barcode.trim() : "";
    const categoryId = typeof body.categoryId === "string" ? body.categoryId : null;
    if (!sku || !name || !branchId || !/^\d+(\.\d{1,2})?$/.test(price) || !/^\d+(\.\d{1,2})?$/.test(taxRate)) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "SKU, name, branch, valid price and tax rate are required." } });
    }
    if (!isTenantId(branchId) || (categoryId !== null && !isTenantId(categoryId))) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Branch and category identifiers must be valid UUIDs." } });
    }
    assertBranchAccess(actor, branchId);
    if ((hsnCode && !/^\d{4}(?:\d{2}(?:\d{2})?)?$/.test(hsnCode)) || unitOfMeasure.length < 1 || unitOfMeasure.length > 20) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "HSN code must be 4, 6 or 8 digits and unit must be 1–20 characters." } });
    }
    if (Number(taxRate) > 100) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Tax rate must be between 0 and 100." } });
    }

    if (barcode.length > 64) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Barcode must be 64 characters or fewer." } });

    const product = await withTenantTransaction(actor.tenantId, async (client) => {
      const branch = await client.query("SELECT id FROM branches WHERE tenant_id = $1 AND id = $2", [actor.tenantId, branchId]);
      if (!branch.rowCount) return null;
      if (categoryId) {
        const category = await client.query("SELECT id FROM product_categories WHERE tenant_id = $1 AND id = $2", [actor.tenantId, categoryId]);
        if (!category.rowCount) return null;
      }
      const inserted = await client.query(
        `INSERT INTO products (tenant_id, sku, name, description, price, tax_rate, hsn_code, unit_of_measure, barcode, category_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, sku, name, description, price::text, tax_rate::text AS "taxRate", hsn_code AS "hsnCode", unit_of_measure AS "unitOfMeasure", barcode, category_id AS "categoryId"`,
        [actor.tenantId, sku, name, (typeof body.description === "string" ? body.description.trim() : "") || null, price, taxRate, hsnCode || null, unitOfMeasure, barcode || null, categoryId],
      );
      const row = inserted.rows[0];
      await client.query(
        `INSERT INTO inventory_balances (tenant_id, branch_id, product_id, on_hand, reserved)
         VALUES ($1, $2, $3, 0, 0)`,
        [actor.tenantId, branchId, row.id],
      );
      return row;
    });
    if (!product) return reply.code(404).send({ error: { code: "BRANCH_OR_CATEGORY_NOT_FOUND", message: "The selected branch or category does not belong to this shop." } });
    return reply.code(201).send({ product });
  });
}
