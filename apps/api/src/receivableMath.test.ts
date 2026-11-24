import test from "node:test";
import assert from "node:assert/strict";
import { applyCreditCollection } from "./receivableMath.js";

test("partial collection leaves the correct outstanding amount", () => {
  assert.deepEqual(applyCreditCollection("1250.00", "400.25", "100.50"), {
    collectedAmount: "500.75", outstandingAmount: "749.25", paymentStatus: "pending",
  });
});

test("exact final collection settles the receivable", () => {
  assert.deepEqual(applyCreditCollection("100.00", "75.00", "25.00"), {
    collectedAmount: "100.00", outstandingAmount: "0.00", paymentStatus: "paid",
  });
});

test("over-collection is rejected using integer paise arithmetic", () => {
  assert.throws(() => applyCreditCollection("0.30", "0.20", "0.11"), /exceeds/);
});

test("invalid precision and non-positive collections are rejected", () => {
  assert.throws(() => applyCreditCollection("10.00", "0.00", "1.001"), /decimal places/);
  assert.throws(() => applyCreditCollection("10.00", "0.00", "0.00"), /Invalid/);
});
