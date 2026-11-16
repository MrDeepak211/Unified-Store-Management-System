import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { registerProductRoutes } from "./routes/products.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import { registerInventoryRoutes } from "./routes/inventory.js";
import { registerOnlineOrderRoutes } from "./routes/onlineOrders.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerBranchRoutes } from "./routes/branches.js";
import { registerInventoryEventRoutes } from "./routes/inventoryEvents.js";
import { registerPartyAndPurchaseRoutes } from "./routes/partiesPurchases.js";
import { registerReturnsAndReportsRoutes } from "./routes/returnsReports.js";
import { registerStoreSettingsRoutes } from "./routes/storeSettings.js";
import { registerPaymentRoutes } from "./routes/payments.js";
import { registerRazorpayWebhookRoutes } from "./routes/razorpayWebhook.js";
import { registerProfileAndInvoiceRoutes } from "./routes/profileInvoices.js";
import { registerInventoryTransferRoutes } from "./routes/inventoryTransfers.js";
import { registerStaffRoutes } from "./routes/staff.js";
import { registerOnlineOrderManagementRoutes } from "./routes/onlineOrderManagement.js";
import { registerSaleRoutes } from "./routes/sales.js";
import { registerStorefrontRoutes } from "./routes/storefront.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    requestIdHeader: "x-request-id",
    bodyLimit: 1_048_576,
  });
  await app.register(helmet);
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
    (request as FastifyRequest & { rawBody?: Buffer }).rawBody = rawBody;
    try { done(null, JSON.parse(rawBody.toString("utf8"))); }
    catch (error) { done(error as Error); }
  });
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
  await registerInventoryTransferRoutes(app);
  await registerStaffRoutes(app);
  await registerOnlineOrderManagementRoutes(app);
  await registerProductRoutes(app);
  await registerInventoryRoutes(app);
  await registerPartyAndPurchaseRoutes(app);
  await registerReturnsAndReportsRoutes(app);
  await registerStoreSettingsRoutes(app);
  await registerPaymentRoutes(app);
  await registerRazorpayWebhookRoutes(app);
  await registerProfileAndInvoiceRoutes(app);
  await registerSaleRoutes(app);
  await registerStorefrontRoutes(app);
  await registerInventoryEventRoutes(app);
  await registerOnlineOrderRoutes(app);

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "Unhandled request error");
    const normalizedError = error instanceof Error ? error : new Error("Unknown request error.");
    const candidateStatus = "statusCode" in normalizedError ? normalizedError.statusCode : undefined;
    const statusCode = typeof candidateStatus === "number" && candidateStatus >= 400 ? candidateStatus : 500;
    return reply.status(statusCode).send({
      error: {
        code: statusCode >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR",
        message: statusCode >= 500 ? "An unexpected error occurred." : normalizedError.message,
        requestId: request.id,
      },
    });
  });
  return app;
}
