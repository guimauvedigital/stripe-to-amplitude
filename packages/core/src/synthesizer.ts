import type Stripe from "stripe";
import type { AmplitudeEvent, ResolvedCustomer } from "./types.js";

/**
 * Stripe stores `created` and other timestamps in seconds. Amplitude wants ms.
 */
const toMs = (sec: number | null | undefined): number =>
  sec == null ? Date.now() : sec * 1000;

/**
 * Stripe amounts are in the smallest currency unit (cents for EUR/USD, etc.).
 * Amplitude `$revenue` expects a decimal in the customer's currency.
 */
const toMajorUnit = (amountMinor: number | null | undefined): number =>
  amountMinor == null ? 0 : amountMinor / 100;

/**
 * Deterministic insert_id for backfilled events. Combining the synthesized
 * event_type with the source object id (and discriminator timestamp where
 * needed) means re-running the backfill is idempotent — Amplitude dedupes.
 *
 * For the live webhook we use the Stripe event id directly (`evt_xxx`).
 */
const backfillInsertId = (eventType: string, objectId: string, suffix?: string): string =>
  suffix ? `${eventType}:${objectId}:${suffix}` : `${eventType}:${objectId}`;

interface CommonContext {
  /** Resolved Amplitude user_id for this customer (may be null if no match). */
  amplitudeUserId: string | null;
  /** Always present so we can group/segment in Amplitude even if user_id is null. */
  stripeCustomerId: string;
  customerEmail?: string | null;
}

/**
 * Build the shared event scaffold used by every synthesized or forwarded event.
 * - We never delete fields from the Stripe object: it is attached verbatim
 *   under `event_properties.stripe`.
 * - We expose a small set of flat keys at the top of `event_properties` for
 *   ergonomic charting (amount, currency, status, ...).
 */
function buildBaseEvent(
  eventType: string,
  time: number,
  insertId: string,
  ctx: CommonContext,
  stripeObject: unknown,
  flatProps: Record<string, unknown> = {},
): AmplitudeEvent {
  return {
    user_id: ctx.amplitudeUserId ?? undefined,
    device_id: ctx.amplitudeUserId ? undefined : ctx.stripeCustomerId,
    event_type: eventType,
    time,
    insert_id: insertId,
    event_properties: {
      ...flatProps,
      stripe_customer_id: ctx.stripeCustomerId,
      stripe: stripeObject,
    },
    user_properties: {
      $set: {
        stripe_customer_id: ctx.stripeCustomerId,
        ...(ctx.customerEmail ? { email: ctx.customerEmail } : {}),
      },
    },
  };
}

// ---------- Customer ----------

export function synthesizeCustomerEvents(resolved: ResolvedCustomer): AmplitudeEvent[] {
  const c = resolved.raw;
  const ctx: CommonContext = {
    amplitudeUserId: resolved.amplitudeUserId,
    stripeCustomerId: c.id,
    customerEmail: c.email,
  };

  const events: AmplitudeEvent[] = [];

  events.push(
    buildBaseEvent(
      "[Stripe] customer.created",
      toMs(c.created),
      backfillInsertId("customer.created", c.id),
      ctx,
      c,
      {
        email: c.email ?? null,
        currency: c.currency ?? null,
        delinquent: c.delinquent ?? false,
      },
    ),
  );

  // We do not synthesize `customer.deleted` from a backfill: customers.list()
  // only returns non-deleted customers, and Stripe does not retain the
  // deletion timestamp on the deleted stub. The live webhook handles deletes.

  return events;
}

// ---------- Subscription ----------

export function synthesizeSubscriptionEvents(
  sub: Stripe.Subscription,
  ctx: CommonContext,
): AmplitudeEvent[] {
  const events: AmplitudeEvent[] = [];
  const planId = sub.items.data[0]?.price?.id ?? null;
  const planNickname = sub.items.data[0]?.price?.nickname ?? null;
  const productId = sub.items.data[0]?.price?.product as string | null;

  events.push(
    buildBaseEvent(
      "[Stripe] customer.subscription.created",
      toMs(sub.created),
      backfillInsertId("subscription.created", sub.id),
      ctx,
      sub,
      {
        subscription_id: sub.id,
        plan_id: planId,
        plan_nickname: planNickname,
        product_id: productId,
        status: sub.status,
        currency: sub.currency,
      },
    ),
  );

  if (sub.trial_start && sub.trial_end) {
    events.push(
      buildBaseEvent(
        "[Stripe] customer.subscription.trial_will_end",
        toMs(sub.trial_end),
        backfillInsertId("subscription.trial_will_end", sub.id),
        ctx,
        sub,
        { subscription_id: sub.id, plan_id: planId },
      ),
    );
  }

  if (sub.canceled_at) {
    events.push(
      buildBaseEvent(
        "[Stripe] customer.subscription.deleted",
        toMs(sub.canceled_at),
        backfillInsertId("subscription.deleted", sub.id),
        ctx,
        sub,
        {
          subscription_id: sub.id,
          plan_id: planId,
          plan_nickname: planNickname,
          status: sub.status,
          cancellation_reason: sub.cancellation_details?.reason ?? null,
          cancellation_feedback: sub.cancellation_details?.feedback ?? null,
          cancellation_comment: sub.cancellation_details?.comment ?? null,
        },
      ),
    );
  }

  return events;
}

// ---------- Invoice ----------

export function synthesizeInvoiceEvents(
  inv: Stripe.Invoice,
  ctx: CommonContext,
): AmplitudeEvent[] {
  const events: AmplitudeEvent[] = [];
  const baseFlat = {
    invoice_id: inv.id,
    invoice_number: inv.number,
    subscription_id: typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id,
    amount_due_minor: inv.amount_due,
    amount_paid_minor: inv.amount_paid,
    amount_remaining_minor: inv.amount_remaining,
    amount_due: toMajorUnit(inv.amount_due),
    amount_paid: toMajorUnit(inv.amount_paid),
    currency: inv.currency,
    status: inv.status,
    billing_reason: inv.billing_reason,
    period_start: inv.period_start ? toMs(inv.period_start) : null,
    period_end: inv.period_end ? toMs(inv.period_end) : null,
  };

  events.push(
    buildBaseEvent(
      "[Stripe] invoice.created",
      toMs(inv.created),
      backfillInsertId("invoice.created", inv.id ?? `${inv.customer}-${inv.created}`),
      ctx,
      inv,
      baseFlat,
    ),
  );

  const t = inv.status_transitions;
  if (t?.finalized_at && inv.id) {
    events.push(
      buildBaseEvent(
        "[Stripe] invoice.finalized",
        toMs(t.finalized_at),
        backfillInsertId("invoice.finalized", inv.id),
        ctx,
        inv,
        baseFlat,
      ),
    );
  }
  if (t?.paid_at && inv.id && inv.amount_paid > 0) {
    const paidEvent = buildBaseEvent(
      "[Stripe] invoice.payment_succeeded",
      toMs(t.paid_at),
      backfillInsertId("invoice.payment_succeeded", inv.id),
      ctx,
      inv,
      baseFlat,
    );
    paidEvent.$revenue = toMajorUnit(inv.amount_paid);
    paidEvent.$revenueType = inv.billing_reason ?? "invoice";
    paidEvent.$productId =
      (inv.lines.data[0]?.price?.product as string | undefined) ?? undefined;
    events.push(paidEvent);
  }
  if (t?.voided_at && inv.id) {
    events.push(
      buildBaseEvent(
        "[Stripe] invoice.voided",
        toMs(t.voided_at),
        backfillInsertId("invoice.voided", inv.id),
        ctx,
        inv,
        baseFlat,
      ),
    );
  }
  if (t?.marked_uncollectible_at && inv.id) {
    events.push(
      buildBaseEvent(
        "[Stripe] invoice.marked_uncollectible",
        toMs(t.marked_uncollectible_at),
        backfillInsertId("invoice.marked_uncollectible", inv.id),
        ctx,
        inv,
        baseFlat,
      ),
    );
  }

  return events;
}

// ---------- Charge ----------

export function synthesizeChargeEvents(
  charge: Stripe.Charge,
  ctx: CommonContext,
): AmplitudeEvent[] {
  const events: AmplitudeEvent[] = [];
  const flat = {
    charge_id: charge.id,
    amount_minor: charge.amount,
    amount_captured_minor: charge.amount_captured,
    amount: toMajorUnit(charge.amount),
    currency: charge.currency,
    status: charge.status,
    paid: charge.paid,
    refunded: charge.refunded,
    payment_intent_id:
      typeof charge.payment_intent === "string"
        ? charge.payment_intent
        : charge.payment_intent?.id ?? null,
    failure_code: charge.failure_code,
    failure_message: charge.failure_message,
  };

  if (charge.status === "succeeded") {
    const ev = buildBaseEvent(
      "[Stripe] charge.succeeded",
      toMs(charge.created),
      backfillInsertId("charge.succeeded", charge.id),
      ctx,
      charge,
      flat,
    );
    ev.$revenue = toMajorUnit(charge.amount);
    ev.$revenueType = "charge";
    events.push(ev);
  } else if (charge.status === "failed") {
    events.push(
      buildBaseEvent(
        "[Stripe] charge.failed",
        toMs(charge.created),
        backfillInsertId("charge.failed", charge.id),
        ctx,
        charge,
        flat,
      ),
    );
  }

  return events;
}

// ---------- Refund ----------

export function synthesizeRefundEvents(
  refund: Stripe.Refund,
  ctx: CommonContext,
): AmplitudeEvent[] {
  const flat = {
    refund_id: refund.id,
    charge_id: typeof refund.charge === "string" ? refund.charge : refund.charge?.id ?? null,
    amount_minor: refund.amount,
    amount: toMajorUnit(refund.amount),
    currency: refund.currency,
    status: refund.status,
    reason: refund.reason,
  };

  const ev = buildBaseEvent(
    "[Stripe] charge.refunded",
    toMs(refund.created),
    backfillInsertId("charge.refunded", refund.id),
    ctx,
    refund,
    flat,
  );
  ev.$revenue = -toMajorUnit(refund.amount);
  ev.$revenueType = "refund";
  return [ev];
}

// ---------- PaymentIntent ----------

export function synthesizePaymentIntentEvents(
  pi: Stripe.PaymentIntent,
  ctx: CommonContext,
): AmplitudeEvent[] {
  const flat = {
    payment_intent_id: pi.id,
    amount_minor: pi.amount,
    amount: toMajorUnit(pi.amount),
    amount_received_minor: pi.amount_received,
    currency: pi.currency,
    status: pi.status,
  };

  if (pi.status === "succeeded") {
    const ev = buildBaseEvent(
      "[Stripe] payment_intent.succeeded",
      toMs(pi.created),
      backfillInsertId("payment_intent.succeeded", pi.id),
      ctx,
      pi,
      flat,
    );
    ev.$revenue = toMajorUnit(pi.amount_received);
    ev.$revenueType = "payment_intent";
    return [ev];
  }
  if (pi.status === "requires_payment_method" && pi.last_payment_error) {
    return [
      buildBaseEvent(
        "[Stripe] payment_intent.payment_failed",
        toMs(pi.created),
        backfillInsertId("payment_intent.payment_failed", pi.id),
        ctx,
        pi,
        { ...flat, error_code: pi.last_payment_error.code },
      ),
    ];
  }
  return [];
}

// ---------- Dispute ----------

export function synthesizeDisputeEvents(
  d: Stripe.Dispute,
  ctx: CommonContext,
): AmplitudeEvent[] {
  const flat = {
    dispute_id: d.id,
    charge_id: typeof d.charge === "string" ? d.charge : d.charge?.id,
    amount_minor: d.amount,
    amount: toMajorUnit(d.amount),
    currency: d.currency,
    status: d.status,
    reason: d.reason,
  };
  return [
    buildBaseEvent(
      "[Stripe] charge.dispute.created",
      toMs(d.created),
      backfillInsertId("charge.dispute.created", d.id),
      ctx,
      d,
      flat,
    ),
  ];
}

// ---------- Credit Note ----------

export function synthesizeCreditNoteEvents(
  cn: Stripe.CreditNote,
  ctx: CommonContext,
): AmplitudeEvent[] {
  const flat = {
    credit_note_id: cn.id,
    invoice_id: typeof cn.invoice === "string" ? cn.invoice : cn.invoice?.id,
    amount_minor: cn.amount,
    amount: toMajorUnit(cn.amount),
    currency: cn.currency,
    status: cn.status,
    reason: cn.reason,
  };
  return [
    buildBaseEvent(
      "[Stripe] credit_note.created",
      toMs(cn.created),
      backfillInsertId("credit_note.created", cn.id),
      ctx,
      cn,
      flat,
    ),
  ];
}

export type { CommonContext };
