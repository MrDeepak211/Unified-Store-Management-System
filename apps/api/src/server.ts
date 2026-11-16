import "dotenv/config";
import { buildApp } from "./app.js";
import { startInventoryEventListener, stopInventoryEventListener } from "./routes/inventoryEvents.js";

const host = process.env.API_HOST ?? "0.0.0.0";
const rawPort = Number(process.env.API_PORT ?? 4000);
const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : 4000;
const app = await buildApp();
await startInventoryEventListener();

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down USMS API");
  await app.close();
  await stopInventoryEventListener();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
