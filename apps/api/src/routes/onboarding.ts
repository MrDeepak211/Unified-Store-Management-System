import type { FastifyInstance } from "fastify";
import { verifyAccessToken } from "../auth.js";
import { withTenantTransaction } from "../db.js";

type OnboardingBody = {
  shopName?: string;
  slug?: string;
  branchName?: string;
  branchCode?: string;
  supportEmail?: string;
  supportPhone?: string;
};

export async function registerOnboardingRoutes(app: FastifyInstance) {
  app.post<{ Body: OnboardingBody }>("/api/v1/onboarding/shop", async (request, reply) => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Sign in before creating a shop." } });
    }
    let subject: string;
    let email: string | null = null;
    try {
      const payload = await verifyAccessToken(authorization.slice(7));
      if (typeof payload.sub !== "string") throw new Error("Missing subject");
      subject = payload.sub;
      email = typeof payload.email === "string" ? payload.email : null;
    } catch {
      return reply.code(401).send({ error: { code: "INVALID_SESSION", message: "Your session is invalid or expired." } });
    }

    const body = request.body ?? {};
    const shopName = typeof body.shopName === "string" ? body.shopName.trim() : "";
    const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
    const branchName = typeof body.branchName === "string" ? body.branchName.trim() : "Main Branch";
    const branchCode = typeof body.branchCode === "string" ? body.branchCode.trim().toUpperCase() : "MAIN";
    if (shopName.length < 2 || shopName.length > 100 || !/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug) || branchName.length < 2 || branchCode.length < 2 || branchCode.length > 12) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Provide a shop name, a 3–40 character URL slug, and valid branch details." } });
    }

    try {
      const created = await (async () => {
        const { getPool } = await import("../db.js");
        const client = await getPool().connect();
        try {
          await client.query("BEGIN");
          const tenantResult = await client.query(
            "INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id, name, slug",
            [shopName, slug],
          );
          const tenant = tenantResult.rows[0];
          await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.id]);
          const branchResult = await client.query(
            `INSERT INTO branches (tenant_id, name, code, is_default)
             VALUES ($1, $2, $3, true) RETURNING id, name, code`,
            [tenant.id, branchName, branchCode],
          );
          await client.query(
            `INSERT INTO tenant_memberships (tenant_id, auth_subject, email, role)
             VALUES ($1, $2, $3, 'owner')`,
            [tenant.id, subject, email],
          );
          await client.query(
            `INSERT INTO storefront_settings (tenant_id, display_name, support_email, support_phone, is_published)
             VALUES ($1, $2, $3, $4, false)`,
            [tenant.id, shopName, body.supportEmail?.trim() || email, body.supportPhone?.trim() || null],
          );
          await client.query("COMMIT");
          return { tenant, branch: branchResult.rows[0] };
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      })();
      return reply.code(201).send({ ...created, storefrontUrl: `https://${slug}.usms.in`, storefrontPublished: false });
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && error.code === "23505") {
        return reply.code(409).send({ error: { code: "SHOP_SLUG_TAKEN", message: "That shop URL or branch code is already in use." } });
      }
      throw error;
    }
  });
}
