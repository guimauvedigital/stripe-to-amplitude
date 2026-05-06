import type Stripe from "stripe";
import type { AmplitudeEvent, ResolvedCustomer } from "./types.js";
import {
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

/**
 * Map a live Stripe webhook event to one Amplitude event with the same
 * `[Stripe] <type>` naming convention. The Stripe object is preserved
 * verbatim under `event_properties.stripe`, the Stripe event id is used as
 * `insert_id` for natural retry safety, and `$revenue` is set on
 * payment_intent.succeeded just like Amplitude's native integration does.
 *
 * The customer must be pre-resolved so the user_id is consistent between
 * backfill and live. The webhook server is responsible for fetching/caching
 * customers as new ones are seen.
 */
export function mapStripeEventToAmplitude(
  event: Stripe.Event,
  resolved: ResolvedCustomer | null,
): AmplitudeEvent | null {
  const obj = event.data.object as Stripe.Customer | { customer?: string | Stripe.Customer | null };
  const stripeCustomerId =
    "id" in obj && (obj as Stripe.Customer).object === "customer"
      ? (obj as Stripe.Customer).id
      : typeof (obj as { customer?: string | Stripe.Customer | null }).customer === "string"
        ? ((obj as { customer?: string }).customer as string)
        : ((obj as { customer?: { id: string } }).customer?.id ?? "");

  if (!stripeCustomerId) return null;

  const ctx: CommonContext = {
    amplitudeUserId: resolved?.amplitudeUserId ?? null,
    stripeCustomerId,
    customerEmail: resolved?.email ?? null,
  };

  const base: AmplitudeEvent = {
    user_id: ctx.amplitudeUserId ?? undefined,
    device_id: ctx.amplitudeUserId ? undefined : stripeCustomerId,
    event_type: `[Stripe] ${event.type}`,
    time: event.created * 1000,
    insert_id: event.id,
    event_properties: {
      stripe_customer_id: stripeCustomerId,
      stripe_event_id: event.id,
      stripe: event.data.object,
    },
    user_properties: {
      $set: {
        stripe_customer_id: stripeCustomerId,
        ...(ctx.customerEmail ? { email: ctx.customerEmail } : {}),
      },
    },
  };

  // Match the Amplitude native behaviour where payment_intent.succeeded is
  // surfaced as `$revenue`.
  if (event.type === "payment_intent.succeeded") {
    const pi = event.data.object as Stripe.PaymentIntent;
    base.$revenue = pi.amount_received / 100;
    base.$revenueType = "payment_intent";
  }
  if (event.type === "charge.succeeded") {
    const c = event.data.object as Stripe.Charge;
    base.$revenue = c.amount / 100;
    base.$revenueType = "charge";
  }
  if (event.type === "charge.refunded") {
    const c = event.data.object as Stripe.Charge;
    base.$revenue = -(c.amount_refunded / 100);
    base.$revenueType = "refund";
  }

  return base;
}

/**
 * Synthesize Amplitude events from a Stripe object retrieved via the REST API
 * (used by the historical backfill). Same `[Stripe] <type>` naming as the
 * live webhook so both sources flow into the same Amplitude charts.
 */
export function synthesizeFromObject(
  obj:
    | { kind: "customer"; data: ResolvedCustomer }
    | { kind: "subscription"; data: Stripe.Subscription; ctx: CommonContext }
    | { kind: "invoice"; data: Stripe.Invoice; ctx: CommonContext }
    | { kind: "charge"; data: Stripe.Charge; ctx: CommonContext }
    | { kind: "refund"; data: Stripe.Refund; ctx: CommonContext }
    | { kind: "payment_intent"; data: Stripe.PaymentIntent; ctx: CommonContext }
    | { kind: "dispute"; data: Stripe.Dispute; ctx: CommonContext }
    | { kind: "credit_note"; data: Stripe.CreditNote; ctx: CommonContext },
): AmplitudeEvent[] {
  switch (obj.kind) {
    case "customer":
      return synthesizeCustomerEvents(obj.data);
    case "subscription":
      return synthesizeSubscriptionEvents(obj.data, obj.ctx);
    case "invoice":
      return synthesizeInvoiceEvents(obj.data, obj.ctx);
    case "charge":
      return synthesizeChargeEvents(obj.data, obj.ctx);
    case "refund":
      return synthesizeRefundEvents(obj.data, obj.ctx);
    case "payment_intent":
      return synthesizePaymentIntentEvents(obj.data, obj.ctx);
    case "dispute":
      return synthesizeDisputeEvents(obj.data, obj.ctx);
    case "credit_note":
      return synthesizeCreditNoteEvents(obj.data, obj.ctx);
  }
}
