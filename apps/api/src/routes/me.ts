import type { FastifyInstance } from "fastify";
import { verifyAccessToken } from "../auth.js";
import { getPool } from "../db.js";

export async function registerMeRoutes(app: FastifyInstance) {
  app.get("/api/v1/me/shops", async (request, reply) => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Sign in to view your shops." } });
    }
    let subject: string;
    try {
      const payload = await verifyAccessToken(authorization.slice(7));
      if (typeof payload.sub !== "string") throw new Error("Missing subject");
      subject = payload.sub;
    } catch {
      return reply.code(401).send({ error: { code: "INVALID_SESSION", message: "Your session is invalid or expired." } });
    }
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.auth_subject', $1, true)", [subject]);
      const result = await client.query(
        `SELECT m.id AS "membershipId", m.tenant_id AS "tenantId", m.role,
                t.name AS "shopName", t.slug, t.status
         FROM tenant_memberships m
         JOIN tenants t ON t.id = m.tenant_id
         WHERE m.auth_subject = $1 AND m.is_active = true AND t.status = 'active'
         ORDER BY m.created_at ASC`,
        [subject],
      );
      await client.query("COMMIT");
      return { shops: result.rows };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
