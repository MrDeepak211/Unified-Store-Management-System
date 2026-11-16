import type { FastifyInstance } from "fastify";
import { requireTenantActor } from "../auth.js";
import { withTenantTransaction } from "../db.js";

type BusinessProfileBody = {
  legalName?: string;
  gstin?: string;
  stateCode?: string;
  address?: Record<string, unknown>;
  timezone?: string;
};

export async function registerProfileAndInvoiceRoutes(app: FastifyInstance) {
  app.get("/api/v1/business/profile", async (request) => {
    const actor = await requireTenantActor(request);
    return withTenantTransaction(actor.tenantId, async (client) => {
      const result = await client.query(
        `SELECT name AS "shopName", legal_name AS "legalName", gstin, state_code AS "stateCode",
                business_address AS address, timezone
         FROM tenants WHERE id = $1 LIMIT 1`,
        [actor.tenantId],
      );
      return { profile: result.rows[0] ?? null };
    });
  });

  app.put<{ Body: BusinessProfileBody }>("/api/v1/business/profile", async (request, reply) => {
    const actor = await requireTenantActor(request, ["owner", "admin"]);
    const body = request.body ?? {};
    const legalName = typeof body.legalName === "string" ? body.legalName.trim() : "";
    const gstin = typeof body.gstin === "string" ? body.gstin.trim().toUpperCase() : "";
    const stateCode = typeof body.stateCode === "string" ? body.stateCode.trim() : "";
    const timezone = typeof body.timezone === "string" ? body.timezone.trim() : "Asia/Kolkata";
    if (legalName.length < 2 || legalName.length > 120 || (gstin && !/^[0-9A-Z]{15}$/.test(gstin)) || !/^\d{2}$/.test(stateCode)) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Provide a legal business name, valid GSTIN (if registered), and two-digit state code." } });
    }
    try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); }
    catch { return reply.code(400).send({ error: { code: "INVALID_TIMEZONE", message: "Choose a valid IANA timezone." } }); }
    const profile = await withTenantTransaction(actor.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE tenants SET legal_name = $2, gstin = $3, state_code = $4,
           business_address = $5::jsonb, timezone = $6
         WHERE id = $1
         RETURNING name AS "shopName", legal_name AS "legalName", gstin,
                   state_code AS "stateCode", business_address AS address, timezone`,
        [actor.tenantId, legalName, gstin || null, stateCode, JSON.stringify(body.address ?? {}), timezone],
      );
      return result.rows[0];
    });
    return { profile };
  });

  app.get("/api/v1/business/invoices", async (request) => {
    const actor = await requireTenantActor(request);
    return withTenantTransaction(actor.tenantId, async (client) => {
      const result = await client.query(
        `SELECT id AS "orderId", invoice_number AS "invoiceNumber", invoice_issued_at AS "issuedAt",
                invoice_issuer_snapshot AS issuer, invoice_customer_snapshot AS customer,
                subtotal::text, tax_total::text AS "taxTotal", grand_total::text AS "grandTotal",
                channel, status
         FROM sales_orders WHERE tenant_id = $1 AND invoice_number IS NOT NULL
           AND ($2::uuid[] IS NULL OR branch_id = ANY($2))
         ORDER BY invoice_issued_at DESC LIMIT 200`,
        [actor.tenantId, actor.branchIds.length ? actor.branchIds : null],
      );
      return { invoices: result.rows };
    });
  });

  app.get<{ Params: { orderId: string } }>("/api/v1/business/invoices/:orderId", async (request, reply) => {
    const actor = await requireTenantActor(request);
    return withTenantTransaction(actor.tenantId, async (client) => {
      const invoice = await client.query(
        `SELECT id AS "orderId", invoice_number AS "invoiceNumber", invoice_issued_at AS "issuedAt",
                invoice_issuer_snapshot AS issuer, invoice_customer_snapshot AS customer,
                subtotal::text, tax_total::text AS "taxTotal", grand_total::text AS "grandTotal",
                channel, status
         FROM sales_orders WHERE tenant_id = $1 AND id = $2 AND invoice_number IS NOT NULL
           AND ($3::uuid[] IS NULL OR branch_id = ANY($3)) LIMIT 1`,
        [actor.tenantId, request.params.orderId, actor.branchIds.length ? actor.branchIds : null],
      );
      if (!invoice.rowCount) return reply.code(404).send({ error: { code: "INVOICE_NOT_FOUND", message: "Invoice not found." } });
      const items = await client.query(
        `SELECT product_name_snapshot AS "productName", sku_snapshot AS sku,
                hsn_code_snapshot AS "hsnCode", unit_of_measure_snapshot AS "unitOfMeasure",
                quantity, unit_price::text AS "unitPrice", tax_rate::text AS "taxRate",
                line_total::text AS "lineTotal"
         FROM sales_order_items WHERE tenant_id = $1 AND order_id = $2 ORDER BY id`,
        [actor.tenantId, request.params.orderId],
      );
      return { invoice: invoice.rows[0], items: items.rows, documentType: "Sales Invoice", gstReviewRequired: true };
    });
  });
}
