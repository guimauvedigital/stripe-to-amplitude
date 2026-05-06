#!/usr/bin/env node
/**
 * Lists every Stripe customer that lacks a `metadata.user_id` (or whichever
 * primary strategy is configured). Use this before launching the real
 * backfill to know which customers will fall through to email / device-id
 * — and patch them in Stripe if you want a clean import.
 *
 * Usage:
 *   pnpm find-unmatched               # prints to stdout
 *   pnpm find-unmatched > unmatched.csv
 */
import Stripe from "stripe";
import {
  parseFallbackChain,
  parseUserIdStrategy,
  resolveUserId,
} from "@stripe-to-amplitude/core";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const stripe = new Stripe(required("STRIPE_API_KEY"));
  const resolver = {
    primary: parseUserIdStrategy(process.env.USER_ID_STRATEGY ?? "metadata.user_id"),
    fallbacks: parseFallbackChain(process.env.USER_ID_FALLBACK ?? ""),
  };

  // CSV header
  console.log("stripe_customer_id,email,name,created_iso,resolved_via,resolved_value");

  let total = 0;
  let unmatched = 0;
  let fallbackOnly = 0;

  for await (const customer of stripe.customers.list({ limit: 100 })) {
    total += 1;
    const { userId, via } = resolveUserId(customer, resolver);

    // We only care about customers where the PRIMARY strategy failed.
    if (via && via === resolver.primary) continue;

    if (via === null) unmatched += 1;
    else fallbackOnly += 1;

    const isoCreated = new Date(customer.created * 1000).toISOString();
    const safe = (s: string | null | undefined) => (s ?? "").replace(/[",\n]/g, " ");
    console.log(
      [
        customer.id,
        safe(customer.email),
        safe(customer.name),
        isoCreated,
        via ?? "none",
        userId ?? "",
      ].join(","),
    );
  }

  console.error(
    `\n[summary] total=${total} primary_match=${total - unmatched - fallbackOnly} fallback_only=${fallbackOnly} no_match=${unmatched}\n`,
  );
}

main().catch((err) => {
  console.error("[find-unmatched] failed:", err);
  process.exit(1);
});
