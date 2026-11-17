import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { buildApp } from "./app.js";
import { closePool, getPool } from "./db.js";

const issuer = "http://127.0.0.1:45873/auth/v1";
const audience = "authenticated";
const tenantA = randomUUID();
const tenantB = randomUUID();
const branchA = randomUUID();
const branchB = randomUUID();
const ownerSubject = randomUUID();
const cashierSubject = randomUUID();
const inactiveSubject = randomUUID();
let server: Server;
let jwksUrl = "";
let ownerToken = "";
let cashierToken = "";
let inactiveToken = "";
let app: Awaited<ReturnType<typeof buildApp>>;

async function sign(subject: string, privateKey: KeyLike, kid: string) {
  return new SignJWT({ email: `${subject}@usms.test` })
    .setProtectedHeader({ alg: "ES256", kid, typ: "JWT" })
    .setSubject(subject)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey as never);
}

before(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for authenticated API integration tests.");
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  const kid = "usms-ci-integration-key";
  const document = { keys: [{ ...jwk, kid, use: "sig", alg: "ES256" }] };
  server = createServer((request, response) => {
    if (request.url === "/.well-known/jwks.json") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(document));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind local JWKS test server.");
  jwksUrl = `http://127.0.0.1:${address.port}/.well-known/jwks.json`;
  process.env.SUPABASE_JWKS_URL = jwksUrl;
  process.env.SUPABASE_JWT_ISSUER = issuer;
  process.env.SUPABASE_JWT_AUDIENCE = audience;

  const pool = getPool();
  await pool.query("INSERT INTO tenants (id, name, slug) VALUES ($1, 'Integration A', $2), ($3, 'Integration B', $4)", [
    tenantA, `it-${tenantA}`, tenantB, `it-${tenantB}`,
  ]);
  await pool.query(
    "INSERT INTO branches (id, tenant_id, name, code, is_default) VALUES ($1, $2, 'Main', 'MAIN', true), ($3, $4, 'Other', 'OTHER', true)",
    [branchA, tenantA, branchB, tenantB],
  );
  await pool.query(
    `INSERT INTO tenant_memberships (tenant_id, auth_subject, email, role, branch_ids, is_active)
     VALUES ($1, $2, 'owner@usms.test', 'owner', '{}', true),
            ($1, $3, 'cashier@usms.test', 'cashier', ARRAY[$4]::uuid[], true),
            ($5, $6, 'inactive@usms.test', 'owner', '{}', false)`,
    [tenantA, ownerSubject, cashierSubject, branchA, tenantB, inactiveSubject],
  );
  ownerToken = await sign(ownerSubject, privateKey, kid);
  cashierToken = await sign(cashierSubject, privateKey, kid);
  inactiveToken = await sign(inactiveSubject, privateKey, kid);
  app = await buildApp();
});

after(async () => {
  if (app) await app.close();
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (process.env.DATABASE_URL) {
    const pool = getPool();
    await pool.query("DELETE FROM tenant_memberships WHERE tenant_id = ANY($1::uuid[])", [[tenantA, tenantB]]);
    await pool.query("DELETE FROM branches WHERE tenant_id = ANY($1::uuid[])", [[tenantA, tenantB]]);
    await pool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [[tenantA, tenantB]]);
    await closePool();
  }
});

test("authenticated tenant membership, inactive access, roles and branch scope are enforced", async () => {
  const ownerHeaders = { authorization: `Bearer ${ownerToken}`, "x-usms-tenant": tenantA };
  const cashierHeaders = { authorization: `Bearer ${cashierToken}`, "x-usms-tenant": tenantA };

  const ownerProducts = await app.inject({ method: "GET", url: "/api/v1/business/products", headers: ownerHeaders });
  assert.equal(ownerProducts.statusCode, 200, ownerProducts.body);

  const crossTenant = await app.inject({
    method: "GET", url: "/api/v1/business/products",
    headers: { authorization: `Bearer ${ownerToken}`, "x-usms-tenant": tenantB },
  });
  assert.equal(crossTenant.statusCode, 403, crossTenant.body);

  const inactive = await app.inject({
    method: "GET", url: "/api/v1/business/products",
    headers: { authorization: `Bearer ${inactiveToken}`, "x-usms-tenant": tenantB },
  });
  assert.equal(inactive.statusCode, 403, inactive.body);

  const cashierStaff = await app.inject({ method: "GET", url: "/api/v1/business/staff", headers: cashierHeaders });
  assert.equal(cashierStaff.statusCode, 403, cashierStaff.body);

  const ownerStaff = await app.inject({ method: "GET", url: "/api/v1/business/staff", headers: ownerHeaders });
  assert.equal(ownerStaff.statusCode, 200, ownerStaff.body);

  const cashierCategoryWrite = await app.inject({
    method: "POST", url: "/api/v1/business/categories",
    headers: { ...cashierHeaders, "content-type": "application/json" }, payload: { name: "Test" },
  });
  assert.equal(cashierCategoryWrite.statusCode, 403, cashierCategoryWrite.body);

  const ownerValidation = await app.inject({
    method: "POST", url: "/api/v1/business/categories",
    headers: { ...ownerHeaders, "content-type": "application/json" }, payload: { name: "" },
  });
  assert.equal(ownerValidation.statusCode, 400, ownerValidation.body);

  const assignedBranch = await app.inject({
    method: "GET", url: `/api/v1/business/products?branchId=${branchA}`, headers: cashierHeaders,
  });
  assert.equal(assignedBranch.statusCode, 200, assignedBranch.body);

  const unassignedBranch = await app.inject({
    method: "GET", url: `/api/v1/business/products?branchId=${branchB}`, headers: cashierHeaders,
  });
  assert.equal(unassignedBranch.statusCode, 403, unassignedBranch.body);
});
