import test from "node:test";
import assert from "node:assert/strict";
import { assertBranchAccess, assertRoleAccess, isTenantId, type TenantActor } from "./auth.js";

const actor = (overrides: Partial<TenantActor> = {}): TenantActor => ({
  tenantId: "11111111-1111-4111-8111-111111111111",
  membershipId: "22222222-2222-4222-8222-222222222222",
  authSubject: "user-subject",
  role: "cashier",
  branchIds: ["33333333-3333-4333-8333-333333333333"],
  ...overrides,
});

test("accepts valid tenant UUIDs and rejects malformed identifiers", () => {
  assert.equal(isTenantId("11111111-1111-4111-8111-111111111111"), true);
  assert.equal(isTenantId("not-a-uuid"), false);
  assert.equal(isTenantId("11111111-1111-1111-1111-111111111111"), false);
  assert.equal(isTenantId(undefined), false);
});

test("allows a staff member to access an assigned branch", () => {
  assert.doesNotThrow(() => assertBranchAccess(actor(), "33333333-3333-4333-8333-333333333333"));
});

test("blocks a staff member from an unassigned branch", () => {
  assert.throws(
    () => assertBranchAccess(actor(), "44444444-4444-4444-8444-444444444444"),
    (error: unknown) => Boolean(error && typeof error === "object" && "statusCode" in error && error.statusCode === 403),
  );
});

test("an empty branch assignment retains the documented all-branches meaning", () => {
  assert.doesNotThrow(() => assertBranchAccess(actor({ branchIds: [] }), "44444444-4444-4444-8444-444444444444"));
});

test("enforces role allow-lists and preserves owner/admin role boundaries", () => {
  assert.doesNotThrow(() => assertRoleAccess("owner", ["owner", "admin"]));
  assert.doesNotThrow(() => assertRoleAccess("admin", ["owner", "admin"]));
  assert.throws(
    () => assertRoleAccess("cashier", ["owner", "admin"]),
    (error: unknown) => Boolean(error && typeof error === "object" && "statusCode" in error && error.statusCode === 403),
  );
});
