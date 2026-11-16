import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { FastifyRequest } from "fastify";
import { withTenantTransaction } from "./db.js";

export interface TenantActor {
  tenantId: string;
  membershipId: string;
  authSubject: string;
  role: "owner" | "admin" | "manager" | "cashier" | "viewer";
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function getJwks() {
  const url = process.env.SUPABASE_JWKS_URL;
  if (!url) throw new Error("SUPABASE_JWKS_URL is not configured.");
  jwks ??= createRemoteJWKSet(new URL(url));
  return jwks;
}

async function verifyAccessToken(token: string): Promise<JWTPayload> {
  const issuer = process.env.SUPABASE_JWT_ISSUER;
  if (!issuer) throw new Error("SUPABASE_JWT_ISSUER is not configured.");
  const { payload } = await jwtVerify(token, getJwks(), {
    issuer,
    audience: process.env.SUPABASE_JWT_AUDIENCE ?? "authenticated",
    algorithms: ["ES256", "RS256"],
  });
  if (typeof payload.sub !== "string") throw new Error("Token subject is missing.");
  return payload;
}

export async function requireTenantActor(
  request: FastifyRequest,
  allowedRoles?: TenantActor["role"][],
): Promise<TenantActor> {
  const authorization = request.headers.authorization;
  const tenantId = request.headers["x-usms-tenant"];
  if (!authorization?.startsWith("Bearer ") || typeof tenantId !== "string") {
    throw Object.assign(new Error("Sign in and select a shop to continue."), { statusCode: 401 });
  }

  let payload: JWTPayload;
  try {
    payload = await verifyAccessToken(authorization.slice(7));
  } catch {
    throw Object.assign(new Error("Your session is invalid or expired."), { statusCode: 401 });
  }

  const actor = await withTenantTransaction(tenantId, async (client) => {
    const result = await client.query(
      `SELECT id, tenant_id, auth_subject, role
       FROM tenant_memberships
       WHERE tenant_id = $1 AND auth_subject = $2 AND is_active = true
       LIMIT 1`,
      [tenantId, payload.sub],
    );
    const row = result.rows[0];
    return row ? {
      tenantId: row.tenant_id as string,
      membershipId: row.id as string,
      authSubject: row.auth_subject as string,
      role: row.role as TenantActor["role"],
    } : null;
  });

  if (!actor) throw Object.assign(new Error("You do not have access to this shop."), { statusCode: 403 });
  if (allowedRoles && !allowedRoles.includes(actor.role)) {
    throw Object.assign(new Error("Your role does not allow this action."), { statusCode: 403 });
  }
  return actor;
}
