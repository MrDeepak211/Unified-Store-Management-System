import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify, { type FastifyInstance } from "fastify";
import { registerProductRoutes } from "./routes/products.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import { registerInventoryRoutes } from "./routes/inventory.js";
import { registerOnlineOrderRoutes } from "./routes/onlineOrders.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerBranchRoutes } from "./routes/branches.js";
import { registerSaleRoutes } from "./routes/sales.js";
import { registerStorefrontRoutes } from "./routes/storefront.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    requestIdHeader: "x-request-id",
    bodyLimit: 1_048_576,
  });
  await app.register(helmet);
  await app.register(cors, {
    origin: process.env.WEB_ORIGIN?.split(",").map((value) => value.trim()) ?? false,
    credentials: true,
  });

  app.get("/health", async () => ({ status: "ok", service: "usms-api" as const }));
  app.get("/api/v1/meta", async () => ({
    name: "Unified Store Management System",
    version: "0.1.0",
    apiVersion: "v1",
    capabilities: ["individual-storefronts", "shared-inventory", "pos-sales"],
  }));

  await registerMeRoutes(app);
  await registerOnboardingRoutes(app);
  await registerBranchRoutes(app);
  await registerProductRoutes(app);
  await registerInventoryRoutes(app);
  await registerSaleRoutes(app);
  await registerStorefrontRoutes(app);
  await registerOnlineOrderRoutes(app);

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "Unhandled request error");
    const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    return reply.status(statusCode).send({
      error: {
        code: statusCode >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR",
        message: statusCode >= 500 ? "An unexpected error occurred." : error.message,
        requestId: request.id,
      },
    });
  });
  return app;
}
