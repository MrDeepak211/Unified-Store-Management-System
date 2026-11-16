import type { FastifyInstance } from "fastify";
import { requireTenantActor } from "../auth.js";
import { withTenantTransaction } from "../db.js";

type StaffRole = "admin" | "manager" | "cashier" | "viewer";
type InviteBody = { email?: string; role?: StaffRole; branchIds?: string[] };
type UpdateBody = { role?: StaffRole; branchIds?: string[]; isActive?: boolean };

function validateBranchIds(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some((id) => typeof id !== "string")) return null;
  return [...new Set(value as string[])];
}

export async function registerStaffRoutes(app: FastifyInstance) {
  app.get("/api/v1/business/staff", async (request) => {
    const actor = await requireTenantActor(request, ["owner", "admin"]);
    return withTenantTransaction(actor.tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, email, role, branch_ids AS "branchIds", is_active AS "isActive", created_at AS "createdAt"
         FROM tenant_memberships WHERE tenant_id = $1 ORDER BY created_at DESC`,
        [actor.tenantId],
      );
      return { staff: result.rows };
    });
  });

  app.post<{ Body: InviteBody }>("/api/v1/business/staff/invite", async (request, reply) => {
    const actor = await requireTenantActor(request, ["owner", "admin"]);
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const role = request.body?.role;
    const branchIds = validateBranchIds(request.body?.branchIds);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !role || !["admin","manager","cashier","viewer"].includes(role) || !branchIds) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Provide a valid email, staff role and branch assignment list." } });
    }
    if (actor.role !== "owner" && role === "admin") {
      return reply.code(403).send({ error: { code: "ROLE_ASSIGNMENT_DENIED", message: "Only the shop owner can invite another admin." } });
    }
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!serviceKey || !supabaseUrl) return reply.code(503).send({ error: { code: "INVITATIONS_NOT_CONFIGURED", message: "Staff invitations require Supabase server-side admin credentials." } });
    const validBranches = await withTenantTransaction(actor.tenantId, async (client) => {
      if (!branchIds.length) return true;
      const result = await client.query("SELECT id FROM branches WHERE tenant_id = $1 AND id = ANY($2::uuid[])", [actor.tenantId, branchIds]);
      return result.rowCount === branchIds.length;
    });
    if (!validBranches) return reply.code(400).send({ error: { code: "INVALID_BRANCH_ASSIGNMENT", message: "One or more selected branches do not belong to this shop." } });

    const invitation = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/invite`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        data: { invited_by_tenant: actor.tenantId },
        ...(process.env.SUPABASE_INVITE_REDIRECT_URL ? { redirect_to: process.env.SUPABASE_INVITE_REDIRECT_URL } : {}),
      }),
    });
    const invited = await invitation.json() as { id?: string; user?: { id?: string }; msg?: string; message?: string };
    const authSubject = invited.id ?? invited.user?.id;
    if (!invitation.ok || !authSubject) {
      request.log.warn({ status: invitation.status, message: invited.msg ?? invited.message }, "Supabase staff invitation failed");
      return reply.code(502).send({ error: { code: "INVITATION_FAILED", message: "Supabase could not send the staff invitation. Verify the email and Auth email settings." } });
    }
    const membership = await withTenantTransaction(actor.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO tenant_memberships (tenant_id, auth_subject, email, role, branch_ids, is_active)
         VALUES ($1, $2, $3, $4, $5::uuid[], true)
         ON CONFLICT (tenant_id, auth_subject) DO UPDATE SET email = EXCLUDED.email, role = EXCLUDED.role,
           branch_ids = EXCLUDED.branch_ids, is_active = true
         RETURNING id, email, role, branch_ids AS "branchIds", is_active AS "isActive"`,
        [actor.tenantId, authSubject, email, role, branchIds],
      );
      return result.rows[0];
    });
    return reply.code(201).send({ staff: membership, invitationSent: true });
  });

  app.patch<{ Params: { membershipId: string }; Body: UpdateBody }>("/api/v1/business/staff/:membershipId", async (request, reply) => {
    const actor = await requireTenantActor(request, ["owner", "admin"]);
    const body = request.body ?? {};
    const role = body.role;
    const branchIds = validateBranchIds(body.branchIds);
    if ((role !== undefined && !["admin","manager","cashier","viewer"].includes(role)) || !branchIds) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid role or branch assignments." } });
    }
    if (actor.role !== "owner" && role === "admin") return reply.code(403).send({ error: { code: "ROLE_ASSIGNMENT_DENIED", message: "Only the shop owner can assign admin." } });
    const updated = await withTenantTransaction(actor.tenantId, async (client) => {
      const target = await client.query("SELECT id, role FROM tenant_memberships WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [actor.tenantId, request.params.membershipId]);
      if (!target.rowCount || target.rows[0].role === "owner") return null;
      if (branchIds.length) {
        const branches = await client.query("SELECT id FROM branches WHERE tenant_id = $1 AND id = ANY($2::uuid[])", [actor.tenantId, branchIds]);
        if (branches.rowCount !== branchIds.length) throw Object.assign(new Error("Branch assignment is invalid."), { statusCode: 400 });
      }
      const result = await client.query(
        `UPDATE tenant_memberships SET role = COALESCE($3, role),
           branch_ids = COALESCE($4::uuid[], branch_ids),
           is_active = COALESCE($5, is_active)
         WHERE tenant_id = $1 AND id = $2
         RETURNING id, email, role, branch_ids AS "branchIds", is_active AS "isActive"`,
        [actor.tenantId, request.params.membershipId, role ?? null, body.branchIds === undefined ? null : branchIds, typeof body.isActive === "boolean" ? body.isActive : null],
      );
      return result.rows[0];
    });
    if (!updated) return reply.code(404).send({ error: { code: "STAFF_NOT_FOUND", message: "Staff member not found or owner record cannot be changed." } });
    return { staff: updated };
  });
}
