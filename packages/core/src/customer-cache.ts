import type Stripe from "stripe";
import type { ResolvedCustomer, UserIdResolverConfig } from "./types.js";
import { toResolvedCustomer } from "./user-id-resolver.js";

/**
 * In-memory cache mapping Stripe customer ids to resolved Amplitude user_ids.
 * Used by both the backfill (pre-populated up front) and the webhook server
 * (lazily filled as new customers are seen).
 */
export class CustomerCache {
  private readonly map = new Map<string, ResolvedCustomer>();

  constructor(private readonly resolverConfig: UserIdResolverConfig) {}

  set(customer: Stripe.Customer): ResolvedCustomer {
    const resolved = toResolvedCustomer(customer, this.resolverConfig);
    this.map.set(customer.id, resolved);
    return resolved;
  }

  get(stripeCustomerId: string): ResolvedCustomer | undefined {
    return this.map.get(stripeCustomerId);
  }

  has(stripeCustomerId: string): boolean {
    return this.map.has(stripeCustomerId);
  }

  /** Returns the resolved record, fetching from Stripe if missing. */
  async resolve(stripeCustomerId: string, stripe: Stripe): Promise<ResolvedCustomer> {
    const cached = this.map.get(stripeCustomerId);
    if (cached) return cached;
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    if (customer.deleted) {
      const stub: ResolvedCustomer = {
        stripeCustomerId,
        amplitudeUserId: null,
        resolvedVia: null,
        email: null,
        // Cast: a deleted customer still satisfies the runtime shape we need.
        raw: customer as unknown as Stripe.Customer,
      };
      this.map.set(stripeCustomerId, stub);
      return stub;
    }
    return this.set(customer);
  }

  size(): number {
    return this.map.size;
  }
}
