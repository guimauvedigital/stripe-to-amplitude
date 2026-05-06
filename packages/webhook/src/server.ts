import Fastify from "fastify";
import Stripe from "stripe";
import {
  AmplitudeClient,
  CustomerCache,
  mapStripeEventToAmplitude,
} from "@stripe-to-amplitude/core";
import type { WebhookConfig } from "./config.js";

export async function buildServer(cfg: WebhookConfig) {
  const app = Fastify({ logger: { level: cfg.logLevel } });

  const stripe = new Stripe(cfg.stripeApiKey);
  const amplitude = new AmplitudeClient({
    apiKey: cfg.amplitudeApiKey,
    endpoint: cfg.amplitudeEndpoint,
    useBatchApi: false, // live events go through /2/httpapi
    maxEventsPerRequest: 1,
  });
  const cache = new CustomerCache(cfg.resolver);

  app.get("/healthz", async () => ({ ok: true }));

  // Stripe signature verification requires the raw bytes of the request,
  // so we register a custom content-type parser only for /webhook to avoid
  // Fastify's default JSON parser mutating the body.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  app.post("/webhook", async (request, reply) => {
    const sig = request.headers["stripe-signature"];
    if (typeof sig !== "string") {
      reply.code(400);
      return { error: "missing stripe-signature header" };
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        request.body as Buffer,
        sig,
        cfg.stripeWebhookSecret,
      );
    } catch (err) {
      app.log.warn({ err }, "stripe signature verification failed");
      reply.code(400);
      return { error: "invalid signature" };
    }

    // Resolve the customer (cached) so user_id is consistent with the backfill.
    const obj = event.data.object as { customer?: string | Stripe.Customer | null; id?: string; object?: string };
    let stripeCustomerId: string | undefined;
    if (obj.object === "customer" && obj.id) {
      stripeCustomerId = obj.id;
      // Pre-warm the cache for follow-up child events on this customer.
      await cache.resolve(stripeCustomerId, stripe);
    } else if (typeof obj.customer === "string") {
      stripeCustomerId = obj.customer;
    } else if (obj.customer && typeof obj.customer === "object") {
      stripeCustomerId = obj.customer.id;
    }

    const resolved = stripeCustomerId
      ? await cache.resolve(stripeCustomerId, stripe)
      : null;

    const amplitudeEvent = mapStripeEventToAmplitude(event, resolved);
    if (!amplitudeEvent) {
      app.log.info({ type: event.type, eventId: event.id }, "no customer on event, skipping");
      return { ok: true, skipped: true };
    }

    try {
      await amplitude.send([amplitudeEvent]);
    } catch (err) {
      app.log.error({ err, eventId: event.id }, "amplitude send failed");
      // Returning a non-2xx makes Stripe retry — exactly what we want here.
      reply.code(500);
      return { error: "amplitude send failed" };
    }

    return { ok: true, eventId: event.id, type: event.type };
  });

  return app;
}
