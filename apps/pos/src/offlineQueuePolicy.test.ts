import test from "node:test";
import assert from "node:assert/strict";
import { canSyncPendingSale, isLegacyUnscopedSale } from "./offlineQueuePolicy.js";

test("only pending sales for the active tenant may sync", () => {
  assert.equal(canSyncPendingSale({ tenantId: "tenant-a", status: "pending" }, "tenant-a"), true);
  assert.equal(canSyncPendingSale({ tenantId: "tenant-b", status: "pending" }, "tenant-a"), false);
  assert.equal(canSyncPendingSale({ tenantId: "tenant-a", status: "failed" }, "tenant-a"), false);
});

test("legacy queue records without a tenant are never auto-synced", () => {
  const legacy = { status: "pending" as const };
  assert.equal(isLegacyUnscopedSale(legacy), true);
  assert.equal(canSyncPendingSale(legacy, "tenant-a"), false);
});
