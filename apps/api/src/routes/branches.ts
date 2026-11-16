import type { FastifyInstance } from "fastify";
import { requireTenantActor } from "../auth.js";
import { withTenantTransaction } from "../db.js";

export async function registerBranchRoutes(app: FastifyInstance) {
  app.get("/api/v1/business/branches", async (request) => {
    const actor = await requireTenantActor(request);
    return withTenantTransaction(actor.tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, name, code, address, is_default AS "isDefault"
         FROM branches WHERE tenant_id = $1 ORDER BY is_default DESC, name ASC`,
        [actor.tenantId],
      );
      return { branches: result.rows };
    });
  });
}
