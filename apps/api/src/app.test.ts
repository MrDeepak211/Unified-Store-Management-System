import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";

test("API health and metadata endpoints are available without authentication", async () => {
  const app = await buildApp();
  try {
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: "ok", service: "usms-api" });

    const metadata = await app.inject({ method: "GET", url: "/api/v1/meta" });
    assert.equal(metadata.statusCode, 200);
    assert.equal(metadata.json().apiVersion, "v1");
  } finally {
    await app.close();
  }
});

test("protected business routes reject requests without a bearer token", async () => {
  const app = await buildApp();
  try {
    const protectedRoutes = [
      { method: "GET" as const, url: "/api/v1/business/products" },
      { method: "GET" as const, url: "/api/v1/business/categories" },
      { method: "GET" as const, url: "/api/v1/business/staff" },
      { method: "POST" as const, url: "/api/v1/business/products", payload: { name: "Test" } },
      { method: "POST" as const, url: "/api/v1/business/staff/invite", payload: { email: "test@example.com", role: "cashier" } },
    ];

    for (const route of protectedRoutes) {
      const response = await app.inject(route);
      assert.equal(response.statusCode, 401, `${route.method} ${route.url} must reject unauthenticated requests`);
      assert.equal(response.json().error.code, "REQUEST_ERROR");
      assert.ok(response.json().error.requestId);
    }
  } finally {
    await app.close();
  }
});

test("shop discovery and onboarding reject requests without a bearer token", async () => {
  const app = await buildApp();
  try {
    const shops = await app.inject({ method: "GET", url: "/api/v1/me/shops" });
    assert.equal(shops.statusCode, 401);
    assert.equal(shops.json().error.code, "UNAUTHENTICATED");

    const onboarding = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/shop",
      payload: { shopName: "Example Shop", slug: "example-shop" },
    });
    assert.equal(onboarding.statusCode, 401);
    assert.equal(onboarding.json().error.code, "UNAUTHENTICATED");
  } finally {
    await app.close();
  }
});

test("protected routes reject malformed tenant identifiers before database access", async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/business/products",
      headers: {
        authorization: "Bearer syntactically-present-token",
        "x-usms-tenant": "not-a-uuid",
      },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, "REQUEST_ERROR");
  } finally {
    await app.close();
  }
});
