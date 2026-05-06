#!/usr/bin/env node
/**
 * Exports Stripe Products + their default Prices as a CSV ready to upload
 * as an Amplitude Lookup Table on the `product_id` event property.
 *
 * Usage:
 *   pnpm export-products > products.csv
 *
 * Then in Amplitude:
 *   Settings → Lookup Tables → Add Lookup Table
 *   - Property to join on: `product_id` (event property)
 *   - Upload products.csv
 *   - Map column `product_id` to the join key
 *
 * Once uploaded, every chart that references a Stripe event can group/segment
 * by `product_name`, `tier`, `monthly_price_eur`, `interval`, etc. on existing
 * events — no re-import required.
 */
import Stripe from "stripe";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function main(): Promise<void> {
  const stripe = new Stripe(required("STRIPE_API_KEY"));

  // Pull every product (active and archived) so we cover historical subscriptions.
  const products = new Map<string, Stripe.Product>();
  for await (const p of stripe.products.list({ limit: 100, active: true })) {
    products.set(p.id, p);
  }
  for await (const p of stripe.products.list({ limit: 100, active: false })) {
    products.set(p.id, p);
  }

  // For each product, find a representative recurring Price so we can expose
  // monthly equivalent revenue and interval. We pick the lowest-priced active
  // recurring Price (typically the most common tier).
  const repPriceByProduct = new Map<string, Stripe.Price>();
  for await (const price of stripe.prices.list({ limit: 100, active: true })) {
    if (price.type !== "recurring") continue;
    const productId = typeof price.product === "string" ? price.product : price.product.id;
    const current = repPriceByProduct.get(productId);
    if (!current || (price.unit_amount ?? Infinity) < (current.unit_amount ?? Infinity)) {
      repPriceByProduct.set(productId, price);
    }
  }

  // Header. Keep names short and snake_case so they're readable in Amplitude.
  const header = [
    "product_id",
    "product_name",
    "product_description",
    "product_active",
    "tier",
    "monthly_price_eur",
    "interval",
    "interval_count",
    "default_price_id",
    "currency",
  ];
  console.log(header.map(csvField).join(","));

  // Emit one row per product, sorted by name for readability.
  const sorted = [...products.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const product of sorted) {
    const repPrice = repPriceByProduct.get(product.id);
    const unitMajor = repPrice?.unit_amount != null ? repPrice.unit_amount / 100 : null;
    const interval = repPrice?.recurring?.interval ?? null;
    const intervalCount = repPrice?.recurring?.interval_count ?? null;

    // Approximate monthly equivalent (e.g. yearly plan / 12).
    let monthly: number | null = unitMajor;
    if (unitMajor != null && interval === "year") monthly = unitMajor / 12;
    if (unitMajor != null && interval === "week") monthly = unitMajor * 4.33;
    if (unitMajor != null && interval === "day") monthly = unitMajor * 30;

    // Tier: use the product's metadata.tier if set, else fall back to its name.
    const tier = product.metadata?.tier ?? product.name;

    const row = [
      product.id,
      product.name,
      product.description,
      product.active ? "true" : "false",
      tier,
      monthly != null ? monthly.toFixed(2) : "",
      interval,
      intervalCount,
      repPrice?.id ?? null,
      repPrice?.currency ?? null,
    ];
    console.log(row.map(csvField).join(","));
  }

  console.error(`\n[summary] ${products.size} products exported to stdout`);
}

main().catch((err) => {
  console.error("[export-products] failed:", err);
  process.exit(1);
});
