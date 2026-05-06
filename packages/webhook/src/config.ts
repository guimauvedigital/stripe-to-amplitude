import {
  parseFallbackChain,
  parseUserIdStrategy,
  type UserIdResolverConfig,
} from "@stripe-to-amplitude/core";

export interface WebhookConfig {
  stripeApiKey: string;
  stripeWebhookSecret: string;
  amplitudeApiKey: string;
  amplitudeEndpoint?: string;
  resolver: UserIdResolverConfig;
  port: number;
  host: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function loadWebhookConfig(): WebhookConfig {
  const lvl = (process.env.LOG_LEVEL ?? "info") as WebhookConfig["logLevel"];
  return {
    stripeApiKey: required("STRIPE_API_KEY"),
    stripeWebhookSecret: required("STRIPE_WEBHOOK_SECRET"),
    amplitudeApiKey: required("AMPLITUDE_API_KEY"),
    amplitudeEndpoint: process.env.AMPLITUDE_ENDPOINT,
    resolver: {
      primary: parseUserIdStrategy(process.env.USER_ID_STRATEGY ?? "metadata.user_id"),
      fallbacks: parseFallbackChain(process.env.USER_ID_FALLBACK ?? "email,id"),
    },
    port: Number.parseInt(process.env.PORT ?? "3000", 10),
    host: process.env.HOST ?? "0.0.0.0",
    logLevel: lvl,
  };
}
