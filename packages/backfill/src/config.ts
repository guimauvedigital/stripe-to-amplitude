import {
  parseFallbackChain,
  parseUserIdStrategy,
  type StripeEntity,
  type UserIdResolverConfig,
} from "@stripe-to-amplitude/core";

const ALL_ENTITIES: StripeEntity[] = [
  "customer",
  "subscription",
  "invoice",
  "charge",
  "refund",
  "payment_intent",
  "dispute",
  "credit_note",
];

export interface BackfillConfig {
  stripeApiKey: string;
  amplitudeApiKey: string;
  amplitudeEndpoint?: string;
  resolver: UserIdResolverConfig;
  entities: StripeEntity[];
  /** Unix seconds. Empty means "since account creation". */
  since?: number;
  stateDir: string;
  /** When true, no events are sent to Amplitude. */
  dryRun: boolean;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export function parseEntitiesEnv(raw: string | undefined): StripeEntity[] {
  if (!raw || raw.trim().length === 0) return [...ALL_ENTITIES];
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    if (!ALL_ENTITIES.includes(p as StripeEntity)) {
      throw new Error(
        `Invalid BACKFILL_ENTITIES entry "${p}". Allowed: ${ALL_ENTITIES.join(",")}`,
      );
    }
  }
  return parts as StripeEntity[];
}

export function loadConfig(): BackfillConfig {
  const sinceRaw = process.env.BACKFILL_SINCE?.trim();
  return {
    stripeApiKey: required("STRIPE_API_KEY"),
    amplitudeApiKey: required("AMPLITUDE_API_KEY"),
    amplitudeEndpoint: process.env.AMPLITUDE_ENDPOINT,
    resolver: {
      primary: parseUserIdStrategy(process.env.USER_ID_STRATEGY ?? "metadata.user_id"),
      fallbacks: parseFallbackChain(process.env.USER_ID_FALLBACK ?? "email,id"),
    },
    entities: parseEntitiesEnv(process.env.BACKFILL_ENTITIES),
    since: sinceRaw ? Number.parseInt(sinceRaw, 10) : undefined,
    stateDir: process.env.BACKFILL_STATE_DIR ?? "./.backfill-state",
    dryRun: process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true",
  };
}
