import type Stripe from "stripe";

/**
 * In-memory catalog of Stripe Products / Prices / Coupons / Tax Rates.
 *
 * Loaded once per backfill run (or refreshed periodically by the webhook
 * server). Used to enrich synthesized Amplitude events with human-readable
 * names without an extra network call per object.
 */
export class StripeCatalog {
  private products = new Map<string, Stripe.Product>();
  private prices = new Map<string, Stripe.Price>();
  private coupons = new Map<string, Stripe.Coupon>();
  private taxRates = new Map<string, Stripe.TaxRate>();
  private loadedAt: number | null = null;

  async load(stripe: Stripe): Promise<void> {
    await Promise.all([
      this.loadProducts(stripe),
      this.loadPrices(stripe),
      this.loadCoupons(stripe),
      this.loadTaxRates(stripe),
    ]);
    this.loadedAt = Date.now();
  }

  async loadProducts(stripe: Stripe): Promise<Map<string, Stripe.Product>> {
    const map = new Map<string, Stripe.Product>();
    for await (const p of stripe.products.list({ limit: 100, active: undefined })) {
      map.set(p.id, p);
    }
    this.products = map;
    return map;
  }

  async loadPrices(stripe: Stripe): Promise<Map<string, Stripe.Price>> {
    const map = new Map<string, Stripe.Price>();
    for await (const p of stripe.prices.list({ limit: 100, active: undefined })) {
      map.set(p.id, p);
    }
    this.prices = map;
    return map;
  }

  async loadCoupons(stripe: Stripe): Promise<Map<string, Stripe.Coupon>> {
    const map = new Map<string, Stripe.Coupon>();
    for await (const c of stripe.coupons.list({ limit: 100 })) {
      map.set(c.id, c);
    }
    this.coupons = map;
    return map;
  }

  async loadTaxRates(stripe: Stripe): Promise<Map<string, Stripe.TaxRate>> {
    const map = new Map<string, Stripe.TaxRate>();
    for await (const t of stripe.taxRates.list({ limit: 100 })) {
      map.set(t.id, t);
    }
    this.taxRates = map;
    return map;
  }

  productById(id: string | null | undefined): Stripe.Product | undefined {
    if (!id) return undefined;
    return this.products.get(id);
  }

  priceById(id: string | null | undefined): Stripe.Price | undefined {
    if (!id) return undefined;
    return this.prices.get(id);
  }

  couponById(id: string | null | undefined): Stripe.Coupon | undefined {
    if (!id) return undefined;
    return this.coupons.get(id);
  }

  taxRateById(id: string | null | undefined): Stripe.TaxRate | undefined {
    if (!id) return undefined;
    return this.taxRates.get(id);
  }

  /** Epoch ms of the last successful full load (for webhook-side TTL). */
  lastLoadedAt(): number | null {
    return this.loadedAt;
  }

  /**
   * Refresh if the cache is older than `maxAgeMs`. Returns true if a refresh
   * happened. Call this from the webhook on each event so the catalog stays
   * warm without hammering Stripe.
   */
  async refreshIfStale(stripe: Stripe, maxAgeMs: number): Promise<boolean> {
    if (this.loadedAt !== null && Date.now() - this.loadedAt < maxAgeMs) return false;
    await this.load(stripe);
    return true;
  }
}
