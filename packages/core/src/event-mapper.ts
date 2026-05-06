import type Stripe from "stripe";
import {
  INSERT_ID_VERSION,
  synthesizeChargeEvents,
  synthesizeCreditNoteEvents,
  synthesizeCustomerEvents,
  synthesizeDisputeEvents,
  synthesizeInvoiceEvents,
  synthesizePaymentIntentEvents,
  synthesizeRefundEvents,
  synthesizeSubscriptionEvents,
  type CommonContext,
} from "./synthesizer.js";
import type { StripeCatalog } from "./stripe-catalog.js";
import type { AmplitudeEvent, ResolvedCustomer } from "./types.js";

/**
 * Live webhook → Amplitude event.
 *
 * To guarantee the live and backfill paths produce identical event shapes
 * (same flat properties, same enrichment, same `$setOnce` / `$set` /
 * `$add` operators on `user_properties`), we always route the webhook
 * through the same `synthesize*` function as the backfill, then pick the
 * single emitted event whose `event_type` matches `[Stripe v2] <event.type>`.
 *
 * Two delivery semantics:
 *
 * 1. Direct match — Stripe webhook type IS synthesized (created, deleted,
 *    paused, trial_will_end, dispute.closed, invoice.payment_succeeded, ...).
 *    Keep the synthesizer's deterministic `insert_id` AND its `time` so the
 *    live event dedupes against the backfill (otherwise `$add` lifetime
 *    counters would double when the same object is seen by both paths).
 *
 * 2. Alias — Stripe webhook type is NOT synthesized 1-to-1
 *    (`customer.updated`, `customer.subscription.updated`,
 *    `customer.subscription.resumed`). Reuse the closest synthesized event's
 *    body (full flatten, enrichment, `$set` user props), but rename
 *    `event_type`, override `time` to `event.created`, and use
 *    `<event.id>:v2` as `insert_id` so each webhook occurrence is tracked
 *    (a subscription can be updated dozens of times). For state-change
 *    aliases we also bump `last_subscription_change_at_ms` to the webhook
 *    time so the user profile reflects when the change actually happened.
 */
const EVENT_TYPE_ALIASES: Record<string, string> = {
  "customer.updated": "customer.created",
  "customer.subscription.updated": "customer.subscription.created",
  "customer.subscription.resumed": "customer.subscription.created",
};

const ADVANCE_SUBSCRIPTION_CHANGE_TIME = new Set<string>([
  "customer.subscription.updated",
  "customer.subscription.resumed",
]);

export function mapStripeEventToAmplitude(
  event: Stripe.Event,
  resolved: ResolvedCustomer | null,
  catalog: StripeCatalog,
): AmplitudeEvent | null {
  const obj = event.data.object as unknown as Record<string, unknown> & { object?: string };
  const stripeCustomerId = extractCustomerId(obj);
  if (!stripeCustomerId) return null;
  if (!resolved || !resolved.amplitudeUserId) return null;

  const ctx: CommonContext = {
    amplitudeUserId: resolved.amplitudeUserId,
    stripeCustomerId,
    customerEmail: resolved.email,
  };

  const synthesized = synthesizeForWebhook(event, resolved, ctx, catalog);
  if (synthesized.length === 0) return null;

  const target = `[Stripe v2] ${event.type}`;
  const direct = synthesized.find((e) => e.event_type === target);

  if (direct) {
    return withStripeEventId(direct, event.id);
  }

  const aliasFor = EVENT_TYPE_ALIASES[event.type];
  if (!aliasFor) return null;
  const alias = synthesized.find((e) => e.event_type === `[Stripe v2] ${aliasFor}`);
  if (!alias) return null;

  const aliased: AmplitudeEvent = {
    ...alias,
    event_type: target,
    time: event.created * 1000,
    insert_id: `${event.id}:${INSERT_ID_VERSION}`,
  };

  if (ADVANCE_SUBSCRIPTION_CHANGE_TIME.has(event.type) && aliased.user_properties) {
    const userProps = aliased.user_properties as {
      $set?: Record<string, unknown>;
      $setOnce?: Record<string, unknown>;
      $add?: Record<string, number>;
    };
    if (userProps.$set) {
      aliased.user_properties = {
        ...userProps,
        $set: {
          ...userProps.$set,
          last_subscription_change_at_ms: event.created * 1000,
        },
      };
    }
  }

  return withStripeEventId(aliased, event.id);
}

function withStripeEventId(ev: AmplitudeEvent, stripeEventId: string): AmplitudeEvent {
  return {
    ...ev,
    event_properties: {
      ...(ev.event_properties ?? {}),
      stripe_event_id: stripeEventId,
    },
  };
}

function synthesizeForWebhook(
  event: Stripe.Event,
  resolved: ResolvedCustomer,
  ctx: CommonContext,
  catalog: StripeCatalog,
): AmplitudeEvent[] {
  const obj = event.data.object as unknown as Record<string, unknown> & { object?: string };
  const objectType = obj.object;

  switch (objectType) {
    case "customer":
      return synthesizeCustomerEvents(resolved, catalog);
    case "subscription":
      return synthesizeSubscriptionEvents(obj as unknown as Stripe.Subscription, ctx, catalog);
    case "invoice":
      return synthesizeInvoiceEvents(obj as unknown as Stripe.Invoice, ctx, catalog);
    case "charge": {
      // The `charge.refunded` webhook delivers the Charge with its refunds
      // populated; we synthesize the most recent refund instead of the charge.
      if (event.type === "charge.refunded") {
        const charge = obj as unknown as Stripe.Charge;
        const refund = charge.refunds?.data?.[0];
        return refund ? synthesizeRefundEvents(refund, ctx, catalog, charge) : [];
      }
      return synthesizeChargeEvents(obj as unknown as Stripe.Charge, ctx, catalog);
    }
    case "refund":
      return synthesizeRefundEvents(obj as unknown as Stripe.Refund, ctx, catalog, null);
    case "payment_intent":
      return synthesizePaymentIntentEvents(obj as unknown as Stripe.PaymentIntent, ctx, catalog);
    case "dispute":
      return synthesizeDisputeEvents(obj as unknown as Stripe.Dispute, ctx, catalog);
    case "credit_note":
      return synthesizeCreditNoteEvents(obj as unknown as Stripe.CreditNote, ctx, catalog);
    default:
      return [];
  }
}

function extractCustomerId(
  obj: Record<string, unknown> & { object?: string },
): string | null {
  if (obj.object === "customer" && typeof obj.id === "string") {
    return obj.id;
  }
  const c = obj.customer;
  if (typeof c === "string") return c;
  if (c && typeof c === "object" && typeof (c as { id?: string }).id === "string") {
    return (c as { id: string }).id;
  }
  return null;
}

/**
 * Synthesize Amplitude events from a Stripe object retrieved via the REST API
 * (used by the historical backfill). Each kind takes a StripeCatalog so we can
 * enrich with product / price / coupon / tax-rate names without per-event
 * lookups.
 */
export function synthesizeFromObject(
  obj:
    | { kind: "customer"; data: ResolvedCustomer }
    | { kind: "subscription"; data: Stripe.Subscription; ctx: CommonContext }
    | { kind: "invoice"; data: Stripe.Invoice; ctx: CommonContext }
    | { kind: "charge"; data: Stripe.Charge; ctx: CommonContext }
    | {
        kind: "refund";
        data: Stripe.Refund;
        ctx: CommonContext;
        originalCharge?: Stripe.Charge | null;
      }
    | { kind: "payment_intent"; data: Stripe.PaymentIntent; ctx: CommonContext }
    | { kind: "dispute"; data: Stripe.Dispute; ctx: CommonContext }
    | { kind: "credit_note"; data: Stripe.CreditNote; ctx: CommonContext },
  catalog: StripeCatalog,
): AmplitudeEvent[] {
  switch (obj.kind) {
    case "customer":
      return synthesizeCustomerEvents(obj.data, catalog);
    case "subscription":
      return synthesizeSubscriptionEvents(obj.data, obj.ctx, catalog);
    case "invoice":
      return synthesizeInvoiceEvents(obj.data, obj.ctx, catalog);
    case "charge":
      return synthesizeChargeEvents(obj.data, obj.ctx, catalog);
    case "refund":
      return synthesizeRefundEvents(obj.data, obj.ctx, catalog, obj.originalCharge ?? null);
    case "payment_intent":
      return synthesizePaymentIntentEvents(obj.data, obj.ctx, catalog);
    case "dispute":
      return synthesizeDisputeEvents(obj.data, obj.ctx, catalog);
    case "credit_note":
      return synthesizeCreditNoteEvents(obj.data, obj.ctx, catalog);
  }
}
