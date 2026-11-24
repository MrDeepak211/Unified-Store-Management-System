import test from "node:test";
import assert from "node:assert/strict";
function cents(value: string): bigint { const [whole, fraction = ""] = value.split("."); return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0")); }
test("partial collection leaves an outstanding balance", () => { const total = cents("1250.00"); const collected = cents("400.25"); assert.equal((total-collected).toString(), "84975"); });
test("exact final collection settles the receivable", () => { const total = cents("100.00"); const prior = cents("75.00"); const next = cents("25.00"); assert.equal(total-prior-next, 0n); });
test("over-collection is detectable without floating point rounding", () => { const total = cents("0.30"); const collected = cents("0.20"); assert.equal(cents("0.11") > total-collected, true); });
