import type { FastifyInstance } from "fastify";

type CreateBranchBody = { name?: string; code?: string; address?: Record<string, unknown>; isDefault?: boolean };
import { requireTenantActor } from "../auth.js";
import { withTenantTransaction } from "../db.js";

export async function registerBranchRoutes(app: FastifyInstance) {
  app.post<{ Body: CreateBranchBody }>("/api/v1/business/branches", async (request, reply) => {
    const actor = await requireTenantActor(request, ["owner", "admin"]);
    const body = request.body ?? {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
    if (name.length < 2 || name.length > 80 || !/^[A-Z0-9-]{2,12}$/.test(code)) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Branch name and a 2–12 character alphanumeric branch code are required." } });
    try {
      const branch = await withTenantTransaction(actor.tenantId, async (client) => {
        if (body.isDefault) await client.query("UPDATE branches SET is_default = false WHERE tenant_id = $1", [actor.tenantId]);
        const inserted = await client.query(
          `INSERT INTO branches (tenant_id, name, code, address, is_default) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id, name, code, address, is_default AS "isDefault"`,
          [actor.tenantId, name, code, JSON.stringify(body.address ?? {}), body.isDefault === true],
        );
        await client.query(
          `INSERT INTO inventory_balances (tenant_id, branch_id, product_id, on_hand, reserved) SELECT $1, $2, id, 0, 0 FROM products WHERE tenant_id = $1`,
          [actor.tenantId, inserted.rows[0].id],
        );
        return inserted.rows[0];
      });
      return reply.code(201).send({ branch });
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && error.code === "23505") return reply.code(409).send({ error: { code: "BRANCH_CODE_EXISTS", message: "That branch code is already in use." } });
      throw error;
    }
  });
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
