import type { AmplitudeClientConfig, AmplitudeEvent } from "./types.js";

const DEFAULT_ENDPOINT = "https://api2.amplitude.com";
const HTTPAPI_PATH = "/2/httpapi";
const BATCH_PATH = "/batch";

const HTTPAPI_MAX_EVENTS = 1000;
const BATCH_MAX_EVENTS = 4000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AmplitudeClient {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly path: string;
  private readonly maxPerRequest: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly minIdLength: number;

  constructor(config: AmplitudeClientConfig) {
    this.apiKey = config.apiKey;
    this.endpoint = (config.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, "");
    const hardCap = config.useBatchApi ? BATCH_MAX_EVENTS : HTTPAPI_MAX_EVENTS;
    this.path = config.useBatchApi ? BATCH_PATH : HTTPAPI_PATH;
    this.maxPerRequest = Math.min(config.maxEventsPerRequest ?? hardCap, hardCap);
    this.maxRetries = config.maxRetries ?? 5;
    this.retryBaseMs = config.retryBaseMs ?? 500;
    this.minIdLength = config.minIdLength ?? 1;
  }

  /** Send events in chunks of `maxPerRequest`. Resolves when all chunks succeed. */
  async send(events: AmplitudeEvent[]): Promise<void> {
    for (let i = 0; i < events.length; i += this.maxPerRequest) {
      const chunk = events.slice(i, i + this.maxPerRequest);
      await this.postWithRetry(chunk);
    }
  }

  private async postWithRetry(events: AmplitudeEvent[]): Promise<void> {
    let attempt = 0;
    while (true) {
      const response = await fetch(`${this.endpoint}${this.path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          api_key: this.apiKey,
          events,
          options: { min_id_length: this.minIdLength },
        }),
      });

      if (response.ok) return;

      const body = await response.text().catch(() => "");
      const retryable = response.status === 429 || response.status >= 500;

      if (!retryable || attempt >= this.maxRetries) {
        throw new AmplitudeRequestError(
          `Amplitude ${this.path} failed: ${response.status} ${response.statusText} :: ${body}`,
          response.status,
          body,
        );
      }

      const wait = this.retryBaseMs * 2 ** attempt;
      await sleep(wait);
      attempt += 1;
    }
  }
}

export class AmplitudeRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "AmplitudeRequestError";
  }
}
