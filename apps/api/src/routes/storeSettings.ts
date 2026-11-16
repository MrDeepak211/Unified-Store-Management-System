import type { FastifyInstance } from "fastify";
import { requireTenantActor } from "../auth.js";
import { withTenantTransaction } from "../db.js";

type StoreSettingsBody = {
  displayName?: string;
  primaryColor?: string;
  supportEmail?: string;
  supportPhone?: string;
  isPublished?: boolean;
};

export async function registerStoreSettingsRoutes(app: FastifyInstance) {
  app.get("/api/v1/business/storefront", async (request) => {
    const actor = await requireTenantActor(request);
    return withTenantTransaction(actor.tenantId, async (client) => {
      const result = await client.query(
        `SELECT display_name AS "displayName", primary_color AS "primaryColor",
                logo_url AS "logoUrl", support_email AS "supportEmail",
                support_phone AS "supportPhone", is_published AS "isPublished"
         FROM storefront_settings WHERE tenant_id = $1 LIMIT 1`,
        [actor.tenantId],
      );
      return { settings: result.rows[0] ?? null };
    });
  });

  app.put<{ Body: StoreSettingsBody }>("/api/v1/business/storefront", async (request, reply) => {
    const actor = await requireTenantActor(request, ["owner", "admin"]);
    const body = request.body ?? {};
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const primaryColor = typeof body.primaryColor === "string" ? body.primaryColor : "#2563eb";
    if (displayName.length < 2 || displayName.length > 100 || !/^#[0-9a-fA-F]{6}$/.test(primaryColor)) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Provide a store name and a valid six-digit hex color." } });
    }
    const settings = await withTenantTransaction(actor.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE storefront_settings
         SET display_name = $2, primary_color = $3, support_email = $4, support_phone = $5,
             is_published = COALESCE($6, is_published), updated_at = now()
         WHERE tenant_id = $1
         RETURNING display_name AS "displayName", primary_color AS "primaryColor",
                   support_email AS "supportEmail", support_phone AS "supportPhone",
                   is_published AS "isPublished"`,
        [actor.tenantId, displayName, primaryColor, body.supportEmail?.trim() || null, body.supportPhone?.trim() || null, typeof body.isPublished === "boolean" ? body.isPublished : null],
      );
      return result.rows[0];
    });
    return { settings };
  });
}
