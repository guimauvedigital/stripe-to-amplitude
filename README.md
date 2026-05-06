# stripe-to-amplitude

Open-source bridge that loads **all your Stripe data — past and future — into Amplitude** with a single, consistent event format.

- **Backfill**: one-shot CLI / Docker Job that walks every `customer`, `subscription`, `invoice`, `charge`, `refund`, `payment_intent`, `dispute` and `credit_note` since your Stripe account was created and synthesizes Amplitude events at their original timestamps.
- **Live**: long-running webhook server that verifies Stripe signatures and forwards every Stripe event to Amplitude using the same event format as the backfill — so historical and live data are indistinguishable in your charts.
- **No data loss**: every Stripe object is preserved verbatim under `event_properties.stripe`. We add convenience flat fields on top, never remove anything.
- **Stable user identity**: a configurable resolver maps `customer.metadata.<your_user_id>` (or email, or `cus_xxx`) to your Amplitude `user_id`, with a fallback chain.
- **Idempotent**: every event has a deterministic `insert_id`. Re-running the backfill is safe; webhook retries are deduped.

## Why this exists

Amplitude offers a native Stripe integration but: (a) it is gated behind paid plans, (b) it does not import any historical data, and (c) it ingests events from the moment you flip the switch onward. For an investor data room, fundraising, or any retroactive analytics need, that is not enough. This project closes the gap with a small, single-purpose codebase you can self-host on your own k8s.

## Architecture

```
                        packages/core
                ┌──────────────────────────────┐
                │ Stripe object/event mapper   │
                │ Amplitude HTTP client        │
                │ user_id resolver + cache     │
                └──────────────────────────────┘
                       ▲                 ▲
                       │                 │
        ┌──────────────┘                 └──────────────┐
        │                                                │
 packages/backfill                              packages/webhook
 ─────────────────                              ─────────────────
 One-shot CLI / Job                             Fastify server
 Reads /v1/customers,                           Verifies Stripe
 /v1/invoices, ... in                           signature, forwards
 ascending `created`                            every event to
 order. Resumable                               Amplitude /2/httpapi.
 via state file.                                Customer cache filled
 Sends to Amplitude                             on demand from Stripe.
 /batch endpoint.
```

A single `core` package owns the transformation logic. The same mapper is used by both the backfill and the webhook server, so the format is **always identical** between historical and live events. That is the project's main correctness property.

## Event format

All emitted events are named `[Stripe] <stripe.event.type>`, matching Amplitude's native Stripe integration convention so you can swap between this project and the native one without re-writing your charts.

```json
{
  "user_id": "user_uuid_resolved_from_metadata",
  "event_type": "[Stripe] invoice.payment_succeeded",
  "time": 1714000000000,
  "insert_id": "invoice.payment_succeeded:in_1Pxxxxx",
  "$revenue": 49.0,
  "$revenueType": "subscription_cycle",
  "event_properties": {
    "invoice_id": "in_1Pxxxxx",
    "amount_paid": 49.0,
    "currency": "eur",
    "status": "paid",
    "stripe_customer_id": "cus_xxx",
    "stripe": { /* full Stripe Invoice object — nothing removed */ }
  },
  "user_properties": {
    "$set": { "stripe_customer_id": "cus_xxx", "email": "user@example.com" }
  }
}
```

### What each Stripe object becomes

| Stripe object | Synthesized event(s) (backfill) | Source timestamp |
|---|---|---|
| `customer` | `[Stripe] customer.created`, `customer.deleted` | `created`, n/a (Stripe drops the timestamp on delete) |
| `subscription` | `customer.subscription.created`, `customer.subscription.deleted`, `customer.subscription.trial_will_end` | `created`, `canceled_at`, `trial_end` |
| `invoice` | `invoice.created`, `invoice.finalized`, `invoice.payment_succeeded`, `invoice.voided`, `invoice.marked_uncollectible` | `created`, `status_transitions.*` |
| `charge` | `charge.succeeded` or `charge.failed` | `created` |
| `refund` | `charge.refunded` (with negative `$revenue`) | `created` |
| `payment_intent` | `payment_intent.succeeded` (with `$revenue`) or `payment_intent.payment_failed` | `created` |
| `dispute` | `charge.dispute.created` | `created` |
| `credit_note` | `credit_note.created` | `created` |

The live webhook handler emits exactly the same `event_type` for the corresponding Stripe webhook payload, with the Stripe event id used as `insert_id`.

## What we cannot reconstruct

Stripe only retains raw events for ~30 days. For older periods, this project derives events from object timestamps. That covers everything that matters for revenue analytics (MRR, ARR, churn dates, paid invoices, LTV cohorts, NRR), but **intermediate `subscription.updated` events from before live forwarding was enabled cannot be recovered** — only the create-time and current-state are available. From the day the webhook server is running, no information is lost.

## Quick start

### Prerequisites

- Node 20+
- pnpm 10
- A Stripe restricted API key with read access to: customers, subscriptions, invoices, charges, refunds, products, payment_intents, disputes, credit_notes
- An Amplitude project API key (any plan, including Starter)

### 1. Configure

```bash
cp .env.example .env
# edit .env to set STRIPE_API_KEY, AMPLITUDE_API_KEY, USER_ID_STRATEGY
```

### 2. (Important) Lift Amplitude's 365-day event-age limit

By default Amplitude rejects events older than 365 days. Open the in-app support chat and ask:

> Please disable the 365-day event age limit on project ID `<your_project_id>` for the next 7 days. We are running a one-time historical backfill via the Batch Event Upload API.

This is granted within hours and is required if your Stripe account has data older than a year.

### 3. Run the historical backfill

```bash
pnpm install
pnpm --filter @stripe-to-amplitude/core build
pnpm --filter @stripe-to-amplitude/backfill build
DRY_RUN=1 pnpm backfill   # first pass, no Amplitude writes
pnpm backfill              # for real
```

The runner persists cursor state in `.backfill-state/state.json`. If it crashes or you Ctrl-C, just re-run — it resumes where it left off and Amplitude dedupes via `insert_id`.

### 4. Start the live webhook

```bash
pnpm --filter @stripe-to-amplitude/webhook build
pnpm webhook
```

In Stripe Dashboard → Developers → Webhooks → "Add endpoint" → point it at `https://your-host/webhook` and copy the signing secret into `STRIPE_WEBHOOK_SECRET`. Subscribe to "Send all events" — the bridge will faithfully forward each one as `[Stripe] <type>`.

## Deploy on Kubernetes

```bash
# 1. Build & push images (substitute your registry).
docker build -f Dockerfile.webhook -t ghcr.io/your-org/stripe-to-amplitude-webhook:0.1.0 .
docker build -f Dockerfile.backfill -t ghcr.io/your-org/stripe-to-amplitude-backfill:0.1.0 .
docker push ghcr.io/your-org/stripe-to-amplitude-webhook:0.1.0
docker push ghcr.io/your-org/stripe-to-amplitude-backfill:0.1.0

# 2. Replace YOUR_ORG in k8s/*.yaml with your registry, then:
kubectl apply -f k8s/secret.example.yaml   # after editing the placeholders
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml          # adjust host & TLS issuer first

# 3. Run the backfill once.
kubectl apply -f k8s/job-backfill.yaml
kubectl logs -f job/stripe-to-amplitude-backfill
```

The backfill Job mounts a 1Gi PVC for `/state` so a re-run resumes from the last cursor.

## Configuration reference

| Env var | Purpose | Default |
|---|---|---|
| `STRIPE_API_KEY` | Stripe restricted key (read-only) | required |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret (webhook only) | required for webhook |
| `AMPLITUDE_API_KEY` | Amplitude project API key | required |
| `AMPLITUDE_ENDPOINT` | Override base URL (e.g. EU residency) | `https://api2.amplitude.com` |
| `USER_ID_STRATEGY` | `metadata.<field>` \| `email` \| `id` \| `skip` | `metadata.user_id` |
| `USER_ID_FALLBACK` | Comma-separated chain | `email,id` |
| `BACKFILL_ENTITIES` | Subset to import | all |
| `BACKFILL_SINCE` | Unix-seconds floor for `created` | account creation |
| `BACKFILL_STATE_DIR` | Where to persist cursors | `./.backfill-state` |
| `DRY_RUN` | `1` to skip Amplitude writes | `0` |
| `PORT` / `HOST` | Webhook bind | `3000` / `0.0.0.0` |
| `LOG_LEVEL` | Pino level | `info` |

## License

MIT — see [LICENSE](./LICENSE).
