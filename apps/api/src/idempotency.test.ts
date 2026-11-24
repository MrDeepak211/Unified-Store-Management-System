import test from "node:test";
import assert from "node:assert/strict";
import { createRequestFingerprint } from "./idempotency.js";

test("fingerprint ignores object key order", () => {
  assert.equal(
    createRequestFingerprint({ branchId: "b1", paymentMethod: "cash" }),
    createRequestFingerprint({ paymentMethod: "cash", branchId: "b1" }),
  );
});

test("fingerprint changes when request meaning changes", () => {
  const original = createRequestFingerprint({ branchId: "b1", quantity: 2 });
  assert.notEqual(original, createRequestFingerprint({ branchId: "b2", quantity: 2 }));
  assert.notEqual(original, createRequestFingerprint({ branchId: "b1", quantity: 3 }));
});

test("arrays retain order unless callers normalize them", () => {
  assert.notEqual(
    createRequestFingerprint({ items: ["p1", "p2"] }),
    createRequestFingerprint({ items: ["p2", "p1"] }),
  );
});
