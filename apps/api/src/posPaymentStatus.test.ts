import test from "node:test";
import assert from "node:assert/strict";
import { paymentStatusForPosMethod } from "./posPaymentStatus.js";

test("credit sales remain unpaid until a collection is recorded", () => {
  assert.equal(paymentStatusForPosMethod("credit"), "pending");
});

test("immediately settled POS methods are marked paid", () => {
  for (const method of ["cash", "upi", "card", "bank_transfer"] as const) {
    assert.equal(paymentStatusForPosMethod(method), "paid");
  }
});
