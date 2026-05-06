import type Stripe from "stripe";
import { flatten, flattenWithPrefix, type FlatPrimitive } from "./flatten.js";
import type { StripeCatalog } from "./stripe-catalog.js";
import type { AmplitudeEvent, ResolvedCustomer } from "./types.js";

/**
 * v2 of the synthesized event surface.
 *
 * Every Amplitude event embeds a fully-flattened version of the source Stripe
 * object directly under `event_properties` (no allowlist), plus enrichment
 * (`product_*`, `price_*`, `coupon_*`, `tax_rates_*_*`) resolved through the
 * `StripeCatalog`, plus computed derived fields (MRR, ARR, refund_pct, ...).
 *
 * `insert_id` carries the `:v2` suffix so re-running the backfill against an
 * Amplitude project that already received v1 events produces a clean second
 * cohort (filter by `event_properties.data_version`).
 *
 * USER PROPERTY OPERATOR MAP
 * --------------------------
 * | Event                                 | $setOnce                              | $set                                                                                                                                                                                  | $add                                                                                  |
 * |---------------------------------------|---------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------|
 * | customer.created                      | signup_at_ms                          | country, language, currency, tax_exempt, delinquent                                                                                                                                   | —                                                                                     |
 * | customer.subscription.created         | first_subscription_created_at_ms      | current_plan_id, current_plan_name, current_product_name, current_tier, current_mrr_minor, current_subscription_status, last_subscription_change_at_ms                                | —                                                                                     |
 * | customer.subscription.updated         | —                                     | current_plan_id, current_plan_name, current_product_name, current_tier, current_mrr_minor, current_subscription_status, last_subscription_change_at_ms                                | —                                                                                     |
 * | customer.subscription.deleted         | —                                     | current_subscription_status, last_subscription_change_at_ms                                                                                                                           | —                                                                                     |
 * | customer.subscription.paused          | —                                     | current_subscription_status, last_subscription_change_at_ms                                                                                                                           | —                                                                                     |
 * | customer.subscription.resumed         | —                                     | current_subscription_status, last_subscription_change_at_ms                                                                                                                           | —                                                                                     |
 * | customer.subscription.trial_converted | —                                     | current_subscription_status, last_subscription_change_at_ms                                                                                                                           | —                                                                                     |
 * | invoice.payment_succeeded             | first_paid_invoice_at_ms              | last_payment_at_ms                                                                                                                                                                    | lifetime_revenue_minor, lifetime_invoices_count                                       |
 * | invoice.payment_failed                | —                                     | —                                                                                                                                                                                     | —                                                                                     |
 * | charge.refunded                       | —                                     | —                                                                                                                                                                                     | lifetime_refunds_count, lifetime_refunded_minor                                       |
 * | charge.dispute.created                | —                                     | —                                                                                                                                                                                     | lifetime_disputes_count, lifetime_chargeback_minor                                    |
 */
export const INSERT_ID_VERSION = "v2";
const DATA_VERSION = 2;

const toMs = (sec: number | null | undefined): number =>
  sec == null ? Date.now() : sec * 1000;

const toMajorUnit = (amountMinor: number | null | undefined): number =>
  amountMinor == null ? 0 : amountMinor / 100;

/** Stable v2 backfill insert_id. */
const v2InsertId = (eventType: string, objectId: string, suffix?: string): string =>
  suffix
    ? `${eventType}:${objectId}:${suffix}:${INSERT_ID_VERSION}`
    : `${eventType}:${objectId}:${INSERT_ID_VERSION}`;

interface CommonContext {
  amplitudeUserId: string | null;
  stripeCustomerId: string;
  customerEmail?: string | null;
}

type AmplitudeUserProps = {
  $setOnce?: Record<string, FlatPrimitive>;
  $set?: Record<string, FlatPrimitive>;
  $add?: Record<string, number>;
};

interface BuildOpts {
  derived?: Record<string, FlatPrimitive>;
  enrichment?: Record<string, FlatPrimitive>;
  userProps?: AmplitudeUserProps;
  livemode?: boolean | null;
  testClockId?: string | null;
}

/**
 * Build the shared event scaffold using the deep flattener over the Stripe
 * object. Enrichment / derived fields are layered on top so they win over
 * any naturally clashing keys from the flatten pass.
 */
function buildEvent(
  eventType: string,
  time: number,
  insertId: string,
  ctx: CommonContext,
  stripeObject: unknown,
  opts: BuildOpts = {},
): AmplitudeEvent {
  const flat = flatten(stripeObject);
  const livemode =
    opts.livemode ??
    (typeof (stripeObject as { livemode?: boolean })?.livemode === "boolean"
      ? (stripeObject as { livemode: boolean }).livemode
      : null);
  const testClockId =
    opts.testClockId ??
    ((stripeObject as { test_clock?: string | { id?: string } | null })?.test_clock
      ? typeof (stripeObject as { test_clock?: string | { id?: string } }).test_clock === "string"
        ? ((stripeObject as { test_clock: string }).test_clock)
        : ((stripeObject as { test_clock: { id?: string } }).test_clock?.id ?? null)
      : null);

  const event_properties: Record<string, unknown> = {
    ...flat,
    ...(opts.enrichment ?? {}),
    ...(opts.derived ?? {}),
    stripe_customer_id: ctx.stripeCustomerId,
    data_version: DATA_VERSION,
    livemode,
    test_clock_id: testClockId,
  };

  const baseSet: Record<string, FlatPrimitive> = {
    stripe_customer_id: ctx.stripeCustomerId,
  };
  if (ctx.customerEmail) baseSet.email = ctx.customerEmail;

  const user_properties: AmplitudeUserProps = {
    $set: { ...baseSet, ...(opts.userProps?.$set ?? {}) },
  };
  if (opts.userProps?.$setOnce && Object.keys(opts.userProps.$setOnce).length > 0) {
    user_properties.$setOnce = opts.userProps.$setOnce;
  }
  if (opts.userProps?.$add && Object.keys(opts.userProps.$add).length > 0) {
    user_properties.$add = opts.userProps.$add;
  }

  return {
    user_id: ctx.amplitudeUserId ?? undefined,
    device_id: ctx.amplitudeUserId ? undefined : ctx.stripeCustomerId,
    event_type: eventType,
    time,
    insert_id: insertId,
    event_properties,
    user_properties: user_properties as Record<string, unknown>,
  };
}

// ---------- Enrichment helpers ----------

function priceFromSubscription(sub: Stripe.Subscription): Stripe.Price | null {
  return sub.items.data[0]?.price ?? null;
}

function productIdOf(price: Stripe.Price | null | undefined): string | null {
  if (!price) return null;
  return typeof price.product === "string" ? price.product : (price.product?.id ?? null);
}

function couponIdOf(sub: Stripe.Subscription): string | null {
  const d = (sub as Stripe.Subscription & { discount?: Stripe.Discount | null }).discount ?? null;
  if (!d) return null;
  return typeof d.coupon === "string" ? d.coupon : (d.coupon?.id ?? null);
}

function buildCatalogEnrichment(
  catalog: StripeCatalog,
  opts: { priceId?: string | null; couponId?: string | null; taxRateIds?: string[] },
): Record<string, FlatPrimitive> {
  const out: Record<string, FlatPrimitive> = {};
  const price = catalog.priceById(opts.priceId);
  if (price) {
    Object.assign(out, flattenWithPrefix(price, "price"));
    const productId = productIdOf(price);
    const product = catalog.productById(productId);
    if (product) Object.assign(out, flattenWithPrefix(product, "product"));
  }
  const coupon = catalog.couponById(opts.couponId);
  if (coupon) Object.assign(out, flattenWithPrefix(coupon, "coupon"));
  if (opts.taxRateIds) {
    opts.taxRateIds.forEach((id, idx) => {
      const tr = catalog.taxRateById(id);
      if (tr) Object.assign(out, flattenWithPrefix(tr, `tax_rates_${idx}`));
    });
  }
  return out;
}

function tierFromProduct(product: Stripe.Product | undefined): string | null {
  if (!product) return null;
  const md = product.metadata ?? {};
  return md.tier ?? md.plan_tier ?? null;
}

// ---------- Customer ----------

export function synthesizeCustomerEvents(
  resolved: ResolvedCustomer,
  _catalog: StripeCatalog,
): AmplitudeEvent[] {
  const c = resolved.raw;
  const ctx: CommonContext = {
    amplitudeUserId: resolved.amplitudeUserId,
    stripeCustomerId: c.id,
    customerEmail: c.email,
  };

  const userProps: AmplitudeUserProps = {
    $setOnce: { signup_at_ms: toMs(c.created) },
    $set: {
      ...(c.address?.country ? { country: c.address.country } : {}),
      ...(c.preferred_locales && c.preferred_locales.length > 0
        ? { language: c.preferred_locales[0] }
        : {}),
      ...(c.currency ? { currency: c.currency } : {}),
      ...(c.tax_exempt ? { tax_exempt: c.tax_exempt } : {}),
      delinquent: c.delinquent ?? false,
    },
  };

  return [
    buildEvent(
      "[Stripe v2] customer.created",
      toMs(c.created),
      v2InsertId("customer.created", c.id),
      ctx,
      c,
      { userProps },
    ),
  ];
}

// ---------- Subscription ----------

function mrrMinor(sub: Stripe.Subscription): number {
  // Sum each line: unit_amount * quantity, normalized to per-month.
  let total = 0;
  for (const item of sub.items.data) {
    const price = item.price;
    if (!price?.recurring) continue;
    const qty = item.quantity ?? 1;
    const unit = price.unit_amount ?? 0;
    const interval = price.recurring.interval;
    const intervalCount = price.recurring.interval_count ?? 1;
    let perMonth = 0;
    if (interval === "month") perMonth = unit / intervalCount;
    else if (interval === "year") perMonth = unit / (12 * intervalCount);
    else if (interval === "week") perMonth = (unit * (52 / 12)) / intervalCount;
    else if (interval === "day") perMonth = (unit * 30) / intervalCount;
    total += Math.round(perMonth * qty);
  }
  return total;
}

function subDerivedFields(sub: Stripe.Subscription): Record<string, FlatPrimitive> {
  const out: Record<string, FlatPrimitive> = {};
  const mrr = mrrMinor(sub);
  out.mrr_minor = mrr;
  out.mrr = toMajorUnit(mrr);
  out.arr_minor = mrr * 12;
  out.arr = toMajorUnit(mrr * 12);
  out.is_trialing = sub.status === "trialing";
  if (sub.trial_start && sub.trial_end) {
    out.trial_length_days = Math.round((sub.trial_end - sub.trial_start) / 86400);
  }
  out.voluntary_cancel = !!sub.cancel_at_period_end;
  if (sub.canceled_at) {
    out.tenure_days = Math.round((sub.canceled_at - sub.created) / 86400);
  }
  const cpe = (sub as Stripe.Subscription & { current_period_end?: number }).current_period_end;
  if (cpe) {
    out.current_period_remaining_days = Math.max(
      0,
      Math.round((cpe - Date.now() / 1000) / 86400),
    );
  }
  return out;
}

export function synthesizeSubscriptionEvents(
  sub: Stripe.Subscription,
  ctx: CommonContext,
  catalog: StripeCatalog,
): AmplitudeEvent[] {
  const events: AmplitudeEvent[] = [];
  const price = priceFromSubscription(sub);
  const enrichment = buildCatalogEnrichment(catalog, {
    priceId: price?.id,
    couponId: couponIdOf(sub),
  });
  const derived = subDerivedFields(sub);
  const product = catalog.productById(productIdOf(price));
  const planName = price?.nickname ?? product?.name ?? null;

  const setProps: Record<string, FlatPrimitive> = {
    current_subscription_status: sub.status,
    last_subscription_change_at_ms: toMs(sub.created),
  };
  if (price?.id) setProps.current_plan_id = price.id;
  if (planName) setProps.current_plan_name = planName;
  if (product?.name) setProps.current_product_name = product.name;
  const tier = tierFromProduct(product);
  if (tier) setProps.current_tier = tier;
  setProps.current_mrr_minor = derived.mrr_minor as number;

  events.push(
    buildEvent(
      "[Stripe v2] customer.subscription.created",
      toMs(sub.created),
      v2InsertId("subscription.created", sub.id),
      ctx,
      sub,
      {
        derived,
        enrichment,
        userProps: {
          $setOnce: { first_subscription_created_at_ms: toMs(sub.created) },
          $set: setProps,
        },
      },
    ),
  );

  if (sub.trial_start && sub.trial_end) {
    events.push(
      buildEvent(
        "[Stripe v2] customer.subscription.trial_will_end",
        toMs(sub.trial_end),
        v2InsertId("subscription.trial_will_end", sub.id),
        ctx,
        sub,
        { derived, enrichment },
      ),
    );

    if (sub.status === "active" && sub.trial_end * 1000 < Date.now()) {
      events.push(
        buildEvent(
          "[Stripe v2] customer.subscription.trial_converted",
          toMs(sub.trial_end),
          v2InsertId("subscription.trial_converted", sub.id),
          ctx,
          sub,
          {
            derived,
            enrichment,
            userProps: {
              $set: {
                current_subscription_status: sub.status,
                last_subscription_change_at_ms: toMs(sub.trial_end),
              },
            },
          },
        ),
      );
    }
  }

  if (sub.canceled_at) {
    events.push(
      buildEvent(
        "[Stripe v2] customer.subscription.deleted",
        toMs(sub.canceled_at),
        v2InsertId("subscription.deleted", sub.id),
        ctx,
        sub,
        {
          derived,
          enrichment,
          userProps: {
            $set: {
              current_subscription_status: sub.status,
              last_subscription_change_at_ms: toMs(sub.canceled_at),
            },
          },
        },
      ),
    );
  }

  const pause = (sub as Stripe.Subscription & { pause_collection?: Stripe.Subscription.PauseCollection | null })
    .pause_collection;
  if (pause) {
    events.push(
      buildEvent(
        "[Stripe v2] customer.subscription.paused",
        toMs(sub.created),
        v2InsertId("subscription.paused", sub.id),
        ctx,
        sub,
        {
          derived,
          enrichment,
          userProps: {
            $set: {
              current_subscription_status: "paused",
              last_subscription_change_at_ms: toMs(sub.created),
            },
          },
        },
      ),
    );
    if (pause.resumes_at && pause.resumes_at * 1000 < Date.now()) {
      events.push(
        buildEvent(
          "[Stripe v2] customer.subscription.resumed",
          toMs(pause.resumes_at),
          v2InsertId("subscription.resumed", sub.id),
          ctx,
          sub,
          {
            derived,
            enrichment,
            userProps: {
              $set: {
                current_subscription_status: sub.status,
                last_subscription_change_at_ms: toMs(pause.resumes_at),
              },
            },
          },
        ),
      );
    }
  }

  return events;
}

// ---------- Invoice ----------

function invoiceDerivedFields(inv: Stripe.Invoice): Record<string, FlatPrimitive> {
  const out: Record<string, FlatPrimitive> = {};
  let isProration = false;
  let prorationMinor = 0;
  for (const line of inv.lines.data) {
    if (line.proration) {
      isProration = true;
      prorationMinor += line.amount ?? 0;
    }
  }
  out.is_proration = isProration;
  out.proration_amount_minor = prorationMinor;
  out.proration_amount = toMajorUnit(prorationMinor);
  const t = inv.status_transitions;
  if (t?.paid_at && inv.created) {
    out.time_to_pay_seconds = t.paid_at - inv.created;
  }
  if (t?.finalized_at && inv.created) {
    out.time_to_finalize_seconds = t.finalized_at - inv.created;
  }
  return out;
}

function invoiceTaxRateIds(inv: Stripe.Invoice): string[] {
  const ids = new Set<string>();
  type LegacyLine = Stripe.InvoiceLineItem & {
    tax_rates?: Array<Stripe.TaxRate | string>;
    tax_amounts?: Array<{ tax_rate?: Stripe.TaxRate | string }>;
    taxes?: Array<{ tax_rate_details?: { tax_rate?: Stripe.TaxRate | string } }>;
  };
  for (const line of inv.lines.data as LegacyLine[]) {
    if (line.tax_rates) {
      for (const tr of line.tax_rates) ids.add(typeof tr === "string" ? tr : tr.id);
    }
    if (line.tax_amounts) {
      for (const ta of line.tax_amounts) {
        const tr = ta.tax_rate;
        if (!tr) continue;
        ids.add(typeof tr === "string" ? tr : tr.id);
      }
    }
    if (line.taxes) {
      for (const t of line.taxes) {
        const tr = t.tax_rate_details?.tax_rate;
        if (!tr) continue;
        ids.add(typeof tr === "string" ? tr : tr.id);
      }
    }
  }
  return Array.from(ids);
}

function invoiceCouponId(inv: Stripe.Invoice): string | null {
  const d = (inv as Stripe.Invoice & { discount?: { coupon?: Stripe.Coupon | string } | null }).discount;
  if (!d?.coupon) return null;
  return typeof d.coupon === "string" ? d.coupon : d.coupon.id;
}

export function synthesizeInvoiceEvents(
  inv: Stripe.Invoice,
  ctx: CommonContext,
  catalog: StripeCatalog,
): AmplitudeEvent[] {
  const events: AmplitudeEvent[] = [];
  const id = inv.id ?? `${typeof inv.customer === "string" ? inv.customer : ""}-${inv.created}`;
  const firstLinePrice = inv.lines.data[0]?.price ?? null;
  const enrichment = buildCatalogEnrichment(catalog, {
    priceId: firstLinePrice?.id,
    couponId: invoiceCouponId(inv),
    taxRateIds: invoiceTaxRateIds(inv),
  });
  const derived = invoiceDerivedFields(inv);

  events.push(
    buildEvent(
      "[Stripe v2] invoice.created",
      toMs(inv.created),
      v2InsertId("invoice.created", id),
      ctx,
      inv,
      { derived, enrichment },
    ),
  );

  const t = inv.status_transitions;
  if (t?.finalized_at && inv.id) {
    events.push(
      buildEvent(
        "[Stripe v2] invoice.finalized",
        toMs(t.finalized_at),
        v2InsertId("invoice.finalized", inv.id),
        ctx,
        inv,
        { derived, enrichment },
      ),
    );
  }
  if (t?.paid_at && inv.id && inv.amount_paid > 0) {
    const paidEvent = buildEvent(
      "[Stripe v2] invoice.payment_succeeded",
      toMs(t.paid_at),
      v2InsertId("invoice.payment_succeeded", inv.id),
      ctx,
      inv,
      {
        derived,
        enrichment,
        userProps: {
          $setOnce: { first_paid_invoice_at_ms: toMs(t.paid_at) },
          $set: { last_payment_at_ms: toMs(t.paid_at) },
          $add: {
            lifetime_revenue_minor: inv.amount_paid,
            lifetime_invoices_count: 1,
          },
        },
      },
    );
    paidEvent.$revenue = toMajorUnit(inv.amount_paid);
    paidEvent.$revenueType = inv.billing_reason ?? "invoice";
    const pid = inv.lines.data[0]?.price?.product;
    if (typeof pid === "string") paidEvent.$productId = pid;
    else if (pid && "id" in pid) paidEvent.$productId = pid.id;
    events.push(paidEvent);
  }
  if (t?.voided_at && inv.id) {
    events.push(
      buildEvent(
        "[Stripe v2] invoice.voided",
        toMs(t.voided_at),
        v2InsertId("invoice.voided", inv.id),
        ctx,
        inv,
        { derived, enrichment },
      ),
    );
  }
  if (t?.marked_uncollectible_at && inv.id) {
    events.push(
      buildEvent(
        "[Stripe v2] invoice.marked_uncollectible",
        toMs(t.marked_uncollectible_at),
        v2InsertId("invoice.marked_uncollectible", inv.id),
        ctx,
        inv,
        { derived, enrichment },
      ),
    );
  }

  // payment_failed: attempt_count >= 1, status open|uncollectible, no paid_at.
  if (
    inv.id &&
    !t?.paid_at &&
    (inv.attempt_count ?? 0) >= 1 &&
    (inv.status === "open" || inv.status === "uncollectible")
  ) {
    const failTime =
      (inv as Stripe.Invoice & { webhooks_delivered_at?: number | null }).webhooks_delivered_at ??
      inv.created;
    events.push(
      buildEvent(
        "[Stripe v2] invoice.payment_failed",
        toMs(failTime),
        v2InsertId("invoice.payment_failed", inv.id),
        ctx,
        inv,
        { derived, enrichment },
      ),
    );
  }

  return events;
}

// ---------- Charge ----------

function chargeDerivedFields(charge: Stripe.Charge): Record<string, FlatPrimitive> {
  const out: Record<string, FlatPrimitive> = {};
  const bt = charge.balance_transaction;
  if (bt && typeof bt === "object") {
    if (typeof bt.fee === "number") {
      out.stripe_fee_minor = bt.fee;
      out.stripe_fee = toMajorUnit(bt.fee);
    }
    if (typeof bt.net === "number") {
      out.net_minor = bt.net;
      out.net = toMajorUnit(bt.net);
    }
  }
  return out;
}

export function synthesizeChargeEvents(
  charge: Stripe.Charge,
  ctx: CommonContext,
  _catalog: StripeCatalog,
): AmplitudeEvent[] {
  const events: AmplitudeEvent[] = [];
  const derived = chargeDerivedFields(charge);

  if (charge.status === "succeeded") {
    const ev = buildEvent(
      "[Stripe v2] charge.succeeded",
      toMs(charge.created),
      v2InsertId("charge.succeeded", charge.id),
      ctx,
      charge,
      { derived },
    );
    ev.$revenue = toMajorUnit(charge.amount);
    ev.$revenueType = "charge";
    events.push(ev);
  } else if (charge.status === "failed") {
    events.push(
      buildEvent(
        "[Stripe v2] charge.failed",
        toMs(charge.created),
        v2InsertId("charge.failed", charge.id),
        ctx,
        charge,
        { derived },
      ),
    );
  }

  return events;
}

// ---------- Refund ----------

export function synthesizeRefundEvents(
  refund: Stripe.Refund,
  ctx: CommonContext,
  _catalog: StripeCatalog,
  originalCharge?: Stripe.Charge | null,
): AmplitudeEvent[] {
  const derived: Record<string, FlatPrimitive> = {};
  if (originalCharge && typeof originalCharge.amount === "number" && originalCharge.amount > 0) {
    const isPartial = refund.amount < originalCharge.amount;
    derived.is_partial_refund = isPartial;
    derived.refund_pct = refund.amount / originalCharge.amount;
  }

  // Stripe Refund objects don't expose `livemode`; inherit from the parent
  // charge so `livemode` filters in Amplitude don't drop refund rows.
  const refundLivemode = (refund as unknown as { livemode?: boolean }).livemode;
  const livemode =
    typeof refundLivemode === "boolean" ? refundLivemode : (originalCharge?.livemode ?? null);

  const ev = buildEvent(
    "[Stripe v2] charge.refunded",
    toMs(refund.created),
    v2InsertId("charge.refunded", refund.id),
    ctx,
    refund,
    {
      derived,
      livemode,
      userProps: {
        $add: {
          lifetime_refunds_count: 1,
          lifetime_refunded_minor: refund.amount,
        },
      },
    },
  );
  ev.$revenue = -toMajorUnit(refund.amount);
  ev.$revenueType = "refund";
  return [ev];
}

// ---------- PaymentIntent ----------

export function synthesizePaymentIntentEvents(
  pi: Stripe.PaymentIntent,
  ctx: CommonContext,
  _catalog: StripeCatalog,
): AmplitudeEvent[] {
  if (pi.status === "succeeded") {
    const ev = buildEvent(
      "[Stripe v2] payment_intent.succeeded",
      toMs(pi.created),
      v2InsertId("payment_intent.succeeded", pi.id),
      ctx,
      pi,
    );
    ev.$revenue = toMajorUnit(pi.amount_received);
    ev.$revenueType = "payment_intent";
    return [ev];
  }
  if (pi.status === "requires_payment_method" && pi.last_payment_error) {
    return [
      buildEvent(
        "[Stripe v2] payment_intent.payment_failed",
        toMs(pi.created),
        v2InsertId("payment_intent.payment_failed", pi.id),
        ctx,
        pi,
      ),
    ];
  }
  return [];
}

// ---------- Dispute ----------

export function synthesizeDisputeEvents(
  d: Stripe.Dispute,
  ctx: CommonContext,
  _catalog: StripeCatalog,
): AmplitudeEvent[] {
  const events: AmplitudeEvent[] = [];

  events.push(
    buildEvent(
      "[Stripe v2] charge.dispute.created",
      toMs(d.created),
      v2InsertId("charge.dispute.created", d.id),
      ctx,
      d,
      {
        userProps: {
          $add: {
            lifetime_disputes_count: 1,
            lifetime_chargeback_minor: d.amount,
          },
        },
      },
    ),
  );

  if (d.status === "won" || d.status === "lost" || d.status === "warning_closed") {
    // Pick a "closed at" timestamp: the most recent balance_transaction
    // beats `created`, otherwise we add a small delta to keep ordering
    // strictly after the open event.
    let closedSec = d.created + 1;
    const txns = (d as Stripe.Dispute & { balance_transactions?: Stripe.BalanceTransaction[] })
      .balance_transactions;
    if (txns && txns.length > 0) {
      const max = Math.max(...txns.map((t) => t.created));
      if (Number.isFinite(max)) closedSec = max;
    }
    events.push(
      buildEvent(
        "[Stripe v2] charge.dispute.closed",
        toMs(closedSec),
        v2InsertId("charge.dispute.closed", d.id, d.status),
        ctx,
        d,
        { derived: { dispute_outcome: d.status } },
      ),
    );
  }

  return events;
}

// ---------- Credit Note ----------

export function synthesizeCreditNoteEvents(
  cn: Stripe.CreditNote,
  ctx: CommonContext,
  _catalog: StripeCatalog,
): AmplitudeEvent[] {
  return [
    buildEvent(
      "[Stripe v2] credit_note.created",
      toMs(cn.created),
      v2InsertId("credit_note.created", cn.id),
      ctx,
      cn,
    ),
  ];
}

export type { CommonContext };
