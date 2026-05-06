#!/usr/bin/env node
import { loadWebhookConfig } from "./config.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const cfg = loadWebhookConfig();
  const app = await buildServer(cfg);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: cfg.port, host: cfg.host });
}

main().catch((err) => {
  console.error("[webhook] failed to start:", err);
  process.exit(1);
});
