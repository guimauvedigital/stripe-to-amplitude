#!/usr/bin/env node
/**
 * Pulls a small sample of every Stripe entity, runs them through the v2
 * synthesizer with full catalog enrichment, and writes the resulting Amplitude
 * events to ./sample-events.json. Sends nothing to Amplitude — review the
 * file to validate the payload shape before launching the full backfill.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import Stripe from "stripe";
import {
  CustomerCache,
  StripeCatalog,
  synthesizeFromObject,
  type AmplitudeEvent,
  type CommonContext,
} from "@stripe-to-amplitude/core";
import { loadConfig } from "./config.js";

const PER_ENTITY = Number.parseInt(process.env.SAMPLE_PER_ENTITY ?? "5", 10);
const OUTPUT_PATH = process.env.SAMPLE_OUTPUT ?? "./sample-events.json";
const RAW_OUTPUT_PATH = process.env.SAMPLE_RAW_OUTPUT ?? "./sample-raw.json";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const stripe = new Stripe(cfg.stripeApiKey);
  const cache = new CustomerCache(cfg.resolver);
  const catalog = new StripeCatalog();

  console.log(`[sample] loading Stripe catalog`);
  await catalog.load(stripe);

  const all: AmplitudeEvent[] = [];
  const raw: Array<{ kind: string; data: unknown }> = [];
  const ctxFor = async (
    customer: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined,
  ): Promise<CommonContext | null> => {
    const id =
      typeof customer === "string"
        ? customer
        : customer && "id" in customer
          ? customer.id
          : null;
    if (!id) return null;
    const resolved = await cache.resolve(id, stripe);
    if (!resolved.amplitudeUserId) return null;
    return {
      amplitudeUserId: resolved.amplitudeUserId,
      stripeCustomerId: id,
      customerEmail: resolved.email,
    };
  };

  console.log(`[sample] customers (${PER_ENTITY})`);
  let count = 0;
  for await (const c of stripe.customers.list({
    limit: PER_ENTITY,
    expand: ["data.invoice_settings.default_payment_method", "data.tax_ids"],
  })) {
    if (count++ >= PER_ENTITY) break;
    const resolved = cache.set(c);
    if (!resolved.amplitudeUserId) continue;
    raw.push({ kind: "customer", data: c });
    all.push(...synthesizeFromObject({ kind: "customer", data: resolved }, catalog));
  }

  console.log(`[sample] subscriptions (${PER_ENTITY})`);
  count = 0;
  for await (const s of stripe.subscriptions.list({
    limit: PER_ENTITY,
    status: "all",
    expand: ["data.discount.coupon", "data.latest_invoice"],
  })) {
    if (count++ >= PER_ENTITY) break;
    const ctx = await ctxFor(s.customer);
    if (!ctx) continue;
    raw.push({ kind: "subscription", data: s });
    all.push(...synthesizeFromObject({ kind: "subscription", data: s, ctx }, catalog));
  }

  console.log(`[sample] invoices (${PER_ENTITY})`);
  count = 0;
  for await (const i of stripe.invoices.list({
    limit: PER_ENTITY,
    expand: ["data.charge.balance_transaction", "data.payment_intent"],
  })) {
    if (count++ >= PER_ENTITY) break;
    const ctx = await ctxFor(i.customer);
    if (!ctx) continue;
    raw.push({ kind: "invoice", data: i });
    all.push(...synthesizeFromObject({ kind: "invoice", data: i, ctx }, catalog));
  }

  console.log(`[sample] charges (${PER_ENTITY})`);
  count = 0;
  for await (const ch of stripe.charges.list({
    limit: PER_ENTITY,
    expand: ["data.balance_transaction"],
  })) {
    if (count++ >= PER_ENTITY) break;
    const ctx = await ctxFor(ch.customer);
    if (!ctx) continue;
    raw.push({ kind: "charge", data: ch });
    all.push(...synthesizeFromObject({ kind: "charge", data: ch, ctx }, catalog));
  }

  console.log(`[sample] refunds (${PER_ENTITY})`);
  count = 0;
  for await (const r of stripe.refunds.list({
    limit: PER_ENTITY,
    expand: ["data.balance_transaction", "data.charge"],
  })) {
    if (count++ >= PER_ENTITY) break;
    const charge =
      typeof r.charge === "string"
        ? await stripe.charges.retrieve(r.charge)
        : (r.charge as Stripe.Charge | null);
    const ctx = await ctxFor(charge?.customer);
    if (!ctx) continue;
    raw.push({ kind: "refund", data: r });
    all.push(
      ...synthesizeFromObject(
        { kind: "refund", data: r, ctx, originalCharge: charge ?? null },
        catalog,
      ),
    );
  }

  console.log(`[sample] payment_intents (${PER_ENTITY})`);
  count = 0;
  for await (const pi of stripe.paymentIntents.list({ limit: PER_ENTITY })) {
    if (count++ >= PER_ENTITY) break;
    const ctx = await ctxFor(pi.customer);
    if (!ctx) continue;
    raw.push({ kind: "payment_intent", data: pi });
    all.push(...synthesizeFromObject({ kind: "payment_intent", data: pi, ctx }, catalog));
  }

  console.log(`[sample] disputes (any)`);
  count = 0;
  for await (const d of stripe.disputes.list({ limit: PER_ENTITY })) {
    if (count++ >= PER_ENTITY) break;
    const chargeId = typeof d.charge === "string" ? d.charge : d.charge?.id;
    if (!chargeId) continue;
    const charge = await stripe.charges.retrieve(chargeId);
    const ctx = await ctxFor(charge.customer);
    if (!ctx) continue;
    raw.push({ kind: "dispute", data: d });
    all.push(...synthesizeFromObject({ kind: "dispute", data: d, ctx }, catalog));
  }

  console.log(`[sample] credit_notes (${PER_ENTITY})`);
  count = 0;
  for await (const cn of stripe.creditNotes.list({ limit: PER_ENTITY })) {
    if (count++ >= PER_ENTITY) break;
    const ctx = await ctxFor(cn.customer);
    if (!ctx) continue;
    raw.push({ kind: "credit_note", data: cn });
    all.push(...synthesizeFromObject({ kind: "credit_note", data: cn, ctx }, catalog));
  }

  await mkdir(dirname(OUTPUT_PATH), { recursive: true }).catch(() => {});
  await writeFile(OUTPUT_PATH, JSON.stringify(all, null, 2), "utf8");
  await writeFile(RAW_OUTPUT_PATH, JSON.stringify(raw, null, 2), "utf8");
  console.log(`[sample] wrote ${raw.length} raw Stripe responses to ${RAW_OUTPUT_PATH}`);

  const byType = new Map<string, number>();
  for (const ev of all) byType.set(ev.event_type, (byType.get(ev.event_type) ?? 0) + 1);
  console.log(`\n[sample] wrote ${all.length} events to ${OUTPUT_PATH}`);
  console.log(`[sample] event_type distribution:`);
  for (const [t, c] of [...byType.entries()].sort()) console.log(`  ${t}: ${c}`);
}

main().catch((err) => {
  console.error("[sample] failed:", err);
  process.exit(1);
});
