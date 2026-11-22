import test from "node:test";
import assert from "node:assert/strict";
import { classifyRefundAmount, shouldRestockAfterFullRefund } from "./refundPolicy.js";

test("only an exact full refund is eligible for automatic refund settlement", () => {
  assert.equal(classifyRefundAmount(2500, 2500), "full");
  assert.equal(classifyRefundAmount(1200, 2500), "partial");
});

test("invalid, missing, zero and over-payment refund amounts are rejected", () => {
  assert.equal(classifyRefundAmount(undefined, 2500), "invalid");
  assert.equal(classifyRefundAmount(0, 2500), "invalid");
  assert.equal(classifyRefundAmount(-1, 2500), "invalid");
  assert.equal(classifyRefundAmount(2501, 2500), "invalid");
  assert.equal(classifyRefundAmount(Number.MAX_SAFE_INTEGER + 1, 2500), "invalid");
  assert.equal(classifyRefundAmount(100, 0), "invalid");
});

test("automatic restock is restricted to confirmed, unfulfilled orders", () => {
  assert.equal(shouldRestockAfterFullRefund("confirmed"), true);
  assert.equal(shouldRestockAfterFullRefund("fulfilled"), false);
  assert.equal(shouldRestockAfterFullRefund("cancelled"), false);
  assert.equal(shouldRestockAfterFullRefund("refunded"), false);
});
