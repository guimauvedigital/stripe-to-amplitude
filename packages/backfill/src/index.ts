#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { runBackfill } from "./runner.js";

async function main(): Promise<void> {
  const cfg = loadConfig();

  console.log("[backfill] starting with config:", {
    entities: cfg.entities,
    since: cfg.since ?? "account creation",
    primary: cfg.resolver.primary,
    fallbacks: cfg.resolver.fallbacks,
    dryRun: cfg.dryRun,
    stateDir: cfg.stateDir,
  });

  const stats = await runBackfill(cfg);

  console.log("[backfill] done");
  console.log("  events per entity:", stats.perEntity);
  console.log("  matched by primary user_id strategy:", stats.matchedByPrimary);
  console.log("  matched by fallback:", stats.matchedByFallback);
  console.log("  unmatched customers (no user_id at all):", stats.unmatchedCustomers);
}

main().catch((err) => {
  console.error("[backfill] failed:", err);
  process.exitCode = 1;
});
