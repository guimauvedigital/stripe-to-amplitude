/**
 * Generic deep flattener for Stripe objects → Amplitude event_properties.
 *
 * Pure flatten — no inference. We forward Stripe data verbatim so the source
 * of truth is unambiguous. Conventions:
 * - Nested objects become `parent_child_grandchild`.
 * - Arrays of primitives are kept as a typed array (Amplitude indexes them).
 * - Arrays of objects are indexed: `parent_0_child`, `parent_1_child`, ...
 * - Stripe timestamps stay in seconds, Stripe amounts stay in minor units
 *   (cents). The single conversion to millis happens at the top-level
 *   Amplitude `time` field — handled by the synthesizer, not here.
 * - null/undefined values are skipped.
 * - Stripe SDK's `lastResponse` is dropped (leaks raw HTTP info).
 * - Keys containing `secret` (case-insensitive) are dropped — Stripe explicitly
 *   forbids logging client secrets.
 * - Function-typed values are dropped.
 * - Property keys are coerced to Amplitude-safe form: lowercase snake_case,
 *   only `[a-z0-9_]`, dots replaced with `_`, capped at 1000 chars.
 */

export type FlatPrimitive = string | number | boolean | string[] | number[];

const MAX_KEY_LENGTH = 1000;

function safeKey(raw: string): string {
  let k = raw.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  k = k.replace(/_+/g, "_");
  if (k.length > MAX_KEY_LENGTH) k = k.slice(0, MAX_KEY_LENGTH);
  return k;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  if (Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isSecretKey(rawKey: string): boolean {
  return /secret/i.test(rawKey);
}

function assignArray(
  out: Record<string, FlatPrimitive>,
  key: string,
  arr: unknown[],
): void {
  if (arr.length === 0) return;
  if (arr.every((v) => typeof v === "string")) {
    out[safeKey(key)] = arr as string[];
    return;
  }
  if (arr.every((v) => typeof v === "number" && Number.isFinite(v))) {
    out[safeKey(key)] = arr as number[];
    return;
  }
  for (let i = 0; i < arr.length; i += 1) {
    walk(out, `${key}_${i}`, arr[i]);
  }
}

function walk(
  out: Record<string, FlatPrimitive>,
  prefix: string,
  value: unknown,
): void {
  if (value === null || value === undefined) return;
  if (typeof value === "function") return;

  if (typeof value === "string") {
    out[safeKey(prefix)] = value;
    return;
  }
  if (typeof value === "boolean") {
    out[safeKey(prefix)] = value;
    return;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) out[safeKey(prefix)] = value;
    return;
  }
  if (typeof value === "bigint") {
    out[safeKey(prefix)] = Number(value);
    return;
  }
  if (value instanceof Date) {
    out[safeKey(prefix)] = value.getTime();
    return;
  }
  if (Array.isArray(value)) {
    assignArray(out, prefix, value);
    return;
  }
  if (isPlainObject(value)) {
    for (const [rawChildKey, child] of Object.entries(value)) {
      if (rawChildKey === "lastResponse") continue;
      if (isSecretKey(rawChildKey)) continue;
      const childKey = safeKey(rawChildKey);
      const nextPrefix = prefix ? `${prefix}_${childKey}` : childKey;
      walk(out, nextPrefix, child);
    }
  }
}

export function flatten(value: unknown, prefix = ""): Record<string, FlatPrimitive> {
  const out: Record<string, FlatPrimitive> = {};
  if (!isPlainObject(value)) return out;
  for (const [rawKey, child] of Object.entries(value)) {
    if (rawKey === "lastResponse") continue;
    if (isSecretKey(rawKey)) continue;
    const key = safeKey(rawKey);
    const nextPrefix = prefix ? `${prefix}_${key}` : key;
    walk(out, nextPrefix, child);
  }
  return out;
}

/** Flatten with a forced top-level prefix (e.g. `product` → `product_*`). */
export function flattenWithPrefix(value: unknown, prefix: string): Record<string, FlatPrimitive> {
  return flatten(value, safeKey(prefix));
}
