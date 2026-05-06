import type Stripe from "stripe";

/**
 * Identifier strategy for resolving Amplitude user_id from a Stripe Customer.
 * - `metadata.<field>` reads `customer.metadata[field]`
 * - `email` reads `customer.email`
 * - `id` reads `customer.id` (cus_xxx)
 */
export type UserIdStrategy = `metadata.${string}` | "email" | "id" | "skip";

export interface UserIdResolverConfig {
  primary: UserIdStrategy;
  fallbacks: UserIdStrategy[];
}

export interface AmplitudeEvent {
  user_id?: string;
  device_id?: string;
  event_type: string;
  time: number;
  insert_id: string;
  event_properties?: Record<string, unknown>;
  user_properties?: Record<string, unknown>;
  /** Stripe customer id, exposed as a user property and also kept handy here for joins. */
  groups?: Record<string, string | string[]>;
  /** Set when the event represents revenue. Amplitude treats this specially. */
  $revenue?: number;
  $price?: number;
  $quantity?: number;
  $productId?: string;
  $revenueType?: string;
}

export interface AmplitudeClientConfig {
  apiKey: string;
  /** Base URL: https://api2.amplitude.com (default) or https://api.eu.amplitude.com */
  endpoint?: string;
  /** When true, posts to /batch (designed for historical loads). Else /2/httpapi. */
  useBatchApi?: boolean;
  /** Max events per HTTP request. Amplitude limit: 2000 (httpapi) / 4000 (batch). */
  maxEventsPerRequest?: number;
  /** Retries on 429/5xx. */
  maxRetries?: number;
  /** Backoff base in ms. */
  retryBaseMs?: number;
  /**
   * Override Amplitude's default minimum length of 5 for user_id / device_id.
   * Stripe metadata user ids and early numeric ids are often shorter, so we
   * default to 1 here (any non-empty id passes).
   */
  minIdLength?: number;
}

/** Stats accumulated across a backfill or webhook session. */
export interface MappingStats {
  matchedByPrimary: number;
  matchedByFallback: Record<string, number>;
  skippedNoUserId: number;
  totalEvents: number;
}

export type StripeEntity =
  | "customer"
  | "subscription"
  | "invoice"
  | "charge"
  | "refund"
  | "payment_intent"
  | "dispute"
  | "credit_note";

/**
 * Light wrapper around the Stripe Customer needed to resolve a user_id.
 * The synthesizer uses a Map<customer_id, ResolvedCustomer> so child entities
 * (invoices, charges, etc.) can pick up the right user_id without re-fetching.
 */
export interface ResolvedCustomer {
  stripeCustomerId: string;
  amplitudeUserId: string | null;
  resolvedVia: UserIdStrategy | null;
  email: string | null;
  raw: Stripe.Customer;
}
