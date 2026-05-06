import type Stripe from "stripe";
import type { ResolvedCustomer, UserIdResolverConfig, UserIdStrategy } from "./types.js";

function applyStrategy(strategy: UserIdStrategy, customer: Stripe.Customer): string | null {
  if (strategy === "skip") return null;
  if (strategy === "id") return customer.id;
  if (strategy === "email") return customer.email ?? null;
  if (strategy.startsWith("metadata.")) {
    const field = strategy.slice("metadata.".length);
    const value = customer.metadata?.[field];
    return value && value.length > 0 ? value : null;
  }
  return null;
}

/**
 * Resolve a Stripe Customer to an Amplitude user_id using a primary strategy
 * and a fallback chain. Returns the strategy that produced the value so callers
 * can record matching stats.
 */
export function resolveUserId(
  customer: Stripe.Customer,
  config: UserIdResolverConfig,
): { userId: string | null; via: UserIdStrategy | null } {
  const primary = applyStrategy(config.primary, customer);
  if (primary) return { userId: primary, via: config.primary };

  for (const fallback of config.fallbacks) {
    const value = applyStrategy(fallback, customer);
    if (value) return { userId: value, via: fallback };
  }
  return { userId: null, via: null };
}

export function toResolvedCustomer(
  customer: Stripe.Customer,
  config: UserIdResolverConfig,
): ResolvedCustomer {
  const { userId, via } = resolveUserId(customer, config);
  return {
    stripeCustomerId: customer.id,
    amplitudeUserId: userId,
    resolvedVia: via,
    email: customer.email ?? null,
    raw: customer,
  };
}

export function parseUserIdStrategy(raw: string): UserIdStrategy {
  const trimmed = raw.trim();
  if (trimmed === "email" || trimmed === "id" || trimmed === "skip") return trimmed;
  if (trimmed.startsWith("metadata.")) return trimmed as UserIdStrategy;
  throw new Error(
    `Invalid USER_ID_STRATEGY value "${raw}". Expected: email | id | skip | metadata.<field>`,
  );
}

export function parseFallbackChain(raw: string | undefined): UserIdStrategy[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(parseUserIdStrategy);
}
