import Stripe from "stripe";
import {
  AmplitudeClient,
  CustomerCache,
  StripeCatalog,
  synthesizeFromObject,
  type AmplitudeEvent,
  type CommonContext,
  type ResolvedCustomer,
  type StripeEntity,
} from "@stripe-to-amplitude/core";
import type { BackfillConfig } from "./config.js";
import { StateStore } from "./state-store.js";

interface Stats {
  perEntity: Record<string, number>;
  matchedByPrimary: number;
  matchedByFallback: Record<string, number>;
  unmatchedCustomers: number;
}

const newStats = (): Stats => ({
  perEntity: {},
  matchedByPrimary: 0,
  matchedByFallback: {},
  unmatchedCustomers: 0,
});

interface ListParams {
  limit: number;
  created?: Stripe.RangeQueryParam;
  expand?: string[];
}

/**
 * Iterate every item of a Stripe list endpoint using the SDK's built-in
 * cursor pagination (`starting_after`). This walks the resource end-to-end
 * regardless of how many pages there are. Stripe returns items in descending
 * `created` order, which is fine because we use the Stripe object id as part
 * of the Amplitude `insert_id`: a re-run is naturally idempotent.
 */
async function* iterateAll<T extends { id: string; created: number }>(
  list: (params: ListParams) => Stripe.ApiListPromise<T>,
  hardSince: number | undefined,
  label: string,
  expand?: string[],
): AsyncGenerator<T> {
  const params: ListParams = { limit: 100 };
  if (hardSince) params.created = { gte: hardSince };
  if (expand && expand.length > 0) params.expand = expand;

  let count = 0;
  for await (const item of list(params)) {
    count += 1;
    yield item;
    if (count % 500 === 0) {
      console.log(`[backfill]   ${label}: ${count} items so far`);
    }
  }
  console.log(`[backfill]   ${label}: ${count} total items`);
}

async function dispatch(
  client: AmplitudeClient,
  events: AmplitudeEvent[],
  dryRun: boolean,
): Promise<void> {
  if (events.length === 0) return;
  if (dryRun) return;
  await client.send(events);
}

export async function runBackfill(cfg: BackfillConfig): Promise<Stats> {
  const stripe = new Stripe(cfg.stripeApiKey);
  const amplitude = new AmplitudeClient({
    apiKey: cfg.amplitudeApiKey,
    endpoint: cfg.amplitudeEndpoint,
    useBatchApi: true,
  });
  const cache = new CustomerCache(cfg.resolver);
  const catalog = new StripeCatalog();
  const state = new StateStore(cfg.stateDir);
  await state.load();

  const stats = newStats();
  const log = (msg: string) => console.log(`[backfill] ${new Date().toISOString()} ${msg}`);

  log("Loading Stripe catalog (products / prices / coupons / tax rates)");
  await catalog.load(stripe);
  log("  catalog loaded");

  // -------- Phase 1: customers (must run first) --------
  if (cfg.entities.includes("customer") && !state.isCompleted("customer")) {
    log("Phase 1/2: customers");
    let buffer: AmplitudeEvent[] = [];

    for await (const customer of iterateAll(
      (params) =>
        stripe.customers.list(
          params as Stripe.CustomerListParams,
        ),
      cfg.since,
      "customer",
      ["data.invoice_settings.default_payment_method", "data.tax_ids"],
    )) {
      const resolved = cache.set(customer);
      countMatch(resolved, stats);
      // Skip customers with no resolved user_id: we don't want anonymous
      // device-id-only events polluting the project. The cache still keeps
      // the resolved record so child-entity lookups know to skip too.
      if (!resolved.amplitudeUserId) continue;
      const events = synthesizeFromObject({ kind: "customer", data: resolved }, catalog);
      buffer.push(...events);
      stats.perEntity.customer = (stats.perEntity.customer ?? 0) + events.length;

      if (buffer.length >= 1000) {
        await dispatch(amplitude, buffer, cfg.dryRun);
        buffer = [];
      }
    }
    if (buffer.length > 0) await dispatch(amplitude, buffer, cfg.dryRun);
    if (!cfg.dryRun) await state.markCompleted("customer");
    log(`  customers done. cache size: ${cache.size()}`);
  } else if (cfg.entities.some((e) => e !== "customer") && cache.size() === 0) {
    // We need the customer cache populated for child entities, even if customer
    // ingestion was completed in a prior run.
    log("Re-warming customer cache from Stripe (skipping ingestion)");
    let count = 0;
    for await (const customer of stripe.customers.list({ limit: 100 })) {
      cache.set(customer);
      count += 1;
      if (count % 500 === 0) log(`  cache: ${count}`);
    }
    log(`  cache size: ${cache.size()}`);
  }

  // -------- Phase 2: child entities --------
  for (const entity of cfg.entities) {
    if (entity === "customer") continue;
    if (state.isCompleted(entity)) {
      log(`Skipping ${entity} (already completed in a prior run)`);
      continue;
    }
    await runEntity(entity, stripe, amplitude, cache, catalog, cfg, state, stats, log);
  }

  return stats;
}

async function runEntity(
  entity: Exclude<StripeEntity, "customer">,
  stripe: Stripe,
  amplitude: AmplitudeClient,
  cache: CustomerCache,
  catalog: StripeCatalog,
  cfg: BackfillConfig,
  state: StateStore,
  stats: Stats,
  log: (msg: string) => void,
): Promise<void> {
  log(`Phase 2: ${entity}`);
  let buffer: AmplitudeEvent[] = [];

  const buildCtx = async (
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
    if (!resolved.amplitudeUserId) {
      stats.unmatchedCustomers += 1;
      return null; // Skip events for customers we couldn't resolve.
    }
    return {
      amplitudeUserId: resolved.amplitudeUserId,
      stripeCustomerId: id,
      customerEmail: resolved.email,
    };
  };

  const flushIfNeeded = async () => {
    if (buffer.length >= 1000) {
      await dispatch(amplitude, buffer, cfg.dryRun);
      buffer = [];
    }
  };

  switch (entity) {
    case "subscription": {
      for await (const sub of iterateAll<Stripe.Subscription>(
        (p) =>
          stripe.subscriptions.list({
            ...(p as Stripe.SubscriptionListParams),
            status: "all",
          }),
        cfg.since,
        "subscription",
        ["data.discount.coupon", "data.latest_invoice"],
      )) {
        const ctx = await buildCtx(sub.customer);
        if (!ctx) continue;
        const events = synthesizeFromObject(
          { kind: "subscription", data: sub, ctx },
          catalog,
        );
        buffer.push(...events);
        stats.perEntity.subscription = (stats.perEntity.subscription ?? 0) + events.length;
        await flushIfNeeded();
      }
      break;
    }
    case "invoice": {
      for await (const inv of iterateAll<Stripe.Invoice>(
        (p) => stripe.invoices.list(p as Stripe.InvoiceListParams),
        cfg.since,
        "invoice",
        ["data.charge.balance_transaction", "data.payment_intent"],
      )) {
        const ctx = await buildCtx(inv.customer);
        if (!ctx) continue;
        const events = synthesizeFromObject({ kind: "invoice", data: inv, ctx }, catalog);
        buffer.push(...events);
        stats.perEntity.invoice = (stats.perEntity.invoice ?? 0) + events.length;
        await flushIfNeeded();
      }
      break;
    }
    case "charge": {
      for await (const ch of iterateAll<Stripe.Charge>(
        (p) => stripe.charges.list(p as Stripe.ChargeListParams),
        cfg.since,
        "charge",
        ["data.balance_transaction"],
      )) {
        const ctx = await buildCtx(ch.customer);
        if (!ctx) continue;
        const events = synthesizeFromObject({ kind: "charge", data: ch, ctx }, catalog);
        buffer.push(...events);
        stats.perEntity.charge = (stats.perEntity.charge ?? 0) + events.length;
        await flushIfNeeded();
      }
      break;
    }
    case "refund": {
      // Refunds don't carry the customer id directly, so we resolve via the charge.
      for await (const r of iterateAll<Stripe.Refund>(
        (p) => stripe.refunds.list(p as Stripe.RefundListParams),
        cfg.since,
        "refund",
        ["data.balance_transaction", "data.charge"],
      )) {
        const chargeFromExpand =
          r.charge && typeof r.charge === "object" ? (r.charge as Stripe.Charge) : null;
        const chargeId =
          typeof r.charge === "string" ? r.charge : r.charge?.id;
        if (!chargeId) continue;
        const charge = chargeFromExpand ?? (await stripe.charges.retrieve(chargeId));
        const ctx = await buildCtx(charge.customer);
        if (!ctx) continue;
        const events = synthesizeFromObject(
          { kind: "refund", data: r, ctx, originalCharge: charge },
          catalog,
        );
        buffer.push(...events);
        stats.perEntity.refund = (stats.perEntity.refund ?? 0) + events.length;
        await flushIfNeeded();
      }
      break;
    }
    case "payment_intent": {
      for await (const pi of iterateAll<Stripe.PaymentIntent>(
        (p) => stripe.paymentIntents.list(p as Stripe.PaymentIntentListParams),
        cfg.since,
        "payment_intent",
      )) {
        const ctx = await buildCtx(pi.customer);
        if (!ctx) continue;
        const events = synthesizeFromObject(
          { kind: "payment_intent", data: pi, ctx },
          catalog,
        );
        buffer.push(...events);
        stats.perEntity.payment_intent = (stats.perEntity.payment_intent ?? 0) + events.length;
        await flushIfNeeded();
      }
      break;
    }
    case "dispute": {
      for await (const d of iterateAll<Stripe.Dispute>(
        (p) => stripe.disputes.list(p as Stripe.DisputeListParams),
        cfg.since,
        "dispute",
      )) {
        const chargeId = typeof d.charge === "string" ? d.charge : d.charge?.id;
        if (!chargeId) continue;
        const charge = await stripe.charges.retrieve(chargeId);
        const ctx = await buildCtx(charge.customer);
        if (!ctx) continue;
        const events = synthesizeFromObject({ kind: "dispute", data: d, ctx }, catalog);
        buffer.push(...events);
        stats.perEntity.dispute = (stats.perEntity.dispute ?? 0) + events.length;
        await flushIfNeeded();
      }
      break;
    }
    case "credit_note": {
      for await (const cn of iterateAll<Stripe.CreditNote>(
        (p) => stripe.creditNotes.list(p as Stripe.CreditNoteListParams),
        cfg.since,
        "credit_note",
      )) {
        const ctx = await buildCtx(cn.customer);
        if (!ctx) continue;
        const events = synthesizeFromObject(
          { kind: "credit_note", data: cn, ctx },
          catalog,
        );
        buffer.push(...events);
        stats.perEntity.credit_note = (stats.perEntity.credit_note ?? 0) + events.length;
        await flushIfNeeded();
      }
      break;
    }
  }

  if (buffer.length > 0) await dispatch(amplitude, buffer, cfg.dryRun);
  if (!cfg.dryRun) await state.markCompleted(entity);
  log(`  ${entity} done: ${stats.perEntity[entity] ?? 0} events`);
}

function countMatch(resolved: ResolvedCustomer, stats: Stats): void {
  if (!resolved.resolvedVia) {
    stats.unmatchedCustomers += 1;
    return;
  }
  if (resolved.resolvedVia.startsWith("metadata.")) {
    stats.matchedByPrimary += 1;
    return;
  }
  stats.matchedByFallback[resolved.resolvedVia] =
    (stats.matchedByFallback[resolved.resolvedVia] ?? 0) + 1;
}
